import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  FLOW_HOSTS,
  disconnectBrowserConnectionOnly,
  engineLog,
  getBrowser,
  isChromeRunning,
  listCdpTargets,
  runningProfileDir,
} from "./chrome.js";
import {
  isMockMode,
  loadAccountsRegistry,
  readEmailFromProfilePrefs,
  recordProbe,
} from "./accounts.js";

export type SessionStateStatus =
  | "chrome_off"
  | "wrong_profile"
  | "login_in_progress"
  | "signed_out"
  | "signed_in_no_project"
  | "ready"
  | "busy"
  | "error";

export interface SessionProbeResult {
  status: SessionStateStatus;
  state: SessionStateStatus;
  url: string;
  signedIn: boolean;
  inProject: boolean;
  chrome_running: boolean;
  account_id: string | null;
  generation: number;
  email?: string;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
  error?: string;
}

const DETAILED_CREDITS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per account
const LOGIN_URL_PATTERN = /accounts\.google\.com|\/ServiceLogin|\/InteractiveLogin|\/AccountChooser|\/signin\/v2/i;

interface PassiveDomSnapshot {
  email?: string;
  plan?: string;
  composer?: string;
  passiveCredits?: number;
  hasAccountButton: boolean;
  hasSignInButton: boolean;
}

async function readPassiveDom(page: Page): Promise<PassiveDomSnapshot> {
  try {
    return await page.evaluate(() => {
      const result: {
        email?: string;
        plan?: string;
        composer?: string;
        passiveCredits?: number;
        hasAccountButton: boolean;
        hasSignInButton: boolean;
      } = {
        hasAccountButton: false,
        hasSignInButton: false,
      };

      const emailRegex = /\b([a-zA-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))\b/;
      const isIgnoredEmail = (e: string) => /@(?:example\.com|google\.com|sentry\.io)$/i.test(e) || /^(?:support|noreply|help|info)@/i.test(e);

      // 1. Check account details button (plan + aria-label email)
      const buttons = [...document.querySelectorAll("button, a[role='button']")];
      for (const btn of buttons) {
        const aria = btn.getAttribute("aria-label") || "";
        const title = btn.getAttribute("title") || "";
        const text = (btn as HTMLElement).innerText || "";

        if (/Account details|Google Account/i.test(aria) || /Account details/i.test(title)) {
          result.hasAccountButton = true;
          const firstLine = text.trim().split("\n")[0]?.trim();
          if (firstLine && firstLine.length < 40 && !/account/i.test(firstLine)) {
            result.plan = firstLine;
          }
        }

        if (/^sign in$/i.test(text.trim()) || /^sign in$/i.test(aria.trim())) {
          result.hasSignInButton = true;
        }

        for (const src of [aria, title, btn.getAttribute("data-email") || ""]) {
          const m = src.match(emailRegex);
          if (m && !isIgnoredEmail(m[1])) {
            result.email = m[1].toLowerCase();
          }
        }
      }

      // 2. Check [data-email] anywhere in DOM
      if (!result.email) {
        const elWithEmail = document.querySelector("[data-email]");
        const attrEmail = elWithEmail?.getAttribute("data-email");
        if (attrEmail && emailRegex.test(attrEmail) && !isIgnoredEmail(attrEmail)) {
          result.email = attrEmail.trim().toLowerCase();
        }
      }

      // 3. Check WIZ_global_data or inline scripts for the authenticated Google email
      if (!result.email) {
        for (const s of document.querySelectorAll("script")) {
          const content = s.textContent || "";
          if (content.includes("WIZ_global_data") || content.includes("AF_initDataCallback")) {
            const m = content.match(emailRegex);
            if (m && !isIgnoredEmail(m[1])) {
              result.email = m[1].toLowerCase();
              break;
            }
          }
        }
      }

      // 4. Settings trigger (composer model info)
      const settingsBtn = document.querySelector('button.settings-trigger-button, button[aria-label="Settings trigger"]') as HTMLElement | null;
      if (settingsBtn) {
        const cText = (settingsBtn.innerText || "").replace(/\s+/g, " ").trim();
        if (cText) result.composer = cText;
      }

      // 5. Passive credits check (ONLY if credits link is already visible in DOM without clicking)
      const links = [...document.querySelectorAll("a, span, div")];
      for (const el of links) {
        const txt = ((el as HTMLElement).innerText || "").trim();
        if (/^\d[\d,.\s]*Google Flow credits$/i.test(txt)) {
          const rect = (el as HTMLElement).getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            const num = Number(txt.replace(/[^\d]/g, ""));
            if (!Number.isNaN(num)) {
              result.passiveCredits = num;
              break;
            }
          }
        }
      }

      return result;
    });
  } catch {
    return { hasAccountButton: false, hasSignInButton: false };
  }
}

/**
 * Active credit readout (opens & closes Account details panel).
 * Works on both the Flow dashboard (`https://flow.google.com/?hl=en`) and inside `/project/...`.
 */
async function readCreditsActive(page: Page): Promise<{ credits?: number; plan?: string; email?: string }> {
  const out: { credits?: number; plan?: string; email?: string } = {};
  const closePanelIfOpen = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    const closeBtn = page.getByRole("button", { name: "Close account panel" });
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 3000 }).catch(() => {});
    }
  };

  try {
    await closePanelIfOpen();
    const accBtn = page.getByRole("button", { name: /Account details|Google Account/i }).first();
    if (!(await accBtn.isVisible().catch(() => false))) {
      await accBtn.waitFor({ state: "visible", timeout: 3500 }).catch(() => {});
    }
    if (!(await accBtn.isVisible().catch(() => false))) return out;

    const rawBtnText = await accBtn
      .innerText()
      .then((t) => t.trim().split("\n")[0]?.trim(), () => undefined);
    if (rawBtnText && rawBtnText.length < 40 && !/account/i.test(rawBtnText)) {
      out.plan = rawBtnText;
    }

    await accBtn.click({ timeout: 4000 });
    const link = page.getByRole("link", { name: /Google Flow credits/i }).first();
    await link.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    if (await link.isVisible().catch(() => false)) {
      const rawText = await link.innerText();
      const n = Number(rawText.replace(/[^\d]/g, ""));
      if (!Number.isNaN(n)) {
        out.credits = n;
      }
    } else {
      const fallbackCredits = await page
        .evaluate(() => {
          const els = [...document.querySelectorAll("a, span, div, p")];
          for (const el of els) {
            const txt = ((el as HTMLElement).innerText || "").trim();
            const m = txt.match(/^(\d[\d,.\s]*)\s*Google Flow credits$/i);
            if (m) {
              const n = Number(m[1].replace(/[^\d]/g, ""));
              if (!Number.isNaN(n)) return n;
            }
          }
          return undefined;
        })
        .catch(() => undefined);
      if (fallbackCredits !== undefined) {
        out.credits = fallbackCredits;
      }
    }

    // While the account panel is open, also grab the email text passively if shown inside the panel
    const panelEmail = await page
      .evaluate(() => {
        const m = document.body.innerText.match(/\b([a-zA-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))\b/);
        return m ? m[1].toLowerCase() : undefined;
      })
      .catch(() => undefined);
    if (panelEmail) out.email = panelEmail;
  } catch {
    // Best effort
  } finally {
    await closePanelIfOpen();
  }
  return out;
}

/**
 * Passive session probe for Google Flow:
 * - NEVER calls `newPage()` or `goto()`
 * - NEVER clicks "New project" or opens a project
 * - Immediately detaches and returns `login_in_progress` if any tab is on `accounts.google.com`
 * - Verifies login via `.google.com` `SID` / `__Secure-1PSID` cookies + non-marketing URL
 * - Rate-limits `detailed` credit panel clicks to at most once every 5 minutes per account
 */
export async function probeSession(
  accountId?: string | null,
  opts?: { detailed?: boolean; forceDetailed?: boolean },
): Promise<SessionProbeResult> {
  const reg = loadAccountsRegistry();
  const targetId = accountId !== undefined ? accountId : reg.active_account_id;
  const startGen = reg.generation;
  const targetAcc = targetId ? reg.accounts.find((a) => a.id === targetId) : undefined;

  if (isMockMode()) {
    const mockCredits =
      process.env.FLOW_MOCK_CREDITS !== undefined
        ? Number(process.env.FLOW_MOCK_CREDITS)
        : targetAcc?.credits ?? 9999;
    if (!targetAcc) {
      return {
        status: "signed_out",
        state: "signed_out",
        url: "",
        signedIn: false,
        inProject: false,
        chrome_running: false,
        account_id: null,
        generation: startGen,
        hint: "Belum ada akun aktif.",
      };
    }
    recordProbe(targetAcc.id, startGen, {
      status: "signed_in",
      credits: mockCredits,
      credits_checked_at: Date.now(),
      plan: "Mock Testing Mode",
    });
    return {
      status: "ready",
      state: "ready",
      url: "https://flow.google.com/project/mock-project",
      signedIn: true,
      inProject: true,
      chrome_running: true,
      account_id: targetAcc.id,
      generation: startGen,
      email: targetAcc.email,
      plan: "Mock Testing Mode",
      credits_remaining: mockCredits,
      composer: "Omni 1.1 Flash",
    };
  }

  if (!targetAcc) {
    const chromeUp = await isChromeRunning();
    const st: SessionStateStatus = chromeUp ? "wrong_profile" : "chrome_off";
    return {
      status: st,
      state: st,
      url: "",
      signedIn: false,
      inProject: false,
      chrome_running: chromeUp,
      account_id: null,
      generation: startGen,
      hint: "Belum ada akun Google Flow. Klik Tambah Akun untuk memulai.",
    };
  }

  const chromeUp = await isChromeRunning();
  if (!chromeUp) {
    const prefEmail = targetAcc.email || readEmailFromProfilePrefs(targetAcc.profile_dir);
    if (prefEmail && !targetAcc.email) {
      recordProbe(targetAcc.id, startGen, { email: prefEmail });
    }
    return {
      status: "chrome_off",
      state: "chrome_off",
      url: "",
      signedIn: targetAcc.status === "signed_in",
      inProject: false,
      chrome_running: false,
      account_id: targetAcc.id,
      generation: startGen,
      email: prefEmail,
      plan: targetAcc.plan,
      credits_remaining: targetAcc.credits,
      hint: "Chrome tertutup. Klik Login untuk membuka jendela Google Flow.",
    };
  }

  const runDir = await runningProfileDir();
  if (!runDir || resolve(runDir) !== resolve(targetAcc.profile_dir)) {
    engineLog(
      "probe",
      `wrong_profile for account ${targetAcc.id}: running=${runDir ?? "null"}, expected=${targetAcc.profile_dir}`,
    );
    return {
      status: "wrong_profile",
      state: "wrong_profile",
      url: "",
      signedIn: false,
      inProject: false,
      chrome_running: true,
      account_id: targetAcc.id,
      generation: startGen,
      email: targetAcc.email,
      plan: targetAcc.plan,
      credits_remaining: targetAcc.credits,
      hint: "Chrome yang sedang berjalan menggunakan profil akun berbeda.",
    };
  }

  // Check CDP target URLs via HTTP GET /json/list BEFORE connecting Playwright over WebSocket.
  // If the user is on accounts.google.com, do NOT attach CDP WebSocket at all (fixes A5).
  const targets = await listCdpTargets();
  const pageTargets = targets.filter((t) => !t.type || t.type === "page");
  const loginTarget = pageTargets.find((t) => t.url && LOGIN_URL_PATTERN.test(t.url));
  if (loginTarget) {
    await disconnectBrowserConnectionOnly();
    engineLog("probe", `login_in_progress for ${targetAcc.id} (tab on accounts.google.com)`);
    return {
      status: "login_in_progress",
      state: "login_in_progress",
      url: loginTarget.url || "https://accounts.google.com/",
      signedIn: false,
      inProject: false,
      chrome_running: true,
      account_id: targetAcc.id,
      generation: startGen,
      email: targetAcc.email,
      credits_remaining: targetAcc.credits,
      plan: targetAcc.plan,
      hint: "Sedang login di jendela Google Chrome...",
    };
  }

  try {
    const b = await getBrowser({ autoLaunch: false });
    const context = b.contexts()[0];
    if (!context) {
      return {
        status: "chrome_off",
        state: "chrome_off",
        url: "",
        signedIn: false,
        inProject: false,
        chrome_running: false,
        account_id: targetAcc.id,
        generation: startGen,
        email: targetAcc.email,
        credits_remaining: targetAcc.credits,
        plan: targetAcc.plan,
        hint: "Jendela Chrome tidak memiliki context aktif.",
      };
    }

    const pages = context.pages();
    const loginPage = pages.find((p) => LOGIN_URL_PATTERN.test(p.url()));
    if (loginPage) {
      const loginUrl = loginPage.url();
      await disconnectBrowserConnectionOnly();
      engineLog("probe", `login_in_progress for ${targetAcc.id} (${loginUrl.slice(0, 60)})`);
      return {
        status: "login_in_progress",
        state: "login_in_progress",
        url: loginUrl,
        signedIn: false,
        inProject: false,
        chrome_running: true,
        account_id: targetAcc.id,
        generation: startGen,
        email: targetAcc.email,
        credits_remaining: targetAcc.credits,
        plan: targetAcc.plan,
        hint: "Sedang login di jendela Google Chrome...",
      };
    }

    // Check Google session cookies (.google.com SID / __Secure-1PSID / __Secure-3PSID)
    const cookies = await context
      .cookies(["https://accounts.google.com", "https://www.google.com", "https://labs.google", "https://flow.google.com"])
      .catch(() => []);
    const nowSec = Date.now() / 1000;
    const hasSidCookie = cookies.some(
      (c) =>
        (c.name === "SID" || c.name === "__Secure-1PSID" || c.name === "__Secure-3PSID") &&
        Boolean(c.value) &&
        (!c.expires || c.expires < 0 || c.expires > nowSec),
    );

    const flowPage = pages.find((p) => FLOW_HOSTS.test(p.url()));
    let flowUrl = flowPage ? flowPage.url() : "";
    let onMarketingPage = flowPage ? /\/about(\/|$|\?|#)|accounts\.google\.com/i.test(flowUrl) : false;

    let domInfo: PassiveDomSnapshot = { hasAccountButton: false, hasSignInButton: false };
    if (flowPage && !onMarketingPage) {
      domInfo = await readPassiveDom(flowPage);
      if (!domInfo.hasAccountButton && !domInfo.hasSignInButton && domInfo.passiveCredits === undefined) {
        for (let i = 0; i < 9; i++) {
          await new Promise((r) => setTimeout(r, 500));
          flowUrl = flowPage.url();
          if (LOGIN_URL_PATTERN.test(flowUrl)) {
            await disconnectBrowserConnectionOnly();
            engineLog("probe", `login_in_progress for ${targetAcc.id} (${flowUrl.slice(0, 60)})`);
            return {
              status: "login_in_progress",
              state: "login_in_progress",
              url: flowUrl,
              signedIn: false,
              inProject: false,
              chrome_running: true,
              account_id: targetAcc.id,
              generation: startGen,
              email: targetAcc.email,
              credits_remaining: targetAcc.credits,
              plan: targetAcc.plan,
              hint: "Sedang login di jendela Google Chrome...",
            };
          }
          onMarketingPage = /\/about(\/|$|\?|#)|accounts\.google\.com/i.test(flowUrl);
          if (onMarketingPage) break;
          domInfo = await readPassiveDom(flowPage);
          if (domInfo.hasAccountButton || domInfo.hasSignInButton || domInfo.passiveCredits !== undefined) {
            break;
          }
        }
      }
    }

    const detectedEmail = domInfo.email || readEmailFromProfilePrefs(targetAcc.profile_dir) || targetAcc.email;

    // Signed in requires valid Google session cookies AND not being bounced to Flow's /about marketing page
    // (or seeing an explicit "Sign in" button without an Account button on Flow)
    const isSignedIn =
      hasSidCookie &&
      !onMarketingPage &&
      !(flowPage && domInfo.hasSignInButton && !domInfo.hasAccountButton);

    if (!isSignedIn) {
      recordProbe(
        targetAcc.id,
        startGen,
        {
          status: "signed_out",
          email: detectedEmail,
        },
        { allowInactive: opts?.forceDetailed === true },
      );
      engineLog("probe", `probeSession ${targetAcc.id}: signed_out (hasSid=${hasSidCookie}, url=${flowUrl || "none"})`);
      return {
        status: "signed_out",
        state: "signed_out",
        url: flowUrl,
        signedIn: false,
        inProject: false,
        chrome_running: true,
        account_id: targetAcc.id,
        generation: startGen,
        email: detectedEmail,
        hint: "Belum login ke Google Flow. Silakan login di jendela Chrome.",
      };
    }

    const inProject = Boolean(flowPage && /\/project\//.test(flowUrl));
    let credits = domInfo.passiveCredits !== undefined ? domInfo.passiveCredits : targetAcc.credits;
    let creditsCheckedAt = domInfo.passiveCredits !== undefined ? Date.now() : targetAcc.credits_checked_at;
    let plan = domInfo.plan || targetAcc.plan;
    let finalEmail = detectedEmail;

    const needsInitialCredits = targetAcc.credits === undefined;
    const cooldownElapsed =
      !targetAcc.credits_checked_at || Date.now() - targetAcc.credits_checked_at >= DETAILED_CREDITS_COOLDOWN_MS;
    const canRunDetailed =
      Boolean(flowPage) &&
      (opts?.forceDetailed === true ||
        needsInitialCredits ||
        (opts?.detailed === true && cooldownElapsed));

    if (canRunDetailed && flowPage) {
      const activeRead = await readCreditsActive(flowPage);
      if (activeRead.credits !== undefined) {
        credits = activeRead.credits;
        creditsCheckedAt = Date.now();
      }
      if (activeRead.plan) {
        plan = activeRead.plan;
      }
      if (activeRead.email) {
        finalEmail = activeRead.email;
      }
    }

    recordProbe(
      targetAcc.id,
      startGen,
      {
        status: "signed_in",
        email: finalEmail,
        credits,
        credits_checked_at: creditsCheckedAt,
        plan,
      },
      { allowInactive: opts?.forceDetailed === true },
    );

    const finalStatus: SessionStateStatus = inProject ? "ready" : "signed_in_no_project";
    engineLog(
      "probe",
      `probeSession ${targetAcc.id}: ${finalStatus} (email=${finalEmail ?? "?"}, credits=${credits ?? "?"})`,
    );

    return {
      status: finalStatus,
      state: finalStatus,
      url: flowUrl,
      signedIn: true,
      inProject,
      chrome_running: true,
      account_id: targetAcc.id,
      generation: startGen,
      email: finalEmail,
      plan,
      credits_remaining: credits,
      composer: domInfo.composer,
      hint: inProject ? undefined : "Login berhasil. Buka atau buat project di Google Flow.",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isWrongProf = message.startsWith("wrong_profile:");
    const isChromeOff = message.startsWith("chrome_off:");
    const st: SessionStateStatus = isWrongProf ? "wrong_profile" : isChromeOff ? "chrome_off" : "error";
    engineLog("probe", `probeSession ${targetAcc.id} error (${st}): ${message}`);
    // Do NOT overwrite account status on transient error (fixes A7)
    return {
      status: st,
      state: st,
      url: "",
      signedIn: targetAcc.status === "signed_in",
      inProject: false,
      chrome_running: !isChromeOff,
      account_id: targetAcc.id,
      generation: startGen,
      email: targetAcc.email,
      plan: targetAcc.plan,
      credits_remaining: targetAcc.credits,
      error: message,
      hint: message,
    };
  }
}

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FLOW_URL,
  HOME_DIR,
  PROFILE_DIR,
  engineLog,
  ensureChromeForProfile,
  inEnglish,
  isChromeRunning,
  killPid,
  runningChromePidSync,
  runningProfileDir,
  runningProfileDirSync,
  setProfileDir,
  shutdownChrome,
} from "./chrome.js";
import { withFlowLock } from "./flowlock.js";
import { moveToBin, normalizeProfilePath } from "./platform.js";
import { probeSession, type SessionProbeResult } from "./session.js";

export type AccountStatus = "unknown" | "signed_out" | "signed_in" | "expired";

export interface FlowAccount {
  id: string;
  label: string;
  /** Alias for `label` kept for backward compatibility */
  name: string;
  email?: string;
  profile_dir: string;
  status: AccountStatus;
  /** Alias for `status === "signed_in"` kept for backward compatibility */
  signed_in: boolean;
  credits?: number;
  credits_checked_at?: number;
  plan?: string;
  created_at: number;
  last_active: number;
}

export interface AccountsRegistry {
  version: 2;
  active_account_id: string | null;
  generation: number;
  accounts: FlowAccount[];
}

const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const ACCOUNTS_V1_BACKUP_FILE = join(HOME_DIR, "accounts.v1.backup.json");
const MOCK_ACCOUNTS_FILE = join(HOME_DIR, "accounts.mock.json");
export const PROFILES_BASE_DIR = join(HOME_DIR, "profiles");

const POLLUTED_MOCK_IDS = new Set(["acc_backup_1", "acc_backup_2"]);
const POLLUTED_MOCK_EMAILS = new Set(["arfi***@gmail.com", "develapar***@gmail.com", "studio***@gmail.com"]);

export function isMockMode(): boolean {
  return process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true";
}

function getAccountsFilePath(): string {
  return isMockMode() ? MOCK_ACCOUNTS_FILE : ACCOUNTS_FILE;
}

function indexToLetters(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

export function nextAccountLabel(accounts: Array<{ label?: string; name?: string }>): string {
  const used = new Set(
    accounts
      .map((a) => (a.label || a.name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  for (let i = 0; i < 702; i++) {
    const candidate = `Akun ${indexToLetters(i)}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `Akun ${accounts.length + 1}`;
}

export function readEmailFromProfilePrefs(profileDir: string): string | undefined {
  if (!profileDir) return undefined;
  try {
    const prefPath = join(profileDir, "Default", "Preferences");
    if (!existsSync(prefPath)) return undefined;
    const raw = readFileSync(prefPath, "utf8");
    const parsed = JSON.parse(raw) as {
      account_info?: Array<{ email?: string }>;
      google?: { services?: { last_username?: string; username?: string } };
    };
    const fromAccountInfo = parsed.account_info?.find((a) => typeof a?.email === "string" && a.email.includes("@"))?.email;
    if (fromAccountInfo && !POLLUTED_MOCK_EMAILS.has(fromAccountInfo)) {
      return fromAccountInfo.trim();
    }
    const fromServices = parsed.google?.services?.username || parsed.google?.services?.last_username;
    if (typeof fromServices === "string" && fromServices.includes("@") && !POLLUTED_MOCK_EMAILS.has(fromServices)) {
      return fromServices.trim();
    }
  } catch {}
  return undefined;
}

export function normalizeAccount(acc: Partial<FlowAccount> & { id: string; profile_dir: string }): FlowAccount {
  const label = (acc.label || acc.name || "Akun A").trim();
  const status: AccountStatus =
    acc.status === "signed_in" || acc.status === "signed_out" || acc.status === "expired" || acc.status === "unknown"
      ? acc.status
      : acc.signed_in === true
        ? "signed_in"
        : acc.signed_in === false
          ? "signed_out"
          : "unknown";
  return {
    id: acc.id,
    label,
    name: label,
    email: acc.email || undefined,
    profile_dir: acc.profile_dir,
    status,
    signed_in: status === "signed_in",
    credits: typeof acc.credits === "number" && !Number.isNaN(acc.credits) ? acc.credits : undefined,
    credits_checked_at: typeof acc.credits_checked_at === "number" ? acc.credits_checked_at : undefined,
    plan: acc.plan || undefined,
    created_at: typeof acc.created_at === "number" ? acc.created_at : Date.now(),
    last_active: typeof acc.last_active === "number" ? acc.last_active : Date.now(),
  };
}

function syncActiveProfileToChrome(reg: AccountsRegistry): void {
  const active = reg.active_account_id ? reg.accounts.find((a) => a.id === reg.active_account_id) : undefined;
  if (active) {
    setProfileDir(active.profile_dir);
  }
}

function migrateV1ToV2(rawParsed: Record<string, any>): AccountsRegistry {
  // 1. Backup accounts.json -> accounts.v1.backup.json
  try {
    if (existsSync(ACCOUNTS_FILE) && !existsSync(ACCOUNTS_V1_BACKUP_FILE)) {
      copyFileSync(ACCOUNTS_FILE, ACCOUNTS_V1_BACKUP_FILE);
      engineLog("accounts", `Backed up v1 accounts.json to ${ACCOUNTS_V1_BACKUP_FILE}`);
    }
  } catch (err) {
    engineLog("accounts", `Warning: failed to backup v1 accounts.json: ${(err as Error).message}`);
  }

  const rawAccounts: Array<Record<string, any>> = Array.isArray(rawParsed.accounts) ? rawParsed.accounts : [];
  let activeId: string | null = typeof rawParsed.active_account_id === "string" ? rawParsed.active_account_id : null;

  // 2. Filter out polluted mock entries
  const cleanedRaw = rawAccounts.filter((acc) => {
    if (!acc || typeof acc !== "object" || !acc.id) return false;
    if (acc.id !== "default") {
      if (
        POLLUTED_MOCK_IDS.has(String(acc.id)) ||
        (acc.email && POLLUTED_MOCK_EMAILS.has(String(acc.email))) ||
        acc.name === "Akun VIP Studio"
      ) {
        return false;
      }
    }
    return true;
  });

  const migratedAccounts: FlowAccount[] = [];
  const usedIds = new Set<string>(cleanedRaw.map((a) => String(a.id)));

  for (const acc of cleanedRaw) {
    const rawId = String(acc.id);
    if (rawId === "default") {
      const legacyDir = acc.profile_dir ? String(acc.profile_dir) : PROFILE_DIR;
      const legacyExists = existsSync(legacyDir);
      const hasValidEmail = acc.email && !POLLUTED_MOCK_EMAILS.has(String(acc.email)) ? String(acc.email) : undefined;

      // If legacy default profile doesn't exist on disk and had no real email/login, skip empty bootstrap
      if (!legacyExists && !hasValidEmail && !acc.signed_in) {
        if (activeId === "default") activeId = null;
        continue;
      }

      // If Chrome is currently holding legacyDir on port 9333, terminate it before renaming folder
      try {
        const runningDir = runningProfileDirSync();
        if (runningDir && normalizeProfilePath(runningDir) === normalizeProfilePath(legacyDir)) {
          const pid = runningChromePidSync();
          if (pid) {
            engineLog("accounts", `Stopping Chrome (pid=${pid}) using legacy default profile before migration rename`);
            killPid(pid);
          }
        }
      } catch {}

      let ts = Date.now();
      let newId = `acc_${ts}`;
      while (usedIds.has(newId) || existsSync(join(PROFILES_BASE_DIR, newId))) {
        ts += 1;
        newId = `acc_${ts}`;
      }
      usedIds.add(newId);

      const newProfileDir = join(PROFILES_BASE_DIR, newId);
      mkdirSync(PROFILES_BASE_DIR, { recursive: true });
      if (legacyExists) {
        try {
          renameSync(legacyDir, newProfileDir);
          engineLog("accounts", `Migrated legacy default profile folder ${legacyDir} -> ${newProfileDir}`);
        } catch (err) {
          engineLog("accounts", `Warning: could not rename ${legacyDir} -> ${newProfileDir}: ${(err as Error).message}`);
          mkdirSync(newProfileDir, { recursive: true });
        }
      } else {
        mkdirSync(newProfileDir, { recursive: true });
      }

      const detectedEmail = hasValidEmail || readEmailFromProfilePrefs(newProfileDir);
      const label = detectedEmail || nextAccountLabel(migratedAccounts);

      migratedAccounts.push(
        normalizeAccount({
          id: newId,
          label,
          email: detectedEmail,
          profile_dir: newProfileDir,
          status: "unknown", // Will be verified by passive probe
          credits: undefined, // Reset polluted credits
          credits_checked_at: undefined,
          plan: undefined,
          created_at: typeof acc.created_at === "number" ? acc.created_at : Date.now(),
          last_active: typeof acc.last_active === "number" ? acc.last_active : Date.now(),
        }),
      );

      if (activeId === "default") {
        activeId = newId;
      }
      continue;
    }

    // Normal account migration
    const profileDir = acc.profile_dir ? String(acc.profile_dir) : join(PROFILES_BASE_DIR, rawId);
    mkdirSync(profileDir, { recursive: true });
    const detectedEmail =
      (acc.email && !POLLUTED_MOCK_EMAILS.has(String(acc.email)) ? String(acc.email) : undefined) ||
      readEmailFromProfilePrefs(profileDir);
    const rawLabel = String(acc.label || acc.name || "").trim();
    const label = rawLabel && rawLabel !== "Akun Utama" ? rawLabel : detectedEmail || nextAccountLabel(migratedAccounts);
    const status: AccountStatus =
      acc.status === "signed_in" || acc.status === "signed_out" || acc.status === "expired" || acc.status === "unknown"
        ? acc.status
        : acc.signed_in === true
          ? "signed_in"
          : acc.signed_in === false
            ? "signed_out"
            : "unknown";

    migratedAccounts.push(
      normalizeAccount({
        id: rawId,
        label,
        email: detectedEmail,
        profile_dir: profileDir,
        status,
        credits: undefined, // Reset polluted credits per plan 1.4 step 4
        credits_checked_at: undefined,
        plan: acc.plan ? String(acc.plan) : undefined,
        created_at: typeof acc.created_at === "number" ? acc.created_at : Date.now(),
        last_active: typeof acc.last_active === "number" ? acc.last_active : Date.now(),
      }),
    );
  }

  if (activeId && !migratedAccounts.some((a) => a.id === activeId)) {
    activeId = migratedAccounts[0]?.id ?? null;
  }

  const v2Reg: AccountsRegistry = {
    version: 2,
    active_account_id: activeId,
    generation: typeof rawParsed.generation === "number" && rawParsed.generation > 0 ? rawParsed.generation : 1,
    accounts: migratedAccounts,
  };

  sanitizeAndDeduplicateRegistry(v2Reg);
  saveAccountsRegistry(v2Reg);
  engineLog(
    "accounts",
    `Migrated accounts.json to v2 (${v2Reg.accounts.length} accounts, active=${v2Reg.active_account_id ?? "null"})`,
  );
  return v2Reg;
}

/**
 * 1. Restores missing `credits` & `plan` from `accounts.v1.backup.json` when available.
 * 2. Deduplicates duplicate email accounts created when the legacy `default` seed profile was migrated
 *    alongside an already-added user account for the same Google email.
 */
function sanitizeAndDeduplicateRegistry(reg: AccountsRegistry): boolean {
  let dirty = false;

  // 1. Restore missing credits & plan from v1 backup file if present
  if (reg.accounts.some((a) => a.credits === undefined) && existsSync(ACCOUNTS_V1_BACKUP_FILE)) {
    try {
      const backupRaw = readFileSync(ACCOUNTS_V1_BACKUP_FILE, "utf8");
      const backupParsed = JSON.parse(backupRaw) as { accounts?: Array<Record<string, any>> };
      const backupAccounts = Array.isArray(backupParsed?.accounts) ? backupParsed.accounts : [];
      for (const acc of reg.accounts) {
        if (acc.credits !== undefined) continue;
        const match = backupAccounts.find((b) => {
          if (!b || typeof b !== "object" || !b.id) return false;
          const bId = String(b.id);
          if (POLLUTED_MOCK_IDS.has(bId)) return false;
          if (bId === acc.id) return true;
          if (bId === "default") {
            if (typeof b.created_at === "number" && b.created_at === acc.created_at) return true;
            if (typeof b.email === "string" && acc.email && b.email.toLowerCase() === acc.email.toLowerCase()) {
              return true;
            }
          }
          return false;
        });
        if (match && typeof match.credits === "number" && !Number.isNaN(match.credits)) {
          acc.credits = Number(match.credits);
          if (!acc.plan && typeof match.plan === "string" && match.plan) {
            acc.plan = match.plan;
          }
          dirty = true;
          engineLog(
            "accounts",
            `Restored credits=${acc.credits} (plan=${acc.plan ?? "-"}) for ${acc.id} (${acc.label}) from v1 backup`,
          );
        }
      }
    } catch {}
  }

  // 2. Deduplicate duplicate email accounts where one has an auto-generated email label (from `default` seed migration)
  //    and another has a custom user label (e.g. "akun 1").
  const byEmail = new Map<string, FlowAccount[]>();
  for (const acc of reg.accounts) {
    const emailKey = (acc.email || "").trim().toLowerCase();
    if (!emailKey) continue;
    const list = byEmail.get(emailKey) ?? [];
    list.push(acc);
    byEmail.set(emailKey, list);
  }

  const removeIds = new Set<string>();
  for (const [emailKey, group] of byEmail.entries()) {
    if (group.length < 2) continue;
    const customLabelAccs = group.filter((a) => a.label.trim().toLowerCase() !== emailKey);
    const seedEmailLabelAccs = group.filter((a) => a.label.trim().toLowerCase() === emailKey);
    if (customLabelAccs.length > 0 && seedEmailLabelAccs.length > 0) {
      const kept = customLabelAccs[0];
      for (const dup of seedEmailLabelAccs) {
        if (dup.id === kept.id) continue;
        if (kept.credits === undefined && dup.credits !== undefined) {
          kept.credits = dup.credits;
          kept.credits_checked_at = dup.credits_checked_at;
        }
        if (!kept.plan && dup.plan) {
          kept.plan = dup.plan;
        }
        if (kept.status !== "signed_in" && dup.status === "signed_in") {
          kept.status = "signed_in";
          kept.signed_in = true;
        }
        if (reg.active_account_id === dup.id) {
          reg.active_account_id = kept.id;
        }
        removeIds.add(dup.id);
        if (
          !isMockMode() &&
          dup.profile_dir &&
          normalizeProfilePath(dup.profile_dir) !== normalizeProfilePath(kept.profile_dir) &&
          existsSync(dup.profile_dir)
        ) {
          try {
            moveToBin(dup.profile_dir);
          } catch {
            try {
              rmSync(dup.profile_dir, { recursive: true, force: true });
            } catch {}
          }
        }
        dirty = true;
        engineLog(
          "accounts",
          `Deduplicated ex-seed account ${dup.id} (${dup.label}) into ${kept.id} (${kept.label})`,
        );
      }
    }
  }

  if (removeIds.size > 0) {
    reg.accounts = reg.accounts.filter((a) => !removeIds.has(a.id));
  }

  return dirty;
}

export function loadAccountsRegistry(): AccountsRegistry {
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(PROFILES_BASE_DIR, { recursive: true });

  if (isMockMode()) {
    const mockCredits = process.env.FLOW_MOCK_CREDITS !== undefined ? Number(process.env.FLOW_MOCK_CREDITS) : 45;
    if (existsSync(MOCK_ACCOUNTS_FILE)) {
      try {
        const raw = readFileSync(MOCK_ACCOUNTS_FILE, "utf8");
        const parsed = JSON.parse(raw) as Partial<AccountsRegistry>;
        if (parsed && parsed.version === 2 && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          const normalized: AccountsRegistry = {
            version: 2,
            active_account_id: parsed.active_account_id ?? parsed.accounts[0].id,
            generation: typeof parsed.generation === "number" ? parsed.generation : 1,
            accounts: parsed.accounts.map((a) => normalizeAccount(a)),
          };
          syncActiveProfileToChrome(normalized);
          return normalized;
        }
      } catch {}
    }

    const mockRegistry: AccountsRegistry = {
      version: 2,
      active_account_id: "acc_mock_a",
      generation: 1,
      accounts: [
        normalizeAccount({
          id: "acc_mock_a",
          label: "Akun A",
          email: "mock.a@example.com",
          credits: mockCredits,
          credits_checked_at: Date.now(),
          status: "signed_in",
          profile_dir: join(PROFILES_BASE_DIR, "acc_mock_a"),
          created_at: Date.now() - 86400000,
          last_active: Date.now(),
        }),
        normalizeAccount({
          id: "acc_mock_b",
          label: "Akun B",
          email: "mock.b@example.com",
          credits: 150,
          credits_checked_at: Date.now() - 120000,
          status: "signed_in",
          profile_dir: join(PROFILES_BASE_DIR, "acc_mock_b"),
          created_at: Date.now() - 43200000,
          last_active: Date.now() - 3600000,
        }),
      ],
    };
    saveAccountsRegistry(mockRegistry);
    syncActiveProfileToChrome(mockRegistry);
    return mockRegistry;
  }

  if (existsSync(ACCOUNTS_FILE)) {
    try {
      const raw = readFileSync(ACCOUNTS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (parsed && typeof parsed === "object") {
        if (parsed.version !== 2) {
          const migrated = migrateV1ToV2(parsed);
          syncActiveProfileToChrome(migrated);
          return migrated;
        }

        let dirty = false;
        const accounts: FlowAccount[] = Array.isArray(parsed.accounts)
          ? parsed.accounts.map((rawAcc: Record<string, any>) => {
              if ("storage_state" in rawAcc) dirty = true;
              const profileDir = rawAcc.profile_dir ? String(rawAcc.profile_dir) : join(PROFILES_BASE_DIR, String(rawAcc.id));
              let email = rawAcc.email ? String(rawAcc.email) : undefined;
              if (!email) {
                const detected = readEmailFromProfilePrefs(profileDir);
                if (detected) {
                  email = detected;
                  dirty = true;
                }
              }
              return normalizeAccount({
                ...rawAcc,
                id: String(rawAcc.id),
                profile_dir: profileDir,
                email,
              });
            })
          : [];

        let activeId: string | null = typeof parsed.active_account_id === "string" ? parsed.active_account_id : null;
        if (activeId && !accounts.some((a) => a.id === activeId)) {
          activeId = accounts[0]?.id ?? null;
          dirty = true;
        }

        const reg: AccountsRegistry = {
          version: 2,
          active_account_id: activeId,
          generation: typeof parsed.generation === "number" && parsed.generation > 0 ? parsed.generation : 1,
          accounts,
        };

        if (sanitizeAndDeduplicateRegistry(reg)) {
          dirty = true;
        }

        if (dirty) {
          saveAccountsRegistry(reg);
        }
        syncActiveProfileToChrome(reg);
        return reg;
      }
    } catch (err) {
      engineLog("accounts", `Error loading accounts.json: ${(err as Error).message}`);
    }
  }

  // Empty v2 registry bootstrap — no "Akun Utama" / `default`
  const emptyReg: AccountsRegistry = {
    version: 2,
    active_account_id: null,
    generation: 1,
    accounts: [],
  };
  saveAccountsRegistry(emptyReg);
  return emptyReg;
}

export function saveAccountsRegistry(reg: AccountsRegistry): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const normalized: AccountsRegistry = {
    version: 2,
    active_account_id: reg.active_account_id ?? null,
    generation: typeof reg.generation === "number" && reg.generation > 0 ? reg.generation : 1,
    accounts: reg.accounts.map((a) => normalizeAccount(a)),
  };
  writeFileSync(getAccountsFilePath(), JSON.stringify(normalized, null, 2), "utf8");
}

export function getActiveAccount(): FlowAccount | undefined {
  const reg = loadAccountsRegistry();
  if (!reg.active_account_id) return undefined;
  return reg.accounts.find((a) => a.id === reg.active_account_id);
}

export function getActiveProfileDir(): string {
  const active = getActiveAccount();
  return active ? active.profile_dir : PROFILE_DIR;
}

export function listAccounts(): FlowAccount[] {
  return loadAccountsRegistry().accounts;
}

export function bumpAccountsGeneration(): number {
  const reg = loadAccountsRegistry();
  reg.generation = (reg.generation || 1) + 1;
  saveAccountsRegistry(reg);
  return reg.generation;
}

/**
 * Writes probe results strictly BY ACCOUNT ID and drops them if `generation` changed
 * or if `accountId` is no longer the active account (unless `opts.allowInactive` is true).
 */
export function recordProbe(
  accountId: string,
  startGeneration: number,
  patch: {
    status?: AccountStatus;
    email?: string;
    credits?: number;
    credits_checked_at?: number;
    plan?: string;
  },
  opts?: { allowInactive?: boolean },
): FlowAccount | null {
  const reg = loadAccountsRegistry();
  if (reg.generation !== startGeneration || (!opts?.allowInactive && reg.active_account_id !== accountId)) {
    engineLog(
      "probe",
      `Dropped stale probe result for ${accountId} (startGen=${startGeneration}, currentGen=${reg.generation}, active=${reg.active_account_id ?? "null"})`,
    );
    return null;
  }

  const target = reg.accounts.find((a) => a.id === accountId);
  if (!target) return null;

  if (patch.status !== undefined) {
    target.status = patch.status;
    target.signed_in = patch.status === "signed_in";
    if (patch.status === "signed_out" || patch.status === "expired") {
      target.credits = undefined;
      target.credits_checked_at = undefined;
      target.plan = undefined;
    }
  }
  if (patch.email !== undefined && patch.email) {
    target.email = patch.email;
  }
  if (patch.credits !== undefined && !Number.isNaN(patch.credits)) {
    target.credits = patch.credits;
    target.credits_checked_at = patch.credits_checked_at ?? Date.now();
  }
  if (patch.plan !== undefined) {
    target.plan = patch.plan;
  }
  target.last_active = Date.now();

  const normalized = normalizeAccount(target);
  const idx = reg.accounts.findIndex((a) => a.id === accountId);
  reg.accounts[idx] = normalized;
  saveAccountsRegistry(reg);
  return normalized;
}

export type LaunchState = "idle" | "launching" | "ready" | "error";

export interface AccountLaunchStatus {
  state: LaunchState;
  error?: string;
}

const pendingLaunch = new Map<string, AccountLaunchStatus>();

export function getAccountLaunchStatus(accountId: string | null): AccountLaunchStatus {
  if (!accountId) return { state: "idle" };
  return pendingLaunch.get(accountId) ?? { state: "idle" };
}

export function setAccountLaunchStatus(accountId: string, status: AccountLaunchStatus): void {
  pendingLaunch.set(accountId, status);
}

export async function launchLoginChrome(accountId: string): Promise<void> {
  const reg = loadAccountsRegistry();
  const acc = reg.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  setAccountLaunchStatus(accountId, { state: "launching" });
  try {
    if (!isMockMode()) {
      await ensureChromeForProfile(acc.profile_dir, { visible: true, bringToFront: true });
    }
    setAccountLaunchStatus(accountId, { state: "ready" });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    engineLog("accounts", `launchLoginChrome error for ${accountId}: ${errorMsg}`);
    setAccountLaunchStatus(accountId, { state: "error", error: errorMsg });
  }
}

export async function createAccount(label?: string): Promise<FlowAccount> {
  return withFlowLock("create-account", async () => {
    const reg = loadAccountsRegistry();
    let ts = Date.now();
    let id = `acc_${ts}`;
    while (reg.accounts.some((a) => a.id === id) || existsSync(join(PROFILES_BASE_DIR, id))) {
      ts += 1;
      id = `acc_${ts}`;
    }

    const accLabel = label && label.trim() ? label.trim() : nextAccountLabel(reg.accounts);
    const profileDir = join(PROFILES_BASE_DIR, id);
    mkdirSync(profileDir, { recursive: true });

    const newAcc = normalizeAccount({
      id,
      label: accLabel,
      status: isMockMode() ? "signed_in" : "unknown",
      credits: isMockMode() ? 100 : undefined,
      credits_checked_at: isMockMode() ? Date.now() : undefined,
      profile_dir: profileDir,
      created_at: Date.now(),
      last_active: Date.now(),
    });

    reg.accounts.push(newAcc);
    reg.active_account_id = id;
    reg.generation = (reg.generation || 1) + 1;
    saveAccountsRegistry(reg);
    setProfileDir(profileDir);

    engineLog("accounts", `Created account ${id} (${accLabel}), generation=${reg.generation}`);

    setAccountLaunchStatus(id, { state: "launching" });
    if (!isMockMode()) {
      void launchLoginChrome(id).catch((err) => {
        engineLog("accounts", `Background Chrome launch rejected: ${(err as Error).message}`);
      });
    } else {
      setAccountLaunchStatus(id, { state: "ready" });
    }

    return newAcc;
  });
}

export async function switchAccount(
  accountId: string,
  opts?: { visible?: boolean; launch?: boolean },
): Promise<{ account: FlowAccount; state: SessionProbeResult; generation: number }> {
  return withFlowLock("switch-account", async () => {
    const reg = loadAccountsRegistry();
    const target = reg.accounts.find((a) => a.id === accountId);
    if (!target) {
      throw new Error(`Akun dengan ID "${accountId}" tidak ditemukan.`);
    }

    reg.active_account_id = accountId;
    reg.generation = (reg.generation || 1) + 1;
    target.last_active = Date.now();
    saveAccountsRegistry(reg);
    setProfileDir(target.profile_dir);

    engineLog("accounts", `Switching to account ${accountId} (${target.label}), generation=${reg.generation}`);

    if (isMockMode()) {
      if (target.credits !== undefined) {
        process.env.FLOW_MOCK_CREDITS = String(target.credits);
      }
      const state = await probeSession(accountId, { detailed: false });
      const updated = getActiveAccount() || target;
      return { account: updated, state, generation: reg.generation };
    }

    const shouldLaunch = opts?.launch !== false;
    // Default visible=true so Flow composer and settings triggers render properly
    const visible = opts?.visible !== false && process.env.FLOW_HEADLESS !== "1" && process.env.FLOW_HEADLESS !== "true";
    if (shouldLaunch) {
      await ensureChromeForProfile(target.profile_dir, {
        visible,
        openUrl: inEnglish(FLOW_URL),
        bringToFront: visible,
      });
    } else {
      const runDir = await runningProfileDir();
      if (runDir && normalizeProfilePath(runDir) !== normalizeProfilePath(target.profile_dir)) {
        await shutdownChrome();
      }
    }

    const needDetailed =
      target.credits === undefined ||
      !target.credits_checked_at ||
      Date.now() - target.credits_checked_at >= 5 * 60 * 1000;
    const state = await probeSession(accountId, {
      detailed: needDetailed,
      forceDetailed: target.credits === undefined,
    });
    const latestReg = loadAccountsRegistry();
    const updated = latestReg.accounts.find((a) => a.id === accountId) || target;
    return { account: updated, state, generation: latestReg.generation };
  });
}

export async function refreshAccountCredits(opts?: {
  accountId?: string;
  all?: boolean;
  visible?: boolean;
}): Promise<{ accounts: FlowAccount[]; active_account_id: string | null; generation: number }> {
  return withFlowLock("refresh-credits", async () => {
    const reg = loadAccountsRegistry();
    if (isMockMode()) {
      const now = Date.now();
      for (const acc of reg.accounts) {
        if (opts?.all || !opts?.accountId || acc.id === opts.accountId) {
          if (acc.credits === undefined) acc.credits = 100;
          acc.credits_checked_at = now;
        }
      }
      saveAccountsRegistry(reg);
      return {
        accounts: reg.accounts,
        active_account_id: reg.active_account_id,
        generation: reg.generation,
      };
    }

    const originalActiveId = reg.active_account_id;
    const targets = opts?.all
      ? reg.accounts.filter((a) => a.status !== "signed_out")
      : reg.accounts.filter((a) => a.id === (opts?.accountId || reg.active_account_id));

    for (const acc of targets) {
      try {
        await ensureChromeForProfile(acc.profile_dir, {
          visible: opts?.visible,
          openUrl: inEnglish(FLOW_URL),
        });
        await probeSession(acc.id, { detailed: true, forceDetailed: true });
      } catch (err) {
        engineLog("accounts", `refreshAccountCredits error for ${acc.id}: ${(err as Error).message}`);
      }
    }

    const latestReg = loadAccountsRegistry();
    const activeAcc = originalActiveId
      ? latestReg.accounts.find((a) => a.id === originalActiveId)
      : undefined;
    if (activeAcc) {
      setProfileDir(activeAcc.profile_dir);
      const runDir = await runningProfileDir();
      if (runDir && normalizeProfilePath(runDir) !== normalizeProfilePath(activeAcc.profile_dir)) {
        await ensureChromeForProfile(activeAcc.profile_dir, {
          visible: opts?.visible,
          openUrl: inEnglish(FLOW_URL),
        }).catch(() => {});
      }
    }

    return {
      accounts: latestReg.accounts,
      active_account_id: latestReg.active_account_id,
      generation: latestReg.generation,
    };
  });
}

export async function renameAccount(accountId: string, newLabel: string): Promise<FlowAccount> {
  const trimmed = (newLabel || "").trim();
  if (!trimmed) {
    throw new Error("Nama/label akun tidak boleh kosong.");
  }
  const reg = loadAccountsRegistry();
  const target = reg.accounts.find((a) => a.id === accountId);
  if (!target) throw new Error(`Akun "${accountId}" tidak ditemukan.`);
  target.label = trimmed;
  target.name = trimmed;
  saveAccountsRegistry(reg);
  engineLog("accounts", `Renamed account ${accountId} -> "${trimmed}"`);
  return normalizeAccount(target);
}

export async function deleteAccount(accountId: string): Promise<{
  deleted_id: string;
  active_account_id: string | null;
  generation: number;
}> {
  return withFlowLock("delete-account", async () => {
    const reg = loadAccountsRegistry();
    const idx = reg.accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) throw new Error(`Akun "${accountId}" tidak ditemukan.`);

    const target = reg.accounts[idx];

    if (!isMockMode()) {
      const runDir = await runningProfileDir();
      const isTargetRunning =
        (runDir && normalizeProfilePath(runDir) === normalizeProfilePath(target.profile_dir)) ||
        (reg.active_account_id === accountId && (await isChromeRunning()));
      if (isTargetRunning) {
        await shutdownChrome();
      }
    }

    reg.accounts.splice(idx, 1);
    reg.generation = (reg.generation || 1) + 1;

    if (reg.active_account_id === accountId) {
      reg.active_account_id = reg.accounts[0]?.id ?? null;
    }

    saveAccountsRegistry(reg);
    syncActiveProfileToChrome(reg);

    if (!isMockMode() && target.profile_dir && existsSync(target.profile_dir)) {
      try {
        moveToBin(target.profile_dir);
        engineLog("accounts", `Moved profile ${target.profile_dir} for deleted account ${accountId} to Trash`);
      } catch {
        try {
          rmSync(target.profile_dir, { recursive: true, force: true });
          engineLog("accounts", `Removed profile ${target.profile_dir} for deleted account ${accountId} via rmSync fallback`);
        } catch (rmErr) {
          engineLog("accounts", `Warning: failed to remove ${target.profile_dir}: ${(rmErr as Error).message}`);
        }
      }
    }

    engineLog(
      "accounts",
      `Deleted account ${accountId} (${target.label}), active_account_id=${reg.active_account_id ?? "null"}, generation=${reg.generation}`,
    );

    return {
      deleted_id: accountId,
      active_account_id: reg.active_account_id,
      generation: reg.generation,
    };
  });
}

export async function ensureActiveAccountReady(): Promise<FlowAccount> {
  const reg = loadAccountsRegistry();
  const active = reg.active_account_id ? reg.accounts.find((a) => a.id === reg.active_account_id) : undefined;
  if (!active) {
    const err = new Error("Belum ada akun Google Flow yang aktif. Silakan tambahkan dan login akun Google Flow terlebih dahulu.") as Error & { code?: string };
    err.code = "NO_ACTIVE_ACCOUNT";
    throw err;
  }

  if (active.status !== "signed_in") {
    const probe = await probeSession(active.id, { detailed: false }).catch(() => null);
    const refreshed = getActiveAccount();
    if (!probe?.signedIn && refreshed?.status !== "signed_in") {
      const err = new Error(
        `Akun Google Flow "${active.label}" belum login. Silakan klik Login pada menu akun terlebih dahulu.`,
      ) as Error & { code?: string };
      err.code = "ACCOUNT_NOT_SIGNED_IN";
      throw err;
    }
    if (refreshed) return refreshed;
  }

  return active;
}

export async function updateActiveAccountState(patch: {
  credits?: number;
  signed_in?: boolean;
  status?: AccountStatus;
  plan?: string;
  email?: string;
}): Promise<FlowAccount | undefined> {
  const reg = loadAccountsRegistry();
  if (!reg.active_account_id) return undefined;
  const status: AccountStatus | undefined =
    patch.status !== undefined
      ? patch.status
      : patch.signed_in === true
        ? "signed_in"
        : patch.signed_in === false
          ? "signed_out"
          : undefined;
  const updated = recordProbe(reg.active_account_id, reg.generation, {
    status,
    credits: patch.credits,
    plan: patch.plan,
    email: patch.email,
  });
  return updated ?? undefined;
}

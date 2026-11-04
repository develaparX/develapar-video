import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, PROFILE_DIR, applyStoredCookiesIfNeeded, disconnectBrowser, setProfileDir } from "./chrome.js";
import { getFlowState, type FlowState } from "./flow.js";

export interface FlowAccount {
  id: string;
  name: string;
  email?: string;
  credits?: number;
  signed_in?: boolean;
  plan?: string;
  profile_dir: string;
  storage_state?: { cookies?: any[]; origins?: any[] };
  created_at: number;
  last_active: number;
}

export interface AccountsRegistry {
  active_account_id: string;
  accounts: FlowAccount[];
}

const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const MOCK_ACCOUNTS_FILE = join(HOME_DIR, "accounts.mock.json");
export const PROFILES_BASE_DIR = join(HOME_DIR, "profiles");

let activeProfileDirOverride: string | null = null;

function isMockMode(): boolean {
  return process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true";
}

function getAccountsFilePath(): string {
  return isMockMode() ? MOCK_ACCOUNTS_FILE : ACCOUNTS_FILE;
}

function syncActiveProfileToChrome(reg: AccountsRegistry): void {
  if (activeProfileDirOverride) {
    setProfileDir(activeProfileDirOverride);
    return;
  }
  const active = reg.accounts.find((a) => a.id === reg.active_account_id) || reg.accounts[0];
  setProfileDir(active ? active.profile_dir : PROFILE_DIR);
}

export function getActiveProfileDir(): string {
  if (activeProfileDirOverride) return activeProfileDirOverride;
  const reg = loadAccountsRegistry();
  const active = reg.accounts.find((a) => a.id === reg.active_account_id);
  return active ? active.profile_dir : PROFILE_DIR;
}

const POLLUTED_MOCK_IDS = new Set(["acc_backup_1", "acc_backup_2"]);
const POLLUTED_MOCK_EMAILS = new Set(["arfi***@gmail.com", "develapar***@gmail.com", "studio***@gmail.com"]);

export function loadAccountsRegistry(): AccountsRegistry {
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(PROFILES_BASE_DIR, { recursive: true });

  if (isMockMode()) {
    // In mock mode, use MOCK_ACCOUNTS_FILE so real accounts.json is never polluted
    if (existsSync(MOCK_ACCOUNTS_FILE)) {
      try {
        const raw = readFileSync(MOCK_ACCOUNTS_FILE, "utf8");
        const parsed = JSON.parse(raw) as AccountsRegistry;
        if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          syncActiveProfileToChrome(parsed);
          return parsed;
        }
      } catch {}
    }
    const mockRegistry: AccountsRegistry = {
      active_account_id: "default",
      accounts: [
        {
          id: "default",
          name: "Akun Utama",
          email: "arfi***@gmail.com",
          credits: process.env.FLOW_MOCK_CREDITS !== undefined ? Number(process.env.FLOW_MOCK_CREDITS) : 45,
          signed_in: true,
          profile_dir: PROFILE_DIR,
          created_at: Date.now() - 86400000,
          last_active: Date.now(),
        },
        {
          id: "acc_backup_1",
          name: "Akun Cadangan 1",
          email: "develapar***@gmail.com",
          credits: 150,
          signed_in: true,
          profile_dir: join(PROFILES_BASE_DIR, "acc_backup_1"),
          created_at: Date.now() - 43200000,
          last_active: Date.now() - 3600000,
        },
        {
          id: "acc_backup_2",
          name: "Akun Cadangan 2",
          email: "studio***@gmail.com",
          credits: 80,
          signed_in: true,
          profile_dir: join(PROFILES_BASE_DIR, "acc_backup_2"),
          created_at: Date.now() - 21600000,
          last_active: Date.now() - 7200000,
        },
      ],
    };
    saveAccountsRegistry(mockRegistry);
    syncActiveProfileToChrome(mockRegistry);
    return mockRegistry;
  }

  if (existsSync(ACCOUNTS_FILE)) {
    try {
      const raw = readFileSync(ACCOUNTS_FILE, "utf8");
      const parsed = JSON.parse(raw) as AccountsRegistry;
      if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
        let sanitized = false;
        const cleanedAccounts = parsed.accounts.filter((acc) => {
          if (acc.id !== "default") {
            if (
              POLLUTED_MOCK_IDS.has(acc.id) ||
              (acc.email && POLLUTED_MOCK_EMAILS.has(acc.email)) ||
              acc.name === "Akun VIP Studio"
            ) {
              sanitized = true;
              return false;
            }
          }
          return true;
        });

        for (const acc of cleanedAccounts) {
          if (acc.id === "default") {
            if (acc.email === "arfi***@gmail.com" || acc.credits === 45) {
              acc.email = undefined;
              acc.credits = undefined;
              acc.signed_in = false;
              acc.plan = undefined;
              sanitized = true;
            }
          }
        }

        if (cleanedAccounts.length > 0) {
          parsed.accounts = cleanedAccounts;
          if (!parsed.accounts.some((a) => a.id === parsed.active_account_id)) {
            parsed.active_account_id = parsed.accounts[0].id;
            sanitized = true;
          }
          if (sanitized) {
            saveAccountsRegistry(parsed);
          }
          syncActiveProfileToChrome(parsed);
          return parsed;
        }
      }
    } catch {}
  }

  // Initial registry bootstrap: wrap existing default profile
  const defaultAcc: FlowAccount = {
    id: "default",
    name: "Akun Utama",
    email: undefined,
    credits: undefined,
    signed_in: false,
    profile_dir: PROFILE_DIR,
    created_at: Date.now(),
    last_active: Date.now(),
  };

  const initial: AccountsRegistry = {
    active_account_id: "default",
    accounts: [defaultAcc],
  };

  saveAccountsRegistry(initial);
  syncActiveProfileToChrome(initial);
  return initial;
}

export function saveAccountsRegistry(reg: AccountsRegistry): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(getAccountsFilePath(), JSON.stringify(reg, null, 2), "utf8");
}

export function getActiveAccount(): FlowAccount {
  const reg = loadAccountsRegistry();
  const acc = reg.accounts.find((a) => a.id === reg.active_account_id);
  return acc || reg.accounts[0];
}

export function listAccounts(): FlowAccount[] {
  const reg = loadAccountsRegistry();
  return reg.accounts;
}

export async function createAccount(name?: string): Promise<FlowAccount> {
  const reg = loadAccountsRegistry();
  const id = `acc_${Date.now()}`;
  const accName = name && name.trim() ? name.trim() : `Akun ${reg.accounts.length + 1}`;
  const profileDir = join(PROFILES_BASE_DIR, id);
  mkdirSync(profileDir, { recursive: true });

  const newAcc: FlowAccount = {
    id,
    name: accName,
    credits: isMockMode() ? 100 : undefined,
    signed_in: isMockMode() ? true : false,
    profile_dir: profileDir,
    created_at: Date.now(),
    last_active: Date.now(),
  };

  reg.accounts.push(newAcc);
  saveAccountsRegistry(reg);

  // Automatically switch to the newly created account so user can log in
  await switchAccount(id);
  return newAcc;
}

export async function switchAccount(accountId: string): Promise<{ account: FlowAccount; state?: FlowState }> {
  const reg = loadAccountsRegistry();
  const target = reg.accounts.find((a) => a.id === accountId);
  if (!target) {
    throw new Error(`Akun dengan ID "${accountId}" tidak ditemukan.`);
  }

  reg.active_account_id = accountId;
  target.last_active = Date.now();
  saveAccountsRegistry(reg);
  activeProfileDirOverride = target.profile_dir;
  setProfileDir(target.profile_dir);

  if (isMockMode()) {
    // In mock mode, update credits from mock account
    if (target.credits !== undefined) {
      process.env.FLOW_MOCK_CREDITS = String(target.credits);
    }
    const state = await getFlowState(true).catch(() => getFlowState());
    return { account: target, state };
  }

  // Live CDP switch: disconnect current browser and relaunch targeting new profile
  await disconnectBrowser();
  let state = await getFlowState(true).catch(() => getFlowState());

  if (target.storage_state?.cookies?.length) {
    await applyStoredCookiesIfNeeded(target.storage_state.cookies);
    if (!state.signedIn) {
      state = await getFlowState(true).catch(() => state);
    }
  }

  target.signed_in = state.signedIn;
  if (!state.signedIn) {
    target.credits = undefined;
    target.plan = undefined;
  } else {
    if (state.credits_remaining !== undefined) {
      target.credits = state.credits_remaining;
    }
    if (state.plan) {
      target.plan = state.plan;
    }
  }
  saveAccountsRegistry(reg);

  return { account: target, state };
}

export async function renameAccount(accountId: string, newName: string): Promise<void> {
  const reg = loadAccountsRegistry();
  const target = reg.accounts.find((a) => a.id === accountId);
  if (!target) throw new Error(`Akun "${accountId}" tidak ditemukan.`);
  target.name = newName.trim();
  saveAccountsRegistry(reg);
}

export async function deleteAccount(accountId: string): Promise<void> {
  const reg = loadAccountsRegistry();
  if (reg.accounts.length <= 1) {
    throw new Error("Tidak dapat menghapus satu-satunya akun yang tersisa.");
  }

  const idx = reg.accounts.findIndex((a) => a.id === accountId);
  if (idx === -1) throw new Error(`Akun "${accountId}" tidak ditemukan.`);

  reg.accounts.splice(idx, 1);

  if (reg.active_account_id === accountId) {
    // Switch to first remaining account
    const nextAcc = reg.accounts[0];
    reg.active_account_id = nextAcc.id;
    saveAccountsRegistry(reg);
    await switchAccount(nextAcc.id);
  } else {
    saveAccountsRegistry(reg);
  }
}

export async function updateActiveAccountState(patch: {
  credits?: number;
  signed_in?: boolean;
  plan?: string;
  email?: string;
  storage_state?: { cookies?: any[]; origins?: any[] };
}): Promise<FlowAccount | undefined> {
  const reg = loadAccountsRegistry();
  const active = reg.accounts.find((a) => a.id === reg.active_account_id) || reg.accounts[0];
  if (!active) return undefined;

  if (patch.signed_in !== undefined) {
    active.signed_in = patch.signed_in;
    if (patch.signed_in === false) {
      active.credits = undefined;
      active.plan = undefined;
    }
  }
  if (patch.credits !== undefined) {
    active.credits = patch.credits;
  }
  if (patch.plan !== undefined) {
    active.plan = patch.plan;
  }
  if (patch.email !== undefined) {
    active.email = patch.email;
  }
  if (patch.storage_state !== undefined) {
    active.storage_state = patch.storage_state;
  }
  active.last_active = Date.now();
  saveAccountsRegistry(reg);
  return active;
}

export async function updateActiveAccountCredits(credits: number): Promise<void> {
  await updateActiveAccountState({ credits, signed_in: true });
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, PROFILE_DIR, disconnectBrowser, setProfileDir } from "./chrome.js";
import { getFlowState, type FlowState } from "./flow.js";

export interface FlowAccount {
  id: string;
  name: string;
  email?: string;
  credits?: number;
  profile_dir: string;
  created_at: number;
  last_active: number;
}

export interface AccountsRegistry {
  active_account_id: string;
  accounts: FlowAccount[];
}

const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const PROFILES_BASE_DIR = join(HOME_DIR, "profiles");

let activeProfileDirOverride: string | null = null;

export function getActiveProfileDir(): string {
  if (activeProfileDirOverride) return activeProfileDirOverride;
  const reg = loadAccountsRegistry();
  const active = reg.accounts.find((a) => a.id === reg.active_account_id);
  return active ? active.profile_dir : PROFILE_DIR;
}

export function loadAccountsRegistry(): AccountsRegistry {
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(PROFILES_BASE_DIR, { recursive: true });

  if (process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") {
    // In mock mode, provide multi-account structure for testing
    if (existsSync(ACCOUNTS_FILE)) {
      try {
        const raw = readFileSync(ACCOUNTS_FILE, "utf8");
        return JSON.parse(raw) as AccountsRegistry;
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
          profile_dir: PROFILE_DIR,
          created_at: Date.now() - 86400000,
          last_active: Date.now(),
        },
        {
          id: "acc_backup_1",
          name: "Akun Cadangan 1",
          email: "develapar***@gmail.com",
          credits: 150,
          profile_dir: join(PROFILES_BASE_DIR, "acc_backup_1"),
          created_at: Date.now() - 43200000,
          last_active: Date.now() - 3600000,
        },
        {
          id: "acc_backup_2",
          name: "Akun Cadangan 2",
          email: "studio***@gmail.com",
          credits: 80,
          profile_dir: join(PROFILES_BASE_DIR, "acc_backup_2"),
          created_at: Date.now() - 21600000,
          last_active: Date.now() - 7200000,
        },
      ],
    };
    saveAccountsRegistry(mockRegistry);
    return mockRegistry;
  }

  if (existsSync(ACCOUNTS_FILE)) {
    try {
      const raw = readFileSync(ACCOUNTS_FILE, "utf8");
      const parsed = JSON.parse(raw) as AccountsRegistry;
      if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
        return parsed;
      }
    } catch {}
  }

  // Initial registry bootstrap: wrap existing default profile
  const defaultAcc: FlowAccount = {
    id: "default",
    name: "Akun Utama",
    email: undefined,
    credits: undefined,
    profile_dir: PROFILE_DIR,
    created_at: Date.now(),
    last_active: Date.now(),
  };

  const initial: AccountsRegistry = {
    active_account_id: "default",
    accounts: [defaultAcc],
  };

  saveAccountsRegistry(initial);
  return initial;
}

export function saveAccountsRegistry(reg: AccountsRegistry): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(reg, null, 2), "utf8");
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
    credits: process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true" ? 100 : undefined,
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

  if (process.env.FLOW_MOCK_RENDER === "1" || process.env.FLOW_MOCK_RENDER === "true") {
    // In mock mode, update credits from mock account
    if (target.credits !== undefined) {
      process.env.FLOW_MOCK_CREDITS = String(target.credits);
    }
    const state = await getFlowState(true).catch(() => getFlowState());
    return { account: target, state };
  }

  // Live CDP switch: disconnect current browser and relaunch targeting new profile
  await disconnectBrowser();
  const state = await getFlowState(true).catch(() => getFlowState());

  if (state.credits_remaining !== undefined) {
    target.credits = state.credits_remaining;
    saveAccountsRegistry(reg);
  }

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

export async function updateActiveAccountCredits(credits: number): Promise<void> {
  const reg = loadAccountsRegistry();
  const active = reg.accounts.find((a) => a.id === reg.active_account_id);
  if (active) {
    active.credits = credits;
    active.last_active = Date.now();
    saveAccountsRegistry(reg);
  }
}

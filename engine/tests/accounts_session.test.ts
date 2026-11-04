import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "flow-mcp-test-v0210-"));
process.env.FLOW_MCP_HOME = tempHome;
process.env.FLOW_MCP_CDP_PORT = "19449"; // Unused port so real Chrome is never touched

const {
  loadAccountsRegistry,
  saveAccountsRegistry,
  createAccount,
  renameAccount,
  deleteAccount,
  switchAccount,
  refreshAccountCredits,
  recordProbe,
  nextAccountLabel,
  PROFILES_BASE_DIR,
} = await import("../src/accounts.js");
const { withFlowLock, tryFlowLock, flowLockOwner } = await import("../src/flowlock.js");

describe("Accounts & Session v0.2.10", () => {
  beforeEach(() => {
    delete process.env.FLOW_MOCK_RENDER;
    rmSync(tempHome, { recursive: true, force: true });
    mkdirSync(tempHome, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("bootstraps empty v2 registry without default or Akun Utama", () => {
    const reg = loadAccountsRegistry();
    expect(reg.version).toBe(2);
    expect(reg.active_account_id).toBeNull();
    expect(reg.accounts).toEqual([]);
  });

  test("deduplicates ex-seed duplicate email account and restores credits from accounts.v1.backup.json", () => {
    // 1. Write v1 backup containing credits=118 and plan="PRO" for acc_user_1 and default
    const v1Backup = {
      active_account_id: "acc_user_1",
      accounts: [
        {
          id: "default",
          name: "Akun Utama",
          signed_in: true,
          created_at: 1793694332928,
          credits: 118,
          plan: "PRO",
        },
        {
          id: "acc_user_1",
          name: "akun 1",
          signed_in: true,
          created_at: 1793787059640,
          credits: 118,
          plan: "PRO",
        },
      ],
    };
    writeFileSync(join(tempHome, "accounts.v1.backup.json"), JSON.stringify(v1Backup, null, 2), "utf8");

    // 2. Write v2 accounts.json with both the ex-seed migrated account (label === email) and user custom account ("akun 1")
    const dupDir = join(PROFILES_BASE_DIR, "acc_seed_dup");
    const keptDir = join(PROFILES_BASE_DIR, "acc_user_1");
    mkdirSync(dupDir, { recursive: true });
    mkdirSync(keptDir, { recursive: true });

    const v2Raw = {
      version: 2,
      active_account_id: "acc_seed_dup",
      generation: 5,
      accounts: [
        {
          id: "acc_seed_dup",
          label: "rahvayana88@gmail.com",
          name: "rahvayana88@gmail.com",
          email: "rahvayana88@gmail.com",
          profile_dir: dupDir,
          status: "signed_in",
          signed_in: true,
          created_at: 1793694332928,
          last_active: 1793789262756,
        },
        {
          id: "acc_user_1",
          label: "akun 1",
          name: "akun 1",
          email: "rahvayana88@gmail.com",
          profile_dir: keptDir,
          status: "signed_in",
          signed_in: true,
          plan: "PRO",
          created_at: 1793787059640,
          last_active: 1793789290637,
        },
      ],
    };
    writeFileSync(join(tempHome, "accounts.json"), JSON.stringify(v2Raw, null, 2), "utf8");

    const reg = loadAccountsRegistry();
    expect(reg.accounts.length).toBe(1);
    expect(reg.accounts[0].id).toBe("acc_user_1");
    expect(reg.accounts[0].label).toBe("akun 1");
    expect(reg.accounts[0].credits).toBe(118);
    expect(reg.accounts[0].plan).toBe("PRO");
    expect(reg.active_account_id).toBe("acc_user_1");

    // Persisted on disk as well
    const persisted = JSON.parse(readFileSync(join(tempHome, "accounts.json"), "utf8"));
    expect(persisted.accounts.length).toBe(1);
    expect(persisted.accounts[0].id).toBe("acc_user_1");
    expect(persisted.accounts[0].credits).toBe(118);
  });

  test("recordProbe enforces generation guard, active account guard, and allowInactive option", () => {
    saveAccountsRegistry({
      version: 2,
      active_account_id: "acc_1",
      generation: 3,
      accounts: [
        {
          id: "acc_1",
          label: "Akun A",
          name: "Akun A",
          profile_dir: join(PROFILES_BASE_DIR, "acc_1"),
          status: "signed_in",
          signed_in: true,
          created_at: 1000,
          last_active: 1000,
        },
        {
          id: "acc_2",
          label: "Akun B",
          name: "Akun B",
          profile_dir: join(PROFILES_BASE_DIR, "acc_2"),
          status: "signed_in",
          signed_in: true,
          created_at: 1000,
          last_active: 1000,
        },
      ],
    });

    // Stale generation is dropped
    expect(recordProbe("acc_1", 2, { credits: 500 })).toBeNull();
    // Inactive account without allowInactive is dropped
    expect(recordProbe("acc_2", 3, { credits: 600 })).toBeNull();
    // Inactive account with allowInactive=true is recorded (used by refreshAccountCredits)
    const updatedInactive = recordProbe("acc_2", 3, { credits: 750, plan: "PRO" }, { allowInactive: true });
    expect(updatedInactive?.credits).toBe(750);
    expect(updatedInactive?.plan).toBe("PRO");
  });

  test("switchAccount, renameAccount, deleteAccount, and refreshAccountCredits work cleanly in mock mode", async () => {
    process.env.FLOW_MOCK_RENDER = "1";
    const reg0 = loadAccountsRegistry();
    expect(reg0.accounts.length).toBe(2);

    const added = await createAccount("Akun Kreatif");
    expect(added.label).toBe("Akun Kreatif");

    const renamed = await renameAccount(added.id, "Akun Utama Studio");
    expect(renamed.label).toBe("Akun Utama Studio");

    const switched = await switchAccount("acc_mock_b");
    expect(switched.account.id).toBe("acc_mock_b");
    expect(switched.state.signedIn).toBe(true);

    const refreshed = await refreshAccountCredits({ all: true });
    expect(refreshed.accounts.every((a) => typeof a.credits === "number")).toBe(true);

    const delRes = await deleteAccount(added.id);
    expect(delRes.deleted_id).toBe(added.id);
    expect(loadAccountsRegistry().accounts.some((a) => a.id === added.id)).toBe(false);
  });

  test("withFlowLock and tryFlowLock enforce mutual exclusion", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const p1 = withFlowLock("op1", async () => {
      order.push("op1-start");
      expect(flowLockOwner()).toBe("op1");
      // tryFlowLock from outside while locked should return null
      await firstGate;
      order.push("op1-end");
    });

    await new Promise((r) => setTimeout(r, 10));
    const tryRes = await tryFlowLock("heartbeat", async () => "should-not-run");
    expect(tryRes).toBeNull();

    const p2 = withFlowLock("op2", async () => {
      order.push("op2-start");
    });

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["op1-start", "op1-end", "op2-start"]);
  });

  test("nextAccountLabel picks first unused sequential label", () => {
    expect(nextAccountLabel([])).toBe("Akun A");
    expect(nextAccountLabel([{ label: "Akun A" }])).toBe("Akun B");
    expect(nextAccountLabel([{ label: "Akun A" }, { label: "Akun C" }])).toBe("Akun B");
  });
});

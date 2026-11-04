import { AsyncLocalStorage } from "node:async_hooks";

const lockContext = new AsyncLocalStorage<string>();

interface Waiter {
  owner: string;
  resolve: () => void;
}

let currentOwner: string | null = null;
const waitQueue: Waiter[] = [];

export function flowLockOwner(): string | null {
  return currentOwner;
}

export function isFlowLocked(): boolean {
  return currentOwner !== null;
}

function releaseLock(): void {
  const next = waitQueue.shift();
  if (next) {
    currentOwner = next.owner;
    next.resolve();
  } else {
    currentOwner = null;
  }
}

/**
 * Exclusive FIFO mutex for all Playwright / Chrome profile operations.
 * Re-entrant within the same async call chain via AsyncLocalStorage to avoid self-deadlock
 * (e.g. when runPipelineAsync enqueues a job into JobQueue and waits for it).
 */
export async function withFlowLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const inheritedOwner = lockContext.getStore();
  if (inheritedOwner) {
    return fn();
  }

  if (currentOwner !== null) {
    await new Promise<void>((resolve) => {
      waitQueue.push({ owner, resolve });
    });
  } else {
    currentOwner = owner;
  }

  try {
    return await lockContext.run(owner, fn);
  } finally {
    releaseLock();
  }
}

/**
 * Non-blocking lock acquisition for passive heartbeat / status probes.
 * Returns null immediately if the lock is currently held by another operation.
 */
export async function tryFlowLock<T>(owner: string, fn: () => Promise<T>): Promise<T | null> {
  const inheritedOwner = lockContext.getStore();
  if (inheritedOwner) {
    return fn();
  }

  if (currentOwner !== null) {
    return null;
  }

  currentOwner = owner;
  try {
    return await lockContext.run(owner, fn);
  } finally {
    releaseLock();
  }
}

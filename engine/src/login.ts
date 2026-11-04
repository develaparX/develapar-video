#!/usr/bin/env node
// One-time setup: opens the active dedicated Chrome profile on Flow so the user can sign in by hand.
import { createAccount, getActiveAccount, loadAccountsRegistry } from "./accounts.js";
import { getFlowPage, setProfileDir } from "./chrome.js";

loadAccountsRegistry();
let active = getActiveAccount();
if (!active) {
  active = await createAccount();
}
setProfileDir(active.profile_dir);
const page = await getFlowPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log(`Account: ${active.label} (${active.id})`);
console.log(`Profile: ${active.profile_dir}`);
console.log("Sign in to Google in that window, then open or create a Flow project. The session is kept for next time.");
process.exit(0);

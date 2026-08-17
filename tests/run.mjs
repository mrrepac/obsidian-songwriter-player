/**
 * Runs every suite and fails the process if any check did. Every suite runs
 * even after one fails — a red run should show everything that is wrong, not
 * just the first thing.
 */
import settings from "./settings.test.mjs";
import mediasession from "./mediasession.test.mjs";
import hotkeys from "./hotkeys.test.mjs";
import pickup from "./pickup.test.mjs";

const suites = [settings, mediasession, hotkeys, pickup];

let ok = true;
for (const run of suites) {
  try {
    const passed = await run();
    ok = passed && ok;
  } catch (e) {
    console.log(`\n  CRASH  ${e?.stack ?? e}`);
    ok = false;
  }
}

console.log(ok ? "\nall checks passed\n" : "\nsome checks failed\n");
process.exit(ok ? 0 : 1);

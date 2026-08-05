/**
 * The built-in bindings.
 *
 * Two commands on one combination is a failure that says nothing: Obsidian
 * shows a conflict deep in its settings and one of the two simply stops
 * answering. The table is small enough to read and easy enough to break — a
 * letter added without noticing its Russian twin already claimed the key, or a
 * keypad symbol that turns out to be the main row's under another name.
 */
import { browserGlobals, bundle, load, obsidianStub, suite } from "./harness.mjs";

const describe = (h) => `${[...h.modifiers].sort().join("+")}+${h.key}`;

export default async function run() {
  const s = suite("hotkeys — the built-in bindings");

  const exports = load(
    await bundle("src/main.ts", { ANALYSIS_WORKER_SOURCE: '""' }),
    { modules: { obsidian: obsidianStub() }, globals: browserGlobals() }
  );
  const table = exports.DEFAULT_HOTKEYS;

  s.check("the table ships", () => table && Object.keys(table).length > 0);

  // ---- no combination is claimed twice ----
  {
    const claimed = new Map();
    const clashes = [];
    for (const [command, hotkeys] of Object.entries(table)) {
      for (const hotkey of hotkeys) {
        const combo = describe(hotkey);
        if (claimed.has(combo)) clashes.push(`${combo}: ${claimed.get(combo)} and ${command}`);
        else claimed.set(combo, command);
      }
    }
    s.check("every combination belongs to one command", () => clashes.length === 0, clashes.join("; "));
    s.check("and there are enough of them to be worth a switch", () => claimed.size >= 20,
      `${claimed.size} combinations`);
  }

  // ---- every binding is shaped the way Obsidian expects ----
  {
    const malformed = [];
    for (const [command, hotkeys] of Object.entries(table)) {
      if (!Array.isArray(hotkeys) || hotkeys.length === 0) malformed.push(`${command}: no keys`);
      for (const hotkey of hotkeys ?? []) {
        if (!Array.isArray(hotkey?.modifiers) || hotkey.modifiers.length === 0) {
          malformed.push(`${command}: no modifier`);
        }
        // a bare key would fire while typing; every one of these is under Alt
        if (!hotkey?.key || typeof hotkey.key !== "string") malformed.push(`${command}: no key`);
      }
    }
    s.check("every binding has a modifier and a key", () => malformed.length === 0, malformed.join("; "));
  }

  // ---- the layouts stay in step ----
  // A letter binding without its Russian twin works until the moment the layout
  // is switched, which for these commands is most of the time.
  {
    const cyrillic = /[а-яё]/i;
    const lonely = [];
    for (const [command, hotkeys] of Object.entries(table)) {
      const latinLetters = hotkeys.filter((h) => /^[a-z]$/i.test(h.key));
      const twins = hotkeys.filter((h) => cyrillic.test(h.key));
      if (latinLetters.length > 0 && twins.length !== latinLetters.length) lonely.push(command);
    }
    s.check("every letter binding has its Russian twin", () => lonely.length === 0, lonely.join(", "));
  }

  return s.report();
}

/**
 * A test harness with no test framework in it.
 *
 * Obsidian plugins are awkward to test: the code only runs inside the app, and
 * the parts worth guarding — what survives a restart, what gets handed to the
 * operating system — are exactly the parts that touch it. So instead of mocking
 * the plugin, these tests bundle the real source the way it ships, run it with
 * a stub `obsidian` module, and drive it. What is under test is the built
 * artifact, not a copy of the logic.
 *
 * That keeps the dependency list at esbuild, which is already here to build the
 * plugin, and it means a test cannot quietly drift from what users install.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);

/**
 * Bundle a source file as the plugin ships it — CommonJS, `obsidian` left
 * external — and return the text.
 */
export async function bundle(entry, define = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "cjs",
    target: "es2016",
    external: ["obsidian"],
    logLevel: "warning",
    write: false,
    define
  });
  return result.outputFiles[0].text;
}

/**
 * Run a bundle and hand back its exports. `modules` intercepts require() so the
 * stub `obsidian` gets in; `globals` supplies the browser names the bundle
 * expects to find lying around.
 */
export function load(source, { modules = {}, globals = {} } = {}) {
  const names = Object.keys(globals);
  const module = { exports: {} };
  const require = (id) => (id in modules ? modules[id] : nodeRequire(id));
  const run = new Function(
    "require", "module", "exports", ...names,
    `${source}\nreturn module.exports;`
  );
  run(require, module, module.exports, ...names.map((name) => globals[name]));
  return module.exports;
}

/**
 * Just enough of the `obsidian` module for a bundle to finish loading: every
 * class the plugin extends has to be constructible, and moment has to answer,
 * because the i18n module picks the UI language the moment it is imported.
 */
export function obsidianStub(over = {}) {
  const Empty = class {};
  return {
    Plugin: class {},
    Events: class {
      on() { return {}; }
      trigger() {}
      offref() {}
    },
    Notice: class {},
    Platform: { isMobile: false, isDesktop: true, isDesktopApp: true },
    TFile: Empty,
    ItemView: Empty,
    PluginSettingTab: Empty,
    MarkdownView: Empty,
    Menu: Empty,
    Setting: Empty,
    WorkspaceLeaf: Empty,
    App: Empty,
    setIcon() {},
    moment: { locale: () => "en" },
    ...over
  };
}

/** The browser globals a bundle reaches for; none of them do real work here. */
export function browserGlobals(over = {}) {
  return {
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    document: {},
    activeDocument: {},
    navigator: {},
    Audio: class {},
    ...over
  };
}

export function suite(name) {
  const results = [];
  return {
    /**
     * `condition` is a function on purpose. When a bug removes the very field
     * a check reaches for, evaluating it throws — and an exception raised at
     * the call site would take the whole suite down and hide every other
     * result. Evaluated in here, it becomes one honest FAIL and the rest of
     * the suite still runs, which is what tells you how far the damage goes.
     */
    check(label, condition, note = "") {
      let pass = false;
      let thrown = "";
      try {
        pass = typeof condition === "function" ? !!condition() : !!condition;
      } catch (e) {
        thrown = `threw: ${e?.message ?? e}`;
      }
      results.push({ label, pass, note: thrown || note });
    },
    report() {
      console.log(`\n${name}`);
      for (const r of results) {
        console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.note ? `  — ${r.note}` : ""}`);
      }
      const failed = results.filter((r) => !r.pass).length;
      if (failed > 0) console.log(`  ${failed} of ${results.length} failed`);
      return failed === 0;
    }
  };
}

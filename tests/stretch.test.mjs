/**
 * Signalsmith Stretch survives the release build.
 *
 * The package hands the source text of its own functions to an AudioWorklet.
 * If esbuild lowers anything in them into a helper (`__publicField`,
 * `__async`, …), the helper stays behind in main.js, the worklet dies on a
 * ReferenceError and the stretcher never answers — transposing then hangs
 * silently. That happened with the template's es2016 target. A real audio
 * thread is not available here, so this checks the cause: built at the
 * release's own target, the stretcher's code calls no lowering helper.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_TARGET } from "../build-target.mjs";
import { suite } from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = /\b__(async|publicField|defNormalProp|privateAdd|privateGet|privateSet|privateMethod|spreadValues|spreadProps|objRest|pow|await|yieldStar|forAwait|superGet)\b/g;

export default async function run() {
  const s = suite("pitch shifting — Signalsmith in the release build");
  const lowered = async (target) => {
    const out = await esbuild.build({
      entryPoints: [path.join(root, "src/stretch.ts")], bundle: true, format: "cjs",
      target, write: false, logLevel: "silent"
    });
    return [...new Set(out.outputFiles[0].text.match(HELPERS) ?? [])];
  };

  const release = await lowered(MAIN_TARGET);
  s.check("the release target leaves the worklet code untouched", () => release.length === 0, release.join(", "));
  // the check itself has teeth: the old target does produce them
  const old = await lowered("es2016");
  s.check("and the old es2016 target would not", () => old.length > 0, old.join(", "));

  return s.report();
}

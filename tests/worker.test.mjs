/**
 * The analysis worker, run the way Obsidian runs it.
 *
 * Obsidian's workers are web workers that also have Node: `process`, `require`
 * and `Buffer` are all there. Under essentia that mattered — its loader took
 * the Node branch and every analysis died inside Obsidian while passing in a
 * browser. The detectors are plain JS now, but the environment is kept: this
 * builds the worker with the release's own build function, runs it with the
 * Node globals present, and measures a synthetic beat and a chord progression.
 */
import vm from "node:vm";
import { createRequire } from "node:module";
import { buildWorker } from "../worker-build.mjs";
import { suite } from "./harness.mjs";
import { drumLoop, chords } from "./signals.mjs";

export default async function run() {
  const s = suite("analysis worker — as Obsidian runs it");
  const code = await buildWorker();

  s.check("no require at all in the bundle", () => !/\brequire\(/.test(code));
  s.check("no WebAssembly left in the bundle", () => !/WebAssembly\./.test(code));

  let result = null;
  const self = { postMessage: (m) => { result = m; }, location: { href: "blob:app://obsidian.md/worker" } };
  const ctx = vm.createContext({
    self, location: self.location, importScripts() {},
    process, require: createRequire(import.meta.url), Buffer, __filename: "worker.js", __dirname: ".",
    atob, console, setTimeout, clearTimeout, TextDecoder, performance
  });
  ctx.globalThis = ctx;

  let loadError = "";
  try {
    vm.runInContext(code, ctx);
    self.onmessage({ data: { id: 1, tempoSamples: drumLoop(97, 11025), keySamples: chords(22050) } });
  } catch (e) {
    loadError = String(e?.message ?? e);
  }

  s.check("the worker loads and answers", () => !loadError && result !== null, loadError);
  s.check("the analysis succeeds", () => result.ok === true, result?.error ?? "");
  s.check("a 97 bpm beat measures 97", () => Math.abs(result.bpm - 97) < 0.1, `got ${result?.bpm}`);
  s.check("D minor chords read as D minor", () => result.key === "D" && result.scale === "minor",
    `got ${result?.key} ${result?.scale}`);

  return s.report();
}

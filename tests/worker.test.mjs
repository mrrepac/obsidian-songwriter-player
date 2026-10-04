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

  const results = [];
  const self = { postMessage: (m) => { results.push(m); }, location: { href: "blob:app://obsidian.md/worker" } };
  const ctx = vm.createContext({
    self, location: self.location, importScripts() {},
    process, require: createRequire(import.meta.url), Buffer, __filename: "worker.js", __dirname: ".",
    atob, console, setTimeout, clearTimeout, TextDecoder, performance
  });
  ctx.globalThis = ctx;

  let loadError = "";
  try {
    vm.runInContext(code, ctx);
    self.onmessage({ data: { id: 1, kind: "tempo", samples: drumLoop(97, 11025) } });
    self.onmessage({ data: { id: 2, kind: "key", samples: chords(22050) } });
  } catch (e) {
    loadError = String(e?.message ?? e);
  }

  const [tempo, key] = results;
  s.check("the worker loads and answers both kinds", () => !loadError && results.length === 2, loadError);
  s.check("both analyses succeed", () => tempo.ok && key.ok, tempo?.error ?? key?.error ?? "");
  s.check("a 97 bpm beat measures 97", () => Math.abs(tempo.bpm - 97) < 0.1, `got ${tempo?.bpm}`);
  s.check("D minor chords read as D minor", () => key.key === "D" && key.scale === "minor",
    `got ${key?.key} ${key?.scale}`);

  return s.report();
}

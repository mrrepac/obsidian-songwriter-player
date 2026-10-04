/**
 * The analysis worker, run the way Obsidian runs it.
 *
 * Obsidian's workers are web workers that also have Node: `process`, `require`
 * and `Buffer` are all there. essentia's Emscripten loader picks its branch by
 * looking for exactly those, so a worker that is fine in a browser can still
 * die inside Obsidian — a build after 1.8.0 did, on "path.dirname is not a
 * function", and nothing caught it until tracks stopped getting a tempo. This
 * builds the worker with the release's own build function, runs it in such an
 * environment, and measures a synthetic beat.
 */
import vm from "node:vm";
import { createRequire } from "node:module";
import { buildWorker } from "../worker-build.mjs";
import { suite } from "./harness.mjs";

const SR = 44100;

/** Ten seconds of a kick on every beat at `bpm`: a decaying 60 Hz thump. */
function clickTrack(bpm, seconds = 10) {
  const out = new Float32Array(SR * seconds);
  const every = Math.round((SR * 60) / bpm);
  for (let start = 0; start < out.length; start += every) {
    for (let i = 0; i < SR * 0.12 && start + i < out.length; i++) {
      out[start + i] = 0.8 * Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / (SR * 0.03));
    }
  }
  return out;
}

export default async function run() {
  const s = suite("analysis worker — as Obsidian runs it");
  const code = await buildWorker();

  s.check("no bare require of fs in the bundle", () => !/require\(["']fs["']\)/.test(code));

  let result = null;
  const self = { postMessage: (m) => { result = m; }, location: { href: "blob:app://obsidian.md/worker" } };
  const ctx = vm.createContext({
    self, location: self.location, importScripts() {},
    // the Node half of an Obsidian worker — what sent the loader astray
    process, require: createRequire(import.meta.url), Buffer, __filename: "worker.js", __dirname: ".",
    atob, console, WebAssembly, setTimeout, clearTimeout, TextDecoder, crypto: globalThis.crypto, performance
  });
  ctx.globalThis = ctx;

  let loadError = "";
  try {
    vm.runInContext(code, ctx);
    await new Promise((r) => setTimeout(r, 1500)); // the wasm instantiates asynchronously
    self.onmessage({ data: { id: 1, samples: clickTrack(120), sampleRate: SR, keyProfiles: ["edma"] } });
  } catch (e) {
    loadError = String(e?.message ?? e);
  }

  s.check("the worker loads and answers", () => !loadError && result !== null, loadError);
  s.check("the analysis succeeds", () => result.ok === true, result?.error ?? "");
  s.check("a 120 bpm beat measures 120", () => Math.abs(result.multifeature - 120) < 2,
    `got ${result?.multifeature}`);
  s.check("a key comes back", () => typeof result.keys?.[0]?.key === "string");

  return s.report();
}

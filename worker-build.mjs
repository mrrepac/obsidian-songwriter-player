import esbuild from "esbuild";
import { builtinModules } from "node:module";

/**
 * essentia's Emscripten loader carries a Node branch that reaches for fs,
 * path and crypto, and the bare require makes the plugin look like it reads
 * arbitrary files from disk. Obsidian's workers DO have Node, so the branch
 * would run there: the build defines `process` away, which sends the loader
 * down its plain web-worker path, and the empty stubs only keep the now
 * unreachable branch compiling without the requires in the bundle. The stubs
 * alone are not enough — a build after 1.8.0 had them without the define, and
 * inside Obsidian every analysis died on "path.dirname is not a function".
 * tests/worker.test.mjs runs the result the way Obsidian does.
 */
const NODE_STUBS = /^(node:)?(fs|path|crypto)$/;
const stubNodeModules = {
  name: "stub-node-modules",
  setup(build) {
    build.onResolve({ filter: NODE_STUBS }, args => ({ path: args.path, namespace: "node-stub" }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({ contents: "module.exports = {};" }));
  }
};

/**
 * The analysis worker is bundled first and injected into the plugin as a
 * string. Obsidian installs a single main.js, so the worker cannot ship as its
 * own file — and it must not run on the UI thread, because essentia's tempo
 * extractor blocks for seconds on a full track.
 */
export async function buildWorker() {
  const result = await esbuild.build({
    entryPoints: ["src/analysis-worker.ts"],
    bundle: true,
    plugins: [stubNodeModules],
    external: builtinModules.filter(m => !NODE_STUBS.test(m)),
    // no Node inside the worker as far as the loader can tell (see above)
    define: { process: "undefined" },
    format: "iife",
    target: "es2016",
    logLevel: "warning",
    write: false
  });
  return result.outputFiles[0].text;
}

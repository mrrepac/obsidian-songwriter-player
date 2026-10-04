import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The analysis worker is bundled first and injected into the plugin as a
 * string. Obsidian installs a single main.js, so the worker cannot ship as its
 * own file — and it must not run on the UI thread, because the tempo and key
 * networks run for seconds on a full track. The weights (models/*.bin) go in
 * with it through the binary loader. The worker is plain JS end to end: no
 * WebAssembly, no Node branch, the same code on desktop and mobile.
 * tests/worker.test.mjs runs the result the way Obsidian does.
 */
export async function buildWorker() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src/analysis-worker.ts")],
    bundle: true,
    loader: { ".bin": "binary" },
    format: "iife",
    target: "es2016",
    logLevel: "warning",
    write: false
  });
  return result.outputFiles[0].text;
}

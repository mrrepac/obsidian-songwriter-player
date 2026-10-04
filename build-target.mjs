/**
 * The language level of main.js.
 *
 * Signalsmith Stretch builds its AudioWorklet from the source text of its own
 * functions (Function.prototype.toString) and runs that text in the audio
 * thread. Anything esbuild lowers into a helper — `__publicField` for class
 * fields, `__async` for async functions — lives at the top of main.js, not in
 * that text, so the worklet dies on a ReferenceError and the stretcher never
 * answers. ES2022 leaves all of it native. Obsidian 1.7+ runs on a Chromium
 * that has had ES2022 for years. tests/stretch.test.mjs guards this.
 */
export const MAIN_TARGET = "es2022";

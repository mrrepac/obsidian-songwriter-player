/**
 * Tempo and key analysis, off the main thread.
 *
 * RhythmExtractor2013 is a synchronous wasm call that runs for seconds on a
 * full track — on the UI thread that freezes Obsidian outright, so everything
 * here happens in a worker. This file is bundled separately and inlined into
 * main.js as a string (see esbuild.config.mjs); the plugin starts it from a
 * Blob URL, which is why it must not import anything from the plugin itself.
 */
import * as WasmModule from "essentia.js/dist/essentia-wasm.umd.js";
import Essentia from "essentia.js/dist/essentia.js-core.umd.min.js";

/**
 * The emscripten glue exports the module differently depending on what the
 * environment looks like: it overwrites module.exports when it detects Node
 * (which Electron looks like) and exports it by name otherwise.
 */
function resolveWasm(): unknown {
  const m = WasmModule as unknown as { EssentiaWASM?: unknown; default?: unknown };
  return m.EssentiaWASM ?? m.default ?? m;
}

let essentia: Essentia | null = null;
function ensureEssentia(): Essentia {
  if (!essentia) essentia = new Essentia(resolveWasm());
  return essentia;
}

export interface AnalyseRequest {
  id: number;
  samples: Float32Array;
  /** must be 44100: RhythmExtractor2013 has no sample-rate parameter */
  sampleRate: number;
  keyProfiles: string[];
}

export interface AnalyseResponse {
  id: number;
  ok: boolean;
  error?: string;
  /** primary tempo estimate, picks the octave */
  multifeature?: number;
  /** independent estimate; half of the multifeature value flags the octave ambiguity */
  percival?: number;
  confidence?: number;
  beats?: Float32Array;
  keys?: Array<{ profile: string; key: string; scale: string; strength: number }>;
}

self.onmessage = (e: MessageEvent<AnalyseRequest>) => {
  const { id, samples, sampleRate, keyProfiles } = e.data;
  let vector: { delete(): void } | null = null;
  try {
    const es = ensureEssentia();
    vector = es.arrayToVector(samples);
    const signal = vector as never;

    const rhythm = es.RhythmExtractor2013(signal, 208, "multifeature", 40);
    const beats = es.vectorToArray(rhythm.ticks);
    const percival = es.PercivalBpmEstimator(signal, 1024, 2048, 128, 128, 210, 50, sampleRate);

    const keys = keyProfiles.map((profile) => {
      const k = es.KeyExtractor(
        signal, true, 4096, 4096, 12, 3500, 60, 25, 0.2, profile,
        sampleRate, 0.0001, 440, "cosine", "hann"
      );
      return { profile, key: k.key, scale: k.scale, strength: k.strength };
    });

    const response: AnalyseResponse = {
      id,
      ok: true,
      multifeature: rhythm.bpm,
      percival: percival.bpm,
      confidence: rhythm.confidence,
      beats,
      keys
    };
    (self as unknown as Worker).postMessage(response, [beats.buffer]);
  } catch (err) {
    const response: AnalyseResponse = { id, ok: false, error: String(err) };
    (self as unknown as Worker).postMessage(response);
  } finally {
    vector?.delete();
  }
};

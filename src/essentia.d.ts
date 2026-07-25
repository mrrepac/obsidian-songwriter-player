/**
 * Minimal typings for the two essentia.js builds we bundle.
 *
 * The package's main entry also pulls in the model wrapper, which needs
 * TensorFlow.js as a peer dependency — so we import the individual dist files
 * instead and describe just the algorithms this plugin calls.
 */

declare module "essentia.js/dist/essentia-wasm.umd.js" {
  /**
   * Emscripten module, already instantiated when the file is evaluated.
   *
   * Beware: the glue code overwrites `module.exports` with the module itself
   * when it detects Node (which is what Obsidian's Electron renderer looks
   * like), and only exports it by name elsewhere (mobile WebView). Resolve it
   * defensively — see wasmModule() in analysis.ts.
   */
  export const EssentiaWASM: unknown;
  const _default: unknown;
  export default _default;
}

declare module "essentia.js/dist/essentia.js-core.umd.min.js" {
  export interface EssentiaVector {
    delete(): void;
  }

  export interface RhythmResult {
    /** tempo estimate [bpm] */
    bpm: number;
    /** beat positions [s] */
    ticks: EssentiaVector;
    /** 0 (none) … 5.32 (highest); always 0 for the "degara" method */
    confidence: number;
    estimates: EssentiaVector;
    bpmIntervals: EssentiaVector;
  }

  export interface KeyResult {
    /** tonic, e.g. "Eb" */
    key: string;
    /** "major" | "minor" */
    scale: string;
    /** correlation of the winning profile, 0…1 */
    strength: number;
  }

  export default class Essentia {
    constructor(wasm: unknown, isDebug?: boolean);
    version: string;
    algorithmNames: string[];
    arrayToVector(array: Float32Array): EssentiaVector;
    vectorToArray(vector: EssentiaVector): Float32Array;
    delete(): void;
    shutdown(): void;
    RhythmExtractor2013(
      signal: EssentiaVector,
      maxTempo?: number,
      method?: "multifeature" | "degara",
      minTempo?: number
    ): RhythmResult;
    PercivalBpmEstimator(
      signal: EssentiaVector,
      frameSize?: number,
      frameSizeOSS?: number,
      hopSize?: number,
      hopSizeOSS?: number,
      maxBPM?: number,
      minBPM?: number,
      sampleRate?: number
    ): { bpm: number };
    KeyExtractor(
      audio: EssentiaVector,
      averageDetuningCorrection?: boolean,
      frameSize?: number,
      hopSize?: number,
      hpcpSize?: number,
      maxFrequency?: number,
      maximumSpectralPeaks?: number,
      minFrequency?: number,
      pcpThreshold?: number,
      profileType?: string,
      sampleRate?: number,
      spectralPeaksThreshold?: number,
      tuningFrequency?: number,
      weightType?: string,
      windowType?: string
    ): KeyResult;
  }
}

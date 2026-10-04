/**
 * Tempo and key analysis, off the main thread.
 *
 * TempoCNN and S-KEY run for seconds on a full track — on the UI thread that
 * would freeze Obsidian, so everything here happens in a worker. This file is
 * bundled separately and inlined into main.js as a string (see
 * worker-build.mjs); the plugin starts it from a Blob URL, which is why it
 * imports only the detectors and their weights, nothing from the plugin.
 */
import tempoModel from "../models/tempocnn.bin";
import keyModel from "../models/skey.bin";
import { readWeights, Weights } from "./detect/weights";
import { estimateTempo } from "./detect/tempo";
import { estimateKey } from "./detect/key";

export interface AnalyseRequest {
  id: number;
  /** mono at TEMPO_SR (11025 Hz) */
  tempoSamples: Float32Array;
  /** mono at KEY_SR (22050 Hz) */
  keySamples: Float32Array;
}

export interface AnalyseResponse {
  id: number;
  ok: boolean;
  error?: string;
  /** TempoCNN, refined against the onset envelope when that is conclusive */
  bpm?: number;
  /** 0…1, the height of the network's averaged distribution */
  tempoConfidence?: number;
  key?: string;
  scale?: "major" | "minor";
  scaleAlt?: "major" | "minor" | null;
  /** 0…1, S-KEY's probability for the winning key */
  keyStrength?: number;
}

let weights: { tempo: Weights; key: Weights } | null = null;

self.onmessage = (e: MessageEvent<AnalyseRequest>) => {
  const { id, tempoSamples, keySamples } = e.data;
  try {
    weights ??= { tempo: readWeights(tempoModel), key: readWeights(keyModel) };
    const tempo = estimateTempo(weights.tempo, tempoSamples);
    const key = estimateKey(weights.key, keySamples);
    const response: AnalyseResponse = {
      id,
      ok: true,
      bpm: tempo.bpm,
      tempoConfidence: tempo.confidence,
      key: key.key,
      scale: key.scale,
      scaleAlt: key.scaleAlt,
      keyStrength: key.strength
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: AnalyseResponse = { id, ok: false, error: String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};

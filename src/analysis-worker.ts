/**
 * Tempo or key analysis, off the main thread.
 *
 * TempoCNN and S-KEY run for seconds on a full track — on the UI thread that
 * would freeze Obsidian, so everything here happens in a worker. The two are
 * independent, so the plugin starts one worker for each and runs them side by
 * side (see musical.ts). This file is bundled separately and inlined into
 * main.js as a string (see worker-build.mjs); the plugin starts it from a
 * Blob URL, which is why it imports only the detectors and their weights.
 */
import tempoModel from "../models/tempocnn.bin";
import keyModel from "../models/skey.bin";
import { readWeights } from "./detect/weights";
import { estimateTempo } from "./detect/tempo";
import { estimateKey } from "./detect/key";

export type AnalyseRequest =
  /** mono at TEMPO_SR (11025 Hz) */
  | { id: number; kind: "tempo"; samples: Float32Array }
  /** mono at KEY_SR (22050 Hz) */
  | { id: number; kind: "key"; samples: Float32Array };

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

self.onmessage = (e: MessageEvent<AnalyseRequest>) => {
  const request = e.data;
  let response: AnalyseResponse;
  try {
    if (request.kind === "tempo") {
      const tempo = estimateTempo(readWeights(tempoModel), request.samples);
      response = { id: request.id, ok: true, bpm: tempo.bpm, tempoConfidence: tempo.confidence };
    } else {
      const key = estimateKey(readWeights(keyModel), request.samples);
      response = {
        id: request.id, ok: true,
        key: key.key, scale: key.scale, scaleAlt: key.scaleAlt, keyStrength: key.strength
      };
    }
  } catch (err) {
    response = { id: request.id, ok: false, error: String(err) };
  }
  (self as unknown as Worker).postMessage(response);
};

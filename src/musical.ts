import { App, TFile } from "obsidian";
import type { AnalyseRequest, AnalyseResponse } from "./analysis-worker";
import { TEMPO_SR } from "./detect/tempo";
import { KEY_SR } from "./detect/key";

/** Bundled at build time: the analysis worker as source (see worker-build.mjs). */
declare const ANALYSIS_WORKER_SOURCE: string;

/**
 * Tempo by TempoCNN, key by S-KEY — both ported from the originals and held to
 * them by tests/detect.test.mjs. They replaced essentia (RhythmExtractor2013
 * and five voting key profiles) in 1.10.0.
 */
export interface MusicalData {
  /** displayed tempo, folded into the preferred octave and rounded */
  bpm: number;
  key: string;
  scale: string;
  /** the other mode of the same tonic when S-KEY ranks it second */
  scaleAlt: string | null;
  /** S-KEY's probability for the winning key, 0…1 */
  keyStrength: number;
}

/**
 * The network picks a metric level, but which octave a beat "really" is in is
 * a matter of feel, so the preferred window decides; ×2 and ÷2 on the badge
 * override it per track. Production tempos are practically always whole
 * numbers, so a value close to one is snapped to it.
 */
function resolveTempo(raw: number, windowLow: number): number {
  if (!isFinite(raw) || raw <= 0) return 0;
  const bpm = Math.round(foldIntoWindow(raw, windowLow) * 100) / 100;
  return Math.abs(bpm - Math.round(bpm)) < 0.35 ? Math.round(bpm) : bpm;
}

/**
 * Fold a tempo into the preferred octave, e.g. [80, 159]: 160 becomes 80, 77
 * becomes 154. The window spans exactly one octave (low … low*2 − 1), so every
 * tempo maps to one value in it and the halving/doubling never oscillates.
 */
export function foldIntoWindow(bpm: number, low: number): number {
  if (!isFinite(bpm) || bpm <= 0 || low <= 0) return bpm;
  const high = low * 2;
  let value = bpm;
  while (value >= high) value /= 2;
  while (value < low) value *= 2;
  return value;
}

let workerUrl: string | null = null;
function ensureWorker(): Worker {
  if (!workerUrl) {
    const blob = new Blob([ANALYSIS_WORKER_SOURCE], { type: "text/javascript" });
    workerUrl = URL.createObjectURL(blob);
  }
  return new Worker(workerUrl);
}

let nextId = 1;

/** One measurement in its own worker; the worker is gone when it answers. */
async function runInWorker(request: AnalyseRequest): Promise<AnalyseResponse> {
  const worker = ensureWorker();
  try {
    return await new Promise<AnalyseResponse>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<AnalyseResponse>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || "analysis worker failed"));
      worker.postMessage(request, [request.samples.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Mono at the rate a network was trained on. The browser's decoder resamples
 * to the context's rate; the networks have no sample-rate parameter, so a
 * wrong rate would shift every tempo and key.
 */
async function decodeMono(raw: ArrayBuffer, sampleRate: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  // decodeAudioData detaches the buffer it is given, and the file is decoded twice
  const buf = await ctx.decodeAudioData(raw.slice(0));
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < buf.length; i++) mono[i] += data[i] / buf.numberOfChannels;
  }
  return mono;
}

/** Decode the file and measure its tempo and key. */
export async function analyseMusical(app: App, file: TFile, tempoWindowLow: number): Promise<MusicalData | null> {
  const raw = await app.vault.readBinary(file);
  const tempoSamples = await decodeMono(raw, TEMPO_SR);
  const keySamples = await decodeMono(raw, KEY_SR);

  // independent measurements: side by side, the track takes as long as the slower one
  const [tempo, key] = await Promise.all([
    runInWorker({ id: nextId++, kind: "tempo", samples: tempoSamples }),
    runInWorker({ id: nextId++, kind: "key", samples: keySamples })
  ]);
  if (!tempo.ok || tempo.bpm === undefined || !key.ok || !key.key || !key.scale) {
    console.warn("Songwriter: analysis failed", tempo.error ?? key.error);
    return null;
  }
  return {
    bpm: resolveTempo(tempo.bpm, tempoWindowLow),
    key: key.key,
    scale: key.scale,
    scaleAlt: key.scaleAlt ?? null,
    keyStrength: key.keyStrength ?? 0
  };
}

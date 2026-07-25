import { App, TFile } from "obsidian";
import type { AnalyseResponse } from "./analysis-worker";

/** Bundled at build time: the analysis worker as source (see esbuild.config.mjs). */
declare const ANALYSIS_WORKER_SOURCE: string;

/**
 * Both families of key profiles vote. Which family is "right" could not be
 * settled on the eight reference tracks — every profile named the same tonic
 * on all of them and only the mode was ever in dispute — so instead of picking
 * one, the disagreement is surfaced and the user's correction wins.
 */
export const KEY_PROFILES = ["edma", "bgate", "shaath", "temperley", "krumhansl"];

export interface MusicalData {
  /** displayed tempo, rounded */
  bpm: number;
  /** raw estimates, kept so the rounding rule can be revisited */
  bpmRaw: { multifeature: number; percival: number; confidence: number };
  key: string;
  scale: string;
  /** runner-up mode when the profiles split, e.g. "major" against "minor" */
  scaleAlt: string | null;
  /** how many profiles backed the winning key, out of KEY_PROFILES.length */
  keyVotes: number;
  /** beat positions in seconds — the grid the marker and loop can snap to */
  beats?: Float32Array;
}

/**
 * Tempo: the octave comes from RhythmExtractor2013 — checked against three
 * tracks whose tempo the user knows, and the upper reading was right every
 * time — while the number itself comes from Percival lifted into that octave.
 * That combination matters: on a track known to be 160, multifeature drifted
 * to 161.76 (which rounds to 162) whereas Percival gave 160.24.
 *
 * Percival's own octave is NOT used as a signal. It is not stable: the same
 * file measured 80.12 in a fresh essentia instance and 160.25 in a reused one.
 * Lifting cancels that out, but it means "the octave is uncertain" cannot be
 * inferred from it — so the UI simply offers ×2 and ÷2 at all times.
 */
function resolveTempo(multifeature: number, percival: number, windowLow: number): number {
  if (!isFinite(multifeature) || multifeature <= 0) return 0;
  let value = multifeature;
  if (isFinite(percival) && percival > 0) {
    const octave = Math.round(Math.log2(multifeature / percival));
    const lifted = percival * Math.pow(2, octave);
    if (Math.abs(lifted - multifeature) / multifeature < 0.05) value = lifted;
  }
  value = foldIntoWindow(value, windowLow);
  const bpm = Math.round(value * 100) / 100;
  // production tempos are practically always whole numbers
  return Math.abs(bpm - Math.round(bpm)) < 0.35 ? Math.round(bpm) : bpm;
}

/**
 * Fold a tempo into the preferred octave, e.g. [80, 159]: 160 becomes 80, 77
 * becomes 154. The window spans exactly one octave (low … low*2 − 1), so every
 * tempo maps to one value in it and the halving/doubling never oscillates.
 * Which octave a beat "really" is in is a matter of feel, so this is only the
 * default — ×2 and ÷2 on the badge override it per track.
 */
export function foldIntoWindow(bpm: number, low: number): number {
  if (!isFinite(bpm) || bpm <= 0 || low <= 0) return bpm;
  const high = low * 2;
  let value = bpm;
  while (value >= high) value /= 2;
  while (value < low) value *= 2;
  return value;
}

function resolveKey(votes: Array<{ key: string; scale: string; strength: number }>) {
  const tally = new Map<string, { count: number; strength: number }>();
  for (const v of votes) {
    const id = `${v.key} ${v.scale}`;
    const cur = tally.get(id) ?? { count: 0, strength: 0 };
    cur.count++;
    cur.strength += v.strength;
    tally.set(id, cur);
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].strength - a[1].strength
  );
  const [winner, winnerStats] = ranked[0];
  const [key, scale] = winner.split(" ");
  // only report a runner-up that shares the tonic — a different mode of the
  // same note is the disagreement worth showing; anything else is noise
  const runnerUp = ranked[1]?.[0].split(" ");
  const scaleAlt = runnerUp && runnerUp[0] === key ? runnerUp[1] : null;
  return { key, scale, scaleAlt, keyVotes: winnerStats.count };
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

/**
 * Decode the file and measure its tempo and key. Decoding happens at 44100 Hz
 * on purpose: RhythmExtractor2013 takes no sample rate and assumes it, so a
 * 48 kHz context would report a tempo off by about 9%.
 */
export async function analyseMusical(app: App, file: TFile, tempoWindowLow: number): Promise<MusicalData | null> {
  const raw = await app.vault.readBinary(file);
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC({ sampleRate: 44100 });
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(raw);
  } finally {
    void ctx.close();
  }

  const len = buf.length;
  const mono = new Float32Array(len);
  const chans = Math.min(buf.numberOfChannels, 2);
  for (let c = 0; c < chans; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chans;
  }

  const worker = ensureWorker();
  const id = nextId++;
  try {
    const result = await new Promise<AnalyseResponse>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<AnalyseResponse>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || "analysis worker failed"));
      worker.postMessage({ id, samples: mono, sampleRate: 44100, keyProfiles: KEY_PROFILES }, [mono.buffer]);
    });
    if (!result.ok || result.multifeature === undefined || !result.keys) {
      console.warn("Songwriter: analysis failed", result.error);
      return null;
    }
    const key = resolveKey(result.keys);
    return {
      bpm: resolveTempo(result.multifeature, result.percival ?? 0, tempoWindowLow),
      bpmRaw: {
        multifeature: result.multifeature,
        percival: result.percival ?? 0,
        confidence: result.confidence ?? 0
      },
      ...key,
      beats: result.beats
    };
  } finally {
    worker.terminate();
  }
}

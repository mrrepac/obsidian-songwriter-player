import { App, TFile } from "obsidian";

export const WAVE_BINS = 2000;

interface CacheEntry {
  mtime: number;
  promise: Promise<Float32Array | null>;
}

const cache = new Map<string, CacheEntry>();

/** Decode a file once and compute waveform peaks. Cached by path+mtime. */
export function analyzePeaks(app: App, file: TFile): Promise<Float32Array | null> {
  const hit = cache.get(file.path);
  if (hit && hit.mtime === file.stat.mtime) return hit.promise;
  const promise = doAnalyze(app, file);
  cache.set(file.path, { mtime: file.stat.mtime, promise });
  return promise;
}

async function doAnalyze(app: App, file: TFile): Promise<Float32Array | null> {
  let buf: AudioBuffer | null = null;
  try {
    const ab = await app.vault.readBinary(file);
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC();
    try {
      buf = await ctx.decodeAudioData(ab);
    } finally {
      ctx.close();
    }
  } catch (e) {
    console.warn("Songwriter: audio decode failed", e);
  }
  if (!buf) return null;
  return computePeaks(buf);
}

function computePeaks(buf: AudioBuffer): Float32Array {
  const peaks = new Float32Array(WAVE_BINS);
  const chans = Math.min(buf.numberOfChannels, 2);
  const len = buf.length;
  const step = len / WAVE_BINS;
  for (let c = 0; c < chans; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < WAVE_BINS; i++) {
      const from = Math.floor(i * step);
      const to = Math.min(len, Math.max(from + 1, Math.floor((i + 1) * step)));
      const inner = Math.max(1, Math.floor((to - from) / 256));
      let peak = 0;
      for (let j = from; j < to; j += inner) {
        const val = Math.abs(data[j]);
        if (val > peak) peak = val;
      }
      if (peak > peaks[i]) peaks[i] = peak;
    }
  }
  let max = 0;
  for (let i = 0; i < WAVE_BINS; i++) if (peaks[i] > max) max = peaks[i];
  if (max > 0) for (let i = 0; i < WAVE_BINS; i++) peaks[i] /= max;
  return peaks;
}

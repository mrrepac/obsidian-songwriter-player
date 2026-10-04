/**
 * Tempo by TempoCNN (deeptemp_k16, Hendrik Schreiber, AGPL-3.0), computed in
 * plain JS. A port of the engine in D:\reaperplug (engine/src/tempocnn_engine.py),
 * step for step: the same mel front end, the same sliding windows and
 * normaliser, the network, then the same comb refinement that turns the
 * network's whole-BPM classes into "112.4 or 112.5". tests/detect.test.mjs
 * holds it to that engine's own output on real tracks.
 *
 * Input is mono at 11025 Hz. No Obsidian imports: runs in the worker.
 */
import type { Weights } from "./weights";

export const TEMPO_SR = 11025;
const N_FFT = 1024;
const HOP = 512;
const N_MELS = 40;
const FMIN = 20;
const FMAX = 5000;
const WINDOW_FRAMES = 256;
const WINDOW_HOP = 128;
const BPM_OFFSET = 30;

const REFINE_BAND = 0.06;
const REFINE_STEP = 0.02;
const REFINE_HARMONICS = [1, 0.5, 1 / 3, 0.25];
const REFINE_MIN_PROMINENCE = 1.25;
const REFINE_MIN_DOMINANCE = 1.15;
const MIN_REFINE_SECONDS = 4;
const MIN_BPM = 20;
const MAX_BPM = 640;

export interface TempoResult {
  /** refined when the onset envelope allows it, the network's own value otherwise */
  bpm: number;
  bpmCnn: number;
  /** height of the averaged distribution's peak, 0…1 */
  confidence: number;
  refined: boolean;
  /** averaged class distribution, class i = i + 30 BPM (kept for the tests) */
  averaged: Float64Array;
  melSum: number;
}

// --- mel spectrogram (librosa defaults: Slaney scale and norm, periodic Hann)

function hzToMel(f: number): number {
  const fSp = 200 / 3;
  if (f < 1000) return f / fSp;
  return 1000 / fSp + Math.log(f / 1000) / (Math.log(6.4) / 27);
}

function melToHz(m: number): number {
  const fSp = 200 / 3;
  const minLogMel = 1000 / fSp;
  if (m < minLogMel) return fSp * m;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (m - minLogMel));
}

let filterbank: Float32Array[] | null = null;
function melFilterbank(): Float32Array[] {
  if (filterbank) return filterbank;
  const bins = N_FFT / 2 + 1;
  const fftFreqs = Array.from({ length: bins }, (_, i) => (i * TEMPO_SR) / N_FFT);
  const lo = hzToMel(FMIN);
  const hi = hzToMel(FMAX);
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)));
  filterbank = [];
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float32Array(bins);
    const area = 2 / (edges[m + 2] - edges[m]);
    for (let k = 0; k < bins; k++) {
      const lower = -(edges[m] - fftFreqs[k]) / (edges[m + 1] - edges[m]);
      const upper = (edges[m + 2] - fftFreqs[k]) / (edges[m + 2] - edges[m + 1]);
      // float32 weights scaled in float32, as numpy does with weights *= area
      row[k] = Math.fround(Math.fround(Math.max(0, Math.min(lower, upper))) * area);
    }
    filterbank.push(row);
  }
  return filterbank;
}

/** In-place radix-2 FFT on separate real/imaginary arrays. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** [band][frame], power 1 (magnitudes), centred frames with zero padding. */
export function melSpectrogram(samples: Float32Array): Float32Array[] {
  const pad = N_FFT / 2;
  const paddedLength = samples.length + 2 * pad;
  const frames = 1 + Math.floor((paddedLength - N_FFT) / HOP);
  if (frames < 1) throw new Error("audio too short to analyse");
  const fb = melFilterbank();
  const bins = N_FFT / 2 + 1;
  const window = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
  const mel = Array.from({ length: N_MELS }, () => new Float32Array(frames));
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const mag = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    const origin = t * HOP - pad;
    for (let i = 0; i < N_FFT; i++) {
      const s = origin + i;
      re[i] = s >= 0 && s < samples.length ? window[i] * samples[s] : 0;
      im[i] = 0;
    }
    fft(re, im);
    // librosa casts the spectrum to complex64 before taking the magnitude
    for (let k = 0; k < bins; k++) mag[k] = Math.fround(Math.hypot(Math.fround(re[k]), Math.fround(im[k])));
    for (let m = 0; m < N_MELS; m++) {
      const row = fb[m];
      let sum = 0;
      for (let k = 0; k < bins; k++) if (row[k] !== 0) sum += row[k] * mag[k];
      mel[m][t] = sum;
    }
  }
  return mel;
}

// --- the network

interface Layer { op: string; name?: string; h?: number; w?: number }

/** One window through the chain. Activations are [channel][row][column]. */
function forward(weights: Weights, input: Float32Array, rows: number, cols: number): Float64Array {
  let x = input;
  let channels = 1;
  let h = rows;
  let w = cols;
  for (const layer of weights.header.layers as Layer[]) {
    if (layer.op === "conv") {
      const kernel = weights.get(`${layer.name}.w`);
      const bias = weights.get(`${layer.name}.b`).data;
      const [outC, inC, , k] = kernel.shape;
      const kw = kernel.data;
      const half = (k - 1) >> 1;
      const plane = h * w;
      const out = new Float32Array(outC * plane);
      const acc = new Float64Array(plane);
      for (let o = 0; o < outC; o++) {
        acc.fill(bias[o]);
        for (let i = 0; i < inC; i++) {
          const src = i * plane;
          for (let tap = 0; tap < k; tap++) {
            const weight = kw[((o * inC + i) * k) + tap];
            if (weight === 0) continue;
            const shift = tap - half;
            for (let r = 0; r < h; r++) {
              const row = r * w;
              const from = Math.max(0, -shift);
              const to = Math.min(w, w - shift);
              for (let c = from; c < to; c++) acc[row + c] += weight * x[src + row + c + shift];
            }
          }
        }
        out.set(acc, o * plane);
      }
      x = out;
      channels = outC;
    } else if (layer.op === "relu") {
      for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
    } else if (layer.op === "mul" || layer.op === "add") {
      const v = weights.get(layer.name as string).data;
      const plane = h * w;
      for (let c = 0; c < channels; c++) {
        const f = v[c];
        const base = c * plane;
        if (layer.op === "mul") for (let i = 0; i < plane; i++) x[base + i] *= f;
        else for (let i = 0; i < plane; i++) x[base + i] += f;
      }
    } else if (layer.op === "maxpool") {
      const ph = layer.h as number;
      const pw = layer.w as number;
      const oh = Math.floor(h / ph);
      const ow = Math.floor(w / pw);
      const out = new Float32Array(channels * oh * ow);
      for (let c = 0; c < channels; c++) {
        for (let r = 0; r < oh; r++) {
          for (let q = 0; q < ow; q++) {
            let best = -Infinity;
            for (let a = 0; a < ph; a++) {
              for (let b = 0; b < pw; b++) {
                const v = x[c * h * w + (r * ph + a) * w + q * pw + b];
                if (v > best) best = v;
              }
            }
            out[(c * oh + r) * ow + q] = best;
          }
        }
      }
      x = out;
      h = oh;
      w = ow;
    } else if (layer.op === "gap") {
      const plane = h * w;
      const logits = new Float64Array(channels);
      for (let c = 0; c < channels; c++) {
        let s = 0;
        for (let i = 0; i < plane; i++) s += x[c * plane + i];
        logits[c] = s / plane;
      }
      // softmax
      const max = Math.max(...logits);
      let total = 0;
      for (let c = 0; c < channels; c++) total += (logits[c] = Math.exp(logits[c] - max));
      for (let c = 0; c < channels; c++) logits[c] /= total;
      return logits;
    } else {
      throw new Error(`unknown layer ${layer.op}`);
    }
  }
  throw new Error("network ended without pooling");
}

// --- helpers shared with the refinement

function quadInterpolArgmax(y: ArrayLike<number>, x: number): [number, number] {
  if (x === 0 || x === y.length - 1) return [x, y[x]];
  const y0 = y[x - 1];
  const y1 = y[x];
  const y2 = y[x + 1];
  const a = (y0 - 2 * y1 + y2) / 2;
  const b = (y2 - y0) / 2;
  if (a === 0) return [x, y1];
  return [x - b / (2 * a), y1 - (b * b) / (4 * a)];
}

function argmax(y: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < y.length; i++) if (y[i] > y[best]) best = i;
  return best;
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- fine refinement against the onset envelope

function onsetEnvelope(mel: Float32Array[]): Float64Array {
  const frames = mel[0].length;
  if (frames - 1 < 8) return new Float64Array(0);
  const flux = new Float64Array(frames - 1);
  for (const band of mel) {
    let prev = 20 * Math.log10(Math.max(band[0], 1e-10));
    for (let t = 1; t < frames; t++) {
      const cur = 20 * Math.log10(Math.max(band[t], 1e-10));
      if (cur > prev) flux[t - 1] += cur - prev;
      prev = cur;
    }
  }
  let mean = 0;
  for (const v of flux) mean += v;
  mean /= flux.length;
  const n = flux.length;
  for (let t = 0; t < n; t++) flux[t] = (flux[t] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / n));
  return flux;
}

function combScores(envelope: Float64Array, bpms: Float64Array, fps: number): Float64Array {
  const scores = new Float64Array(bpms.length);
  let scale = 0;
  for (const v of envelope) scale += Math.abs(v);
  if (scale === 0) scale = 1;
  for (let h = 1; h <= REFINE_HARMONICS.length; h++) {
    const weight = REFINE_HARMONICS[h - 1];
    let any = false;
    for (let j = 0; j < bpms.length; j++) {
      const cycles = (h * bpms[j]) / 60 / fps;
      if (cycles >= 0.5) continue;
      any = true;
      let re = 0;
      let im = 0;
      for (let t = 0; t < envelope.length; t++) {
        const phase = -2 * Math.PI * cycles * t;
        re += envelope[t] * Math.cos(phase);
        im += envelope[t] * Math.sin(phase);
      }
      scores[j] += (weight * Math.hypot(re, im)) / scale;
    }
    if (!any) break;
  }
  return scores;
}

function refineBpm(mel: Float32Array[], bpm: number): number | null {
  const envelope = onsetEnvelope(mel);
  const fps = TEMPO_SR / HOP;
  if (envelope.length / fps < MIN_REFINE_SECONDS) return null;
  const low = Math.max(MIN_BPM, bpm * (1 - REFINE_BAND));
  const high = Math.min(MAX_BPM, bpm * (1 + REFINE_BAND));
  if (high <= low) return null;
  // numpy.arange(low, high + step, step)
  const count = Math.ceil((high + REFINE_STEP - low) / REFINE_STEP);
  const bpms = Float64Array.from({ length: count }, (_, i) => low + i * REFINE_STEP);
  const scores = combScores(envelope, bpms, fps);
  if (!scores.some(s => s > 0)) return null;

  const med = median(scores);
  const peak = argmax(scores);
  const prominence = med > 0 ? scores[peak] / med : 0;
  if (prominence < REFINE_MIN_PROMINENCE) return null;

  const lobeBpm = (60 * fps) / envelope.length;
  const lobeSteps = Math.max(1, Math.ceil(lobeBpm / REFINE_STEP));
  let rival = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (i >= peak - lobeSteps && i <= peak + lobeSteps) continue;
    if (scores[i] > rival) rival = scores[i];
  }
  if (rival !== -Infinity && rival > 0 && scores[peak] / rival < REFINE_MIN_DOMINANCE) return null;

  const [position] = quadInterpolArgmax(scores, peak);
  const refined = low + position * REFINE_STEP;
  return refined >= low && refined <= high ? refined : null;
}

// --- estimate

export function estimateTempo(weights: Weights, samples: Float32Array): TempoResult {
  const mel = melSpectrogram(samples);
  let melSum = 0;
  for (const band of mel) for (const v of band) melSum += v;

  // sliding windows over a spectrogram padded to at least one window
  const frames = Math.max(mel[0].length, WINDOW_FRAMES);
  const count = Math.floor((frames - WINDOW_FRAMES) / WINDOW_HOP) + 1;
  const at = (m: number, t: number) => (t < mel[m].length ? mel[m][t] : 0);

  // the normaliser sees the stacked windows, overlaps counted every time
  let sum = 0;
  let sumSq = 0;
  for (let n = 0; n < count; n++) {
    for (let m = 0; m < N_MELS; m++) {
      for (let t = 0; t < WINDOW_FRAMES; t++) {
        const v = at(m, n * WINDOW_HOP + t);
        sum += v;
        sumSq += v * v;
      }
    }
  }
  const total = count * N_MELS * WINDOW_FRAMES;
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));

  const averaged = new Float64Array(256);
  const input = new Float32Array(N_MELS * WINDOW_FRAMES);
  for (let n = 0; n < count; n++) {
    for (let m = 0; m < N_MELS; m++) {
      for (let t = 0; t < WINDOW_FRAMES; t++) {
        const v = at(m, n * WINDOW_HOP + t);
        input[m * WINDOW_FRAMES + t] = std !== 0 ? (v - mean) / std : v;
      }
    }
    const probs = forward(weights, input, N_MELS, WINDOW_FRAMES);
    for (let c = 0; c < averaged.length; c++) averaged[c] += probs[c] / count;
  }

  const [index, height] = quadInterpolArgmax(averaged, argmax(averaged));
  const bpmCnn = index + BPM_OFFSET;
  const refined = refineBpm(mel, bpmCnn);
  return {
    bpm: refined ?? bpmCnn,
    bpmCnn,
    confidence: Math.max(0, Math.min(1, height)),
    refined: refined !== null,
    averaged,
    melSum
  };
}

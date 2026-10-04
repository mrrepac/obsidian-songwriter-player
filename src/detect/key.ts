/**
 * Key by S-KEY (Deezer, MIT; github.com/deezer/skey), computed in plain JS: the
 * same constant-Q front end (nnAudio's VQT with the kernels taken from the
 * checkpoint itself) and the same ChromaNet. tests/detect.test.mjs holds it to
 * the Python package's own output on real tracks.
 *
 * Input is mono at 22050 Hz. No Obsidian imports: runs in the worker.
 */
import type { Weights } from "./weights";

export const KEY_SR = 22050;
const HOP = 512;
const N_BINS = 99;
const CROP_BINS = 84;
const OCTAVES = 9;
const EPS = 1e-5;

/** The checkpoint's own class order — verified on synthetic C, G, Am and Em. */
const KEY_NAMES = [
  "A major", "Bb major", "B major", "C major", "C# major", "D major",
  "D# major", "E major", "F major", "F# major", "G major", "G# major",
  "B minor", "C minor", "C# minor", "D minor", "D# minor", "E minor",
  "F minor", "F# minor", "G minor", "G# minor", "A minor", "Bb minor"
];

/** Tracks measured before S-KEY carry essentia's flats; new ones match them. */
const SPELLING: Record<string, string> = { "D#": "Eb", "G#": "Ab" };

export interface KeyResult {
  /** e.g. "C#" or "Eb" — spelled the way essentia spelled them before */
  key: string;
  scale: "major" | "minor";
  /** the other mode of the same tonic when it is the runner-up, else null */
  scaleAlt: "major" | "minor" | null;
  /** the winning class's probability */
  strength: number;
  probs: Float64Array;
  vqtSum: number;
}

// --- VQT

/** conv1d with one kernel, zero padding `pad` on both sides, stride `stride`. */
function lowpassDown(x: Float32Array, kernel: Float32Array): Float32Array {
  const pad = (kernel.length - 1) >> 1;
  const outLength = Math.floor((x.length + 2 * pad - kernel.length) / 2) + 1;
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = i * 2 - pad;
    let s = 0;
    const from = Math.max(0, -start);
    const to = Math.min(kernel.length, x.length - start);
    for (let k = from; k < to; k++) s += kernel[k] * x[start + k];
    out[i] = s;
  }
  return out;
}

/** Magnitude rows [bin][frame] for one octave, reflect padding, `hop` stride. */
function octaveCqt(x: Float32Array, real: Float32Array, imag: Float32Array, filters: number, hop: number): Float64Array[] {
  const len = real.length / filters;
  const pad = len >> 1;
  const frames = Math.floor((x.length + 2 * pad - len) / hop) + 1;
  const at = (i: number) => {
    // torch ReflectionPad1d: mirror without repeating the edge sample
    if (i < 0) i = -i;
    if (i >= x.length) i = 2 * (x.length - 1) - i;
    return x[i];
  };
  const rows: Float64Array[] = [];
  for (let f = 0; f < filters; f++) {
    const row = new Float64Array(frames);
    const kr = real.subarray(f * len, (f + 1) * len);
    const ki = imag.subarray(f * len, (f + 1) * len);
    for (let t = 0; t < frames; t++) {
      const start = t * hop - pad;
      let re = 0;
      let im = 0;
      if (start >= 0 && start + len <= x.length) {
        for (let k = 0; k < len; k++) {
          const v = x[start + k];
          re += kr[k] * v;
          im += ki[k] * v;
        }
      } else {
        for (let k = 0; k < len; k++) {
          const v = at(start + k);
          re += kr[k] * v;
          im += ki[k] * v;
        }
      }
      row[t] = Math.hypot(Math.fround(re), Math.fround(im));
    }
    rows.push(row);
  }
  return rows;
}

/** log-VQT as S-KEY feeds it: [bin][frame], bins low to high, top_db 80. */
export function logVqt(weights: Weights, samples: Float32Array): Float32Array[] {
  const lowpass = weights.get("hcqt.lowpass_filter").data;
  const lengths = weights.get("hcqt.lenghts").data;
  let x = samples;
  let hop = HOP;
  const octaves: Float64Array[][] = [];
  for (let i = 0; i < OCTAVES; i++) {
    if (i > 0) {
      x = lowpassDown(x, lowpass);
      hop = Math.floor(hop / 2);
    }
    const real = weights.get(`hcqt.cqt_kernels_real_${i}`);
    const imag = weights.get(`hcqt.cqt_kernels_imag_${i}`).data;
    octaves.unshift(octaveCqt(x, real.data, imag, real.shape[0], hop));
  }
  const all = octaves.flat();
  const bins = all.slice(all.length - N_BINS);
  const frames = Math.min(...bins.map(r => r.length));

  // AmplitudeToDB(stype="power", top_db=80) over the whole spectrogram
  let maxDb = -Infinity;
  const db = bins.map((row, b) => {
    const scale = Math.sqrt(lengths[b]);
    const out = new Float32Array(frames);
    for (let t = 0; t < frames; t++) {
      const v = 10 * Math.log10(Math.max(Math.fround(row[t] * scale), 1e-10));
      out[t] = v;
      if (v > maxDb) maxDb = v;
    }
    return out;
  });
  const floor = maxDb - 80;
  for (const row of db) for (let t = 0; t < frames; t++) row[t] = Math.max(row[t], floor) / 80 + 1;
  return db;
}

// --- ChromaNet

/** erf to ~1e-7 (Numerical Recipes erfc), for the exact GELU torch uses. */
function erf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
const gelu = (v: number) => 0.5 * v * (1 + erf(v / Math.SQRT2));

interface Act { c: number; h: number; w: number; data: Float32Array }

/** layer_norm over every element, no affine. */
function layerNorm(a: Act): Act {
  const n = a.data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a.data[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (a.data[i] - mean) ** 2;
  variance /= n;
  const inv = 1 / Math.sqrt(variance + EPS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a.data[i] - mean) * inv;
  return { ...a, data: out };
}

/** LayerNorm → conv (1×2, stride 1×2) → GELU. */
function timeDownsample(weights: Weights, i: number, a: Act): Act {
  const x = layerNorm(a);
  const kernel = weights.get(`chromanet.time_downsampling_blocks.${i}.conv.weight`);
  const bias = weights.get(`chromanet.time_downsampling_blocks.${i}.conv.bias`).data;
  const outC = kernel.shape[0];
  const w = Math.floor(a.w / 2);
  const out = new Float32Array(outC * a.h * w);
  for (let o = 0; o < outC; o++) {
    for (let r = 0; r < a.h; r++) {
      for (let q = 0; q < w; q++) {
        let s = bias[o];
        for (let c = 0; c < a.c; c++) {
          const base = (c * a.h + r) * a.w + 2 * q;
          s += kernel.data[(o * a.c + c) * 2] * x.data[base] + kernel.data[(o * a.c + c) * 2 + 1] * x.data[base + 1];
        }
        out[(o * a.h + r) * w + q] = gelu(s);
      }
    }
  }
  return { c: outC, h: a.h, w, data: out };
}

/** Depthwise k×k (replicate padding) → LayerNorm → Linear 4C → GELU → Linear C → γ, residual. */
function convNext(weights: Weights, i: number, a: Act): Act {
  const p = `chromanet.convnext_blocks.${i}`;
  const dw = weights.get(`${p}.dwconv.weight`);
  const dwBias = weights.get(`${p}.dwconv.bias`).data;
  const k = dw.shape[2];
  const half = k >> 1;
  const { c: C, h: H, w: W } = a;
  const conv = new Float32Array(a.data.length);
  for (let c = 0; c < C; c++) {
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        let s = dwBias[c];
        const inside = q >= half && q < W - half;
        for (let u = 0; u < k; u++) {
          const rr = Math.min(H - 1, Math.max(0, r + u - half));
          const row = (c * H + rr) * W;
          const wk = (c * k + u) * k;
          if (inside) {
            // away from the time edges no column needs clamping
            const base = row + q - half;
            for (let v = 0; v < k; v++) s += dw.data[wk + v] * a.data[base + v];
          } else {
            for (let v = 0; v < k; v++) {
              const qq = Math.min(W - 1, Math.max(0, q + v - half));
              s += dw.data[wk + v] * a.data[row + qq];
            }
          }
        }
        conv[(c * H + r) * W + q] = s;
      }
    }
  }
  const normed = layerNorm({ ...a, data: conv }).data;
  const w1 = weights.get(`${p}.pwconv1.weight`).data;
  const b1 = weights.get(`${p}.pwconv1.bias`).data;
  const w2 = weights.get(`${p}.pwconv2.weight`).data;
  const b2 = weights.get(`${p}.pwconv2.bias`).data;
  const gamma = weights.get(`${p}.gamma`).data;
  const hidden = 4 * C;
  const out = new Float32Array(a.data.length);
  const plane = H * W;
  // the two linear layers run over chunks of positions with the position as
  // the inner loop: long, contiguous loops are what the JIT makes fast
  const CHUNK = 4096;
  const mid = new Float64Array(hidden * CHUNK);
  const acc = new Float64Array(CHUNK);
  for (let start = 0; start < plane; start += CHUNK) {
    const n = Math.min(CHUNK, plane - start);
    for (let j = 0; j < hidden; j++) {
      const row = j * CHUNK;
      mid.fill(b1[j], row, row + n);
      for (let c = 0; c < C; c++) {
        const wv = w1[j * C + c];
        const src = c * plane + start;
        for (let p = 0; p < n; p++) mid[row + p] += wv * normed[src + p];
      }
      for (let p = 0; p < n; p++) mid[row + p] = gelu(mid[row + p]);
    }
    for (let c = 0; c < C; c++) {
      acc.fill(b2[c], 0, n);
      for (let j = 0; j < hidden; j++) {
        const wv = w2[c * hidden + j];
        const row = j * CHUNK;
        for (let p = 0; p < n; p++) acc[p] += wv * mid[row + p];
      }
      const dst = c * plane + start;
      const g = gamma[c];
      for (let p = 0; p < n; p++) out[dst + p] = a.data[dst + p] + g * acc[p];
    }
  }
  return { ...a, data: out };
}

function chromaNet(weights: Weights, spec: Float32Array[]): Float64Array {
  const H = spec.length;
  const W = spec[0].length;
  const data = new Float32Array(H * W);
  spec.forEach((row, r) => data.set(row, r * W));
  let a: Act = { c: 1, h: H, w: W, data };
  for (let i = 0; i < 7; i++) {
    a = timeDownsample(weights, i, a);
    a = convNext(weights, i, a);
  }
  // octave pool, then the mean over time: [channel][pitch class]
  const octaves = a.h / 12;
  const pooled = new Float64Array(a.c * 12);
  for (let c = 0; c < a.c; c++) {
    for (let k = 0; k < 12; k++) {
      let s = 0;
      for (let j = 0; j < octaves; j++) {
        const row = (c * a.h + j * 12 + k) * a.w;
        for (let q = 0; q < a.w; q++) s += a.data[row + q];
      }
      pooled[c * 12 + k] = s / (octaves * a.w);
    }
  }
  const cw = weights.get("chromanet.classifier.weight").data;
  const cb = weights.get("chromanet.classifier.bias").data;
  const mean = weights.get("chromanet.batch_norm.running_mean").data;
  const variance = weights.get("chromanet.batch_norm.running_var").data;
  const logits = new Float64Array(24);
  for (let o = 0; o < 2; o++) {
    for (let k = 0; k < 12; k++) {
      let s = cb[o];
      for (let c = 0; c < a.c; c++) s += cw[o * a.c + c] * pooled[c * 12 + k];
      logits[o * 12 + k] = (s - mean[o]) / Math.sqrt(variance[o] + EPS);
    }
  }
  const max = Math.max(...logits);
  let total = 0;
  for (let i = 0; i < 24; i++) total += (logits[i] = Math.exp(logits[i] - max));
  for (let i = 0; i < 24; i++) logits[i] /= total;
  return logits;
}

/** Mono at 22050 Hz in; normalised here to a peak of 1, as S-KEY does. */
export function estimateKey(weights: Weights, samples: Float32Array): KeyResult {
  let peak = 0;
  for (const v of samples) if (Math.abs(v) > peak) peak = Math.abs(v);
  const x = peak > 0 && peak !== 1 ? samples.map(v => v / peak) : samples;
  const full = logVqt(weights, x);
  let vqtSum = 0;
  for (const row of full) for (const v of row) vqtSum += v;
  const spec = full.slice(0, CROP_BINS);
  const probs = chromaNet(weights, spec);
  let best = 0;
  for (let i = 1; i < 24; i++) if (probs[i] > probs[best]) best = i;
  let second = best === 0 ? 1 : 0;
  for (let i = 0; i < 24; i++) if (i !== best && probs[i] > probs[second]) second = i;
  const [tonic, scale] = KEY_NAMES[best].split(" ");
  const [altTonic, altScale] = KEY_NAMES[second].split(" ");
  return {
    key: SPELLING[tonic] ?? tonic,
    scale: scale as "major" | "minor",
    scaleAlt: altTonic === tonic ? altScale as "major" | "minor" : null,
    strength: probs[best],
    probs,
    vqtSum
  };
}

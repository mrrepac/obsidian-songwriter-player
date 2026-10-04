/**
 * Deterministic test signals for the detectors. tests/detect.test.mjs feeds
 * them to the JS ports; tools/reference.py was run on the very same samples
 * (written out by `node tests/signals.mjs <dir>`) to get the originals'
 * answers that the test pins.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A small fixed-seed generator: the noise in the hats must not vary per run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** 30 s of kick on 1 and 3, snare on 2 and 4, hats on eighths, at `bpm`. */
export function drumLoop(bpm, sr, seconds = 30) {
  const out = new Float32Array(Math.round(sr * seconds));
  const noise = rng(7);
  const beat = (60 / bpm) * sr;
  for (let n = 0; n * beat / 2 < out.length; n++) {
    const start = Math.round((n * beat) / 2);
    const inBar = n % 8;
    for (let i = 0; i < sr * 0.25 && start + i < out.length; i++) {
      const tt = i / sr;
      let v = 0.15 * noise() * Math.exp(-tt / 0.01); // hat
      if (inBar === 0 || inBar === 4) v += 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-tt / 0.03)) * tt) * Math.exp(-tt / 0.12);
      if (inBar === 2 || inBar === 6) v += 0.5 * noise() * Math.exp(-tt / 0.05);
      out[start + i] += v;
    }
  }
  return out;
}

/**
 * 24 s of D minor: Dm Gm A Dm, two seconds a chord, harmonics and a decay,
 * over a faint noise floor. The floor matters: without it the bins below the
 * lowest note hold nothing but rounding noise, which differs between torch's
 * float32 and the port's float64 — real recordings never have that silence.
 */
export function chords(sr, seconds = 24) {
  const noise = rng(11);
  const progression = [[50, 62, 65, 69], [55, 62, 67, 70], [57, 61, 64, 69], [50, 62, 65, 69]];
  const out = new Float32Array(Math.round(sr * seconds));
  const len = 2 * sr;
  for (let c = 0; c * len < out.length; c++) {
    const notes = progression[c % progression.length];
    for (let i = 0; i < len && c * len + i < out.length; i++) {
      const tt = i / sr;
      let v = 0;
      for (const m of notes) {
        const f = 440 * 2 ** ((m - 69) / 12);
        for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h;
      }
      out[c * len + i] = 0.1 * v * Math.exp(-tt / 1.2) + 0.003 * noise();
    }
  }
  return out;
}

/** Minimal 32-bit float mono WAV, read back bit for bit by soundfile. */
function wav(samples, sr) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(32, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "drums97-11025.wav"), wav(drumLoop(97, 11025), 11025));
  writeFileSync(path.join(dir, "dminor-22050.wav"), wav(chords(22050), 22050));
  console.log("written to", dir);
}

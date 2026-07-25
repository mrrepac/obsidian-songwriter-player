// types only: keeps this module runnable in a bare browser harness, where the
// whole render path (decode → shift → wav) can be verified without Obsidian
import type { App, TFile } from "obsidian";
import { createPitchShifter, ensurePitchWorklet, pitchLatency, semitonesToRatio } from "./pitch";

/**
 * Bakes the transposition (and the speed, if it is off) into a new audio file
 * next to the original: "beat-tone+2bpm134.wav". The copy is an ordinary file,
 * so it plays with everything the plugin has — marker, A-B zone, waveform,
 * playlist, dragging into a note — and it can be handed to a DAW as is.
 */

const SAMPLE_RATE = 44100;

export interface RenderOptions {
  semitones: number;
  /** playback speed as heard; 1 = as recorded */
  rate: number;
  /** measured tempo, used for the file name */
  bpm?: number | null;
}

/** "beat" + (+2 semitones, 134 bpm) → "beat-tone+2bpm134" */
export function renderedName(basename: string, opts: RenderOptions): string {
  const parts: string[] = [];
  if (opts.semitones !== 0) parts.push(`tone${opts.semitones > 0 ? "+" : ""}${opts.semitones}`);
  if (opts.bpm) parts.push(`bpm${Math.round(opts.bpm * opts.rate)}`);
  else if (opts.rate !== 1) parts.push(`x${opts.rate.toFixed(2)}`);
  return parts.length > 0 ? `${basename}-${parts.join("")}` : basename;
}

/** Renders and writes the copy; returns the new file. */
export async function renderTransposed(app: App, file: TFile, opts: RenderOptions): Promise<TFile> {
  const raw = await app.vault.readBinary(file);
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC({ sampleRate: SAMPLE_RATE });
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(raw);
  } finally {
    void decodeCtx.close();
  }

  // The source is resampled by `rate` — which moves the pitch as well — and the
  // shifter then puts the pitch where it belongs: ratio = 2^(n/12) / rate.
  // Net effect: tempo × rate, pitch × 2^(n/12), which is what is being heard.
  const ratio = semitonesToRatio(opts.semitones) / opts.rate;
  const latency = pitchLatency(ratio);
  const length = Math.ceil(decoded.length / opts.rate) + latency + 1;

  const offline = new OfflineAudioContext(Math.min(decoded.numberOfChannels, 2), length, SAMPLE_RATE);
  await ensurePitchWorklet(offline);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.playbackRate.value = opts.rate;
  const shifter = createPitchShifter(offline);
  const param = shifter.parameters as unknown as Map<string, AudioParam>;
  param.get("ratio")?.setValueAtTime(ratio, 0);
  source.connect(shifter);
  shifter.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const wav = encodeWav(rendered, latency);
  const folder = file.parent?.path ?? "";
  const target = await uniquePath(app, folder, renderedName(file.basename, opts), "wav");
  return await app.vault.createBinary(target, wav);
}

/** Keeps a second render from failing on an existing name. */
async function uniquePath(app: App, folder: string, name: string, ext: string): Promise<string> {
  const base = folder ? `${folder}/${name}` : name;
  if (!app.vault.getAbstractFileByPath(`${base}.${ext}`)) return `${base}.${ext}`;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}.${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return `${base} ${Date.now()}.${ext}`;
}

/** 16-bit PCM WAV — no encoder dependency, plays everywhere, DAW-friendly. */
function encodeWav(buffer: AudioBuffer, skipSamples: number): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const frames = Math.max(0, buffer.length - skipSamples);
  const bytes = frames * channels * 2;
  const out = new ArrayBuffer(44 + bytes);
  const view = new DataView(out);

  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true);                     // block align
  view.setUint16(34, 16, true);                               // bits per sample
  text(36, "data");
  view.setUint32(40, bytes, true);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][i + skipSamples]));
      // asymmetric scaling: -1 maps to -32768, +1 to 32767, no wrap-around
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

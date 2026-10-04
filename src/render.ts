// types only: keeps this module runnable in a bare browser harness, where the
// whole render path (decode → shift → wav) can be verified without Obsidian
import type { App, TFile } from "obsidian";
import { createStretch } from "./stretch";

/**
 * Bakes the transposition (and the speed, if it is off) into a new audio file
 * next to the original: "beat-tone+2bpm134.wav". The copy is an ordinary file,
 * so it plays with everything the plugin has — marker, counters, waveform,
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

  const rendered = await stretchBuffer(decoded, opts);
  const wav = encodeWav(rendered, 0);
  // the vault root's path is "/", not "" — taken as is it builds "//name"
  const folder = !file.parent || file.parent.isRoot() ? "" : file.parent.path;
  const target = await uniquePath(app, folder, renderedName(file.basename, opts), "wav");
  return await app.vault.createBinary(target, wav);
}

/**
 * Speed and key in one pass, the way they are heard: Signalsmith Stretch reads
 * the decoded track from its own buffer at `rate` and shifts it by
 * `semitones`. The stretcher needs a run-up to line its output up with its
 * input, so the playback is scheduled `lead` seconds in and that stretch of
 * the render is dropped again — the copy starts exactly where the track does,
 * which matters once it sits on a DAW's grid.
 */
export async function stretchBuffer(decoded: AudioBuffer, opts: RenderOptions): Promise<AudioBuffer> {
  const channels = Math.min(decoded.numberOfChannels, 2);
  const probe = new OfflineAudioContext(channels, 1, SAMPLE_RATE);
  const lead = await (await createStretch(probe)).latency();
  const leadFrames = Math.ceil(lead * SAMPLE_RATE);
  const frames = Math.ceil(decoded.length / opts.rate);

  const offline = new OfflineAudioContext(channels, leadFrames + frames, SAMPLE_RATE);
  const stretch = await createStretch(offline);
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  await stretch.addBuffers([left, right]);
  await stretch.schedule({ active: true, input: 0, output: lead, rate: opts.rate, semitones: opts.semitones });
  stretch.connect(offline.destination);
  const rendered = await offline.startRendering();

  const out = new OfflineAudioContext(channels, frames, SAMPLE_RATE).createBuffer(channels, frames, SAMPLE_RATE);
  for (let c = 0; c < channels; c++) out.copyToChannel(rendered.getChannelData(c).subarray(leadFrames, leadFrames + frames), c);
  return out;
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

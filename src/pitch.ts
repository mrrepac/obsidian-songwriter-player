/**
 * Live pitch shifting for playback, desktop only.
 *
 * Shifting pitch — unlike stretching time — produces exactly as many samples
 * as it consumes, so the plugin can keep playing through the ordinary <audio>
 * element and simply insert a processing node before the speakers:
 *
 *     <audio> → MediaElementSource → PitchShifter → destination
 *
 * Nothing else in the engine has to change: currentTime, seeking, the A-B
 * zone, the counters and the waveform playhead all still read the element.
 *
 * The DSP is granular: grains of `GRAIN` output samples are read from the
 * input at `ratio` speed (so their content is transposed) and stitched at
 * half-grain steps. Because grains are *placed* at the input rate while being
 * *read* at `ratio` rate, the duration survives and only the pitch moves.
 *
 * Grains are phase-aligned before stitching (SOLA): each one is nudged within
 * ±SEARCH samples to where it correlates best with the tail already written.
 * Without that step neighbouring grains land at arbitrary phases and partly
 * cancel — measured on a 440 Hz sine, the naive version put the peak 40–100
 * cents off the requested note and produced the same frequency for +1 and +2
 * semitones, which is the warble such shifters are notorious for. The nudge
 * does not accumulate (the read position still advances by exactly HOP), so it
 * cannot drift the tempo.
 *
 * Two details that measurably matter, both verified against a metric harness
 * (tone purity, and a "shift there and back" comparison with the original):
 *
 *  - grains are stitched with an explicit raised-cosine CROSSFADE, not by
 *    adding Hann-windowed grains. Overlap-add only holds unity gain when
 *    grains sit exactly HOP apart, which SOLA deliberately breaks, so the
 *    level would ripple;
 *  - the resampler interpolates with a Catmull-Rom cubic rather than linearly,
 *    which is what keeps the top octave from turning to mush.
 */

const WORKLET_NAME = "sw-pitch-shifter";

// One definition, injected into the worklet source below and used by
// pitchLatency(). They were separate values once, and the moment the grain
// changed the render trimmed the wrong amount — do not split them again.
// Measured against 2048 and 4096 on a real beat (spectral distance and level
// envelope after shifting there and back): 1024 ties 2048 on spectrum, holds
// drum transients distinctly better at ±5 semitones, and delays the sound by
// only ~36 ms instead of ~60. 4096 was worse on both counts.
const GRAIN = 1024;
const HOP = GRAIN / 2; // 50% overlap
const SEARCH = 512;   // ±12 ms: covers a full period down to ~43 Hz

/** Runs inside the worklet; kept as source so it can be loaded from a Blob. */
const WORKLET_SOURCE = `
const GRAIN = ${GRAIN};
const HOP = ${HOP};
const RING = ${GRAIN * 8};
const SEARCH = ${SEARCH};
const CORR_STEP = 4;         // coarse candidate spacing, refined to the sample below
const CORR_LEN = HOP;        // the overlap region is what has to line up

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    // raised-cosine crossfade over the overlap: fade[i] + fade[HOP-1-i] ≈ 1,
    // so the stitch holds the level wherever SOLA decided to put the grain
    this.fade = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) this.fade[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / (HOP - 1));
    this.channels = [];
  }

  /** Catmull-Rom: keeps the high end intact where linear interpolation dulls it. */
  sample(buf, position) {
    const i0 = Math.floor(position);
    const frac = position - i0;
    const p0 = buf[(i0 - 1 + RING) % RING];
    const p1 = buf[i0 % RING];
    const p2 = buf[(i0 + 1) % RING];
    const p3 = buf[(i0 + 2) % RING];
    return p1 + 0.5 * frac * (p2 - p0 + frac * (2 * p0 - 5 * p1 + 4 * p2 - p3 + frac * (3 * (p1 - p2) + p3 - p0)));
  }

  channel(index) {
    let c = this.channels[index];
    if (!c) {
      c = {
        input: new Float32Array(RING),
        output: new Float32Array(RING),
        written: 0,     // total input samples received
        readPos: 0,     // input position the next grain reads from
        grainStart: 0,  // output position the next grain is added at
        outRead: 0,     // total output samples handed downstream
        primed: false
      };
      this.channels[index] = c;
    }
    return c;
  }

  reset(c) {
    c.input.fill(0);
    c.output.fill(0);
    c.written = 0;
    c.readPos = 0;
    c.grainStart = 0;
    c.outRead = 0;
    c.primed = false;
  }

  /**
   * Where to start reading so the grain lines up with the tail already in the
   * output: normalised cross-correlation over the overlap region, searched in
   * ±SEARCH input samples.
   */
  bestOffset(c, ratio) {
    // linear interpolation is enough while hunting for the peak; the grain
    // itself is resampled properly afterwards
    const score = (offset, stride) => {
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < CORR_LEN; i += stride) {
        const src = c.readPos + offset + i * ratio;
        const i0 = Math.floor(src);
        if (i0 < 1) return -Infinity;
        const frac = src - i0;
        const a = c.input[i0 % RING];
        const b = c.input[(i0 + 1) % RING];
        const grain = a + (b - a) * frac;
        dot += grain * c.output[(c.grainStart + i) % RING];
        energy += grain * grain;
      }
      if (energy <= 0) return -Infinity;
      // Among near-equal candidates prefer the smallest move: a big nudge
      // repeats or skips content, which shows up as a dented level envelope.
      const penalty = 1 - 0.2 * Math.abs(offset) / SEARCH;
      return (dot / Math.sqrt(energy)) * penalty;
    };

    // This search is the whole cost of the node and it runs on the audio
    // thread, where a block has 2.9 ms: a coarse sweep on every 16th sample of
    // the overlap, then one refinement pass around the winner.
    let best = 0;
    let bestScore = -Infinity;
    for (let offset = -SEARCH; offset <= SEARCH; offset += CORR_STEP) {
      const s = score(offset, 16);
      if (s > bestScore) { bestScore = s; best = offset; }
    }
    let refined = best;
    let refinedScore = -Infinity;
    for (let offset = best - CORR_STEP; offset <= best + CORR_STEP; offset++) {
      const s = score(offset, 4);
      if (s > refinedScore) { refinedScore = s; refined = offset; }
    }
    return refined;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const ratio = parameters.ratio[0];

    for (let ch = 0; ch < output.length; ch++) {
      const inBuf = input && input[ch] ? input[ch] : null;
      const out = output[ch];
      const c = this.channel(ch);
      const n = out.length;

      // straight through when there is nothing to transpose: no granular
      // texture and no added latency at the recorded pitch
      if (Math.abs(ratio - 1) < 1e-4) {
        if (inBuf) out.set(inBuf);
        else out.fill(0);
        if (c.primed) this.reset(c);
        continue;
      }
      c.primed = true;

      if (inBuf) {
        for (let i = 0; i < n; i++) c.input[(c.written + i) % RING] = inBuf[i];
      } else {
        for (let i = 0; i < n; i++) c.input[(c.written + i) % RING] = 0;
      }
      c.written += n;

      // build grains while the input holds a whole one plus the search margin
      // (+2 for the cubic interpolator's look-ahead)
      while (c.readPos + SEARCH + GRAIN * ratio + 3 < c.written) {
        const offset = c.grainStart > 0 ? this.bestOffset(c, ratio) : 0;
        const from = c.readPos + offset;
        for (let i = 0; i < GRAIN; i++) {
          const value = this.sample(c.input, from + i * ratio);
          const slot = (c.grainStart + i) % RING;
          if (i < HOP) {
            // crossfade into the previous grain's tail: unity gain whatever
            // offset the alignment picked
            const w = this.fade[i];
            c.output[slot] = c.output[slot] * (1 - w) + value * w;
          } else {
            c.output[slot] = value;
          }
        }
        // grains advance by the same hop on both sides, which is what keeps
        // the duration — and therefore the tempo — untouched. The alignment
        // offset is deliberately NOT added here, so it cannot accumulate.
        c.readPos += HOP;
        c.grainStart += HOP;
      }

      // Everything below grainStart has had both overlapping grains added to
      // it and is finished. While it is still filling, emit silence WITHOUT
      // advancing outRead — otherwise the reader overruns the writer during
      // priming and never catches up again.
      for (let i = 0; i < n; i++) {
        if (c.outRead < c.grainStart) {
          // not cleared after reading: the crossfade overwrites this region
          out[i] = c.output[c.outRead % RING];
          c.outRead++;
        } else {
          out[i] = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("${WORKLET_NAME}", PitchShifter);
`;

// per context: a worklet module is registered on a context, not globally
const registered = new WeakMap<BaseAudioContext, Promise<void>>();

/** Registers the worklet once per context. */
export function ensurePitchWorklet(ctx: BaseAudioContext): Promise<void> {
  let pending = registered.get(ctx);
  if (!pending) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    pending = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    registered.set(ctx, pending);
  }
  return pending;
}

export function createPitchShifter(ctx: BaseAudioContext): AudioWorkletNode {
  return new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
}

/** Semitones → playback ratio for the shifter. */
export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/**
 * Samples of silence the shifter emits before the first grain is complete.
 * An offline render has to drop them, otherwise the copy starts late.
 * Mirrors the constants inside the worklet.
 */
export function pitchLatency(ratio: number): number {
  if (Math.abs(ratio - 1) < 1e-4) return 0; // bypassed, no delay
  return Math.ceil(SEARCH + GRAIN * ratio);
}

/** Transposed tonic, e.g. "Eb" + 2 → "F". */
const NOTES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_INDEX: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11
};

export function transposeKey(key: string, semitones: number): string {
  const index = NOTE_INDEX[key];
  if (index === undefined) return key;
  return NOTES_SHARP[(((index + semitones) % 12) + 12) % 12];
}

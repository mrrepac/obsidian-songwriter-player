/**
 * A short tonic triad, so a detected key can be checked by ear against the
 * track that is playing. No detector is certain about the mode, and hearing
 * the chord over the beat settles it faster than any confidence number.
 */

const SEMITONES: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Plays the triad of `key` in `scale`; resolves once it has faded out. */
export function playTriad(key: string, scale: string): void {
  const semitone = SEMITONES[key];
  if (semitone === undefined) return;

  const AC: typeof AudioContext =
    window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const now = ctx.currentTime;
  const duration = 1.6;

  const master = ctx.createGain();
  // quiet enough to sit under a playing beat instead of masking it
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.18, now + 0.02);
  master.gain.setValueAtTime(0.18, now + duration - 0.35);
  master.gain.linearRampToValueAtTime(0, now + duration);
  master.connect(ctx.destination);

  // root, third (minor or major), fifth, plus the root an octave up
  const third = scale === "minor" ? 3 : 4;
  const root = 48 + semitone; // C3-ish, low enough not to fight the melody
  for (const [i, midi] of [root, root + third, root + 7, root + 12].entries()) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = midiToFreq(midi);
    const g = ctx.createGain();
    // stagger the entries slightly: an arpeggio reads more clearly than a stab
    const at = now + i * 0.06;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.25, at + 0.03);
    osc.connect(g);
    g.connect(master);
    osc.start(at);
    osc.stop(now + duration);
  }

  window.setTimeout(() => void ctx.close(), (duration + 0.2) * 1000);
}

/**
 * Key arithmetic for the transposition controls. The shifting itself is done
 * by Signalsmith Stretch (see stretch.ts): it replaced the plugin's own
 * granular shifter, which smeared drums and warbled on held notes.
 */

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

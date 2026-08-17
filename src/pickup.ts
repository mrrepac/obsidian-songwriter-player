import { PickupMode } from "./types";

/** What was opened: a note with audio in it, a note without, an audio file. */
export type PickupKind = "note-audio" | "note-empty" | "audio";

export interface PickupInput {
  kind: PickupKind;
  /** the player is sounding right now — the human is busy listening */
  playing: boolean;
  mode: PickupMode;
  currentPath: string | null;
  /** the track this open would load */
  targetPath: string;
  /** what the queue would become */
  queuePaths: string[];
}

export interface PickupDecision {
  setQueue: boolean;
  action: "load" | "offer" | "none";
}

/**
 * Who commands the player when a file is opened.
 *
 * The rule: while music plays, reading notes is not an instruction. Opening an
 * audio file is — that is a hand on the file, not a side effect of reading. The
 * "auto" mode sits outside the rule on purpose: it is called "always pick up",
 * and whoever chose it asked for exactly that.
 *
 * The two "nothing to load" checks run before the hold takes effect: a note
 * for the track already playing is not a request to switch to it, so it must
 * not surface an offer either. Held or not, the queue answer is the same —
 * `setQueue` only ever depends on whether the note's own track is being held
 * back, never on whether there was anything left to load.
 */
export function decidePickup(input: PickupInput): PickupDecision {
  const { kind, playing, mode, currentPath, targetPath, queuePaths } = input;

  if (kind === "note-empty") return { setQueue: false, action: "none" };

  const held = kind === "note-audio" && playing && mode !== "auto";
  const setQueue = !held;

  // already the loaded track, or already inside the queue this open builds —
  // nothing to load either way, whether or not the hold below would apply
  if (currentPath === targetPath) return { setQueue, action: "none" };
  if (kind === "note-audio" && currentPath && queuePaths.includes(currentPath)) {
    return { setQueue, action: "none" };
  }

  if (held) return { setQueue, action: mode === "hybrid" ? "offer" : "none" };

  switch (mode) {
    case "auto": return { setQueue, action: "load" };
    case "hybrid": return { setQueue, action: playing ? "offer" : "load" };
    case "manual": return { setQueue, action: "none" };
  }
}

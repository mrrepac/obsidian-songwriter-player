import type { PlaylistFilter, PlaylistSort } from "./types";

/**
 * Sorting a pack of beats: a track went into a song, was saved for later, or
 * was dropped. Separate from the marker on purpose — the marker says where to
 * play from, not what became of the track.
 */
export type Verdict = "used" | "saved" | "dropped";

/** The order one button steps through; undefined is "new", not sorted yet. */
export const VERDICTS: Verdict[] = ["used", "saved", "dropped"];

export function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.includes(value as Verdict);
}

export interface SortableTrack {
  path: string;
  basename: string;
  mtime: number;
  bpm: number | null;
  plays: number;
}

/**
 * The order of the list is also the order the arrows walk — the view and the
 * queue must never disagree about what "next" means.
 */
export function sortTracks<T extends SortableTrack>(files: T[], sort: PlaylistSort): T[] {
  const byName = (a: T, b: T) =>
    a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" });
  const out = [...files];
  switch (sort) {
    case "tempo":
      // a track nobody measured has no place among tempos: it goes last
      return out.sort((a, b) =>
        (a.bpm ?? Infinity) - (b.bpm ?? Infinity) || byName(a, b));
    case "plays":
      return out.sort((a, b) => b.plays - a.plays || byName(a, b));
    case "recent":
      return out.sort((a, b) => b.mtime - a.mtime || byName(a, b));
    case "name":
    default:
      return out.sort(byName);
  }
}

/** One click on the button: new → used → saved → dropped → new again. */
export function nextVerdict(verdict: Verdict | undefined): Verdict | undefined {
  if (!verdict) return VERDICTS[0];
  const i = VERDICTS.indexOf(verdict);
  return i < 0 ? VERDICTS[0] : VERDICTS[i + 1];
}

/**
 * Whether a playlist row is shown: it has to pass the filter and match every
 * word of the search, in any order and any case.
 */
export function rowVisible(name: string, verdict: Verdict | undefined, filter: PlaylistFilter, query: string): boolean {
  if (filter === "unsorted" && verdict) return false;
  if (filter !== "all" && filter !== "unsorted" && verdict !== filter) return false;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = name.toLocaleLowerCase().replace(/ё/g, "е");
  return words.every(w => hay.includes(w.replace(/ё/g, "е")));
}

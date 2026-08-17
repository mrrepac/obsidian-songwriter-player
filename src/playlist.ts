import { PlaylistSort } from "./types";

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

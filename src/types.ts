import { t } from "./i18n";

export interface TrackData {
  marker: number | null;
  loopA: number | null;
  loopB: number | null;
  plays: number;
  playedSec: number;
  /** measured tempo, rounded; null until the track has been analysed */
  bpm?: number | null;
  /** tonic, e.g. "F#" */
  key?: string | null;
  /** "major" | "minor" */
  scale?: string | null;
  /** the mode the profiles disagreed about, if they did */
  scaleAlt?: string | null;
  /** how many key profiles backed the winner */
  keyVotes?: number;
  /** hand-corrected: analysis must never overwrite it again */
  musicalEdited?: boolean;
  /** playback speed for this track, 1 = as recorded (pitch is preserved) */
  rate?: number;
  /** transposition in semitones, desktop only; undefined = as recorded */
  semitones?: number;
}

export function emptyTrackData(): TrackData {
  return {
    marker: null,
    loopA: null,
    loopB: null,
    plays: 0,
    playedSec: 0
  };
}

export type PickupMode = "hybrid" | "auto" | "manual";

/** Mobile floating-button tap behavior. */
export type FabMode = "marker" | "smart";

/** Where the current playlist came from — shown as the playlist heading. */
export interface QueueSource {
  kind: "note" | "folder";
  name: string;
  path: string;
}

export interface SongwriterSettings {
  pickupMode: PickupMode;
  skipSeconds: number;
  startFromMarkerOnLoad: boolean;
  volume: number;
  playCountSec: number;
  doubleStopMs: number;
  waveHeight: number;
  inlinePlayers: boolean;
  embedButtons: boolean;
  mobileFab: boolean;
  fabMode: FabMode;
  /** hand the track to the OS: media keys, lock screen, "now playing" card */
  mediaKeys: boolean;
  folderQueue: boolean;
  autoAdvance: boolean;
  playlistCollapsed: boolean;
  autoAnalyse: boolean;
  /** lower edge of the preferred tempo octave: 80 means 80…159 */
  tempoWindowLow: number;
  tracks: Record<string, TrackData>;
}

export const DEFAULT_SETTINGS: SongwriterSettings = {
  pickupMode: "hybrid",
  skipSeconds: 5,
  startFromMarkerOnLoad: true,
  volume: 1,
  playCountSec: 5,
  doubleStopMs: 600,
  waveHeight: 110,
  inlinePlayers: true,
  embedButtons: true,
  mobileFab: true,
  fabMode: "marker",
  mediaKeys: true,
  folderQueue: true,
  autoAdvance: false,
  playlistCollapsed: false,
  autoAnalyse: true,
  tempoWindowLow: 80,
  tracks: {}
};

/** "F# minor" → "F#m", "F# major" → "F#" — the notation a songwriter writes down. */
export function formatKey(key?: string | null, scale?: string | null): string {
  if (!key) return "";
  return scale === "minor" ? `${key}m` : key;
}

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "wma", "flac", "aac", "webm", "opus", "3gp"];

export function isAudioPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return AUDIO_EXTENSIONS.includes(ext);
}

/** Total listened time, human-readable: 47s · 12m · 2h05m (localized units) */
export function formatPlayed(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  if (sec < 60) return `${Math.floor(sec)}${t("unitS")}`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}${t("unitM")}`;
  const h = Math.floor(m / 60);
  return `${h}${t("unitH")}${String(m % 60).padStart(2, "0")}${t("unitM")}`;
}

export function formatTime(sec: number, withTenths = false): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const sInt = Math.floor(s);
  const tenth = Math.floor((s - sInt) * 10);
  const ss = String(sInt).padStart(2, "0");
  const base = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  return withTenths ? `${base}.${tenth}` : base;
}

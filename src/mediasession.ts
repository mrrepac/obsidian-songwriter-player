import type SongwriterPlugin from "./main";

/**
 * Hands the loaded track to the operating system: hardware media keys, the
 * lock screen and the notification shade, the "now playing" card Windows puts
 * over the volume overlay.
 *
 * Nothing appears in the plugin's own interface — this only makes the keys
 * already on the keyboard do the obvious thing. The <audio> element lives
 * detached from the document, which the Media Session API does not mind: it
 * follows whatever is actually producing sound, not the DOM. Verified on
 * Windows — the now-playing card and the hardware play/pause and track keys
 * all reach the player.
 *
 * Desktop in practice. On Obsidian mobile the page can fill the session in,
 * but nothing surfaces it: handing a WebView's media session to the lock
 * screen and the notification shade is the host app's job, and Obsidian does
 * not do it. Checked on device — no card appears. The bridge is left running
 * there anyway because it costs nothing and cannot misbehave; only the
 * setting is hidden, so it stops promising what it cannot deliver.
 *
 * The API is reached structurally instead of through the DOM lib, which does
 * not carry it in the TypeScript version this project builds against — the
 * same treatment preservesPitch and webkitAudioContext get elsewhere. Every
 * call is also guarded: setActionHandler throws for actions a platform has
 * not implemented, and setPositionState throws outright on a position past the
 * end or a stopped rate.
 */

interface PositionState {
  duration: number;
  playbackRate?: number;
  position?: number;
}

/** Passed to the seek actions by the platform; every field is optional. */
interface SeekDetails {
  seekTime?: number;
  seekOffset?: number;
}

interface MediaSessionLike {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler(action: string, handler: ((details: SeekDetails) => void) | null): void;
  setPositionState?(state?: PositionState): void;
}

type MetadataCtor = new (init: { title?: string; artist?: string; album?: string }) => unknown;

const ACTIONS = ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"];

function session(): MediaSessionLike | null {
  const nav = navigator as Navigator & { mediaSession?: MediaSessionLike };
  return nav.mediaSession ?? null;
}

export class MediaSessionBridge {
  private plugin: SongwriterPlugin;
  private started = false;

  constructor(plugin: SongwriterPlugin) {
    this.plugin = plugin;
  }

  start() {
    if (!session()) return; // no media session here: nothing to hand the track to
    this.started = true;
    const engine = this.plugin.engine;
    this.plugin.registerEvent(engine.on("track-changed", () => this.refresh()));
    this.plugin.registerEvent(engine.on("play-state", () => {
      this.refreshState();
      this.refreshPosition(); // the OS interpolates from the last report
    }));
    this.plugin.registerEvent(engine.on("queue-changed", () => this.bindActions()));
    this.plugin.registerEvent(engine.on("rate-changed", () => this.refreshPosition()));
    this.plugin.registerDomEvent(engine.audio, "seeked", () => this.refreshPosition());
    this.plugin.registerDomEvent(engine.audio, "durationchange", () => this.refreshPosition());
    this.refresh();
  }

  /** Called from the setting toggle. */
  applyEnabled() {
    if (this.started) this.refresh();
  }

  private get enabled(): boolean {
    return this.plugin.settings.mediaKeys;
  }

  private setHandler(action: string, handler: ((details: SeekDetails) => void) | null) {
    const s = session();
    if (!s) return;
    try {
      s.setActionHandler(action, handler);
    } catch {
      /* an action this platform does not implement */
    }
  }

  private bindActions() {
    const engine = this.plugin.engine;
    const on = this.enabled && !!engine.file;
    // with no playlist to walk, the arrows are left unbound so the system hides
    // them instead of showing buttons that would do nothing
    const many = engine.queue.length > 1;
    const skip = () => this.plugin.settings.skipSeconds;

    this.setHandler("play", on ? () => void engine.safePlay() : null);
    this.setHandler("pause", on ? () => engine.audio.pause() : null);
    this.setHandler("previoustrack", on && many ? () => void engine.step(-1) : null);
    this.setHandler("nexttrack", on && many ? () => void engine.step(1) : null);
    this.setHandler("seekbackward", on ? (d) => engine.seekBy(-(d?.seekOffset ?? skip())) : null);
    this.setHandler("seekforward", on ? (d) => engine.seekBy(d?.seekOffset ?? skip()) : null);
    this.setHandler("seekto", on ? (d) => {
      if (typeof d?.seekTime === "number") engine.seekTo(d.seekTime);
    } : null);
  }

  private refresh() {
    const s = session();
    if (!s) return;
    const file = this.plugin.engine.file;
    this.bindActions(); // prev/next follow the queue, which follows the track
    if (!this.enabled || !file) {
      s.metadata = null;
      s.playbackState = "none";
      this.clearPosition();
      return;
    }
    const Meta = (window as Window & { MediaMetadata?: MetadataCtor }).MediaMetadata;
    if (Meta) {
      s.metadata = new Meta({
        title: file.basename,
        // where the track came from reads best as the artist line: the note
        // being written, or the folder the takes live in
        artist: this.plugin.engine.queueSource?.name ?? file.parent?.name ?? ""
      });
    }
    this.refreshState();
    this.refreshPosition();
  }

  private refreshState() {
    const s = session();
    if (!s) return;
    const engine = this.plugin.engine;
    if (!this.enabled || !engine.file) {
      s.playbackState = "none";
      return;
    }
    s.playbackState = engine.playing ? "playing" : "paused";
  }

  private refreshPosition() {
    const s = session();
    if (!s?.setPositionState) return;
    if (!this.enabled || !this.plugin.engine.file) {
      this.clearPosition();
      return;
    }
    const audio = this.plugin.engine.audio;
    const duration = audio.duration;
    if (!isFinite(duration) || duration <= 0) {
      this.clearPosition(); // metadata has not arrived yet
      return;
    }
    const position = Math.min(Math.max(audio.currentTime, 0), duration);
    const playbackRate = audio.playbackRate > 0 ? audio.playbackRate : 1;
    try {
      s.setPositionState({ duration, position, playbackRate });
    } catch (e) {
      console.warn("Songwriter: media session rejected the position", e);
    }
  }

  private clearPosition() {
    const s = session();
    try {
      s?.setPositionState?.();
    } catch {
      /* nothing was reported yet */
    }
  }

  destroy() {
    const s = session();
    if (!s) return;
    for (const action of ACTIONS) this.setHandler(action, null);
    s.metadata = null;
    s.playbackState = "none";
    this.clearPosition();
  }
}

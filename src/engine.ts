import { Events, Notice, TFile } from "obsidian";
import type SongwriterPlugin from "./main";
import { TrackData, emptyTrackData, formatTime } from "./types";
import { t } from "./i18n";

/**
 * Owns the <audio> element, detached from the DOM: playback is independent
 * of note scrolling and survives closing the panel. The view is a UI shell.
 *
 * Events:
 *  - "track-changed" (file: TFile | null)
 *  - "play-state"    (playing: boolean)
 *  - "data-changed"  ()                    // start point / markers
 *  - "note-audios"   (files: TFile[])
 *  - "pending-switch"(file: TFile | null)
 */
export class PlayerEngine extends Events {
  audio: HTMLAudioElement;
  file: TFile | null = null;
  noteAudios: TFile[] = [];
  pendingSwitch: TFile | null = null;
  /** The note the current track was picked up from (null if opened directly). */
  sourceNote: TFile | null = null;

  private plugin: SongwriterPlugin;

  constructor(plugin: SongwriterPlugin) {
    super();
    this.plugin = plugin;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    // preservesPitch is missing from the TS DOM lib this project targets
    (this.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.audio.volume = plugin.settings.volume;
    this.audio.addEventListener("play", () => {
      this.updateLoopTimer();
      this.trigger("play-state", true);
    });
    this.audio.addEventListener("pause", () => {
      this.updateLoopTimer();
      this.plugin.requestSave(); // flush accumulated listened time
      this.trigger("play-state", false);
    });
    this.audio.addEventListener("ended", () => {
      // loop stretching to the very end: restart from A instead of stopping
      const lp = this.loop;
      if (lp) {
        this.audio.currentTime = lp.a;
        if (this.pendingPlaySec === null) this.armPlayCount();
        void this.safePlay();
        return;
      }
      this.pendingPlaySec = null; // an under-5s tail never scores
      this.updateLoopTimer();
      this.trigger("play-state", false);
    });
    this.audio.addEventListener("timeupdate", this.checkLoop);
    this.audio.addEventListener("seeked", () => {
      this.lastLoopTime = this.audio.currentTime;
    });
    this.audio.addEventListener("error", () => {
      if (this.file && this.audio.error) {
        new Notice(t("loadFailed")(this.file.name));
      }
    });
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get duration(): number {
    const d = this.audio.duration;
    return isFinite(d) ? d : 0;
  }

  // ---- track data (start point / markers) ----

  peekData(): TrackData | null {
    if (!this.file) return null;
    return this.plugin.settings.tracks[this.file.path] ?? null;
  }

  private ensureData(): TrackData | null {
    if (!this.file) return null;
    const tracks = this.plugin.settings.tracks;
    let d = tracks[this.file.path];
    if (!d) {
      d = emptyTrackData();
      tracks[this.file.path] = d;
    }
    return d;
  }

  // ---- play counter ----
  // Counts "passes", but a pass only scores after settings.playCountSec
  // seconds of actual playback: starting (X / waveform click) arms the
  // countdown, checkLoop accumulates played time, and the increment fires at
  // zero. A loop wrap arms the next lap; shorter passes never score.

  private pendingPlaySec: number | null = null;

  private armPlayCount() {
    this.pendingPlaySec = this.plugin.settings.playCountSec;
  }

  private bumpPlays() {
    const d = this.ensureData();
    if (!d) return;
    d.plays = (d.plays ?? 0) + 1;
    this.plugin.requestSave();
    this.trigger("data-changed");
  }

  resetPlays() {
    const d = this.peekData();
    if (!d || (!d.plays && !d.playedSec)) return;
    d.plays = 0;
    d.playedSec = 0;
    this.dataChanged();
  }

  private dataChanged() {
    this.plugin.requestSave();
    this.trigger("data-changed");
  }

  // ---- loading ----

  // Bumped on every load/refresh/unload so an in-flight setSrcAwaitMeta() that
  // resolves late (its metadata event and a newer load's fire on the same
  // <audio>) can detect it was superseded and bail before touching state.
  private loadToken = 0;

  async load(file: TFile, opts: { autoplay?: boolean } = {}) {
    if (this.file?.path === file.path) {
      this.setPendingSwitch(null);
      if (opts.autoplay && !this.playing) await this.safePlay();
      this.trigger("track-changed", this.file);
      return;
    }
    const token = ++this.loadToken;
    this.file = file;
    this.setPendingSwitch(null);
    this.playFromStartOnce = false;
    this.pendingPlaySec = null;
    this.unsavedPlayedSec = 0;
    this.plugin.requestSave(); // flush the previous track's listened time
    await this.setSrcAwaitMeta(this.plugin.app.vault.getResourcePath(file));
    if (token !== this.loadToken) return; // superseded by a newer load/unload
    const start = this.plugin.settings.startFromMarkerOnLoad
      ? (this.peekData()?.marker ?? 0)
      : 0;
    if (start > 0 && start < this.duration) this.audio.currentTime = start;
    this.lastLoopTime = this.audio.currentTime;
    this.updateLoopTimer();
    this.trigger("track-changed", file);
    if (opts.autoplay) await this.safePlay();
  }

  /** Re-resolve the src (e.g. after file rename) keeping position and state. */
  async refreshSrc() {
    if (!this.file) return;
    const token = ++this.loadToken;
    const t = this.audio.currentTime;
    const wasPlaying = this.playing;
    await this.setSrcAwaitMeta(this.plugin.app.vault.getResourcePath(this.file));
    if (token !== this.loadToken) return; // superseded by a newer load/unload
    if (t > 0 && t < this.duration) this.audio.currentTime = t;
    if (wasPlaying) await this.safePlay();
    this.trigger("track-changed", this.file);
  }

  private setSrcAwaitMeta(src: string): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.audio.removeEventListener("loadedmetadata", done);
        this.audio.removeEventListener("error", done);
        resolve();
      };
      this.audio.addEventListener("loadedmetadata", done);
      this.audio.addEventListener("error", done);
      this.audio.src = src;
      this.audio.load();
    });
  }

  unload() {
    this.loadToken++; // cancel any in-flight load()
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.file = null;
    this.playFromStartOnce = false;
    this.pendingPlaySec = null;
    this.stopChain = 0;
    this.setPendingSwitch(null);
    this.updateLoopTimer();
    this.plugin.requestSave(); // flush listened time (the pause event is async)
    this.trigger("track-changed", null);
  }

  // ---- transport ----

  async safePlay() {
    try {
      await this.audio.play();
    } catch (e) {
      console.warn("Songwriter: play() failed", e);
    }
  }

  async playPause() {
    if (!this.file) {
      new Notice(t("noTrack"));
      return;
    }
    if (this.playing) this.audio.pause();
    else await this.safePlay();
  }

  seekTo(sec: number) {
    if (!this.file) return;
    const d = this.duration;
    this.audio.currentTime = Math.max(0, d > 0 ? Math.min(sec, d - 0.05) : sec);
  }

  seekBy(sec: number) {
    this.seekTo(this.audio.currentTime + sec);
  }

  /**
   * Play from the marker if set, otherwise from the beginning.
   * A double-stop arms playFromStartOnce: the next call plays from 0 exactly
   * once (marker stays untouched), then behavior returns to normal.
   */
  async playFromMarker() {
    if (!this.file) {
      new Notice(t("noTrack"));
      return;
    }
    if (this.playFromStartOnce) {
      this.playFromStartOnce = false;
      this.seekTo(0);
    } else {
      this.seekTo(this.peekData()?.marker ?? 0);
    }
    this.armPlayCount();
    await this.safePlay();
  }

  /** Single click on the waveform: play from there; a click outside the loop zone clears it. */
  async playAt(time: number) {
    if (!this.file) return;
    const lp = this.loop;
    if (lp && (time < lp.a || time > lp.b)) this.clearLoop();
    this.seekTo(time);
    this.armPlayCount();
    await this.safePlay();
  }

  /**
   * Stop, with escalation on repeated presses (each within the window from
   * the previous one): 2nd — rewind to 0 and arm a one-shot "next Play from
   * marker starts from the beginning" (marker and zone untouched);
   * 3rd — the marker is deleted too.
   */
  private lastStopAt = 0;
  private stopChain = 0;
  private playFromStartOnce = false;

  stop() {
    const now = Date.now();
    const within = !!this.file && now - this.lastStopAt < this.plugin.settings.doubleStopMs;
    this.lastStopAt = now;
    if (!within) {
      this.stopChain = 1;
      this.audio.pause();
      return;
    }
    this.stopChain++;
    if (this.stopChain === 2) {
      this.audio.pause();
      this.seekTo(0);
      this.playFromStartOnce = true;
      new Notice(t("nextFromStart"), 1500);
    } else if (this.stopChain >= 3) {
      this.stopChain = 0;
      const d = this.peekData();
      const hadMarker = d?.marker !== null && d?.marker !== undefined;
      const hadLoop = !!this.loop;
      this.clearMarker();
      this.clearLoop();
      if (hadMarker && hadLoop) new Notice(t("markerAndLoopCleared"), 1500);
      else if (hadMarker) new Notice(t("markerCleared"), 1500);
      else if (hadLoop) new Notice(t("loopCleared"), 1500);
    }
  }

  setVolume(volume: number) {
    this.plugin.settings.volume = volume;
    this.audio.volume = volume;
    this.plugin.requestSave();
  }

  // ---- marker (single per track) ----

  setMarkerAt(time: number) {
    const d = this.ensureData();
    if (!d) {
      new Notice(t("noTrack"));
      return;
    }
    d.marker = time;
    this.playFromStartOnce = false; // a fresh marker wins over a pending "from start"
    this.dataChanged();
    new Notice(t("markerSet")(formatTime(time, true)), 1500);
  }

  setMarkerHere() {
    this.setMarkerAt(this.audio.currentTime);
  }

  clearMarker() {
    const d = this.peekData();
    if (!d || d.marker === null) return;
    d.marker = null;
    this.dataChanged();
  }

  // ---- A-B loop zone ----

  get loop(): { a: number; b: number } | null {
    const d = this.peekData();
    if (!d || d.loopA === null || d.loopB === null) return null;
    return { a: d.loopA, b: d.loopB };
  }

  setLoopZone(a: number, b: number) {
    const d = this.ensureData();
    if (!d) return;
    if (b - a < 0.2) return; // too small to be a real selection
    d.loopA = a;
    d.loopB = b;
    d.marker = a; // zone start doubles as the marker, so Play from marker replays the zone
    this.playFromStartOnce = false;
    this.dataChanged();
    const t = this.audio.currentTime;
    if (t < a || t >= b) this.seekTo(a);
    this.updateLoopTimer();
  }

  clearLoop() {
    const d = this.peekData();
    if (!d || (d.loopA === null && d.loopB === null)) return;
    d.loopA = null;
    d.loopB = null;
    this.dataChanged();
    this.updateLoopTimer();
  }

  /**
   * Wrap back to A only when playback itself crossed B (lastLoopTime tracks
   * the previous tick; "seeked" resets it), so seeking past the zone by hand
   * does not teleport the user back in.
   */
  private lastLoopTime = 0;
  private loopInterval: number | null = null;

  private unsavedPlayedSec = 0;

  private checkLoop = () => {
    const lp = this.loop;
    const t = this.audio.currentTime;
    // accumulate real playback time (delta guard skips seeks and stalls):
    // it feeds both the total listened counter and the pending play count
    if (this.playing) {
      const delta = t - this.lastLoopTime;
      if (delta > 0 && delta < 2) {
        const d = this.ensureData(); // count from the very first second of a fresh track
        if (d) {
          d.playedSec = (d.playedSec ?? 0) + delta;
          // don't spam saveData 4x/sec: persist every ~30s of playback,
          // pause/stop/track-change flush the rest
          this.unsavedPlayedSec += delta;
          if (this.unsavedPlayedSec >= 30) {
            this.unsavedPlayedSec = 0;
            this.plugin.requestSave();
          }
        }
        if (this.pendingPlaySec !== null) {
          this.pendingPlaySec -= delta;
          if (this.pendingPlaySec <= 0) {
            this.pendingPlaySec = null;
            this.bumpPlays();
          }
        }
      }
    }
    if (lp && this.playing && this.lastLoopTime < lp.b && t >= lp.b) {
      this.audio.currentTime = lp.a;
      this.lastLoopTime = lp.a;
      if (this.pendingPlaySec === null) this.armPlayCount(); // next lap = new pass
      return;
    }
    this.lastLoopTime = t;
  };

  /** timeupdate fires only ~4 times/sec; a 60ms interval keeps the loop edge tight. */
  updateLoopTimer() {
    const need = !!this.loop && this.playing;
    if (need && this.loopInterval === null) {
      this.loopInterval = window.setInterval(this.checkLoop, 60);
    } else if (!need && this.loopInterval !== null) {
      window.clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  // ---- note pickup ----

  setNoteAudios(files: TFile[]) {
    this.noteAudios = files;
    this.trigger("note-audios", files);
  }

  setPendingSwitch(file: TFile | null) {
    if (this.pendingSwitch === file) return;
    this.pendingSwitch = file;
    this.trigger("pending-switch", file);
  }

  destroy() {
    if (this.loopInterval !== null) {
      window.clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

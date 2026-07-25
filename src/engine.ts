import { Events, Notice, Platform, TFile } from "obsidian";
import type SongwriterPlugin from "./main";
import { QueueSource, TrackData, emptyTrackData, formatTime } from "./types";
import { createPitchShifter, ensurePitchWorklet, semitonesToRatio } from "./pitch";
import { t } from "./i18n";

/**
 * Owns the <audio> element, detached from the DOM: playback is independent
 * of note scrolling and survives closing the panel. The view is a UI shell.
 *
 * Events:
 *  - "track-changed" (file: TFile | null)
 *  - "play-state"    (playing: boolean)
 *  - "data-changed"  ()                    // start point / markers
 *  - "queue-changed" (files: TFile[])
 *  - "pending-switch"(file: TFile | null)
 *  - "rate-changed"  (rate: number)
 *  - "pitch-changed" (semitones: number)
 */
export class PlayerEngine extends Events {
  audio: HTMLAudioElement;
  file: TFile | null = null;
  /** The playlist the current track belongs to (a note's audios or a folder). */
  queue: TFile[] = [];
  queueSource: QueueSource | null = null;
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
      // the playlist rolls on only if asked to, and only for a track that is
      // actually in it; the last track just stops
      if (this.plugin.settings.autoAdvance && this.queueIndex >= 0) {
        void this.step(1, { autoplay: true });
      }
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
    this.applyRate();
    void this.applySemitones(); // per-track transposition follows the file
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
    this.applyRate();
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

  // ---- playback speed ----
  //
  // preservesPitch keeps the key where it was, so this stretches time only:
  // "play at 105 instead of 140" rather than a tape slowdown. Kept per track,
  // because a beat you are learning stays slow until you speed it back up.

  static readonly RATE_MIN = 0.5;
  static readonly RATE_MAX = 2;

  get rate(): number {
    return this.audio.playbackRate;
  }

  setRate(rate: number) {
    const r = Math.min(PlayerEngine.RATE_MAX, Math.max(PlayerEngine.RATE_MIN, rate));
    this.audio.playbackRate = r;
    const d = this.ensureData();
    if (d) {
      d.rate = r === 1 ? undefined : r;
      this.plugin.requestSave();
    }
    this.trigger("rate-changed", r);
  }

  /** Nudge the speed so the track lands on a whole number of bpm, when known. */
  stepRate(direction: number) {
    if (!this.file) {
      new Notice(t("noTrack"));
      return;
    }
    const bpm = this.peekData()?.bpm;
    if (bpm) {
      const current = Math.round(bpm * this.rate);
      this.setRate((current + direction) / bpm);
    } else {
      this.setRate(this.rate + direction * 0.05);
    }
  }

  // ---- transposition (desktop only) ----
  //
  // The shifter is inserted between the element and the speakers, so the
  // element stays the source of truth for time: seeking, the A-B zone, the
  // counters and the playhead keep working untouched. The graph is built only
  // when a shift is actually asked for — until then the audio path is exactly
  // what it was, and routing an element through Web Audio (flaky on mobile
  // WebViews) never happens there at all.

  private audioCtx: AudioContext | null = null;
  private pitchNode: AudioWorkletNode | null = null;

  get semitones(): number {
    return this.peekData()?.semitones ?? 0;
  }

  async setSemitones(semitones: number) {
    if (!this.file) {
      new Notice(t("noTrack"));
      return;
    }
    if (!Platform.isDesktop) {
      new Notice(t("desktopOnly"));
      return;
    }
    const value = Math.max(-12, Math.min(12, Math.round(semitones)));
    const d = this.ensureData();
    if (d) {
      d.semitones = value === 0 ? undefined : value;
      this.plugin.requestSave();
    }
    await this.applySemitones();
    this.trigger("pitch-changed", value);
  }

  private async applySemitones() {
    const value = this.semitones;
    // no shift and no graph yet: leave the plain audio path alone
    if (value === 0 && !this.pitchNode) return;
    try {
      await this.ensureGraph();
      // AudioParamMap is typed without get() in the DOM lib this project targets
      const params = this.pitchNode?.parameters as unknown as Map<string, AudioParam> | undefined;
      params?.get("ratio")?.setValueAtTime(semitonesToRatio(value), this.audioCtx?.currentTime ?? 0);
    } catch (e) {
      console.warn("Songwriter: pitch shifting unavailable", e);
      new Notice(t("pitchUnavailable"));
    }
  }

  private async ensureGraph() {
    if (this.pitchNode) {
      if (this.audioCtx?.state === "suspended") await this.audioCtx.resume();
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    await ensurePitchWorklet(ctx);
    // createMediaElementSource can only ever be called once for an element
    const source = ctx.createMediaElementSource(this.audio);
    const node = createPitchShifter(ctx);
    source.connect(node);
    node.connect(ctx.destination);
    this.audioCtx = ctx;
    this.pitchNode = node;
    if (ctx.state === "suspended") await ctx.resume();
  }

  private applyRate() {
    // load() resets playbackRate to 1, so both flags are re-asserted per track
    (this.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.audio.playbackRate = this.peekData()?.rate ?? 1;
    this.trigger("rate-changed", this.audio.playbackRate);
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

  // ---- playlist ----

  setQueue(files: TFile[], source: QueueSource | null = null) {
    this.queue = files;
    this.queueSource = files.length > 0 ? source : null;
    this.trigger("queue-changed", files);
  }

  /** Position of the current track in the queue, or -1 if it is not in there. */
  get queueIndex(): number {
    if (!this.file) return -1;
    const path = this.file.path;
    return this.queue.findIndex(f => f.path === path);
  }

  /**
   * Move by `delta` inside the queue. Keeps playing if something was playing
   * (that is what makes ⏭ feel like a player rather than a file picker), and
   * does nothing at the edges — the playlist does not wrap.
   */
  async step(delta: number, opts: { autoplay?: boolean } = {}): Promise<boolean> {
    const i = this.queueIndex;
    if (i < 0) {
      // nothing loaded (or the track was ejected): enter the playlist at its edge
      if (this.queue.length === 0) return false;
      const entry = delta > 0 ? this.queue[0] : this.queue[this.queue.length - 1];
      await this.load(entry, { autoplay: opts.autoplay ?? false });
      return true;
    }
    const target = this.queue[i + delta];
    if (!target) return false;
    const autoplay = opts.autoplay ?? this.playing;
    await this.load(target, { autoplay });
    return true;
  }

  hasStep(delta: number): boolean {
    const i = this.queueIndex;
    if (i < 0) return this.queue.length > 0;
    return !!this.queue[i + delta];
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
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
      this.pitchNode = null;
    }
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

import { TFile } from "obsidian";
import type SongwriterPlugin from "./main";
import { PlayerEngine } from "./engine";
import { analyzeAudio, WAVE_BINS as BINS } from "./analysis";
import { TrackData, formatTime } from "./types";
import { t } from "./i18n";

/**
 * Canvas waveform: click to play, double click to set the marker, drag to
 * select or resize the A-B loop zone. Peaks come from the shared analysis
 * module (one decode per file); playback itself goes through the engine's
 * <audio>, not Web Audio.
 *
 * Two roles:
 *  - the sidebar renderer *follows the engine*: it always shows whatever track
 *    is loaded and is always "active" (full interaction, live playhead);
 *  - an inline (`bound`) renderer is pinned to one file. It draws that file's
 *    peaks, marker and zone from saved data, but only reflects the engine's
 *    playhead while its file is the loaded track. When it is not, a tap asks
 *    the host to make it the active track (`onActivate`).
 */
export class WaveformRenderer {
  private plugin: SongwriterPlugin;
  private engine: PlayerEngine;
  private bound: boolean;
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hoverLine: HTMLElement;
  private hoverTime: HTMLElement;
  private loadingEl: HTMLElement;

  private shownFile: TFile | null = null;
  private fileDuration = 0;
  private peaks: Float32Array | null = null;
  private decodeToken = 0;
  private rafId = 0;
  private pendingDraw = 0;
  private dirty = true;
  private lastDrawnTime = -1;
  private resizeObserver: ResizeObserver;
  private dragZone: { a: number; b: number } | null = null;
  private colors = { base: "#888", played: "#7aa2f7", cursor: "#7aa2f7", marker: "#e0a03c" };

  onTick: (() => void) | null = null;
  /** Bound renderers only: called with the clicked time when the user taps an
   *  inactive waveform, asking the host to load this file and play from there. */
  onActivate: ((time: number) => void) | null = null;

  constructor(plugin: SongwriterPlugin, engine: PlayerEngine, container: HTMLElement, bound = false) {
    this.plugin = plugin;
    this.engine = engine;
    this.bound = bound;

    this.wrap = container.createDiv({ cls: "sw-wave" });
    this.canvas = this.wrap.createEl("canvas", { cls: "sw-wave-canvas" });
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.hoverLine = this.wrap.createDiv({ cls: "sw-wave-hover-line" });
    this.hoverTime = this.wrap.createDiv({ cls: "sw-wave-hover-time" });
    this.loadingEl = this.wrap.createDiv({ cls: "sw-wave-loading", text: t("waveLoading") });
    this.hideHover();
    this.loadingEl.hide();

    this.bindPointer();
    this.refreshColors();

    this.resizeObserver = new ResizeObserver(() => this.markDirty());
    this.resizeObserver.observe(this.wrap);

    this.startLoopIfActive();
  }

  destroy() {
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    if (this.pendingDraw) window.cancelAnimationFrame(this.pendingDraw);
    this.rafId = 0;
    this.pendingDraw = 0;
    this.resizeObserver.disconnect();
  }

  // ---- active state & duration ----
  // A bound renderer is "active" only while its file is the loaded track; the
  // sidebar renderer (bound === false) always follows the engine.

  private get active(): boolean {
    if (!this.bound) return true;
    const f = this.shownFile;
    return !!f && this.engine.file?.path === f.path;
  }

  /** Something to draw at all (peaks may still be decoding). */
  private get hasContent(): boolean {
    return this.bound ? !!this.shownFile : !!this.engine.file;
  }

  /** Duration to map x⇄time against: the engine's when active, the file's own
   *  decoded duration when this bound waveform is not the loaded track. */
  private get dur(): number {
    return this.active ? this.engine.duration : this.fileDuration;
  }

  /** Duration currently used for layout: the engine's while active, the file's
   *  own decoded duration otherwise. Lets the host show a total for a track
   *  that is not loaded yet. 0 until known. */
  get shownDuration(): number {
    return this.dur;
  }

  /** Whether this waveform's file is the loaded track right now. */
  get isActive(): boolean {
    return this.active;
  }

  private trackData(): TrackData | null {
    const path = this.bound ? this.shownFile?.path : this.engine.file?.path;
    return path ? this.plugin.settings.tracks[path] ?? null : null;
  }

  private get shownLoop(): { a: number; b: number } | null {
    if (this.active) return this.engine.loop;
    const d = this.trackData();
    if (!d || d.loopA === null || d.loopB === null) return null;
    return { a: d.loopA, b: d.loopB };
  }

  /** Host hook (bound renderers): re-evaluate active state when the loaded
   *  track changes — start/stop the animation loop and repaint the playhead. */
  refreshActive() {
    this.startLoopIfActive();
    this.markDirty();
  }

  // ---- animation ----
  // The permanent rAF runs only while this renderer is active (playhead can
  // move). Parked/inactive renderers repaint on demand via a one-shot frame,
  // so a note full of inline waveforms costs almost nothing when idle.

  private startLoopIfActive() {
    if (this.active) {
      if (this.rafId === 0) this.rafId = window.requestAnimationFrame(this.loop);
    } else if (this.rafId !== 0) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private loop = () => {
    this.rafId = window.requestAnimationFrame(this.loop);
    const now = this.engine.audio.currentTime;
    // redraw on any position change (playing OR a paused seek) or a dirty
    // flag; skip work entirely when idle. onTick rides along so the time
    // readout tracks the playhead without a separate 60fps drumbeat.
    if (this.dirty || now !== this.lastDrawnTime) {
      this.draw();
      this.lastDrawnTime = now;
      this.dirty = false;
      this.onTick?.();
    }
  };

  markDirty() {
    this.dirty = true;
    // parked (inactive) renderer: no permanent loop is running, so schedule a
    // single frame to repaint the static waveform.
    if (this.rafId === 0 && this.pendingDraw === 0) {
      this.pendingDraw = window.requestAnimationFrame(() => {
        this.pendingDraw = 0;
        if (this.dirty) {
          this.draw();
          this.dirty = false;
          this.onTick?.();
        }
      });
    }
  }

  refreshColors() {
    const style = getComputedStyle(this.wrap.ownerDocument.body);
    const v = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      base: v("--text-faint", "#888"),
      played: v("--interactive-accent", "#7aa2f7"),
      cursor: v("--text-normal", "#ddd"),
      marker: v("--color-orange", "#e0a03c")
    };
    this.markDirty();
  }

  async setFile(file: TFile | null) {
    const token = ++this.decodeToken;
    this.shownFile = file;
    this.peaks = null;
    this.fileDuration = 0;
    this.loadingEl.hide();
    this.startLoopIfActive();
    this.markDirty();
    if (!file) return;

    this.loadingEl.show();
    let data: Awaited<ReturnType<typeof analyzeAudio>> = null;
    try {
      data = await analyzeAudio(this.plugin.app, file);
    } catch (e) {
      console.warn("Songwriter: waveform decode failed", e);
    }
    if (token !== this.decodeToken) return; // another track was loaded meanwhile
    this.peaks = data?.peaks ?? null;
    this.fileDuration = data?.duration ?? 0;
    this.loadingEl.hide();
    this.markDirty();
  }

  // ---- interaction ----
  // single click: play from there · double click: set marker
  // drag on empty space: select an A-B loop zone · drag a zone edge: resize it
  // an inactive bound waveform ignores all of this — a tap just activates it.

  private bindPointer() {
    const DRAG_THRESHOLD_PX = 5;
    const EDGE_GRAB_PX = 7;
    const MIN_ZONE_SEC = 0.2;
    type Mode = "idle" | "maybe-click" | "select" | "resize-a" | "resize-b";
    let mode: Mode = "idle";
    let downX = 0;
    let downTime = 0;

    const timeAtX = (clientX: number): number => {
      const rect = this.wrap.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const d = this.dur;
      return rect.width > 0 ? (x / rect.width) * d : 0;
    };

    const edgeAt = (clientX: number): "a" | "b" | null => {
      const lp = this.engine.loop;
      const d = this.dur;
      if (!lp || d <= 0) return null;
      const rect = this.wrap.getBoundingClientRect();
      if (rect.width === 0) return null;
      const px = clientX - rect.left;
      const xA = (lp.a / d) * rect.width;
      const xB = (lp.b / d) * rect.width;
      if (Math.abs(px - xA) <= EDGE_GRAB_PX) return "a";
      if (Math.abs(px - xB) <= EDGE_GRAB_PX) return "b";
      return null;
    };

    // Inactive bound waveform: a plain click activates it (and plays from the
    // clicked position). The pointer-drag machinery below stays disarmed.
    this.wrap.addEventListener("click", (e) => {
      if (this.active || !this.hasContent) return;
      this.onActivate?.(timeAtX(e.clientX));
    });

    this.wrap.addEventListener("pointerdown", (e) => {
      if (!this.active || !this.engine.file || e.button !== 0) return;
      const edge = edgeAt(e.clientX);
      const lp = this.engine.loop;
      if (edge && lp) {
        mode = edge === "a" ? "resize-a" : "resize-b";
        this.dragZone = { ...lp };
      } else {
        mode = "maybe-click";
        downX = e.clientX;
        downTime = timeAtX(e.clientX);
      }
      this.wrap.setPointerCapture(e.pointerId);
    });

    this.wrap.addEventListener("pointermove", (e) => {
      if (mode === "maybe-click" && Math.abs(e.clientX - downX) > DRAG_THRESHOLD_PX) {
        mode = "select";
      }
      if (mode === "select") {
        const now = timeAtX(e.clientX);
        this.dragZone = { a: Math.min(downTime, now), b: Math.max(downTime, now) };
        this.markDirty();
      } else if (mode === "resize-a" && this.dragZone) {
        this.dragZone.a = Math.max(0, Math.min(timeAtX(e.clientX), this.dragZone.b - MIN_ZONE_SEC));
        this.markDirty();
      } else if (mode === "resize-b" && this.dragZone) {
        this.dragZone.b = Math.max(timeAtX(e.clientX), this.dragZone.a + MIN_ZONE_SEC);
        this.markDirty();
      } else if (mode === "idle" && this.active) {
        this.wrap.toggleClass("sw-wave-resize", edgeAt(e.clientX) !== null);
      }
      this.showHover(e);
    });

    this.wrap.addEventListener("pointerup", (e) => {
      if (this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
      const dragged = mode === "select" || mode === "resize-a" || mode === "resize-b";
      if (dragged && this.dragZone) {
        this.engine.setLoopZone(this.dragZone.a, this.dragZone.b);
      } else if (mode === "maybe-click") {
        void this.engine.playAt(downTime);
      }
      mode = "idle";
      this.dragZone = null;
      this.markDirty();
    });

    this.wrap.addEventListener("pointercancel", () => {
      mode = "idle";
      this.dragZone = null;
      this.markDirty();
    });

    this.wrap.addEventListener("dblclick", (e) => {
      if (!this.active || !this.engine.file) return;
      this.engine.setMarkerAt(timeAtX(e.clientX));
    });
    this.wrap.addEventListener("pointerleave", () => this.hideHover());
  }

  private showHover(e: PointerEvent) {
    const d = this.dur;
    if (!this.hasContent || d <= 0) {
      this.hideHover();
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    this.hoverLine.show();
    this.hoverTime.show();
    this.hoverLine.style.left = `${x}px`;
    this.hoverTime.setText(formatTime((x / Math.max(rect.width, 1)) * d, true));
    const bubbleHalf = this.hoverTime.offsetWidth / 2;
    const bx = Math.min(Math.max(x, bubbleHalf), rect.width - bubbleHalf);
    this.hoverTime.style.left = `${bx}px`;
  }

  private hideHover() {
    this.hoverLine.hide();
    this.hoverTime.hide();
  }

  // ---- drawing ----

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.wrap.clientWidth;
    const cssH = this.wrap.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    if (!this.hasContent) return;

    const d = this.dur;
    // playhead/played colouring only when this waveform is the live track
    const progress = this.active && d > 0 ? this.engine.audio.currentTime / d : 0;
    const progressX = progress * W;

    // waveform columns
    const colW = Math.max(1, Math.round(2 * dpr));
    const gap = Math.max(1, Math.round(1 * dpr));
    const stepX = colW + gap;
    const cols = Math.max(1, Math.floor(W / stepX));
    const mid = H / 2;
    const maxAmp = mid - 2 * dpr;

    for (let i = 0; i < cols; i++) {
      let amp = 0.18; // placeholder bar height when peaks are unavailable
      if (this.peaks) {
        const from = Math.floor((i / cols) * BINS);
        const to = Math.max(from + 1, Math.floor(((i + 1) / cols) * BINS));
        let peak = 0;
        for (let j = from; j < to; j++) if (this.peaks[j] > peak) peak = this.peaks[j];
        amp = peak;
      }
      const h = Math.max(1 * dpr, amp * maxAmp);
      const x = i * stepX;
      const played = this.active && x + colW <= progressX;
      ctx.fillStyle = played ? this.colors.played : this.colors.base;
      ctx.globalAlpha = played ? 1 : 0.55;
      ctx.fillRect(x, mid - h, colW, h * 2);
    }
    ctx.globalAlpha = 1;

    // A-B loop zone (saved, or being dragged right now)
    const zone = this.dragZone ?? this.shownLoop;
    if (zone && d > 0) {
      const x1 = (zone.a / d) * W;
      const x2 = (zone.b / d) * W;
      ctx.fillStyle = this.colors.played;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x1, 0, x2 - x1, H);
      ctx.globalAlpha = 0.7;
      ctx.fillRect(Math.round(x1), 0, Math.max(1, dpr), H);
      ctx.fillRect(Math.round(x2), 0, Math.max(1, dpr), H);
      ctx.globalAlpha = 1;
    }

    // marker flag
    const data = this.trackData();
    if (data && data.marker !== null && d > 0) {
      const x = Math.round((data.marker / d) * W);
      ctx.fillStyle = this.colors.marker;
      ctx.fillRect(x, 0, Math.max(1.5 * dpr, 1), H);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7 * dpr, 3 * dpr);
      ctx.lineTo(x, 6 * dpr);
      ctx.closePath();
      ctx.fill();
    }

    // playhead (live track only)
    if (this.active) {
      ctx.fillStyle = this.colors.cursor;
      ctx.fillRect(Math.round(progressX), 0, Math.max(1, dpr), H);
    }
  }
}

import { TFile } from "obsidian";
import type SongwriterPlugin from "./main";
import { PlayerEngine } from "./engine";
import { analyzePeaks, WAVE_BINS as BINS } from "./analysis";
import { formatTime } from "./types";
import { t } from "./i18n";

/**
 * Canvas waveform: click to play, double click to set the marker, drag to
 * select or resize the A-B loop zone. Peaks come from the shared analysis
 * module (one decode per file); playback itself goes through the engine's
 * <audio>, not Web Audio.
 */
export class WaveformRenderer {
  private plugin: SongwriterPlugin;
  private engine: PlayerEngine;
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hoverLine: HTMLElement;
  private hoverTime: HTMLElement;
  private loadingEl: HTMLElement;

  private peaks: Float32Array | null = null;
  private decodeToken = 0;
  private rafId = 0;
  private dirty = true;
  private lastDrawnTime = -1;
  private resizeObserver: ResizeObserver;
  private dragZone: { a: number; b: number } | null = null;
  private colors = { base: "#888", played: "#7aa2f7", cursor: "#7aa2f7", marker: "#e0a03c" };

  onTick: (() => void) | null = null;

  constructor(plugin: SongwriterPlugin, engine: PlayerEngine, container: HTMLElement) {
    this.plugin = plugin;
    this.engine = engine;

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

    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      const t = this.engine.audio.currentTime;
      if (this.dirty || (this.engine.playing && t !== this.lastDrawnTime)) {
        this.draw();
        this.lastDrawnTime = t;
        this.dirty = false;
      }
      if (this.onTick) this.onTick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
  }

  markDirty() {
    this.dirty = true;
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
    this.peaks = null;
    this.loadingEl.hide();
    this.markDirty();
    if (!file) return;

    this.loadingEl.show();
    let peaks: Float32Array | null = null;
    try {
      peaks = await analyzePeaks(this.plugin.app, file);
    } catch (e) {
      console.warn("Songwriter: waveform decode failed", e);
    }
    if (token !== this.decodeToken) return; // another track was loaded meanwhile
    this.peaks = peaks;
    this.loadingEl.hide();
    this.markDirty();
  }

  // ---- interaction ----
  // single click: play from there · double click: set marker
  // drag on empty space: select an A-B loop zone · drag a zone edge: resize it

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
      const d = this.engine.duration;
      return rect.width > 0 ? (x / rect.width) * d : 0;
    };

    const edgeAt = (clientX: number): "a" | "b" | null => {
      const lp = this.engine.loop;
      const d = this.engine.duration;
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

    this.wrap.addEventListener("pointerdown", (e) => {
      if (!this.engine.file || e.button !== 0) return;
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
        const t = timeAtX(e.clientX);
        this.dragZone = { a: Math.min(downTime, t), b: Math.max(downTime, t) };
        this.markDirty();
      } else if (mode === "resize-a" && this.dragZone) {
        this.dragZone.a = Math.max(0, Math.min(timeAtX(e.clientX), this.dragZone.b - MIN_ZONE_SEC));
        this.markDirty();
      } else if (mode === "resize-b" && this.dragZone) {
        this.dragZone.b = Math.max(timeAtX(e.clientX), this.dragZone.a + MIN_ZONE_SEC);
        this.markDirty();
      } else if (mode === "idle") {
        this.wrap.toggleClass("sw-wave-resize", edgeAt(e.clientX) !== null);
      }
      this.showHover(e);
    });

    this.wrap.addEventListener("pointerup", (e) => {
      if (this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
      if (mode === "select" && this.dragZone) {
        this.engine.setLoopZone(this.dragZone.a, this.dragZone.b);
      } else if ((mode === "resize-a" || mode === "resize-b") && this.dragZone) {
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
      if (!this.engine.file) return;
      this.engine.setMarkerAt(timeAtX(e.clientX));
    });
    this.wrap.addEventListener("pointerleave", () => this.hideHover());
  }

  private showHover(e: PointerEvent) {
    if (!this.engine.file) {
      this.hideHover();
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const d = this.engine.duration;
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
    if (!this.engine.file) return;

    const d = this.engine.duration;
    const progress = d > 0 ? this.engine.audio.currentTime / d : 0;
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
      ctx.fillStyle = x + colW <= progressX ? this.colors.played : this.colors.base;
      ctx.globalAlpha = x + colW <= progressX ? 1 : 0.55;
      ctx.fillRect(x, mid - h, colW, h * 2);
    }
    ctx.globalAlpha = 1;

    // A-B loop zone (saved or being dragged right now)
    const data = this.engine.peekData();
    const savedLoop = this.engine.loop;
    const zone = this.dragZone ?? savedLoop;
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

    // playhead
    ctx.fillStyle = this.colors.cursor;
    ctx.fillRect(Math.round(progressX), 0, Math.max(1, dpr), H);
  }
}

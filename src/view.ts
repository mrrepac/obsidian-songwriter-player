import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { PlayerEngine } from "./engine";
import { EXT_BTN_TITLE, openExternally, revealInExplorer } from "./external";
import { WaveformRenderer } from "./waveform";
import { formatPlayed, formatTime } from "./types";
import { t } from "./i18n";

export const VIEW_TYPE_SONGWRITER = "songwriter-player";

export class SongwriterView extends ItemView {
  private plugin: SongwriterPlugin;
  private engine: PlayerEngine;
  private wave: WaveformRenderer | null = null;

  private trackRow: HTMLElement;
  private pendingRow: HTMLElement;
  private waveWrap: HTMLElement;
  private timeCurrent: HTMLElement;
  private timeTotal: HTMLElement;
  private playBtn: HTMLButtonElement;
  private playsEl: HTMLElement | null = null;
  private emptyEl: HTMLElement;
  private contentRoot: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: SongwriterPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.engine = plugin.engine;
  }

  getViewType(): string {
    return VIEW_TYPE_SONGWRITER;
  }

  getDisplayText(): string {
    return "Songwriter";
  }

  getIcon(): string {
    return "music";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("sw-root");

    this.emptyEl = root.createDiv({ cls: "sw-empty" });
    this.emptyEl.createDiv({ text: t("emptyTitle") });
    this.emptyEl.createDiv({
      cls: "sw-empty-hint",
      text: t("emptyHint")
    });
    const pickBtn = this.emptyEl.createEl("button", { text: t("pickFromNote") });
    pickBtn.addEventListener("click", () => this.plugin.loadFromActiveNote(false));

    this.contentRoot = root.createDiv({ cls: "sw-player" });

    this.trackRow = this.contentRoot.createDiv({ cls: "sw-track-row" });

    this.pendingRow = this.contentRoot.createDiv({ cls: "sw-pending" });

    this.waveWrap = this.contentRoot.createDiv({ cls: "sw-wave-wrap" });
    this.wave = new WaveformRenderer(this.plugin, this.engine, this.waveWrap);
    this.wave.onTick = () => {
      this.updateCurrentTime();
      this.updatePlays(); // listened time grows while playing
    };

    // time · transport buttons · volume — a single line
    const controls = this.contentRoot.createDiv({ cls: "sw-controls" });

    const time = controls.createDiv({ cls: "sw-time" });
    this.timeCurrent = time.createSpan({ cls: "sw-time-current", text: "0:00.0" });
    time.createSpan({ cls: "sw-time-sep", text: "/" });
    this.timeTotal = time.createSpan({ cls: "sw-time-total", text: "0:00" });

    this.buildTransport(controls);

    const volWrap = controls.createDiv({ cls: "sw-volume" });
    const volIcon = volWrap.createSpan({ cls: "sw-volume-icon" });
    setIcon(volIcon, "volume-2");
    const vol = volWrap.createEl("input", { cls: "sw-volume-slider", type: "range" });
    vol.min = "0";
    vol.max = "1";
    vol.step = "0.01";
    vol.value = String(this.plugin.settings.volume);
    vol.title = t("volume");
    vol.addEventListener("input", () => this.engine.setVolume(parseFloat(vol.value)));

    // engine → UI
    this.registerEvent(this.engine.on("track-changed", () => this.renderAll()));
    this.registerEvent(this.engine.on("play-state", () => this.updatePlayButton()));
    this.registerEvent(this.engine.on("data-changed", () => {
      this.updatePlays();
      this.wave?.markDirty();
    }));
    this.registerEvent(this.engine.on("note-audios", () => this.renderTrackRow()));
    this.registerEvent(this.engine.on("pending-switch", () => this.renderPending()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.wave?.refreshColors()));

    this.registerDomEvent(this.engine.audio, "durationchange", () => this.updateTotalTime());

    this.applySettings();
    this.renderAll();
  }

  applySettings() {
    this.contentEl.style.setProperty("--sw-wave-height", `${this.plugin.settings.waveHeight}px`);
    this.refreshSeekTitles();
  }

  async onClose() {
    this.wave?.destroy();
    this.wave = null;
  }

  private buildTransport(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "sw-transport" });

    const toStartBtn = this.transportBtn(bar, "skip-back", t("playFromMarkerTitle"));
    toStartBtn.addEventListener("click", () => this.engine.playFromMarker());

    const backBtn = this.transportBtn(bar, "chevrons-left", "");
    backBtn.addClass("sw-seek-back");
    backBtn.addEventListener("click", () => this.engine.seekBy(-this.plugin.settings.skipSeconds));

    this.playBtn = this.transportBtn(bar, "play", t("playPauseTitle"));
    this.playBtn.addClass("sw-play-btn");
    this.playBtn.addEventListener("click", () => this.engine.playPause());

    const fwdBtn = this.transportBtn(bar, "chevrons-right", "");
    fwdBtn.addClass("sw-seek-fwd");
    fwdBtn.addEventListener("click", () => this.engine.seekBy(this.plugin.settings.skipSeconds));

    const flagBtn = this.transportBtn(bar, "flag", t("setMarkerTitle"));
    flagBtn.addClass("sw-flag-btn");
    flagBtn.addEventListener("click", () => this.engine.setMarkerHere());

    this.refreshSeekTitles();
  }

  private transportBtn(parent: HTMLElement, icon: string, title: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "sw-tbtn" });
    setIcon(btn, icon);
    if (title) btn.title = title;
    return btn;
  }

  refreshSeekTitles() {
    const s = this.plugin.settings.skipSeconds;
    const back = this.contentRoot.querySelector<HTMLElement>(".sw-seek-back");
    const fwd = this.contentRoot.querySelector<HTMLElement>(".sw-seek-fwd");
    if (back) back.title = t("seekBackTitle")(s);
    if (fwd) fwd.title = t("seekFwdTitle")(s);
  }

  private iconBtn(parent: HTMLElement, icon: string, title: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "clickable-icon sw-icon-btn" });
    setIcon(btn, icon);
    if (title) btn.title = title;
    return btn;
  }

  // ---- renders ----

  private renderAll() {
    const hasTrack = !!this.engine.file;
    this.emptyEl.toggle(!hasTrack);
    this.contentRoot.toggle(hasTrack);
    this.renderTrackRow();
    this.renderPending();
    this.updatePlayButton();
    this.updateTotalTime();
    this.updateCurrentTime();
    this.wave?.setFile(this.engine.file);
    this.wave?.markDirty();
  }

  private renderTrackRow() {
    this.trackRow.empty();
    this.playsEl = null;
    const file = this.engine.file;
    const audios = this.engine.noteAudios;
    const icon = this.trackRow.createSpan({ cls: "sw-track-icon" });
    setIcon(icon, "music");

    if (audios.length > 1) {
      const sel = this.trackRow.createEl("select", { cls: "dropdown sw-track-select" });
      let hasCurrent = false;
      for (const f of audios) {
        const opt = sel.createEl("option", { text: f.basename });
        opt.value = f.path;
        if (file && f.path === file.path) hasCurrent = true;
      }
      if (file && !hasCurrent) {
        const opt = sel.createEl("option", { text: file.basename });
        opt.value = file.path;
      }
      if (file) sel.value = file.path;
      sel.title = t("noteAudiosTitle");
      sel.addEventListener("change", () => {
        const f = this.app.vault.getAbstractFileByPath(sel.value);
        if (f instanceof TFile) this.engine.load(f, { autoplay: this.engine.playing });
      });
    } else {
      const name = this.trackRow.createSpan({
        cls: "sw-track-name",
        text: file ? file.basename : "—"
      });
      if (file) {
        name.addClass("sw-track-name-link");
        name.title = t("openTrackNoteTitle");
        name.addEventListener("click", () => this.plugin.openTrackNote());
      }
    }

    if (file) {
      this.playsEl = this.trackRow.createSpan({ cls: "sw-plays" });
      this.playsEl.title = t("playsTitle");
      this.playsEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.engine.resetPlays();
      });
      this.updatePlays();

      const extBtn = this.trackRow.createEl("button", { cls: "clickable-icon sw-icon-btn sw-ext-open" });
      setIcon(extBtn, "external-link");
      extBtn.title = EXT_BTN_TITLE;
      extBtn.addEventListener("click", () => void openExternally(this.app, file));
      extBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        revealInExplorer(this.app, file);
      });

      const ejectBtn = this.trackRow.createEl("button", { cls: "clickable-icon sw-icon-btn sw-eject" });
      setIcon(ejectBtn, "arrow-up-from-line");
      ejectBtn.title = t("ejectTitle");
      ejectBtn.addEventListener("click", () => this.engine.unload());
    }
  }

  private lastPlaysText = "";
  private updatePlays() {
    if (!this.playsEl) return;
    const data = this.engine.peekData();
    const text = `▶ ${data?.plays ?? 0} · ${formatPlayed(data?.playedSec ?? 0)}`;
    if (text !== this.lastPlaysText) {
      this.lastPlaysText = text;
      this.playsEl.setText(text);
    }
  }

  private renderPending() {
    this.pendingRow.empty();
    const pending = this.engine.pendingSwitch;
    this.pendingRow.toggle(!!pending);
    if (!pending) return;
    this.pendingRow.createSpan({
      cls: "sw-pending-text",
      text: t("pendingInNote")(pending.basename),
      title: pending.path
    });
    const switchBtn = this.pendingRow.createEl("button", { text: t("switchBtn") });
    switchBtn.addEventListener("click", () => {
      this.engine.load(pending, { autoplay: this.engine.playing });
    });
    const closeBtn = this.pendingRow.createEl("button", { cls: "clickable-icon sw-icon-btn" });
    setIcon(closeBtn, "x");
    closeBtn.title = t("hideBtn");
    closeBtn.addEventListener("click", () => this.engine.setPendingSwitch(null));
  }

  private updatePlayButton() {
    if (!this.playBtn) return;
    setIcon(this.playBtn, this.engine.playing ? "pause" : "play");
  }

  private lastTimeText = "";
  private updateCurrentTime() {
    if (!this.timeCurrent) return;
    const text = formatTime(this.engine.audio.currentTime, true);
    if (text !== this.lastTimeText) {
      this.lastTimeText = text;
      this.timeCurrent.setText(text);
    }
  }

  private updateTotalTime() {
    if (!this.timeTotal) return;
    this.timeTotal.setText(formatTime(this.engine.duration));
  }
}

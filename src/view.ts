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
  private playlistEl: HTMLElement;
  private playlistList: HTMLElement;
  private playlistIcon: HTMLElement;
  private playlistTitle: HTMLElement;
  private playlistCount: HTMLElement;
  private playlistChevron: HTMLElement;
  private playlistRows = new Map<string, { flag: HTMLElement; plays: HTMLElement }>();
  private waveWrap: HTMLElement;
  private timeCurrent: HTMLElement;
  private timeTotal: HTMLElement;
  private playBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
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
    return "Songwriter Player";
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
    pickBtn.addEventListener("click", () => {
      void this.plugin.loadFromActiveNote(false);
    });

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

    // the playlist lives outside the player block, so it stays reachable
    // after the track is ejected — pick the next one right from the list
    this.buildPlaylist(root);

    // engine → UI
    this.registerEvent(this.engine.on("track-changed", () => this.renderAll()));
    this.registerEvent(this.engine.on("play-state", () => this.updatePlayButton()));
    this.registerEvent(this.engine.on("data-changed", () => {
      this.updatePlays();
      this.updatePlaylistRow();
      this.wave?.markDirty();
    }));
    this.registerEvent(this.engine.on("queue-changed", () => {
      this.renderTrackRow();
      this.renderPlaylist();
    }));
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

    this.prevBtn = this.transportBtn(bar, "step-back", t("prevTrackTitle"));
    this.prevBtn.addClass("sw-queue-btn");
    this.prevBtn.addEventListener("click", () => {
      void this.engine.step(-1);
    });

    const toStartBtn = this.transportBtn(bar, "skip-back", t("playFromMarkerTitle"));
    toStartBtn.addEventListener("click", () => {
      void this.engine.playFromMarker();
    });

    const backBtn = this.transportBtn(bar, "chevrons-left", "");
    backBtn.addClass("sw-seek-back");
    backBtn.addEventListener("click", () => this.engine.seekBy(-this.plugin.settings.skipSeconds));

    this.playBtn = this.transportBtn(bar, "play", t("playPauseTitle"));
    this.playBtn.addClass("sw-play-btn");
    this.playBtn.addEventListener("click", () => {
      void this.engine.playPause();
    });

    const fwdBtn = this.transportBtn(bar, "chevrons-right", "");
    fwdBtn.addClass("sw-seek-fwd");
    fwdBtn.addEventListener("click", () => this.engine.seekBy(this.plugin.settings.skipSeconds));

    const flagBtn = this.transportBtn(bar, "flag", t("setMarkerTitle"));
    flagBtn.addClass("sw-flag-btn");
    flagBtn.addEventListener("click", () => this.engine.setMarkerHere());

    this.nextBtn = this.transportBtn(bar, "step-forward", t("nextTrackTitle"));
    this.nextBtn.addClass("sw-queue-btn");
    this.nextBtn.addEventListener("click", () => {
      void this.engine.step(1);
    });

    this.refreshSeekTitles();
  }

  /** ⏮ ⏭ only make sense with a playlist, and only where there is a neighbor. */
  private updateQueueButtons() {
    if (!this.prevBtn || !this.nextBtn) return;
    const many = this.engine.queue.length > 1;
    this.prevBtn.toggle(many);
    this.nextBtn.toggle(many);
    this.prevBtn.disabled = !this.engine.hasStep(-1);
    this.nextBtn.disabled = !this.engine.hasStep(1);
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

  // ---- renders ----

  private renderAll() {
    const hasTrack = !!this.engine.file;
    this.emptyEl.toggle(!hasTrack);
    this.contentRoot.toggle(hasTrack);
    this.renderTrackRow();
    this.renderPending();
    this.renderPlaylist();
    this.updatePlayButton();
    this.updateTotalTime();
    this.updateCurrentTime();
    void this.wave?.setFile(this.engine.file);
    this.wave?.markDirty();
  }

  private renderTrackRow() {
    this.trackRow.empty();
    this.playsEl = null;
    const file = this.engine.file;
    const icon = this.trackRow.createSpan({ cls: "sw-track-icon" });
    setIcon(icon, "music");

    const name = this.trackRow.createSpan({
      cls: "sw-track-name",
      text: file ? file.basename : "—"
    });
    if (file) {
      name.addClass("sw-track-name-link");
      name.title = t("openTrackNoteTitle");
      name.addEventListener("click", () => {
        void this.plugin.openTrackNote();
      });
      this.makeRowDraggable(name, file); // the loaded track drags into a note too
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
      extBtn.addEventListener("click", () => openExternally(this.app, file));
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
      text: t("pendingSwitchText")(pending.basename),
      title: pending.path
    });
    const switchBtn = this.pendingRow.createEl("button", { text: t("switchBtn") });
    switchBtn.addEventListener("click", () => {
      void this.engine.load(pending, { autoplay: this.engine.playing });
    });
    const closeBtn = this.pendingRow.createEl("button", { cls: "clickable-icon sw-icon-btn" });
    setIcon(closeBtn, "x");
    closeBtn.title = t("hideBtn");
    closeBtn.addEventListener("click", () => this.engine.setPendingSwitch(null));
  }

  // ---- playlist ----

  private buildPlaylist(parent: HTMLElement) {
    this.playlistEl = parent.createDiv({ cls: "sw-playlist" });

    const head = this.playlistEl.createDiv({ cls: "sw-playlist-head" });
    head.title = t("playlistToggleTitle");
    this.playlistIcon = head.createSpan({ cls: "sw-playlist-icon" });
    this.playlistTitle = head.createSpan({ cls: "sw-playlist-title" });
    this.playlistCount = head.createSpan({ cls: "sw-playlist-count" });
    this.playlistChevron = head.createSpan({ cls: "sw-playlist-chevron" });
    head.addEventListener("click", () => {
      this.plugin.settings.playlistCollapsed = !this.plugin.settings.playlistCollapsed;
      void this.plugin.saveSettings();
      this.applyPlaylistCollapsed();
    });

    this.playlistList = this.playlistEl.createDiv({ cls: "sw-playlist-list" });
  }

  private applyPlaylistCollapsed() {
    const collapsed = this.plugin.settings.playlistCollapsed;
    this.playlistList.toggle(!collapsed);
    setIcon(this.playlistChevron, collapsed ? "chevron-right" : "chevron-down");
  }

  private renderPlaylist() {
    if (!this.playlistEl) return;
    this.updateQueueButtons();

    const queue = this.engine.queue;
    const source = this.engine.queueSource;
    // a lone track is not a playlist — the track row already says everything
    this.playlistEl.toggle(queue.length > 1);
    if (queue.length <= 1) return;

    setIcon(this.playlistIcon, source?.kind === "folder" ? "folder" : "file-text");
    this.playlistTitle.setText(source?.name ?? "");
    this.playlistTitle.title = source
      ? `${source.kind === "folder" ? t("playlistFromFolder") : t("playlistFromNote")} · ${source.path}`
      : "";
    this.playlistCount.setText(String(queue.length));
    this.playlistCount.title = t("playlistCountTitle")(queue.length);
    this.applyPlaylistCollapsed();

    this.playlistList.empty();
    this.playlistRows.clear();
    const currentPath = this.engine.file?.path;
    queue.forEach((f, i) => {
      const row = this.playlistList.createDiv({ cls: "sw-pl-row" });
      const isCurrent = f.path === currentPath;
      if (isCurrent) row.addClass("is-current");
      const num = row.createSpan({ cls: "sw-pl-num" });
      if (isCurrent) setIcon(num, this.engine.playing ? "volume-2" : "pause");
      else num.setText(String(i + 1));
      row.createSpan({ cls: "sw-pl-name", text: f.basename, title: f.path });
      const flag = row.createSpan({ cls: "sw-pl-flag" });
      const plays = row.createSpan({ cls: "sw-pl-plays" });
      this.playlistRows.set(f.path, { flag, plays });
      this.fillPlaylistRow(f.path);
      row.addEventListener("click", () => {
        if (f.path === this.engine.file?.path) void this.engine.playPause();
        else void this.engine.load(f, { autoplay: this.engine.playing });
      });
      this.makeRowDraggable(row, f);
    });
  }

  /**
   * Drag a playlist row into a note and drop an embed of that track there.
   * The link is built by Obsidian itself, so it follows the vault's link
   * format (wikilink or markdown, shortest or relative path); the leading "!"
   * makes it an embed, which this plugin renders as a waveform player.
   */
  private makeRowDraggable(row: HTMLElement, file: TFile) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      const active = this.app.workspace.getActiveFile();
      const link = this.app.fileManager.generateMarkdownLink(file, active?.path ?? "");
      const embed = link.startsWith("!") ? link : `!${link}`;
      e.dataTransfer?.setData("text/plain", embed);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
  }

  /** Marker flag + play count for one row, straight from saved track data. */
  private fillPlaylistRow(path: string) {
    const els = this.playlistRows.get(path);
    if (!els) return;
    const data = this.plugin.settings.tracks[path];
    const hasMarker = data?.marker !== null && data?.marker !== undefined;
    els.flag.empty();
    if (hasMarker) {
      setIcon(els.flag, "flag");
      els.flag.title = t("rowMarkerTitle");
    }
    els.plays.setText(data?.plays ? `▶ ${data.plays}` : "");
  }

  private updatePlaylistRow() {
    const path = this.engine.file?.path;
    if (path) this.fillPlaylistRow(path);
  }

  private updatePlayButton() {
    if (!this.playBtn) return;
    setIcon(this.playBtn, this.engine.playing ? "pause" : "play");
    const num = this.playlistList?.querySelector<HTMLElement>(".sw-pl-row.is-current .sw-pl-num");
    if (num) setIcon(num, this.engine.playing ? "volume-2" : "pause");
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

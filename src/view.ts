import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { PlayerEngine } from "./engine";
import { EXT_BTN_TITLE, dragOutNatively, openExternally, revealInExplorer } from "./external";
import { WaveformRenderer } from "./waveform";
import { playTriad } from "./tone";
import { transposeKey } from "./pitch";
import { renderedName } from "./render";
import { PlaylistFilter, PlaylistSort, formatKey, formatPlayed, formatTime } from "./types";
import { VERDICTS, Verdict, nextVerdict, rowVisible } from "./playlist";

/** How each verdict looks in a playlist row: its icon and its name. */
const VERDICT_UI: Record<Verdict, { icon: string; label: "verdictUsed" | "verdictSaved" | "verdictDropped" }> = {
  used: { icon: "music", label: "verdictUsed" },
  saved: { icon: "bookmark", label: "verdictSaved" },
  dropped: { icon: "x", label: "verdictDropped" }
};
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
  private sortBtn: HTMLElement;
  private playlistChevron: HTMLElement;
  /** Search, filter and the sorting progress — the tools for going through a pack. */
  private toolsEl: HTMLElement;
  private filterBtn: HTMLElement;
  private progressEl: HTMLElement;
  private measureBtn: HTMLElement;
  private measureIcon = "";
  private noneEl: HTMLElement;
  /** The search is a glance, not a setting: it is not saved, and lives only here. */
  private query = "";
  private playlistRows = new Map<string, {
    row: HTMLElement;
    num: HTMLElement;
    index: number;
    name: string;
    verdict: HTMLElement;
    flag: HTMLElement;
    plays: HTMLElement;
    musical: HTMLElement;
  }>();
  /** Paths currently laid out, so an unchanged playlist is never rebuilt. */
  private renderedPaths: string[] = [];
  /**
   * Dragging a track out of Obsidian has to hand the file over the moment the
   * gesture starts — the browser will not wait for a read. So the bytes are
   * fetched ahead of time, on mousedown, and held as an object URL.
   */
  private dragFile: { path: string; url: string } | null = null;
  /**
   * The path of a readBinary() in flight. Two mousedowns can land before the
   * first read resolves; without this, both would pass prepareDragFile's
   * early-return guard and the URL of whichever loses the race would never be
   * revoked. The one that matters is the one asked for last, not the one that
   * happens to resolve first.
   */
  private dragPending: string | null = null;
  private static readonly DRAG_MIME: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
    opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac", webm: "audio/webm",
    wma: "audio/x-ms-wma", "3gp": "audio/3gpp"
  };
  /** The row marked as playing, so a track change touches two rows, not all. */
  private currentRowPath: string | null = null;
  private musicalEl: HTMLElement | null = null;
  private rateEl: HTMLElement;
  private pitchEl: HTMLElement | null = null;
  private waveWrap: HTMLElement;
  private timeCurrent: HTMLElement;
  private timeTotal: HTMLElement;
  private playBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private playsEl: HTMLElement | null = null;
  private markerBtn: HTMLElement | null = null;
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

    this.rateEl = controls.createSpan({ cls: "sw-rate" });
    this.rateEl.setAttribute("role", "button");
    this.rateEl.addEventListener("click", () => this.onRateClick());
    this.updateRate();

    if (Platform.isDesktop) {
      this.pitchEl = controls.createSpan({ cls: "sw-pitch" });
      this.pitchEl.setAttribute("role", "button");
      this.pitchEl.addEventListener("click", () => this.onPitchClick());
      this.updatePitch();
    }

    const volWrap = controls.createDiv({ cls: "sw-volume" });
    const volIcon = volWrap.createSpan({ cls: "sw-volume-icon" });
    setIcon(volIcon, "volume-2");
    const vol = volWrap.createEl("input", { cls: "sw-volume-slider", type: "range" });
    vol.min = "0";
    vol.max = "1";
    vol.step = "0.01";
    vol.value = String(this.plugin.settings.volume);
    vol.setAttribute("aria-label", t("volume"));
    vol.addEventListener("input", () => this.engine.setVolume(parseFloat(vol.value)));

    // the playlist lives outside the player block, so it stays reachable
    // after the track is ejected — pick the next one right from the list
    this.buildPlaylist(root);

    // engine → UI
    this.registerEvent(this.engine.on("track-changed", () => this.renderAll()));
    this.registerEvent(this.engine.on("play-state", () => this.updatePlayButton()));
    this.registerEvent(this.engine.on("data-changed", () => {
      this.updatePlays();
      this.updateMusical();
      // every row, not just the current one: a verdict can land on any of them
      // from the context menu, and the progress counts the whole list
      this.refillPlaylistRows();
      this.updateMarkerBtn();
      this.wave?.markDirty();
    }));
    this.registerEvent(this.engine.on("queue-changed", () => {
      this.renderTrackRow();
      this.renderPlaylist();
    }));
    this.registerEvent(this.engine.on("pending-switch", () => this.renderPending()));
    this.registerEvent(this.engine.on("rate-changed", () => this.updateRate()));
    this.registerEvent(this.engine.on("pitch-changed", () => this.updatePitch()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.wave?.refreshColors()));

    this.registerDomEvent(this.engine.audio, "durationchange", () => this.updateTotalTime());

    // Bare keys while the panel has focus — clicking anywhere in it gives it
    // focus. Never global: letters there would fire in every search box.
    this.contentEl.tabIndex = -1;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onPanelKey(e));

    this.applySettings();
    this.renderAll();
  }

  /**
   * A S D F mark the loaded track (in a track, saved, dropped, new again),
   * ↑ ↓ walk the playlist and ← → seek by the step set in the settings. Matched by physical key, so the Russian layout
   * works without a second table; a text field keeps its keys.
   */
  private onPanelKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    const marks: Record<string, Verdict | undefined> = { KeyA: "used", KeyS: "saved", KeyD: "dropped", KeyF: undefined };
    if (e.code in marks) {
      const file = this.engine.file;
      if (file) this.plugin.setVerdict(file.path, marks[e.code]);
      else new Notice(t("noTrack"));
    } else if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      void this.engine.step(e.code === "ArrowUp" ? -1 : 1);
    } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      const step = this.plugin.settings.skipSeconds;
      this.engine.seekBy(e.code === "ArrowLeft" ? -step : step);
    } else {
      return;
    }
    e.preventDefault(); // the arrows would scroll the panel too
    e.stopPropagation();
  }

  applySettings() {
    this.contentEl.style.setProperty("--sw-wave-height", `${this.plugin.settings.waveHeight}px`);
    this.refreshSeekLabels();
    // a setting can change what every row shows (the tempo window re-folds them all)
    this.refillPlaylistRows();
  }

  async onClose() {
    this.wave?.destroy();
    this.wave = null;
    // clearing the pending path, not just the held file: a read still in
    // flight would otherwise resolve into a closed view and mint an object
    // URL with nothing left to revoke it
    this.dragPending = null;
    this.releaseDragFile();
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

    this.refreshSeekLabels();
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

  /**
   * aria-label rather than title: these buttons carry an icon and no text, so
   * this is the only name a screen reader has to announce. Obsidian renders
   * its own tooltip from aria-label as well, so setting title on top would
   * show two tooltips at once.
   */
  private transportBtn(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "sw-tbtn" });
    setIcon(btn, icon);
    if (label) btn.setAttribute("aria-label", label);
    return btn;
  }

  refreshSeekLabels() {
    const s = this.plugin.settings.skipSeconds;
    const back = this.contentRoot.querySelector<HTMLElement>(".sw-seek-back");
    const fwd = this.contentRoot.querySelector<HTMLElement>(".sw-seek-fwd");
    back?.setAttribute("aria-label", t("seekBackTitle")(s));
    fwd?.setAttribute("aria-label", t("seekFwdTitle")(s));
  }

  // ---- renders ----

  private renderAll() {
    const hasTrack = !!this.engine.file;
    this.emptyEl.toggle(!hasTrack);
    this.contentRoot.toggle(hasTrack);
    this.renderTrackRow();
    this.renderPending();
    this.renderPlaylist();
    this.updateRate();
    this.updatePitch();
    this.updatePlayButton();
    this.updateTotalTime();
    this.updateCurrentTime();
    void this.wave?.setFile(this.engine.file);
    this.wave?.markDirty();
  }

  private renderTrackRow() {
    this.trackRow.empty();
    this.playsEl = null;
    this.musicalEl = null;
    this.markerBtn = null;
    const file = this.engine.file;
    const icon = this.trackRow.createSpan({ cls: "sw-track-icon" });
    setIcon(icon, "music");

    const name = this.trackRow.createSpan({
      cls: "sw-track-name",
      text: file ? file.basename : "—"
    });
    if (file) {
      name.addClass("sw-track-name-link");
      // role, not aria-label: the track's name is already the visible text, and
      // an aria-label would replace it with the explanation. title stays,
      // because it is read as a description rather than as the name.
      name.setAttribute("role", "button");
      // same "\n"-joined pair buildPlaylistRows puts in a playlist row's
      // title: the click behavior, then the drag hint the gesture needs since
      // nothing else here announces it — no aria-label, see the comment on
      // sortBtn above
      name.title = `${t("openTrackNoteTitle")}\n${t("rowDragHint")}`;
      name.addEventListener("click", () => {
        void this.plugin.openTrackNote();
      });
      this.makeRowDraggable(name, file); // the loaded track drags into a note too
    }

    if (file) {
      this.musicalEl = this.trackRow.createSpan({ cls: "sw-musical" });
      this.musicalEl.setAttribute("role", "button");
      this.musicalEl.addEventListener("click", () => this.onMusicalClick(file));
      this.updateMusical();

      this.playsEl = this.trackRow.createSpan({ cls: "sw-plays" });
      this.playsEl.title = t("playsTitle");
      this.playsEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.engine.resetPlays();
      });
      this.updatePlays();

      const extBtn = this.trackRow.createEl("button", { cls: "clickable-icon sw-icon-btn sw-ext-open" });
      setIcon(extBtn, "external-link");
      extBtn.setAttribute("aria-label", EXT_BTN_TITLE);
      extBtn.addEventListener("click", () => openExternally(this.app, file));
      extBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        revealInExplorer(this.app, file);
      });

      // only there while there is a marker to clear: until now the only way to
      // drop one was three taps of the stop key, which nobody finds by hand
      this.markerBtn = this.trackRow.createEl("button", { cls: "clickable-icon sw-icon-btn sw-marker-clear" });
      setIcon(this.markerBtn, "flag-off");
      this.markerBtn.setAttribute("aria-label", t("clearMarkerTitle"));
      this.markerBtn.addEventListener("click", () => this.engine.clearMarker());
      this.updateMarkerBtn();

      const ejectBtn = this.trackRow.createEl("button", { cls: "clickable-icon sw-icon-btn sw-eject" });
      setIcon(ejectBtn, "arrow-up-from-line");
      ejectBtn.setAttribute("aria-label", t("ejectTitle"));
      ejectBtn.addEventListener("click", () => this.engine.unload());
    }
  }

  // ---- playback speed ----

  /** Shows the tempo it is actually playing at, or the bare factor if unmeasured. */
  private updateRate() {
    if (!this.rateEl) return;
    const rate = this.engine.rate;
    const bpm = this.engine.peekData()?.bpm;
    const off = Math.abs(rate - 1) > 0.001;
    this.rateEl.toggleClass("is-active", off);
    // at the recorded speed it shows the factor, not the tempo: a bare "140"
    // next to the badge in the track row reads as a label, not as a control
    if (bpm && off) {
      this.rateEl.setText(`${Math.round(bpm * rate)} BPM`);
      this.rateEl.title = t("rateTitleBpm")(Math.round(bpm * rate), bpm, rate.toFixed(2));
    } else {
      this.rateEl.setText(`${rate.toFixed(2)}×`);
      this.rateEl.title = bpm ? t("rateTitleBpm")(bpm, bpm, "1.00") : t("rateTitle");
    }
  }

  private onRateClick() {
    if (!this.engine.file) return;
    const bpm = this.engine.peekData()?.bpm;
    const menu = new Menu();
    for (const preset of [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
      const label = bpm
        ? `${preset.toFixed(2)}× — ${Math.round(bpm * preset)} BPM`
        : `${preset.toFixed(2)}×`;
      menu.addItem((item) => item
        .setTitle(preset === 1 ? t("rateOriginal")(label) : label)
        .setChecked(Math.abs(this.engine.rate - preset) < 0.001)
        .onClick(() => this.engine.setRate(preset)));
    }
    const rect = this.rateEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top - 4 });
  }

  // ---- transposition ----

  /** Shows the shift and, when the key is known, where it lands. */
  private updatePitch() {
    const el = this.pitchEl;
    if (!el) return;
    const semitones = this.engine.semitones;
    const d = this.engine.peekData();
    el.toggleClass("is-active", semitones !== 0);
    el.setText(semitones === 0 ? "♯ 0" : (semitones > 0 ? `♯ +${semitones}` : `♯ ${semitones}`));
    el.title = d?.key
      ? t("pitchTitleKey")(formatKey(transposeKey(d.key, semitones), d.scale), formatKey(d.key, d.scale))
      : t("pitchTitle");
  }

  private onPitchClick() {
    if (!this.engine.file) return;
    const d = this.engine.peekData();
    const current = this.engine.semitones;
    const menu = new Menu();
    for (let n = 5; n >= -5; n--) {
      const shift = n === 0 ? "0" : (n > 0 ? `+${n}` : String(n));
      const label = d?.key
        ? `${shift} — ${formatKey(transposeKey(d.key, n), d.scale)}`
        : shift;
      menu.addItem((item) => item
        .setTitle(n === 0 ? t("pitchOriginal")(label) : label)
        .setChecked(current === n)
        .onClick(() => void this.engine.setSemitones(n)));
    }
    if (current !== 0 || Math.abs(this.engine.rate - 1) > 0.001) {
      menu.addSeparator();
      const name = renderedName(this.engine.file.basename, {
        semitones: current,
        rate: this.engine.rate,
        bpm: d?.bpm ?? null
      });
      menu.addItem((item) => item
        .setTitle(t("menuSaveCopy")(name))
        .setIcon("save")
        .onClick(() => void this.plugin.saveTransposedCopy()));
    }

    const rect = this.pitchEl?.getBoundingClientRect();
    menu.showAtPosition({ x: rect?.left ?? 0, y: (rect?.top ?? 0) - 4 });
  }

  // ---- tempo & key ----

  /** The badge next to the track name: "140 · F#m", "…" while measuring, "♩ ?" before. */
  private updateMusical() {
    const el = this.musicalEl;
    const file = this.engine.file;
    if (!el || !file) return;
    const d = this.plugin.settings.tracks[file.path];
    const busy = this.plugin.isAnalysing(file.path);
    el.toggleClass("is-busy", busy);
    el.toggleClass("is-empty", !busy && d?.bpm == null);

    if (busy) {
      el.setText("…");
      el.title = t("analysing");
      return;
    }
    if (d?.bpm == null) {
      el.setText("♩ ?");
      el.title = t("analyseHint");
      return;
    }
    const key = formatKey(d.key, d.scale);
    el.setText(key ? `${d.bpm} · ${key}` : String(d.bpm));
    // tracks measured before 1.10.0 carry essentia's profile votes instead
    const votes = d.keyStrength !== undefined
      ? t("keyCertainty")(Math.round(d.keyStrength * 100), d.scaleAlt ? formatKey(d.key, d.scaleAlt) : null)
      : d.scaleAlt
        ? t("votesSplit")(d.keyVotes ?? 0, 5, formatKey(d.key, d.scaleAlt))
        : t("votesUnanimous");
    el.title = t("musicalTitle")(votes, !!d.musicalEdited);
  }

  private onMusicalClick(file: TFile) {
    const d = this.plugin.settings.tracks[file.path];
    if (this.plugin.isAnalysing(file.path)) return;
    if (d?.bpm == null) {
      void this.plugin.analyseTrack(file, true);
      return;
    }

    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(t("menuDouble"))
      .setIcon("chevrons-up")
      .onClick(() => this.plugin.editMusical(file.path, { bpm: Math.round(d.bpm! * 2) })));
    menu.addItem((item) => item
      .setTitle(t("menuHalf"))
      .setIcon("chevrons-down")
      .onClick(() => this.plugin.editMusical(file.path, { bpm: Math.round(d.bpm! / 2) })));

    if (d.key) {
      // the runner-up mode when the detector was torn, the opposite one otherwise
      const alt = d.scaleAlt ?? (d.scale === "minor" ? "major" : "minor");
      const key = d.key;
      const label = (scale: string | null | undefined) =>
        `${formatKey(key, scale)} (${scale === "minor" ? t("modeMinor") : t("modeMajor")})`;

      menu.addSeparator();
      // hearing both triads over the playing beat is the only real way to
      // settle the mode — no detector is certain about it
      menu.addItem((item) => item
        .setTitle(t("menuListen")(label(d.scale)))
        .setIcon("music")
        .onClick(() => playTriad(key, d.scale ?? "major")));
      menu.addItem((item) => item
        .setTitle(t("menuListen")(label(alt)))
        .setIcon("music")
        .onClick(() => playTriad(key, alt)));
      menu.addItem((item) => item
        .setTitle(t("menuSwitchMode")(label(alt)))
        .setIcon("repeat")
        .onClick(() => this.plugin.editMusical(file.path, { scale: alt, scaleAlt: d.scale })));
    }

    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle(t("menuReanalyse"))
      .setIcon("refresh-cw")
      .onClick(() => void this.plugin.analyseTrack(file, true)));
    menu.addItem((item) => item
      .setTitle(t("menuForget"))
      .setIcon("eraser")
      .onClick(() => this.plugin.forgetMusical(file.path)));

    const rect = this.musicalEl?.getBoundingClientRect();
    menu.showAtPosition({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
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
      void this.engine.acceptPendingSwitch();
    });
    const closeBtn = this.pendingRow.createEl("button", { cls: "clickable-icon sw-icon-btn" });
    setIcon(closeBtn, "x");
    closeBtn.setAttribute("aria-label", t("hideBtn"));
    closeBtn.addEventListener("click", () => this.engine.setPendingSwitch(null));
  }

  // ---- playlist ----

  private buildPlaylist(parent: HTMLElement) {
    this.playlistEl = parent.createDiv({ cls: "sw-playlist" });

    const head = this.playlistEl.createDiv({ cls: "sw-playlist-head" });
    head.setAttribute("role", "button");
    head.title = t("playlistToggleTitle");
    this.playlistIcon = head.createSpan({ cls: "sw-playlist-icon" });
    this.playlistTitle = head.createSpan({ cls: "sw-playlist-title" });
    this.playlistCount = head.createSpan({ cls: "sw-playlist-count" });
    this.sortBtn = head.createEl("button", { cls: "clickable-icon sw-icon-btn sw-playlist-sort" });
    setIcon(this.sortBtn, "arrow-up-down");
    this.sortBtn.setAttribute("aria-label", t("sortTitle"));
    // the head above carries its own title for the collapse/expand gesture;
    // an empty title here overrides that inheritance per spec, so hovering
    // the button draws only Obsidian's aria-label tooltip, not both at once —
    // same rule as transportBtn above (see the comment at its definition)
    this.sortBtn.title = "";
    // the button sits inside the head, which toggles collapse on click — this
    // is a different gesture and must not also fold the list
    this.sortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onSortClick();
    });
    this.playlistChevron = head.createSpan({ cls: "sw-playlist-chevron" });
    head.addEventListener("click", () => {
      this.plugin.settings.playlistCollapsed = !this.plugin.settings.playlistCollapsed;
      void this.plugin.saveSettings();
      this.applyPlaylistCollapsed();
    });

    // sits outside the head: a click in the search box must not fold the list
    this.toolsEl = this.playlistEl.createDiv({ cls: "sw-playlist-tools" });
    const search = this.toolsEl.createEl("input", { cls: "sw-playlist-search", type: "search" });
    search.placeholder = t("searchPlaceholder");
    search.setAttribute("aria-label", t("searchPlaceholder"));
    search.addEventListener("input", () => {
      this.query = search.value;
      this.refillPlaylistRows();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) {
        e.stopPropagation(); // clear the search, don't close whatever holds the panel
        search.value = "";
        this.query = "";
        this.refillPlaylistRows();
      }
    });
    this.filterBtn = this.toolsEl.createEl("button", { cls: "sw-playlist-filter" });
    this.filterBtn.setAttribute("aria-label", t("filterTitle"));
    this.filterBtn.addEventListener("click", () => this.onFilterClick());
    this.progressEl = this.toolsEl.createSpan({ cls: "sw-playlist-progress" });
    // a fresh pack arrives unmeasured: one click measures all of it
    this.measureBtn = this.toolsEl.createEl("button", { cls: "clickable-icon sw-playlist-measure" });
    this.measureBtn.addEventListener("click", () => void this.plugin.analyseAll(this.engine.queue));

    this.playlistList = this.playlistEl.createDiv({ cls: "sw-playlist-list" });
    this.noneEl = this.playlistEl.createDiv({ cls: "sw-playlist-none", text: t("playlistNone") });
    this.noneEl.hide();
  }

  private static readonly FILTER_LABEL: Record<PlaylistFilter,
    "filterAll" | "filterUnsorted" | "filterUsed" | "filterSaved" | "filterDropped"> = {
    all: "filterAll", unsorted: "filterUnsorted", used: "filterUsed", saved: "filterSaved", dropped: "filterDropped"
  };

  private onFilterClick() {
    const menu = new Menu();
    const current = this.plugin.settings.playlistFilter;
    for (const filter of ["all", "unsorted", ...VERDICTS] as PlaylistFilter[]) {
      menu.addItem((item) => item
        .setTitle(t(SongwriterView.FILTER_LABEL[filter]))
        .setChecked(current === filter)
        .onClick(() => {
          this.plugin.settings.playlistFilter = filter;
          this.plugin.requestSave();
          this.refillPlaylistRows();
        }));
    }
    // dropped tracks can go for good, from the same place they are filtered
    const dropped = this.engine.queue.filter(f => this.plugin.settings.tracks[f.path]?.verdict === "dropped");
    if (dropped.length > 0) {
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle(t("trashDropped")(dropped.length))
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.plugin.confirmTrash(dropped)));
    }
    const rect = this.filterBtn.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private applyPlaylistCollapsed() {
    const collapsed = this.plugin.settings.playlistCollapsed;
    this.playlistList.toggle(!collapsed);
    this.toolsEl.toggle(!collapsed);
    this.updateSortingTools(); // the "nothing matches" line follows the fold
    // the chevron says this visually; aria-expanded says it to everyone else
    this.playlistEl.querySelector(".sw-playlist-head")
      ?.setAttribute("aria-expanded", String(!collapsed));
    setIcon(this.playlistChevron, collapsed ? "chevron-right" : "chevron-down");
  }

  private renderPlaylist() {
    if (!this.playlistEl) return;
    this.updateQueueButtons();

    const queue = this.engine.queue;
    const source = this.engine.queueSource;
    // a lone track is not a playlist — the track row already says everything
    this.playlistEl.toggle(queue.length > 1);
    if (queue.length <= 1) {
      this.playlistList.empty();
      this.playlistRows.clear(); // the rows are gone; don't keep writing to them
      this.renderedPaths = [];
      this.currentRowPath = null;
      return;
    }

    setIcon(this.playlistIcon, source?.kind === "folder" ? "folder" : "file-text");
    this.playlistTitle.setText(source?.name ?? "");
    this.playlistTitle.title = source
      ? `${source.kind === "folder" ? t("playlistFromFolder") : t("playlistFromNote")} · ${source.path}`
      : "";
    this.playlistCount.setText(String(queue.length));
    this.playlistCount.title = t("playlistCountTitle")(queue.length);
    // a note dictates its own order — the author's sequence — so reordering
    // only ever applies (and only ever offers itself) to a folder playlist
    this.sortBtn.toggle(source?.kind === "folder");
    this.applyPlaylistCollapsed();

    // Rebuilding the rows throws away the list's scroll position, so it only
    // happens when the playlist itself changed. Stepping to the next track
    // leaves the DOM alone and just moves the highlight — otherwise every ⏭
    // through a folder would snap the view back to the first file.
    const paths = queue.map(f => f.path);
    const same = paths.length === this.renderedPaths.length
      && paths.every((p, i) => p === this.renderedPaths[i]);
    if (!same) {
      this.buildPlaylistRows(queue);
      this.renderedPaths = paths;
    }
    this.updatePlaylistCurrent();
    this.updateSortingTools();
  }

  // ---- playlist order ----

  private onSortClick() {
    const menu = new Menu();
    const current = this.plugin.settings.playlistSort;
    const options: [PlaylistSort, string][] = [
      ["name", t("sortByName")],
      ["tempo", t("sortByTempo")],
      ["plays", t("sortByPlays")],
      ["recent", t("sortByRecent")]
    ];
    for (const [sort, label] of options) {
      menu.addItem((item) => item
        .setTitle(label)
        .setChecked(current === sort)
        .onClick(() => this.setPlaylistSort(sort)));
    }
    const rect = this.sortBtn.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  /**
   * Rebuilds the queue through the exact same path collectFolderAudios takes,
   * so the rows on screen and the sequence ⏮/⏭ step through never disagree.
   */
  private setPlaylistSort(sort: PlaylistSort) {
    if (this.plugin.settings.playlistSort === sort) return;
    this.plugin.settings.playlistSort = sort;
    void this.plugin.saveSettings();
    const source = this.engine.queueSource;
    const anchor = this.engine.queue[0];
    if (source?.kind === "folder" && anchor) {
      this.engine.setQueue(this.plugin.collectFolderAudios(anchor), source);
    }
  }

  private buildPlaylistRows(queue: TFile[]) {
    this.playlistList.empty();
    this.playlistRows.clear();
    this.currentRowPath = null; // fresh rows: nothing is highlighted yet
    queue.forEach((f, index) => {
      const row = this.playlistList.createDiv({ cls: "sw-pl-row" });
      row.setAttribute("role", "button");
      const num = row.createSpan({ cls: "sw-pl-num", text: String(index + 1) });
      // sorting a pack: each click steps this track's mark on, right in the
      // list — the row itself still plays, so the click stops here
      const verdict = row.createSpan({ cls: "sw-pl-verdict" });
      verdict.setAttribute("role", "button");
      verdict.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.setVerdict(f.path, nextVerdict(this.plugin.settings.tracks[f.path]?.verdict));
      });
      // no file read for a drag that is not going to start here
      verdict.addEventListener("mousedown", (e) => e.stopPropagation());
      row.createSpan({ cls: "sw-pl-name", text: f.basename, title: `${f.path}\n${t("rowDragHint")}` });
      const flag = row.createSpan({ cls: "sw-pl-flag" });
      const musical = row.createSpan({ cls: "sw-pl-musical" });
      const plays = row.createSpan({ cls: "sw-pl-plays" });
      this.playlistRows.set(f.path, { row, num, index, name: f.basename, verdict, flag, plays, musical });
      this.fillPlaylistRow(f.path);
      row.addEventListener("click", () => {
        if (f.path === this.engine.file?.path) void this.engine.playPause();
        else void this.engine.load(f, { autoplay: this.engine.playing });
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        // a mark from here lands on this row only — nothing starts playing
        const current = this.plugin.settings.tracks[f.path]?.verdict;
        for (const verdict of VERDICTS) {
          menu.addItem((item) => item
            .setTitle(t(VERDICT_UI[verdict].label))
            .setIcon(VERDICT_UI[verdict].icon)
            .setChecked(current === verdict)
            .onClick(() => this.plugin.setVerdict(f.path, verdict)));
        }
        if (current) {
          menu.addItem((item) => item
            .setTitle(t("menuClearVerdict"))
            .setIcon("eraser")
            .onClick(() => this.plugin.setVerdict(f.path, undefined)));
        }
        if (current === "dropped") {
          menu.addItem((item) => item
            .setTitle(t("trashOne"))
            .setIcon("trash-2")
            .setWarning(true)
            .onClick(() => this.plugin.confirmTrash([f])));
        }
        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle(t("copyToNote"))
          .setIcon("copy")
          .onClick(() => void this.plugin.copyTrackToNote(f)));
        menu.showAtMouseEvent(e);
      });
      this.makeRowDraggable(row, f);
    });
  }

  /** Move the "now playing" highlight in place, and keep that row in sight. */
  private updatePlaylistCurrent() {
    this.updateQueueButtons();
    const currentPath = this.engine.file?.path ?? null;
    if (currentPath === this.currentRowPath) return;

    const prev = this.currentRowPath ? this.playlistRows.get(this.currentRowPath) : null;
    if (prev) {
      prev.row.removeClass("is-current");
      prev.num.empty();
      prev.num.setText(String(prev.index + 1)); // back to its ordinal
    }
    this.currentRowPath = currentPath;

    // a track can be loaded without belonging to the playlist — then there is
    // simply no row to light up
    const els = currentPath ? this.playlistRows.get(currentPath) : null;
    if (!els) return;
    els.row.addClass("is-current");
    els.num.empty();
    setIcon(els.num, this.engine.playing ? "volume-2" : "pause");
    this.scrollRowIntoView(els.row);
  }

  /**
   * Scroll the list itself — not via scrollIntoView, which would also pull the
   * whole sidebar around when the panel is short.
   */
  private scrollRowIntoView(row: HTMLElement) {
    const list = this.playlistList;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (listRect.height === 0) return; // collapsed or not laid out yet
    if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }

  /**
   * Drag a row two ways, split by the Alt key. Plain drag targets a note: it
   * carries a link built by Obsidian itself (wikilink or markdown, shortest
   * or relative path per the vault's settings; the leading "!" makes it an
   * embed, which this plugin renders as a waveform player) alongside the raw
   * bytes as a DownloadURL, so dropping on the desktop saves the file and
   * dropping in a note inserts the embed. Alt+drag instead hands the file to
   * dragOutNatively, which reaches apps that want a real path on disk (REAPER
   * ignores the virtual file Chromium offers otherwise) — dropping that
   * gesture into a note does nothing, which is the deliberate price of the
   * split.
   */
  private makeRowDraggable(row: HTMLElement, file: TFile) {
    row.draggable = true;
    // the bytes have to be in hand when the gesture starts, and reading them
    // on hover means reading the whole pack while the mouse wanders down the
    // list. Button 0 only — a right click just opens the context menu, and
    // reading the whole file for a menu it will never drag is wasted work
    // Desktop only: on a phone a tap fires mousedown too, and no drag ever
    // leaves the app there, so every tap on a row would read a whole file for
    // nothing
    row.addEventListener("mousedown", (e) => {
      if (e.button === 0 && Platform.isDesktopApp) void this.prepareDragFile(file);
    });
    row.addEventListener("dragstart", (e) => {
      // Alt takes the native, on-disk route instead of the ordinary drag
      if (e.altKey && dragOutNatively(this.app, file)) {
        e.preventDefault();
        row.removeClass("is-dragging");
        return;
      }
      const active = this.app.workspace.getActiveFile();
      const link = this.app.fileManager.generateMarkdownLink(file, active?.path ?? "");
      const embed = link.startsWith("!") ? link : `!${link}`;
      e.dataTransfer?.setData("text/plain", embed);
      // the file itself, for everything outside Obsidian; an app that
      // understands neither form simply ignores it
      if (e.dataTransfer && this.dragFile?.path === file.path) {
        const mime = SongwriterView.DRAG_MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
        e.dataTransfer.setData("DownloadURL", `${mime}:${file.name}:${this.dragFile.url}`);
      }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
  }

  /** Read one track's bytes and keep them as an object URL, ready for a drag. */
  private async prepareDragFile(file: TFile) {
    if (this.dragFile?.path === file.path || this.dragPending === file.path) return;
    this.dragPending = file.path;
    let bytes: ArrayBuffer;
    try {
      bytes = await this.app.vault.readBinary(file);
    } catch (e) {
      // left set, the pending path would turn every later mousedown on this
      // row into an early return — the track could never be dragged out again
      if (this.dragPending === file.path) this.dragPending = null;
      console.warn("Songwriter: could not read the track for dragging", e);
      return;
    }
    const mime = SongwriterView.DRAG_MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    if (this.dragPending !== file.path) {
      // a later mousedown moved on to another row while this read was in
      // flight — this one lost the race, so its URL is revoked unused rather
      // than pinning the Blob for the life of the document
      URL.revokeObjectURL(url);
      return;
    }
    this.dragPending = null;
    this.releaseDragFile();
    this.dragFile = { path: file.path, url };
  }

  private releaseDragFile() {
    if (!this.dragFile) return;
    URL.revokeObjectURL(this.dragFile.url);
    this.dragFile = null;
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
      // an icon with no text has no name at all without this; and it has to
      // come off again when the marker does, or the row goes on claiming one
      els.flag.setAttribute("aria-label", t("rowMarkerTitle"));
    } else {
      els.flag.removeAttribute("aria-label");
    }
    els.plays.setText(data?.plays ? `▶ ${data.plays}` : "");
    const key = formatKey(data?.key, data?.scale);
    els.musical.setText(data?.bpm != null ? (key ? `${data.bpm} ${key}` : String(data.bpm)) : "");

    const verdict = data?.verdict;
    for (const v of VERDICTS) els.row.toggleClass(`is-${v}`, verdict === v);
    // a new track shows an empty circle: the spot is there to click before
    // anything has been decided
    els.verdict.empty();
    setIcon(els.verdict, verdict ? VERDICT_UI[verdict].icon : "circle");
    els.verdict.setAttribute("aria-label",
      t("verdictRowLabel")(t(verdict ? VERDICT_UI[verdict].label : "verdictNew")));
    els.row.toggle(rowVisible(els.name, verdict, this.plugin.settings.playlistFilter, this.query));
  }

  /** Every row, then the counters and the "nothing matches" line that depend on them. */
  private refillPlaylistRows() {
    for (const path of this.playlistRows.keys()) this.fillPlaylistRow(path);
    this.updateSortingTools();
  }

  /** The filter's label, how far the sorting has got, and whether anything is left to show. */
  private updateSortingTools() {
    if (!this.filterBtn) return;
    const filter = this.plugin.settings.playlistFilter;
    this.filterBtn.setText(t(SongwriterView.FILTER_LABEL[filter]));
    this.filterBtn.toggleClass("is-active", filter !== "all");

    const count: Record<Verdict, number> = { used: 0, saved: 0, dropped: 0 };
    let shown = 0;
    for (const [path, els] of this.playlistRows) {
      const verdict = this.plugin.settings.tracks[path]?.verdict;
      if (verdict) count[verdict]++;
      if (rowVisible(els.name, verdict, filter, this.query)) shown++;
    }
    const total = this.playlistRows.size;
    const sorted = count.used + count.saved + count.dropped;
    // nothing judged yet: no counter, the list looks the way it always did
    this.progressEl.toggle(sorted > 0);
    this.progressEl.setText(`${sorted}/${total}`);
    this.progressEl.title = t("progressTitle")(sorted, total, count.used, count.saved, count.dropped);
    this.noneEl.toggle(total > 0 && shown === 0 && !this.plugin.settings.playlistCollapsed);

    const running = this.plugin.measuringAll;
    let unmeasured = 0;
    for (const path of this.playlistRows.keys()) if (!this.plugin.isMeasured(path)) unmeasured++;
    this.measureBtn.toggle(running || unmeasured > 0);
    const icon = running ? "square" : "gauge";
    if (icon !== this.measureIcon) {
      this.measureIcon = icon;
      this.measureBtn.empty();
      setIcon(this.measureBtn, icon);
      this.measureBtn.createSpan({ cls: "sw-playlist-measure-count" });
    }
    this.measureBtn.find(".sw-playlist-measure-count")?.setText(running ? "" : String(unmeasured));
    this.measureBtn.setAttribute("aria-label", running ? t("measureStopTitle") : t("measureAllTitle")(unmeasured));
  }



  /** The clear-marker button exists only while the track actually has one. */
  private updateMarkerBtn() {
    if (!this.markerBtn) return;
    const path = this.engine.file?.path;
    const marker = path ? this.plugin.settings.tracks[path]?.marker : null;
    this.markerBtn.toggle(marker !== null && marker !== undefined);
  }

  private updatePlayButton() {
    if (!this.playBtn) return;
    setIcon(this.playBtn, this.engine.playing ? "pause" : "play");
    const path = this.engine.file?.path;
    const els = path ? this.playlistRows.get(path) : null;
    if (els) {
      els.num.empty();
      setIcon(els.num, this.engine.playing ? "volume-2" : "pause");
    }
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

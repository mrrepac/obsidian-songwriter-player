import { App, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, QueueSource, SongwriterSettings, TrackData, emptyTrackData, isAudioPath } from "./types";
import { analyseMusical, foldIntoWindow } from "./musical";
import { renderTransposed, renderedName } from "./render";
import { t } from "./i18n";
import { openExternally, revealInExplorer } from "./external";
import { EmbedPlayers } from "./embed";
import { PlayerEngine } from "./engine";
import { MobileMarkerButton } from "./mobilefab";
import { SongwriterView, VIEW_TYPE_SONGWRITER } from "./view";

/** Pre-1.0 data.json shapes (startPoint / named markers / BPM-key / rate). */
interface LegacyTrackData extends Partial<TrackData> {
  startPoint?: number | null;
  markers?: Array<{ time?: number }>;
}

interface LegacySettings extends Partial<Omit<SongwriterSettings, "tracks">> {
  tracks?: Record<string, LegacyTrackData>;
  startFromPointOnLoad?: boolean;
  rate?: number;
}

export default class SongwriterPlugin extends Plugin {
  settings: SongwriterSettings;
  engine: PlayerEngine;
  embeds: EmbedPlayers;
  mobileFab: MobileMarkerButton;
  private saveTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.engine = new PlayerEngine(this);
    this.embeds = new EmbedPlayers(this);
    this.embeds.start();
    this.mobileFab = new MobileMarkerButton(this);
    this.mobileFab.start();

    this.registerView(VIEW_TYPE_SONGWRITER, (leaf) => new SongwriterView(leaf, this));
    this.addRibbonIcon("music", t("ribbonOpenPlayer"), () => this.activateView());
    this.addSettingTab(new SongwriterSettingTab(this.app, this));

    this.addCommand({
      id: "open-player",
      name: "Open player panel",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "play-pause",
      name: "Play/Pause",
      hotkeys: [
        { modifiers: ["Alt"], key: "p" },
        { modifiers: ["Alt"], key: "з" }
      ],
      callback: () => this.engine.playPause()
    });

    this.addCommand({
      id: "play-from-marker",
      name: "Play from marker (or from start)",
      hotkeys: [
        { modifiers: ["Alt"], key: "x" },
        { modifiers: ["Alt"], key: "ч" }
      ],
      callback: () => this.engine.playFromMarker()
    });

    this.addCommand({
      id: "stop",
      name: "Stop",
      hotkeys: [
        { modifiers: ["Alt"], key: "c" },
        { modifiers: ["Alt"], key: "с" }
      ],
      callback: () => this.engine.stop()
    });

    this.addCommand({
      id: "set-marker",
      name: "Set marker at current position",
      hotkeys: [
        { modifiers: ["Alt"], key: "z" },
        { modifiers: ["Alt"], key: "я" }
      ],
      callback: () => this.engine.setMarkerHere()
    });

    this.addCommand({
      id: "clear-marker",
      name: "Clear marker",
      callback: () => this.engine.clearMarker()
    });

    this.addCommand({
      id: "clear-loop",
      name: "Clear A-B loop zone",
      callback: () => this.engine.clearLoop()
    });

    this.addCommand({
      id: "seek-back",
      name: "Seek back",
      hotkeys: [
        { modifiers: ["Alt"], key: "," },
        { modifiers: ["Alt"], key: "б" }
      ],
      callback: () => this.engine.seekBy(-this.settings.skipSeconds)
    });

    this.addCommand({
      id: "seek-forward",
      name: "Seek forward",
      hotkeys: [
        { modifiers: ["Alt"], key: "." },
        { modifiers: ["Alt"], key: "ю" }
      ],
      callback: () => this.engine.seekBy(this.settings.skipSeconds)
    });

    // NOT Alt+↑/↓: Obsidian's editor binds those to "move line up/down" in its
    // CodeMirror keymap, which fires first — so they would quietly do nothing
    // while the cursor is in a note. Alt+PageUp/PageDown are free (checked
    // against the app's own keymap), as are Alt+Home/End for a reset.
    this.addCommand({
      id: "transpose-up",
      name: "Transpose up a semitone",
      hotkeys: [{ modifiers: ["Alt"], key: "PageUp" }],
      callback: () => void this.engine.setSemitones(this.engine.semitones + 1)
    });

    this.addCommand({
      id: "transpose-down",
      name: "Transpose down a semitone",
      hotkeys: [{ modifiers: ["Alt"], key: "PageDown" }],
      callback: () => void this.engine.setSemitones(this.engine.semitones - 1)
    });


    this.addCommand({
      id: "rate-up",
      name: "Play faster",
      hotkeys: [{ modifiers: ["Alt"], key: "=" }],
      callback: () => this.engine.stepRate(1)
    });

    this.addCommand({
      id: "rate-down",
      name: "Play slower",
      hotkeys: [{ modifiers: ["Alt"], key: "-" }],
      callback: () => this.engine.stepRate(-1)
    });

    this.addCommand({
      id: "rate-reset",
      name: "Play as recorded (reset speed and key)",
      hotkeys: [{ modifiers: ["Alt"], key: "0" }],
      callback: () => {
        this.engine.setRate(1);
        // guarded: on mobile setSemitones only reports that it is unavailable
        if (this.engine.semitones !== 0) void this.engine.setSemitones(0);
      }
    });

    this.addCommand({
      id: "save-transposed-copy",
      name: "Save a copy in the chosen key",
      callback: () => void this.saveTransposedCopy()
    });

    this.addCommand({
      id: "analyse-track",
      name: "Measure tempo and key of the current track",
      callback: () => {
        const file = this.engine.file;
        if (!file) {
          new Notice(t("noTrack"));
          return;
        }
        void this.analyseTrack(file, true);
      }
    });

    this.addCommand({
      id: "next-track",
      name: "Next track in the playlist",
      hotkeys: [
        { modifiers: ["Alt"], key: "n" },
        { modifiers: ["Alt"], key: "т" }
      ],
      callback: () => {
        void this.engine.step(1);
      }
    });

    this.addCommand({
      id: "prev-track",
      name: "Previous track in the playlist",
      hotkeys: [
        { modifiers: ["Alt"], key: "b" },
        { modifiers: ["Alt"], key: "и" }
      ],
      callback: () => {
        void this.engine.step(-1);
      }
    });

    this.addCommand({
      id: "load-from-note",
      name: "Load audio from current note",
      callback: () => this.loadFromActiveNote(false)
    });

    this.addCommand({
      id: "open-track-note",
      name: "Open track's note",
      hotkeys: [
        { modifiers: ["Alt"], key: "d" },
        { modifiers: ["Alt"], key: "в" }
      ],
      callback: () => this.openTrackNote()
    });

    this.addCommand({
      id: "unload-track",
      name: "Unload track",
      callback: () => {
        if (!this.engine.file) {
          new Notice(t("noTrack"));
          return;
        }
        this.engine.unload();
      }
    });

    this.addCommand({
      id: "open-track-externally",
      name: "Open track in default app",
      callback: () => {
        const file = this.engine.file;
        if (!file) {
          new Notice(t("noTrack"));
          return;
        }
        openExternally(this.app, file);
      }
    });

    this.addCommand({
      id: "reveal-track",
      name: "Reveal track in system explorer",
      callback: () => {
        const file = this.engine.file;
        if (!file) {
          new Notice(t("noTrack"));
          return;
        }
        revealInExplorer(this.app, file);
      }
    });

    // measuring a freshly loaded track: off the UI thread, cached, once
    this.registerEvent(this.engine.on("track-changed", (file: TFile | null) => {
      if (file && this.settings.autoAnalyse) void this.analyseTrack(file);
    }));

    this.registerEvent(this.app.workspace.on("file-open", (file) => this.handleFileOpen(file)));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (this.settings.tracks[oldPath]) {
        this.settings.tracks[file.path] = this.settings.tracks[oldPath];
        delete this.settings.tracks[oldPath];
        this.requestSave();
      }
      if (this.engine.file === file) void this.engine.refreshSrc();
      if (this.engine.queue.includes(file)) {
        this.engine.setQueue([...this.engine.queue], this.engine.queueSource);
      }
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFile)) return;
      if (this.settings.tracks[file.path]) {
        delete this.settings.tracks[file.path];
        this.requestSave();
      }
      if (this.engine.pendingSwitch?.path === file.path) this.engine.setPendingSwitch(null);
      if (this.engine.queue.some(f => f.path === file.path)) {
        this.engine.setQueue(this.engine.queue.filter(f => f.path !== file.path), this.engine.queueSource);
      }
      if (this.engine.file?.path === file.path) this.engine.unload();
    }));

    this.app.workspace.onLayoutReady(() => {
      void this.ensureViewInSidebar();
      this.handleFileOpen(this.app.workspace.getActiveFile());
    });
  }

  /**
   * Make sure the player tab exists in the right sidebar without opening it,
   * so it can always be found there — especially on mobile, where there is
   * no ribbon to launch it from.
   */
  private async ensureViewInSidebar() {
    const ws = this.app.workspace;
    if (ws.getLeavesOfType(VIEW_TYPE_SONGWRITER).length > 0) return;
    const leaf = ws.getRightLeaf(false);
    if (leaf) await leaf.setViewState({ type: VIEW_TYPE_SONGWRITER, active: false });
  }

  onunload() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // always flush: listened time may be accumulated without a pending timer,
    // and the <audio> pause event fires too late (async) to request a save
    void this.saveSettings();
    this.embeds.destroy();
    this.mobileFab.destroy();
    this.engine.destroy();
  }

  // ---- pickup from the active note / folder ----

  private handleFileOpen(file: TFile | null) {
    if (!file) return;

    let audios: TFile[];
    let source: QueueSource | null;
    let target: TFile;
    /** An audio file was opened by hand: that exact file wins over the queue. */
    let explicit: boolean;

    if (isAudioPath(file.path)) {
      audios = this.settings.folderQueue ? this.collectFolderAudios(file) : [file];
      source = audios.length > 1 && file.parent
        ? { kind: "folder", name: file.parent.name || "/", path: file.parent.path }
        : null;
      target = file;
      explicit = true;
      this.engine.sourceNote = null;
    } else if (file.extension === "md") {
      audios = this.collectNoteAudios(file);
      if (audios.length === 0) {
        // a note without audio (lyrics, a diary page) leaves the playlist
        // alone: it belongs to the loaded track, not to the note being read
        this.engine.setPendingSwitch(null);
        return;
      }
      this.engine.sourceNote = file;
      source = { kind: "note", name: file.basename, path: file.path };
      target = audios[0];
      explicit = false;
    } else {
      return;
    }

    this.engine.setQueue(audios, source);

    const current = this.engine.file;
    if (current && current.path === target.path) {
      this.engine.setPendingSwitch(null);
      return;
    }
    // a note whose audio is already loaded keeps playing — only an explicitly
    // opened audio file overrides the current track
    if (!explicit && current && audios.some(f => f.path === current.path)) {
      this.engine.setPendingSwitch(null);
      return;
    }

    switch (this.settings.pickupMode) {
      case "auto":
        void this.engine.load(target, { autoplay: this.engine.playing });
        break;
      case "hybrid":
        if (this.engine.playing) this.engine.setPendingSwitch(target);
        else void this.engine.load(target);
        break;
      case "manual":
        break;
    }
  }

  /** Every audio file sitting next to this one, in file-explorer-ish order. */
  collectFolderAudios(file: TFile): TFile[] {
    const parent = file.parent;
    if (!parent) return [file];
    const out = parent.children
      .filter((c): c is TFile => c instanceof TFile && isAudioPath(c.path))
      .sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" }));
    return out.length > 0 ? out : [file];
  }

  collectNoteAudios(note: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(note);
    if (!cache) return [];
    const refs = [...(cache.embeds ?? []), ...(cache.links ?? [])]
      .sort((a, b) => a.position.start.offset - b.position.start.offset);
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const ref of refs) {
      const linkPath = ref.link.split("#")[0];
      if (!isAudioPath(linkPath)) continue;
      const f = this.app.metadataCache.getFirstLinkpathDest(linkPath, note.path);
      if (f && !seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    }
    return out;
  }

  async loadFromActiveNote(silent: boolean) {
    const active = this.app.workspace.getActiveFile();
    if (!active) {
      if (!silent) new Notice(t("noActiveNote"));
      return;
    }
    const isAudio = isAudioPath(active.path);
    const audios = isAudio
      ? (this.settings.folderQueue ? this.collectFolderAudios(active) : [active])
      : this.collectNoteAudios(active);
    if (audios.length === 0) {
      if (!silent) new Notice(t("noAudioInNote"));
      return;
    }
    this.engine.setQueue(audios, isAudio
      ? (audios.length > 1 && active.parent
        ? { kind: "folder", name: active.parent.name || "/", path: active.parent.path }
        : null)
      : { kind: "note", name: active.basename, path: active.path });
    this.engine.sourceNote = active.extension === "md" ? active : null;
    await this.engine.load(isAudio ? active : audios[0]);
  }

  // ---- tempo & key ----

  private analysing = new Set<string>();

  isAnalysing(path: string): boolean {
    return this.analysing.has(path);
  }

  trackData(path: string): TrackData {
    let d = this.settings.tracks[path];
    if (!d) {
      d = emptyTrackData();
      this.settings.tracks[path] = d;
    }
    return d;
  }

  /**
   * Measure tempo and key in a worker and remember them. Runs once per file:
   * a stored result, and any hand correction, is left alone unless forced.
   */
  async analyseTrack(file: TFile, force = false): Promise<void> {
    const path = file.path;
    if (this.analysing.has(path)) return;
    const stored = this.settings.tracks[path];
    if (!force && (stored?.musicalEdited || stored?.bpm != null)) return;

    this.analysing.add(path);
    this.engine.trigger("data-changed"); // shows the pending state
    try {
      const result = await analyseMusical(this.app, file, this.settings.tempoWindowLow);
      if (!result) {
        new Notice(t("analyseFailed")(file.basename));
        return;
      }
      const d = this.trackData(path);
      d.bpm = result.bpm;
      d.key = result.key;
      d.scale = result.scale;
      d.scaleAlt = result.scaleAlt;
      d.keyVotes = result.keyVotes;
      d.musicalEdited = false;
      this.requestSave();
    } catch (e) {
      console.warn("Songwriter: analysis failed", e);
      new Notice(t("analyseFailed")(file.basename));
    } finally {
      this.analysing.delete(path);
      this.engine.trigger("data-changed");
    }
  }

  /**
   * Write what is being heard — transposition and speed baked in — as a new
   * file next to the original, named after the change.
   */
  async saveTransposedCopy(): Promise<void> {
    const file = this.engine.file;
    if (!file) {
      new Notice(t("noTrack"));
      return;
    }
    const semitones = this.engine.semitones;
    const rate = this.engine.rate;
    if (semitones === 0 && Math.abs(rate - 1) < 0.001) {
      new Notice(t("renderNothing"));
      return;
    }
    const opts = { semitones, rate, bpm: this.engine.peekData()?.bpm ?? null };
    const notice = new Notice(t("renderWorking")(renderedName(file.basename, opts)), 0);
    try {
      const created = await renderTransposed(this.app, file, opts);
      notice.hide();
      new Notice(t("renderDone")(created.basename), 6000);
      // a folder playlist should show the new neighbour right away
      if (this.engine.queueSource?.kind === "folder" && created.parent?.path === file.parent?.path) {
        this.engine.setQueue(this.collectFolderAudios(file), this.engine.queueSource);
      }
    } catch (e) {
      notice.hide();
      console.warn("Songwriter: render failed", e);
      new Notice(t("renderFailed"));
    }
  }

  /** Hand corrections (×2, ÷2, the other mode) stick for good. */
  editMusical(path: string, patch: Partial<TrackData>) {
    const d = this.trackData(path);
    Object.assign(d, patch, { musicalEdited: true });
    this.requestSave();
    this.engine.trigger("data-changed");
  }

  forgetMusical(path: string) {
    const d = this.settings.tracks[path];
    if (!d) return;
    d.bpm = null;
    d.key = null;
    d.scale = null;
    d.scaleAlt = null;
    d.keyVotes = undefined;
    d.musicalEdited = false;
    this.requestSave();
    this.engine.trigger("data-changed");
  }

  /** Jump back to the note the current track was picked up from. */
  async openTrackNote() {
    const file = this.engine.file;
    if (!file) {
      new Notice(t("noTrack"));
      return;
    }
    let note: TFile | null = null;
    const src = this.engine.sourceNote;
    if (src && this.app.vault.getAbstractFileByPath(src.path) instanceof TFile) {
      note = src;
    }
    if (!note) {
      // fallback: any note that links to this audio file
      const links = this.app.metadataCache.resolvedLinks;
      for (const [notePath, targets] of Object.entries(links)) {
        if (targets[file.path]) {
          const f = this.app.vault.getAbstractFileByPath(notePath);
          if (f instanceof TFile) {
            note = f;
            break;
          }
        }
      }
    }
    if (!note) {
      new Notice(t("trackNoteNotFound"));
      return;
    }
    // if the note is already open in some tab, jump there instead of reopening
    const target = note;
    let existing: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!existing && leaf.view instanceof MarkdownView && leaf.view.file?.path === target.path) {
        existing = leaf;
      }
    });
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      await this.app.workspace.revealLeaf(existing);
    } else {
      await this.app.workspace.getLeaf(false).openFile(target);
    }
  }

  // ---- view ----

  async activateView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE_SONGWRITER)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false) ?? ws.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_SONGWRITER, active: true });
    }
    await ws.revealLeaf(leaf);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SONGWRITER)) {
      const view = leaf.view;
      if (view instanceof SongwriterView) view.applySettings();
    }
  }

  // ---- persistence ----

  async loadSettings() {
    const loaded = ((await this.loadData()) ?? {}) as LegacySettings;
    // migrate from v0.1.0 (startPoint + named markers); `rate` (playback
    // speed, removed for now) and old per-track BPM/key fields are dropped
    // simply by not copying them over.
    const { tracks: loadedTracks, startFromPointOnLoad, rate, ...rest } = loaded;
    void rate;
    this.settings = { ...DEFAULT_SETTINGS, ...rest, tracks: {} };
    if (startFromPointOnLoad !== undefined && rest.startFromMarkerOnLoad === undefined) {
      this.settings.startFromMarkerOnLoad = startFromPointOnLoad;
    }
    for (const [path, raw] of Object.entries(loadedTracks ?? {})) {
      const firstMarker = Array.isArray(raw.markers) ? raw.markers[0]?.time : undefined;
      this.settings.tracks[path] = {
        marker: raw.marker !== undefined ? raw.marker : raw.startPoint ?? firstMarker ?? null,
        loopA: raw.loopA ?? null,
        loopB: raw.loopB ?? null,
        plays: typeof raw.plays === "number" ? raw.plays : 0,
        playedSec: typeof raw.playedSec === "number" ? raw.playedSec : 0,
        // measurements follow the current preferred range: changing it re-folds
        // everything that was not corrected by hand
        bpm: raw.bpm != null && !raw.musicalEdited
          ? Math.round(foldIntoWindow(raw.bpm, this.settings.tempoWindowLow))
          : raw.bpm ?? null,
        key: raw.key ?? null,
        scale: raw.scale ?? null,
        scaleAlt: raw.scaleAlt ?? null,
        keyVotes: raw.keyVotes,
        musicalEdited: raw.musicalEdited
      };
    }
  }

  requestSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, 400);
  }

  async saveSettings() {
    for (const [path, d] of Object.entries(this.settings.tracks)) {
      const noStats = !d.plays && (d.playedSec ?? 0) < 5;
      // measured tempo/key counts as content too — it costs seconds of
      // analysis to get back, so an otherwise empty record must survive
      const noMusical = d.bpm == null && d.key == null;
      if (d.marker === null && d.loopA === null && noStats && noMusical) {
        delete this.settings.tracks[path];
      }
    }
    await this.saveData(this.settings);
  }
}

class SongwriterSettingTab extends PluginSettingTab {
  plugin: SongwriterPlugin;

  constructor(app: App, plugin: SongwriterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("setPickupName"))
      .setDesc(t("setPickupDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("hybrid", t("pickupHybrid"))
        .addOption("auto", t("pickupAuto"))
        .addOption("manual", t("pickupManual"))
        .setValue(this.plugin.settings.pickupMode)
        .onChange(async (value) => {
          this.plugin.settings.pickupMode = value as SongwriterSettings["pickupMode"];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setSkipName"))
      .setDesc(t("setSkipDesc"))
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.skipSeconds)
        .onChange(async (value) => {
          this.plugin.settings.skipSeconds = value;
          this.plugin.refreshViews();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setStartMarkerName"))
      .setDesc(t("setStartMarkerDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.startFromMarkerOnLoad)
        .onChange(async (value) => {
          this.plugin.settings.startFromMarkerOnLoad = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName(t("headingPlaylist")).setHeading();

    new Setting(containerEl)
      .setName(t("setFolderQueueName"))
      .setDesc(t("setFolderQueueDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.folderQueue)
        .onChange(async (value) => {
          this.plugin.settings.folderQueue = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setAutoAdvanceName"))
      .setDesc(t("setAutoAdvanceDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoAdvance)
        .onChange(async (value) => {
          this.plugin.settings.autoAdvance = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName(t("headingMusical")).setHeading();

    new Setting(containerEl)
      .setName(t("setAutoAnalyseName"))
      .setDesc(t("setAutoAnalyseDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoAnalyse)
        .onChange(async (value) => {
          this.plugin.settings.autoAnalyse = value;
          await this.plugin.saveSettings();
        }));

    const windowSetting = new Setting(containerEl).setName(t("setTempoWindowName"));
    const describeWindow = () => windowSetting.setDesc(
      t("setTempoWindowDesc")(this.plugin.settings.tempoWindowLow, this.plugin.settings.tempoWindowLow * 2 - 1)
    );
    describeWindow();
    windowSetting.addSlider(slider => slider
      .setLimits(40, 120, 5)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.tempoWindowLow)
      .onChange(async (value) => {
        this.plugin.settings.tempoWindowLow = value;
        describeWindow();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName(t("headingFine")).setHeading();

    new Setting(containerEl)
      .setName(t("setPlayCountName"))
      .setDesc(t("setPlayCountDesc"))
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.playCountSec)
        .onChange(async (value) => {
          this.plugin.settings.playCountSec = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setDoubleStopName"))
      .setDesc(t("setDoubleStopDesc"))
      .addSlider(slider => slider
        .setLimits(300, 1500, 50)
        .setValue(this.plugin.settings.doubleStopMs)
        .onChange(async (value) => {
          this.plugin.settings.doubleStopMs = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setWaveHName"))
      .setDesc(t("setWaveHDesc"))
      .addSlider(slider => slider
        .setLimits(60, 220, 10)
        .setValue(this.plugin.settings.waveHeight)
        .onChange(async (value) => {
          this.plugin.settings.waveHeight = value;
          this.plugin.refreshViews();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setInlineName"))
      .setDesc(t("setInlineDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inlinePlayers)
        .onChange(async (value) => {
          this.plugin.settings.inlinePlayers = value;
          this.plugin.embeds.applyMode();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setEmbedBtnName"))
      .setDesc(t("setEmbedBtnDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.embedButtons)
        .onChange(async (value) => {
          this.plugin.settings.embedButtons = value;
          this.plugin.embeds.applyVisibility();
          await this.plugin.saveSettings();
        }));

    if (Platform.isMobile) {
      new Setting(containerEl)
        .setName(t("setFabName"))
        .setDesc(t("setFabDesc"))
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.mobileFab)
          .onChange(async (value) => {
            this.plugin.settings.mobileFab = value;
            this.plugin.mobileFab.applyVisibility();
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName(t("setFabModeName"))
        .setDesc(t("setFabModeDesc"))
        .addDropdown(dropdown => dropdown
          .addOption("marker", t("fabModeMarker"))
          .addOption("smart", t("fabModeSmart"))
          .setValue(this.plugin.settings.fabMode)
          .onChange(async (value) => {
            this.plugin.settings.fabMode = value as SongwriterSettings["fabMode"];
            this.plugin.mobileFab.applyVisibility(); // refresh the icon
            await this.plugin.saveSettings();
          }));
    }
  }
}

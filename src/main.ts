import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, SongwriterSettings, TrackData, isAudioPath } from "./types";
import { t } from "./i18n";

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
import { EmbedAudioButtons, openExternally, revealInExplorer } from "./external";
import { PlayerEngine } from "./engine";
import { SongwriterView, VIEW_TYPE_SONGWRITER } from "./view";

export default class SongwriterPlugin extends Plugin {
  settings: SongwriterSettings;
  engine: PlayerEngine;
  embedButtons: EmbedAudioButtons;
  private saveTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.engine = new PlayerEngine(this);
    this.embedButtons = new EmbedAudioButtons(this);
    this.embedButtons.start();

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
        { modifiers: ["Mod", "Alt"], key: "p" },
        { modifiers: ["Mod", "Alt"], key: "з" }
      ],
      callback: () => this.engine.playPause()
    });

    this.addCommand({
      id: "play-from-marker",
      name: "Play from marker (or from start)",
      hotkeys: [
        { modifiers: ["Mod", "Alt"], key: "x" },
        { modifiers: ["Mod", "Alt"], key: "ч" }
      ],
      callback: () => this.engine.playFromMarker()
    });

    this.addCommand({
      id: "stop",
      name: "Stop",
      hotkeys: [
        { modifiers: ["Mod", "Alt"], key: "c" },
        { modifiers: ["Mod", "Alt"], key: "с" }
      ],
      callback: () => this.engine.stop()
    });

    this.addCommand({
      id: "set-marker",
      name: "Set marker at current position",
      hotkeys: [
        { modifiers: ["Mod", "Alt"], key: "a" },
        { modifiers: ["Mod", "Alt"], key: "ф" }
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
        { modifiers: ["Mod", "Alt"], key: "," },
        { modifiers: ["Mod", "Alt"], key: "б" }
      ],
      callback: () => this.engine.seekBy(-this.settings.skipSeconds)
    });

    this.addCommand({
      id: "seek-forward",
      name: "Seek forward",
      hotkeys: [
        { modifiers: ["Mod", "Alt"], key: "." },
        { modifiers: ["Mod", "Alt"], key: "ю" }
      ],
      callback: () => this.engine.seekBy(this.settings.skipSeconds)
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
        { modifiers: ["Mod", "Alt"], key: "s" },
        { modifiers: ["Mod", "Alt"], key: "ы" }
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

    this.registerEvent(this.app.workspace.on("file-open", (file) => this.handleFileOpen(file)));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (this.settings.tracks[oldPath]) {
        this.settings.tracks[file.path] = this.settings.tracks[oldPath];
        delete this.settings.tracks[oldPath];
        this.requestSave();
      }
      if (this.engine.file === file) void this.engine.refreshSrc();
      if (this.engine.noteAudios.includes(file)) {
        this.engine.setNoteAudios([...this.engine.noteAudios]);
      }
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFile)) return;
      if (this.settings.tracks[file.path]) {
        delete this.settings.tracks[file.path];
        this.requestSave();
      }
      if (this.engine.pendingSwitch?.path === file.path) this.engine.setPendingSwitch(null);
      if (this.engine.noteAudios.some(f => f.path === file.path)) {
        this.engine.setNoteAudios(this.engine.noteAudios.filter(f => f.path !== file.path));
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
    this.embedButtons.destroy();
    this.engine.destroy();
  }

  // ---- pickup from the active note ----

  private handleFileOpen(file: TFile | null) {
    if (!file) return;

    let audios: TFile[];
    if (isAudioPath(file.path)) {
      audios = [file];
      this.engine.sourceNote = null;
    } else if (file.extension === "md") {
      audios = this.collectNoteAudios(file);
      if (audios.length > 0) this.engine.sourceNote = file;
    } else {
      return;
    }

    this.engine.setNoteAudios(audios);
    if (audios.length === 0) {
      this.engine.setPendingSwitch(null);
      return;
    }

    const currentInNote = !!this.engine.file && audios.some(f => f.path === this.engine.file!.path);
    if (currentInNote) {
      this.engine.setPendingSwitch(null);
      return;
    }

    switch (this.settings.pickupMode) {
      case "auto":
        void this.engine.load(audios[0], { autoplay: this.engine.playing });
        break;
      case "hybrid":
        if (this.engine.playing) this.engine.setPendingSwitch(audios[0]);
        else void this.engine.load(audios[0]);
        break;
      case "manual":
        break;
    }
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
    const audios = isAudioPath(active.path) ? [active] : this.collectNoteAudios(active);
    this.engine.setNoteAudios(audios);
    if (audios.length === 0) {
      if (!silent) new Notice(t("noAudioInNote"));
      return;
    }
    this.engine.sourceNote = active.extension === "md" ? active : null;
    await this.engine.load(audios[0]);
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
      if (d.marker === null && d.loopA === null && noStats) {
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
      .setName(t("setEmbedBtnName"))
      .setDesc(t("setEmbedBtnDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.embedButtons)
        .onChange(async (value) => {
          this.plugin.settings.embedButtons = value;
          this.plugin.embedButtons.applyVisibility();
          await this.plugin.saveSettings();
        }));
  }
}

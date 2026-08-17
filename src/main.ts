import { App, Hotkey, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, QueueSource, SongwriterSettings, TrackData, emptyTrackData, isAudioPath } from "./types";
import { sortTracks } from "./playlist";
import { analyseMusical, foldIntoWindow } from "./musical";
import { renderTransposed, renderedName } from "./render";
import { t } from "./i18n";
import { openExternally, revealInExplorer } from "./external";
import { copyTrackToNote as copyIntoNote } from "./copy";
import { EmbedPlayers } from "./embed";
import { decidePickup } from "./pickup";
import { PlayerEngine } from "./engine";
import { MediaSessionBridge } from "./mediasession";
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
  /** the beat-grid experiment — drawn bar lines and snapping, both withdrawn */
  beatGrid?: boolean;
  snapToBeats?: boolean;
  snapBars?: number;
}

/**
 * The built-in bindings, gathered here rather than left at each command, so the
 * setting that offers them can also apply them to a running app.
 *
 * Every letter has its Russian twin: the physical key is what the player is
 * reached by, and switching layout mid-sentence to pause the music is not a
 * thing anyone should have to do.
 */
export const DEFAULT_HOTKEYS: Record<string, Hotkey[]> = {
  "play-pause": [{ modifiers: ["Alt"], key: "p" }, { modifiers: ["Alt"], key: "з" }],
  "play-from-marker": [{ modifiers: ["Alt"], key: "x" }, { modifiers: ["Alt"], key: "ч" }],
  "stop": [{ modifiers: ["Alt"], key: "c" }, { modifiers: ["Alt"], key: "с" }],
  "set-marker": [{ modifiers: ["Alt"], key: "z" }, { modifiers: ["Alt"], key: "я" }],
  "seek-back": [{ modifiers: ["Alt"], key: "," }, { modifiers: ["Alt"], key: "б" }],
  "seek-forward": [{ modifiers: ["Alt"], key: "." }, { modifiers: ["Alt"], key: "ю" }],
  "next-track": [{ modifiers: ["Alt"], key: "n" }, { modifiers: ["Alt"], key: "т" }],
  "prev-track": [{ modifiers: ["Alt"], key: "b" }, { modifiers: ["Alt"], key: "и" }],
  "open-track-note": [{ modifiers: ["Alt"], key: "d" }, { modifiers: ["Alt"], key: "в" }],
  // the keypad cluster: × ÷ for the key, + − for the tempo, 0 to undo both
  "transpose-up": [{ modifiers: ["Alt"], key: "PageUp" }, { modifiers: ["Alt"], key: "*" }],
  "transpose-down": [{ modifiers: ["Alt"], key: "PageDown" }, { modifiers: ["Alt"], key: "/" }],
  "rate-up": [{ modifiers: ["Alt"], key: "=" }, { modifiers: ["Alt"], key: "+" }],
  "rate-down": [{ modifiers: ["Alt"], key: "-" }],
  "rate-reset": [{ modifiers: ["Alt"], key: "0" }]
};

/**
 * Obsidian's own table of default bindings. Not part of the plugin API, but it
 * is what makes the setting take effect at once: writing here flips the table's
 * `baked` flag and the app rebuilds it on the next keystroke. Without it a
 * command keeps whatever it was registered with at load, and trying a key out
 * would cost a restart every time.
 */
interface HotkeyManager {
  addDefaultHotkeys(id: string, hotkeys: Hotkey[]): void;
  removeDefaultHotkeys(id: string): void;
}

/** Stored speed, clamped to what the engine can set; "as recorded" stays undefined. */
function restoreRate(rate: unknown): number | undefined {
  if (typeof rate !== "number" || !isFinite(rate)) return undefined;
  const r = Math.min(PlayerEngine.RATE_MAX, Math.max(PlayerEngine.RATE_MIN, rate));
  return Math.abs(r - 1) < 0.001 ? undefined : r;
}

/** Stored transposition, clamped to ±12 semitones; "as recorded" stays undefined. */
function restoreSemitones(semitones: unknown): number | undefined {
  if (typeof semitones !== "number" || !isFinite(semitones)) return undefined;
  const n = Math.max(-12, Math.min(12, Math.round(semitones)));
  return n === 0 ? undefined : n;
}

export default class SongwriterPlugin extends Plugin {
  settings: SongwriterSettings;
  engine: PlayerEngine;
  embeds: EmbedPlayers;
  mobileFab: MobileMarkerButton;
  mediaSession: MediaSessionBridge;
  private saveTimer: number | null = null;

  /**
   * Default hotkeys are offered, not imposed.
   *
   * Up to 1.5.1 every command shipped with keys baked in, which drops one
   * person's layout onto every keyboard — and this layout is deliberately
   * personal, down to the Russian twin of each letter binding. With the setting
   * off the commands register bare and are still reachable from the command
   * palette, or from whatever the user binds them to. An assignment made in
   * Obsidian's own hotkey settings always beats a default either way, so this
   * only decides what a command starts out with.
   *
   * Turning the setting on or off applies immediately — see
   * applyDefaultHotkeys, which is what spares a reload after every change.
   */
  private keys(command: string): Hotkey[] {
    return this.settings.defaultHotkeys ? DEFAULT_HOTKEYS[command] ?? [] : [];
  }

  /**
   * Hand the built-in bindings to the running app, or take them back.
   *
   * Returns false if Obsidian has no hotkey table to write to — then the change
   * is still saved and simply waits for the next reload, which is what the
   * caller says out loud rather than leaving the keys silently dead.
   */
  applyDefaultHotkeys(): boolean {
    const manager = (this.app as App & { hotkeyManager?: HotkeyManager }).hotkeyManager;
    if (typeof manager?.addDefaultHotkeys !== "function") return false;
    if (typeof manager.removeDefaultHotkeys !== "function") return false;
    for (const command of Object.keys(DEFAULT_HOTKEYS)) {
      const id = `${this.manifest.id}:${command}`;
      if (this.settings.defaultHotkeys) manager.addDefaultHotkeys(id, DEFAULT_HOTKEYS[command]);
      else manager.removeDefaultHotkeys(id);
    }
    return true;
  }

  async onload() {
    await this.loadSettings();
    this.engine = new PlayerEngine(this);
    this.embeds = new EmbedPlayers(this);
    this.embeds.start();
    this.mobileFab = new MobileMarkerButton(this);
    this.mobileFab.start();
    this.mediaSession = new MediaSessionBridge(this);
    this.mediaSession.start();

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
      hotkeys: this.keys("play-pause"),
      callback: () => this.engine.playPause()
    });

    this.addCommand({
      id: "play-from-marker",
      name: "Play from marker (or from start)",
      hotkeys: this.keys("play-from-marker"),
      callback: () => this.engine.playFromMarker()
    });

    this.addCommand({
      id: "stop",
      name: "Stop",
      hotkeys: this.keys("stop"),
      callback: () => this.engine.stop()
    });

    this.addCommand({
      id: "set-marker",
      name: "Set marker at current position",
      hotkeys: this.keys("set-marker"),
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
      hotkeys: this.keys("seek-back"),
      callback: () => this.engine.seekBy(-this.settings.skipSeconds)
    });

    this.addCommand({
      id: "seek-forward",
      name: "Seek forward",
      hotkeys: this.keys("seek-forward"),
      callback: () => this.engine.seekBy(this.settings.skipSeconds)
    });

    // The four of these sit together on the numeric keypad, where nothing else
    // in Obsidian is listening: ×  and ÷ change the key, + and − the tempo, so
    // the whole player falls under one hand. PageUp/PageDown and =/− stay as
    // they were for keyboards that have no keypad.
    //
    // Obsidian names a key by its keyCode, and the keypad has its own numbers:
    // 106 is "*", 111 is "/", 107 is "+" — where the main row's = is "=", which
    // is why a hotkey bound to "=" never hears the keypad. The minus is the one
    // that needs nothing extra: 109 and 189 both answer to "-".
    //
    // NOT the arrows: Obsidian keeps Alt+↑/↓ for "move line up/down", and
    // CodeMirror takes Alt+←/→ for word-wise cursor movement before a plugin
    // ever sees them.
    this.addCommand({
      id: "transpose-up",
      name: "Transpose up a semitone",
      hotkeys: this.keys("transpose-up"),
      callback: () => void this.engine.setSemitones(this.engine.semitones + 1)
    });

    this.addCommand({
      id: "transpose-down",
      name: "Transpose down a semitone",
      hotkeys: this.keys("transpose-down"),
      callback: () => void this.engine.setSemitones(this.engine.semitones - 1)
    });


    this.addCommand({
      id: "rate-up",
      name: "Play faster",
      hotkeys: this.keys("rate-up"),
      callback: () => this.engine.stepRate(1)
    });

    this.addCommand({
      id: "rate-down",
      name: "Play slower",
      hotkeys: this.keys("rate-down"),
      callback: () => this.engine.stepRate(-1)
    });

    this.addCommand({
      id: "rate-reset",
      name: "Play as recorded (reset speed and key)",
      hotkeys: this.keys("rate-reset"),
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
      hotkeys: this.keys("next-track"),
      callback: () => {
        void this.engine.step(1);
      }
    });

    this.addCommand({
      id: "prev-track",
      name: "Previous track in the playlist",
      hotkeys: this.keys("prev-track"),
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
      hotkeys: this.keys("open-track-note"),
      callback: () => this.openTrackNote()
    });

    // no default hotkey: the built-in key table is already at fourteen commands
    this.addCommand({
      id: "copy-track-to-note",
      name: "Copy track to current note",
      callback: () => void this.copyTrackToNote()
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

    // A click already opens the file, and that goes through the pickup rule. A
    // double click is a second, louder statement: play it. The explorer's markup
    // is not public API, so a miss here means the gesture quietly does nothing.
    this.registerDomEvent(document, "dblclick", (e) => {
      const title = (e.target as HTMLElement)?.closest?.(".nav-file-title");
      const path = title?.getAttribute("data-path");
      if (!path || !isAudioPath(path)) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      this.engine.setPendingSwitch(null);
      this.engine.setQueue(
        this.settings.folderQueue ? this.collectFolderAudios(file) : [file],
        file.parent ? { kind: "folder", name: file.parent.name || "/", path: file.parent.path } : null
      );
      void this.engine.load(file, { autoplay: true });
    });

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
    this.mediaSession.destroy();
    this.engine.destroy();
  }

  // ---- pickup from the active note / folder ----

  private handleFileOpen(file: TFile | null) {
    if (!file) return;

    let audios: TFile[];
    let source: QueueSource | null;
    /** The note the target would belong to — applied only if it actually loads. */
    let noteSource: TFile | null;
    const audio = isAudioPath(file.path);

    if (audio) {
      audios = this.settings.folderQueue ? this.collectFolderAudios(file) : [file];
      source = audios.length > 1 && file.parent
        ? { kind: "folder", name: file.parent.name || "/", path: file.parent.path }
        : null;
      noteSource = null;
    } else if (file.extension === "md") {
      audios = this.collectNoteAudios(file);
      noteSource = file;
      source = { kind: "note", name: file.basename, path: file.path };
    } else {
      return;
    }

    // target is absent only for a note with no audio in it; decidePickup
    // covers that case itself, so the missing target never reaches a load
    const target: TFile | null = audio ? file : (audios[0] ?? null);

    const decision = decidePickup({
      kind: audio ? "audio" : (audios.length === 0 ? "note-empty" : "note-audio"),
      playing: this.engine.playing,
      mode: this.settings.pickupMode,
      currentPath: this.engine.file?.path ?? null,
      targetPath: target?.path ?? "",
      queuePaths: audios.map(f => f.path)
    });

    if (decision.setQueue) this.engine.setQueue(audios, source);

    // the note association travels with the load, so merely opening a file
    // that does not become the track (manual mode, an offer left unanswered,
    // the track already playing) leaves "open track's note" pointing where it did
    switch (decision.action) {
      case "load":
        if (target) void this.engine.load(target, { autoplay: this.engine.playing, sourceNote: noteSource });
        break;
      case "offer":
        if (target) this.engine.setPendingSwitch(target, noteSource);
        break;
      case "none":
        this.engine.setPendingSwitch(null);
        break;
    }
  }

  /** Every audio file sitting next to this one, ordered by the current playlist sort. */
  collectFolderAudios(file: TFile): TFile[] {
    const parent = file.parent;
    if (!parent) return [file];
    const audios = parent.children
      .filter((c): c is TFile => c instanceof TFile && isAudioPath(c.path));
    if (audios.length === 0) return [file];
    const byPath = new Map(audios.map(f => [f.path, f]));
    const sorted = sortTracks(
      audios.map(f => {
        const d = this.settings.tracks[f.path];
        return { path: f.path, basename: f.basename, mtime: f.stat.mtime, bpm: d?.bpm ?? null, plays: d?.plays ?? 0 };
      }),
      this.settings.playlistSort
    );
    return sorted.map(track => byPath.get(track.path)!);
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
    await this.engine.load(isAudio ? active : audios[0], {
      sourceNote: active.extension === "md" ? active : null
    });
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

  /**
   * File the loaded track into the note being looked at, without touching
   * playback — filing is not listening, so the folder keeps playing through it.
   */
  async copyTrackToNote(file: TFile | null = this.engine.file): Promise<void> {
    if (!file) {
      new Notice(t("noTrack"));
      return;
    }
    const note = this.app.workspace.getActiveFile();
    if (!note || note.extension !== "md") {
      new Notice(t("noActiveNote"));
      return;
    }
    await copyIntoNote(this.app, this, file, note);
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
    const raw = await this.loadData();
    const loaded = (raw ?? {}) as LegacySettings;
    // migrate from v0.1.0 (startPoint + named markers); `rate` (playback
    // speed, removed for now), the withdrawn beat-grid settings and old
    // per-track BPM/key fields are dropped simply by not copying them over.
    const {
      tracks: loadedTracks, startFromPointOnLoad,
      rate, beatGrid, snapToBeats, snapBars,
      ...rest
    } = loaded;
    void [rate, beatGrid, snapToBeats, snapBars];
    this.settings = { ...DEFAULT_SETTINGS, ...rest, tracks: {} };
    if (startFromPointOnLoad !== undefined && rest.startFromMarkerOnLoad === undefined) {
      this.settings.startFromMarkerOnLoad = startFromPointOnLoad;
    }
    // Up to 1.5.1 the hotkeys were baked into the commands, so everyone had
    // them whether they wanted them or not. They are opt-in from now on — but a
    // vault that has been using them must not lose them on an update, so an
    // existing installation is switched on and only a fresh one starts bare.
    // The plugin writes its settings on unload, so "has a data file" is a
    // reliable stand-in for "was already here".
    if (rest.defaultHotkeys === undefined) {
      this.settings.defaultHotkeys = raw != null;
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
        musicalEdited: raw.musicalEdited,
        // speed and transposition are deliberately per track — a beat you are
        // learning stays slow, a song stays in the key you sing it in — so they
        // have to be restored here, not just written
        rate: restoreRate(raw.rate),
        semitones: restoreSemitones(raw.semitones)
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
      // so does a chosen speed or key: they are the whole point of the record
      // for a track being practised, even before it has a marker or a play
      const noPlayback = d.rate === undefined && d.semitones === undefined;
      if (d.marker === null && d.loopA === null && noStats && noMusical && noPlayback) {
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

    new Setting(containerEl).setName(t("headingHotkeys")).setHeading();

    new Setting(containerEl)
      .setName(t("setHotkeysName"))
      .setDesc(t("setHotkeysDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.defaultHotkeys)
        .onChange(async (value) => {
          this.plugin.settings.defaultHotkeys = value;
          await this.plugin.saveSettings();
          // live, so trying a key out costs a keystroke instead of a restart
          if (this.plugin.applyDefaultHotkeys()) {
            new Notice(value ? t("hotkeysOn") : t("hotkeysOff"), 4000);
          } else {
            new Notice(t("hotkeysReloadHint"), 6000);
          }
        }));

    new Setting(containerEl).setName(t("headingFine")).setHeading();

    // desktop only: on mobile the WebView never reaches the system media
    // controls (see mediasession.ts), so the toggle would promise nothing
    if (Platform.isDesktop) {
      new Setting(containerEl)
        .setName(t("setMediaKeysName"))
        .setDesc(t("setMediaKeysDesc"))
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.mediaKeys)
          .onChange(async (value) => {
            this.plugin.settings.mediaKeys = value;
            this.plugin.mediaSession.applyEnabled();
            await this.plugin.saveSettings();
          }));
    }

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

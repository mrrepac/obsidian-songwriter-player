import { EventRef, TFile, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";
import { EXT_BTN_TITLE, openExternally, revealInExplorer } from "./external";
import { WaveformRenderer } from "./waveform";
import { formatTime } from "./types";

/**
 * Replaces (or, when inline players are off, merely decorates) every embedded
 * audio player rendered inside notes. A MutationObserver catches each <audio>
 * as it appears — in both reading mode and Live Preview — and either swaps in a
 * waveform widget wired to the shared engine, or keeps the native player and
 * adds the "open externally" button (the old Open Audio Externally behavior).
 */
export class EmbedPlayers {
  private plugin: SongwriterPlugin;
  private observer: MutationObserver | null = null;
  private docRef: Document | null = null;
  private widgets = new Set<EmbedPlayer>();

  constructor(plugin: SongwriterPlugin) {
    this.plugin = plugin;
  }

  private get doc(): Document {
    return this.docRef ?? activeDocument;
  }

  start() {
    this.docRef = activeDocument;
    this.applyVisibility();
    this.plugin.app.workspace.onLayoutReady(() => this.scanAll());
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as HTMLElement;
          if (el.tagName?.toLowerCase() === "audio") {
            this.process(el as HTMLAudioElement);
          } else {
            el.findAll("audio").forEach((a) => this.process(a as HTMLAudioElement));
          }
        });
      }
      // an embed re-render replaces its <audio> with a fresh node, orphaning
      // our widget — reap the detached ones so their listeners/rAF don't leak.
      this.pruneDetached();
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true });
  }

  applyVisibility() {
    this.doc.body.classList.toggle("sw-hide-embed-buttons", !this.plugin.settings.embedButtons);
  }

  /** Called when the "inline players" toggle flips: rebuild every decoration. */
  applyMode() {
    this.teardownAll();
    this.scanAll();
  }

  scanAll() {
    this.doc.body.findAll("audio").forEach((a) => this.process(a as HTMLAudioElement));
  }

  private pruneDetached() {
    for (const w of this.widgets) {
      if (!w.isConnected()) {
        w.destroy();
        this.widgets.delete(w);
      }
    }
  }

  resolveFile(audio: HTMLAudioElement): TFile | null {
    const embed = audio.closest(".internal-embed");
    let src = embed ? embed.getAttribute("src") : audio.getAttribute("src");
    if (!src) return null;
    src = src.split("#")[0];
    const active = this.plugin.app.workspace.getActiveFile();
    return this.plugin.app.metadataCache.getFirstLinkpathDest(src, active ? active.path : "");
  }

  private process(audio: HTMLAudioElement) {
    if (audio.hasAttribute("data-sw-processed")) return;
    if (audio.hasAttribute("data-open-ext-processed")) return; // old OAE plugin is still active
    // Live Preview can recycle DOM nodes and drop our marker attribute while the
    // decoration is still attached — skip if a widget/button already sits next to it.
    const next = audio.nextElementSibling;
    if (next && (next.hasClass("sw-embed") || next.hasClass("sw-ext-btn"))) return;
    const file = this.resolveFile(audio);
    if (!file) return;
    audio.setAttribute("data-sw-processed", "true");

    if (this.plugin.settings.inlinePlayers) {
      this.widgets.add(new EmbedPlayer(this.plugin, audio, file));
    } else {
      this.decorate(audio, file);
    }
  }

  /** Classic path (inline players off): native player + "open externally" button. */
  private decorate(audio: HTMLAudioElement, file: TFile) {
    const button = createEl("button", { cls: "sw-ext-btn clickable-icon" });
    setIcon(button, "external-link");
    button.title = EXT_BTN_TITLE;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = this.resolveFile(audio) ?? file;
      openExternally(this.plugin.app, f);
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = this.resolveFile(audio) ?? file;
      revealInExplorer(this.plugin.app, f);
    });

    const wrapper = createDiv({ cls: "sw-ext-wrapper" });
    if (audio.parentNode) {
      audio.parentNode.insertBefore(wrapper, audio);
      wrapper.appendChild(audio);
      wrapper.appendChild(button);
    } else {
      audio.insertAdjacentElement("afterend", button);
    }
  }

  private teardownAll() {
    for (const w of this.widgets) w.destroy();
    this.widgets.clear();
    // undo classic wrappers
    this.doc.body.findAll(".sw-ext-wrapper").forEach((wrapper) => {
      const audio = wrapper.find("audio");
      if (audio && wrapper.parentNode) {
        wrapper.parentNode.insertBefore(audio, wrapper);
      }
      wrapper.remove();
    });
    this.doc.body.findAll(".sw-ext-btn").forEach((b) => b.remove());
    this.doc.body.findAll("[data-sw-processed]").forEach((a) =>
      a.removeAttribute("data-sw-processed")
    );
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.teardownAll();
    this.doc.body.classList.remove("sw-hide-embed-buttons");
    this.docRef = null;
  }
}

/**
 * One inline waveform bound to a single audio file, sharing the plugin's single
 * engine with the sidebar. While its file is the loaded track it shows the live
 * playhead and its play button mirrors playback; otherwise it is a static
 * waveform whose play button (or a tap) makes it the active track.
 */
class EmbedPlayer {
  private plugin: SongwriterPlugin;
  private audio: HTMLAudioElement;
  private file: TFile;
  private root: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeEl: HTMLElement;
  private wave: WaveformRenderer;
  private io: IntersectionObserver | null = null;
  private revealed = false;
  private refs: EventRef[] = [];
  private cssRef: EventRef;
  private lastIcon = "";
  private lastTime = "";

  constructor(plugin: SongwriterPlugin, audio: HTMLAudioElement, file: TFile) {
    this.plugin = plugin;
    this.audio = audio;
    this.file = file;

    const engine = plugin.engine;
    audio.addClass("sw-embed-native-hidden");

    const root = createDiv({ cls: "sw-embed" });
    this.root = root;
    audio.insertAdjacentElement("afterend", root);

    const main = root.createDiv({ cls: "sw-embed-main" });
    this.playBtn = main.createEl("button", { cls: "sw-embed-play" });
    this.playBtn.title = t("playPauseTitle");
    this.playBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (engine.file?.path === this.file.path) void engine.playPause();
      else void engine.load(this.file, { autoplay: true });
    });

    const waveWrap = main.createDiv({ cls: "sw-embed-wave" });
    this.wave = new WaveformRenderer(plugin, engine, waveWrap, true);
    // tap on an inactive waveform: make this the active track and play from there
    this.wave.onActivate = (time) => {
      void (async () => {
        if (engine.file?.path !== this.file.path) await engine.load(this.file);
        await engine.playAt(time);
      })();
    };
    this.wave.onTick = () => this.updateTime();

    const ext = main.createEl("button", { cls: "sw-embed-ext clickable-icon" });
    setIcon(ext, "external-link");
    ext.title = EXT_BTN_TITLE;
    ext.addEventListener("click", (e) => {
      e.preventDefault();
      openExternally(plugin.app, this.file);
    });
    ext.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      revealInExplorer(plugin.app, this.file);
    });

    const meta = root.createDiv({ cls: "sw-embed-meta" });
    const name = meta.createSpan({ cls: "sw-embed-name", text: file.basename });
    name.title = file.path;
    this.timeEl = meta.createSpan({ cls: "sw-embed-time" });

    // engine → widget
    const on = (name: Parameters<typeof engine.on>[0], cb: () => void) => {
      this.refs.push(engine.on(name, cb));
    };
    on("track-changed", () => this.onActiveChanged());
    on("play-state", () => this.updatePlayIcon());
    on("data-changed", () => this.wave.markDirty());
    this.cssRef = plugin.app.workspace.on("css-change", () => this.wave.refreshColors());

    this.render();

    // lazy decode: only analyze the file once the widget scrolls into view
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.reveal();
    }, { rootMargin: "200px" });
    this.io.observe(root);
  }

  isConnected(): boolean {
    return this.root.isConnected;
  }

  private reveal() {
    if (this.revealed) return;
    this.revealed = true;
    this.io?.disconnect();
    this.io = null;
    void this.wave.setFile(this.file).then(() => {
      this.updateTime();
      this.updatePlayIcon();
    });
  }

  private onActiveChanged() {
    this.wave.refreshActive();
    this.render();
  }

  private render() {
    this.root.toggleClass("is-active", this.plugin.engine.file?.path === this.file.path);
    this.updatePlayIcon();
    this.updateTime();
  }

  private updatePlayIcon() {
    const active = this.plugin.engine.file?.path === this.file.path;
    const icon = active && this.plugin.engine.playing ? "pause" : "play";
    if (icon !== this.lastIcon) {
      this.lastIcon = icon;
      setIcon(this.playBtn, icon);
    }
  }

  private updateTime() {
    const engine = this.plugin.engine;
    const active = engine.file?.path === this.file.path;
    const total = this.wave.shownDuration;
    let text: string;
    if (active) {
      text = total > 0
        ? `${formatTime(engine.audio.currentTime)} / ${formatTime(total)}`
        : formatTime(engine.audio.currentTime);
    } else {
      text = total > 0 ? formatTime(total) : "";
    }
    if (text !== this.lastTime) {
      this.lastTime = text;
      this.timeEl.setText(text);
    }
  }

  destroy() {
    this.io?.disconnect();
    this.io = null;
    for (const ref of this.refs) this.plugin.engine.offref(ref);
    this.refs = [];
    this.plugin.app.workspace.offref(this.cssRef);
    this.wave.destroy();
    this.root.remove();
    this.audio.removeClass("sw-embed-native-hidden");
    this.audio.removeAttribute("data-sw-processed");
  }
}

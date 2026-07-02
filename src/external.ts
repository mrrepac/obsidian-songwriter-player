import { App, Notice, Platform, TFile, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";

/** Private App APIs that exist at runtime but are missing from obsidian.d.ts. */
interface AppPrivate extends App {
  openWithDefaultApp?(path: string): void;
  showInFolder?(path: string): void;
}

/** Open the file in the system default application (desktop and mobile). */
export function openExternally(app: App, file: TFile): void {
  const priv = app as AppPrivate;
  if (priv.openWithDefaultApp) {
    try {
      priv.openWithDefaultApp(file.path);
      return;
    } catch (e) {
      console.error("Songwriter: failed to open externally", e);
    }
  }
  new Notice(t("extOpenFailed"));
}

/** Reveal the file in the system file explorer (desktop only). */
export function revealInExplorer(app: App, file: TFile): void {
  if (!Platform.isDesktopApp) {
    new Notice(t("desktopOnly"));
    return;
  }
  const priv = app as AppPrivate;
  if (priv.showInFolder) {
    try {
      priv.showInFolder(file.path);
      return;
    } catch (e) {
      console.error("Songwriter: failed to reveal in explorer", e);
    }
  }
  new Notice(t("revealFailed"));
}

export const EXT_BTN_TITLE = t("extBtnTitle");

/**
 * Adds an "open externally" button next to every embedded audio player in
 * notes (ported from the Open Audio Externally plugin). Skips players the old
 * plugin already decorated, so both can coexist during the transition.
 */
export class EmbedAudioButtons {
  private plugin: SongwriterPlugin;
  private observer: MutationObserver | null = null;
  /** The document we attached to in start() — destroy() must clean the same one. */
  private docRef: Document | null = null;

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
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true });
  }

  applyVisibility() {
    this.doc.body.classList.toggle("sw-hide-embed-buttons", !this.plugin.settings.embedButtons);
  }

  scanAll() {
    this.doc.body.findAll("audio").forEach((a) => this.process(a as HTMLAudioElement));
  }

  private resolveFile(audio: HTMLAudioElement): TFile | null {
    const embed = audio.closest(".internal-embed");
    let src = embed ? embed.getAttribute("src") : audio.getAttribute("src");
    if (!src) return null;
    src = src.split("#")[0];
    const active = this.plugin.app.workspace.getActiveFile();
    return this.plugin.app.metadataCache.getFirstLinkpathDest(src, active ? active.path : "");
  }

  private process(audio: HTMLAudioElement) {
    if (audio.hasAttribute("data-sw-ext-processed")) return;
    if (audio.hasAttribute("data-open-ext-processed")) return; // old OAE plugin is still active
    audio.setAttribute("data-sw-ext-processed", "true");
    if (!this.resolveFile(audio)) return;

    const button = createEl("button", { cls: "sw-ext-btn clickable-icon" });
    setIcon(button, "external-link");
    // title only — adding aria-label too makes Obsidian show a second tooltip
    button.title = EXT_BTN_TITLE;
    // resolve lazily at click time: the link target may change after render
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = this.resolveFile(audio);
      if (file) openExternally(this.plugin.app, file);
      else new Notice(t("audioNotFound"));
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = this.resolveFile(audio);
      if (file) revealInExplorer(this.plugin.app, file);
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

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.doc.body.classList.remove("sw-hide-embed-buttons");
    this.doc.body.findAll(".sw-ext-wrapper").forEach((wrapper) => {
      const audio = wrapper.find("audio");
      if (audio && wrapper.parentNode) {
        wrapper.parentNode.insertBefore(audio, wrapper);
        audio.removeAttribute("data-sw-ext-processed");
      }
      wrapper.remove();
    });
    this.doc.body.findAll(".sw-ext-btn").forEach((b) => b.remove());
    this.doc.body.findAll("[data-sw-ext-processed]").forEach((a) =>
      a.removeAttribute("data-sw-ext-processed")
    );
    this.docRef = null;
  }
}

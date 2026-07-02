import { App, Notice, Platform, TFile, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";

/** Open the file in the system default application (mobile fallback included). */
export async function openExternally(app: App, file: TFile): Promise<void> {
  if (Platform.isDesktopApp) {
    try {
      const fullPath = (app.vault.adapter as any).getFullPath(file.path);
      const { shell } = require("electron");
      await shell.openPath(fullPath);
      return;
    } catch (e) {
      console.error("Songwriter: failed to open externally via electron", e);
    }
  }
  try {
    (app as any).openWithDefaultApp(file.path);
  } catch (e) {
    console.error("Songwriter: failed to open externally", e);
    new Notice(t("extOpenFailed"));
  }
}

/** Reveal the file in the system file explorer (desktop only). */
export function revealInExplorer(app: App, file: TFile): void {
  if (!Platform.isDesktopApp) {
    new Notice(t("desktopOnly"));
    return;
  }
  try {
    const fullPath = (app.vault.adapter as any).getFullPath(file.path);
    const { shell } = require("electron");
    shell.showItemInFolder(fullPath);
  } catch (e) {
    console.error("Songwriter: failed to reveal in explorer", e);
    new Notice(t("revealFailed"));
  }
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

  constructor(plugin: SongwriterPlugin) {
    this.plugin = plugin;
  }

  start() {
    this.applyVisibility();
    this.plugin.app.workspace.onLayoutReady(() => this.scanAll());
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as HTMLElement;
          if (el.tagName?.toLowerCase() === "audio") {
            this.process(el as HTMLAudioElement);
          } else if (el.querySelectorAll) {
            el.querySelectorAll("audio").forEach((a) => this.process(a));
          }
        });
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  applyVisibility() {
    document.body.classList.toggle("sw-hide-embed-buttons", !this.plugin.settings.embedButtons);
  }

  scanAll() {
    document.querySelectorAll("audio").forEach((a) => this.process(a));
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
      if (file) void openExternally(this.plugin.app, file);
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
    document.body.classList.remove("sw-hide-embed-buttons");
    document.querySelectorAll(".sw-ext-wrapper").forEach((wrapper) => {
      const audio = wrapper.querySelector("audio");
      if (audio && wrapper.parentNode) {
        wrapper.parentNode.insertBefore(audio, wrapper);
        audio.removeAttribute("data-sw-ext-processed");
      }
      wrapper.remove();
    });
    document.querySelectorAll(".sw-ext-btn").forEach((b) => b.remove());
    document.querySelectorAll("[data-sw-ext-processed]").forEach((a) =>
      a.removeAttribute("data-sw-ext-processed")
    );
  }
}

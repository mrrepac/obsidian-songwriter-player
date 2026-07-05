import { MarkdownView, Platform, setIcon } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";

/**
 * Floating action button laid over the note on mobile. A tap jumps to the
 * marker (or the start) and plays — saving a swipe to the sidebar player and
 * back. Two behaviors (setting `fabMode`):
 *   "marker" (default) — every tap (re)starts from the marker; simplest.
 *   "smart"            — tap plays from the marker while paused, pauses while
 *                        playing; the icon toggles play⇄pause.
 *
 * Visible only on mobile, only on a markdown note, only with a track loaded,
 * and only while the setting is on. The button is created once and shown or
 * hidden — never re-created — so toggling the setting takes effect live.
 */
export class MobileMarkerButton {
  private plugin: SongwriterPlugin;
  private btn: HTMLButtonElement | null = null;
  private docRef: Document | null = null;
  private lastIcon = "";

  constructor(plugin: SongwriterPlugin) {
    this.plugin = plugin;
  }

  start() {
    if (!Platform.isMobile) return;
    this.docRef = activeDocument;
    const btn = this.docRef.body.createEl("button", { cls: "sw-fab" });
    btn.setAttribute("aria-label", t("fabTitle"));
    setIcon(btn, "play");
    this.lastIcon = "play";
    // Suppress the compatibility mouse events that would move focus to the
    // button: this keeps the editor focused so the on-screen keyboard stays up.
    // The click still fires, so the action below runs normally.
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const engine = this.plugin.engine;
      if (this.plugin.settings.fabMode === "smart" && engine.playing) {
        engine.playPause(); // smart mode: pause without leaving the note
      } else {
        void engine.playFromMarker(); // jump to marker (or start) and play
      }
    });
    this.btn = btn;

    this.plugin.registerEvent(this.plugin.engine.on("track-changed", () => this.update()));
    this.plugin.registerEvent(this.plugin.engine.on("play-state", () => this.update()));
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.update()));
    this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => this.update()));

    this.update();
  }

  /** Recompute visibility and swap the play/pause icon. */
  update() {
    if (!this.btn) return;
    const onMarkdown = this.plugin.app.workspace.getActiveViewOfType(MarkdownView) !== null;
    const show = this.plugin.settings.mobileFab && !!this.plugin.engine.file && onMarkdown;
    this.btn.toggle(show);
    if (!show) return;
    // Only "smart" mode shows a pause state; "marker" always offers "play".
    const smartPause = this.plugin.settings.fabMode === "smart" && this.plugin.engine.playing;
    const icon = smartPause ? "pause" : "play";
    if (icon !== this.lastIcon) {
      this.lastIcon = icon;
      setIcon(this.btn, icon);
    }
  }

  /** Called from the setting toggle. */
  applyVisibility() {
    this.update();
  }

  destroy() {
    this.btn?.remove();
    this.btn = null;
    this.docRef = null;
  }
}

import { App, FileSystemAdapter, Notice, Platform, TFile } from "obsidian";
import { t } from "./i18n";

/**
 * PROBE (1.8.0): hand a track to the system the way the file explorer does —
 * as a path on disk, not as bytes from memory. Chromium's own drag offers a
 * virtual file, which the desktop accepts and REAPER ignores; a path is the
 * only form REAPER understands. Returns false when the native route is not
 * available, so the caller can fall back to the ordinary drag.
 */
export function dragOutNatively(app: App, file: TFile): boolean {
  if (!Platform.isDesktopApp) return false;
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return false;
  const req = (window as unknown as { require?: (id: string) => any }).require;
  if (!req) return false;

  try {
    const { nativeImage } = req("electron");
    const webContents = req("@electron/remote").getCurrentWebContents();
    const path = adapter.getFullPath(file.path);
    // an icon is mandatory: a 1×1 image is the cheapest non-empty one, and
    // createEmpty covers the platforms that reject it
    try {
      webContents.startDrag({ file: path, icon: nativeImage.createFromDataURL(DRAG_PIXEL) });
    } catch {
      webContents.startDrag({ file: path, icon: nativeImage.createEmpty() });
    }
    console.log("[songwriter probe] native drag started:", path);
    return true;
  } catch (e) {
    console.error("[songwriter probe] native drag failed", e);
    return false;
  }
}

const DRAG_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

import { App, Notice, Platform, TFile } from "obsidian";
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

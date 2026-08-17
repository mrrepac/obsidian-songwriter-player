import { App, MarkdownView, Notice, TFile, TFolder } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";

/** Newer than our minAppVersion floor, so it is asked for, not assumed. */
interface FileManagerMaybe {
  getAvailablePathForAttachment?(filename: string, sourcePath?: string): Promise<string>;
}

export interface CopyInput {
  sourceName: string;
  sourceSize: number;
  existing: { name: string; size: number }[];
}

export interface CopyTarget {
  /** the file already sitting there, when copying again would only add a twin */
  reuse: string | null;
}

/**
 * Same name and same size is the same track — sorting a pack sends things
 * twice, and a second copy helps nobody.
 */
export function pickCopyTarget(input: CopyInput): CopyTarget {
  const twin = input.existing.find(
    f => f.name === input.sourceName && f.size === input.sourceSize
  );
  return { reuse: twin ? twin.name : null };
}

/**
 * Copy the track next to a note and link it there. The vault's own attachment
 * setting decides the folder, so this follows whatever the user already set up.
 * The player is deliberately left alone: filing is not listening.
 */
export async function copyTrackToNote(
  app: App, plugin: SongwriterPlugin, file: TFile, note: TFile
): Promise<void> {
  try {
    const manager = app.fileManager as unknown as FileManagerMaybe;
    const suggested = typeof manager.getAvailablePathForAttachment === "function"
      ? await manager.getAvailablePathForAttachment(file.name, note.path)
      : `${note.parent?.path ?? ""}/${file.name}`;

    // no "/" means the attachment sits at the vault root, not in a folder
    // named after a mangled filename — slice(0, -1) would silently do that
    const slash = suggested.lastIndexOf("/");
    const folder = await ensureFolder(app, slash === -1 ? "" : suggested.slice(0, slash));
    const existing = folder.children
      .filter((c): c is TFile => c instanceof TFile)
      .map(c => ({ name: c.name, size: c.stat.size }));
    const { reuse } = pickCopyTarget({
      sourceName: file.name, sourceSize: file.stat.size, existing
    });

    const path = folder.path ? `${folder.path}/${reuse ?? file.name}` : (reuse ?? file.name);
    let copy = app.vault.getAbstractFileByPath(path);
    if (!(copy instanceof TFile)) {
      copy = await app.vault.createBinary(suggested, await app.vault.readBinary(file));
    }
    if (!(copy instanceof TFile)) {
      new Notice(t("copyFailed"));
      return;
    }

    // the copy inherits marker, loop, counters and measurements: without them
    // it is a stranger to the plugin and gets analysed all over again
    const data = plugin.settings.tracks[file.path];
    if (data && !plugin.settings.tracks[copy.path]) {
      plugin.settings.tracks[copy.path] = { ...data };
      await plugin.saveSettings();
    }

    const link = app.fileManager.generateMarkdownLink(copy, note.path);
    const embed = link.startsWith("!") ? link : `!${link}`;
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file?.path === note.path) view.editor.replaceSelection(embed);
    else await app.vault.append(note, `\n${embed}\n`);

    new Notice(t("copiedToNote")(copy.name));
  } catch (e) {
    // createBinary/append/createFolder all reject rather than resolve on a
    // real failure (permissions, an existing-file clash, a vanished source) —
    // uncaught, that is a silent no-op with no Notice at all
    console.error("Songwriter: failed to copy track to note", e);
    new Notice(t("copyFailed"));
  }
}

/**
 * The folder for the copy, created only if it is genuinely absent.
 *
 * createFolder on a name that differs only in case destroys the folder that is
 * already there — in July that took out an existing "Архив\!!!СПЕКТАКЛИ". So
 * an existing folder is matched case-insensitively and reused as it is spelled.
 */
async function ensureFolder(app: App, path: string): Promise<TFolder> {
  if (!path) return app.vault.getRoot();
  const wanted = path.toLowerCase();
  const found = app.vault.getAllLoadedFiles()
    .find((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase() === wanted);
  return found ?? await app.vault.createFolder(path);
}

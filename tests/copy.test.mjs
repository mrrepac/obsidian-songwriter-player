/**
 * Sorting a pack means sending the same track to a note more than once by
 * accident. Doing that must not leave "beat 1.mp3", "beat 2.mp3", "beat 3.mp3"
 * behind — a file that is already there is the file we link to.
 */
import { bundle, load, obsidianStub, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("copy — a track into a note");
  const { pickCopyTarget } = load(await bundle("src/copy.ts"), { modules: { obsidian: obsidianStub() } });

  const existing = [{ name: "beat.mp3", size: 4096 }, { name: "other.mp3", size: 512 }];

  s.check("the same file already there is reused",
    () => pickCopyTarget({ sourceName: "beat.mp3", sourceSize: 4096, existing }).reuse === "beat.mp3");
  s.check("a different file of the same name is not",
    () => pickCopyTarget({ sourceName: "beat.mp3", sourceSize: 999, existing }).reuse === null);
  s.check("an unknown name is copied",
    () => pickCopyTarget({ sourceName: "new.mp3", sourceSize: 4096, existing }).reuse === null);
  s.check("an empty folder is copied into",
    () => pickCopyTarget({ sourceName: "beat.mp3", sourceSize: 4096, existing: [] }).reuse === null);

  return s.report();
}

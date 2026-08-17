/**
 * Who commands the player.
 *
 * Opening a note used to replace the queue before anything else was decided,
 * so a note holding one audio file collapsed a thirty-track folder playlist.
 * The track kept playing, which is why nobody noticed until they pressed next.
 */
import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("pickup — who commands the player");
  const { decidePickup } = load(await bundle("src/pickup.ts"));

  // a folder track is playing; the note being opened holds a different one
  const base = {
    kind: "note-audio", playing: true, mode: "hybrid",
    currentPath: "beats/01.mp3", targetPath: "songs/demo.mp3",
    queuePaths: ["songs/demo.mp3", "songs/second.mp3"]
  };
  const decide = (extra) => decidePickup({ ...base, ...extra });

  // ---- the whole point: a playing folder is not for the taking ----
  s.check("a note never touches the queue while music plays",
    () => decide({}).setQueue === false);
  s.check("hybrid still offers the switch",
    () => decide({}).action === "offer");
  s.check("manual stays silent",
    () => decide({ mode: "manual" }).action === "none");
  s.check("manual keeps the queue too",
    () => decide({ mode: "manual" }).setQueue === false);
  s.check("auto means auto — it was chosen on purpose",
    () => decide({ mode: "auto" }).setQueue === true && decide({ mode: "auto" }).action === "load");

  // ---- silence gives the note its old power back ----
  s.check("a silent player takes the note's audio",
    () => decide({ playing: false }).setQueue === true && decide({ playing: false }).action === "load");
  s.check("manual is manual even in silence",
    () => decide({ playing: false, mode: "manual" }).action === "none");
  s.check("but the queue still follows the note",
    () => decide({ playing: false, mode: "manual" }).setQueue === true);
  s.check("a note whose track is already loaded is left alone", () => {
    const d = decide({ playing: false, targetPath: "songs/demo.mp3", currentPath: "songs/demo.mp3" });
    return d.action === "none" && d.setQueue === true;
  });
  s.check("and so is a note holding the loaded track further down the list", () => {
    const d = decide({ playing: false, currentPath: "songs/second.mp3" });
    return d.action === "none" && d.setQueue === true;
  });

  // ---- a note with no audio belongs to nobody ----
  s.check("a note without audio changes nothing", () => {
    const d = decide({ kind: "note-empty" });
    return d.setQueue === false && d.action === "none";
  });

  // ---- an audio file is a command, not a side effect ----
  s.check("an opened audio file rebuilds the queue even mid-playback",
    () => decide({ kind: "audio" }).setQueue === true);
  s.check("and hybrid offers it rather than cutting the music",
    () => decide({ kind: "audio" }).action === "offer");
  s.check("the same file twice does not restart it", () => {
    const d = decide({ kind: "audio", targetPath: "beats/01.mp3" });
    return d.action === "none" && d.setQueue === true;
  });

  return s.report();
}

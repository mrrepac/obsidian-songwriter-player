/**
 * The order shown and the order walked by the arrows are the same order.
 * Two different sequences would be a defect wearing a feature's clothes.
 */
import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("playlist — the order of things");
  const { sortTracks } = load(await bundle("src/playlist.ts"));

  const files = [
    { path: "b.mp3", basename: "b2", mtime: 300, bpm: 90, plays: 1 },
    { path: "a.mp3", basename: "a10", mtime: 100, bpm: null, plays: 7 },
    { path: "c.mp3", basename: "a2", mtime: 200, bpm: 140, plays: 0 }
  ];
  const paths = (sort) => sortTracks(files, sort).map(f => f.path).join(",");

  s.check("by name, and numbers count as numbers", () => paths("name") === "c.mp3,a.mp3,b.mp3");
  s.check("by tempo, slowest first", () => paths("tempo") === "b.mp3,c.mp3,a.mp3");
  s.check("unmeasured tracks sink to the bottom", () => sortTracks(files, "tempo").at(-1).path === "a.mp3");
  s.check("by plays, most played first", () => paths("plays") === "a.mp3,b.mp3,c.mp3");
  s.check("by recency, newest first", () => paths("recent") === "b.mp3,c.mp3,a.mp3");
  s.check("sorting does not mutate the input", () => {
    sortTracks(files, "plays");
    return files[0].path === "b.mp3";
  });

  return s.report();
}

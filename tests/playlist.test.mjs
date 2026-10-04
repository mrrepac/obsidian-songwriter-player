/**
 * The order shown and the order walked by the arrows are the same order.
 * Two different sequences would be a defect wearing a feature's clothes.
 */
import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("playlist — the order of things");
  const { sortTracks, nextVerdict, rowVisible } = load(await bundle("src/playlist.ts"));

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

  // ---- sorting a pack: one button steps through the marks ----
  {
    let v;
    const seen = [];
    for (let i = 0; i < 4; i++) { v = nextVerdict(v); seen.push(v ?? "new"); }
    s.check("new → used → saved → dropped → new", () => seen.join(",") === "used,saved,dropped,new");
    s.check("a mark it does not know starts the cycle over", () => nextVerdict("taken") === "used");
  }

  // ---- which rows the search and the filter let through ----
  {
    s.check("no search and no filter shows everything", () => rowVisible("Yokai hunter", "dropped", "all", ""));
    s.check("new hides every marked track", () => !rowVisible("a", "used", "unsorted", "")
      && !rowVisible("a", "dropped", "unsorted", "") && rowVisible("a", undefined, "unsorted", ""));
    s.check("a mark's filter shows only that mark", () => rowVisible("a", "saved", "saved", "")
      && !rowVisible("a", "used", "saved", "") && !rowVisible("a", undefined, "saved", ""));
    s.check("search ignores case and word order", () => rowVisible("Dark Hyperpop x Drain - running", undefined, "all", "drain DARK"));
    s.check("every word has to match", () => !rowVisible("Dark Hyperpop", undefined, "all", "dark trap"));
    s.check("ё and е are the same letter", () => rowVisible("Ёлка бит", undefined, "all", "елка"));
    s.check("search and filter work together", () => !rowVisible("drain", "used", "unsorted", "drain"));
  }

  return s.report();
}

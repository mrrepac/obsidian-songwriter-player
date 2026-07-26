/**
 * What survives a restart.
 *
 * loadSettings() rebuilds every track record field by field, which means a
 * field added to TrackData but forgotten here is written to disk faithfully and
 * then dropped on the next start — silent data loss with nothing in the code to
 * point at. That is exactly what happened to the per-track speed and
 * transposition between 1.4.0 and 1.4.1. saveSettings() has the mirror hazard:
 * it prunes records it considers empty, so a new field also has to count as
 * content or the record is deleted out from under it.
 *
 * These run the real loadSettings/saveSettings pair over a handmade data.json.
 */
import { browserGlobals, bundle, load, obsidianStub, suite } from "./harness.mjs";

const track = (extra) => ({ marker: null, loopA: null, loopB: null, plays: 0, playedSec: 0, ...extra });

export default async function run() {
  const s = suite("settings — what survives a restart");
  // the analysis worker is inlined as a string at build time and never started
  // here, so an empty one keeps the bundle small and the test fast
  const source = await bundle("src/main.ts", { ANALYSIS_WORKER_SOURCE: '""' });

  let stored = null;
  let saved = null;
  const obsidian = obsidianStub({
    Plugin: class {
      async loadData() { return stored; }
      async saveData(data) { saved = JSON.parse(JSON.stringify(data)); }
    }
  });
  const exports = load(source, { modules: { obsidian }, globals: browserGlobals() });
  const SongwriterPlugin = exports.default ?? exports;

  /** Load a data.json, save it straight back, and report both ends. */
  const roundTrip = async (data) => {
    stored = data;
    saved = null;
    const plugin = new SongwriterPlugin();
    await plugin.loadSettings();
    // snapshot: saveSettings prunes in place, so holding the live object would
    // blur "the load dropped it" into "the save pruned it" — and those are two
    // different bugs with two different fixes
    const loaded = JSON.parse(JSON.stringify(plugin.settings));
    await plugin.saveSettings();
    return { loaded, saved };
  };

  // ---- per-track playback settings ----
  {
    const { loaded, saved } = await roundTrip({
      tracks: {
        "slowed.mp3": track({ rate: 0.8, semitones: -3 }),
        "clamped.mp3": track({ rate: 5, semitones: 99 }),
        "as-recorded.mp3": track({ rate: 1, semitones: 0 }),
        "garbage.mp3": track({ rate: "fast", semitones: null }),
        "empty.mp3": track({}),
        "marked.mp3": track({ marker: 12.5 }),
        "measured.mp3": track({ bpm: 130, key: "E", scale: "minor" })
      }
    });
    const t = saved.tracks;
    s.check("speed and key come back", () => loaded.tracks["slowed.mp3"].rate === 0.8
      && loaded.tracks["slowed.mp3"].semitones === -3);
    s.check("and are still there after saving", () => t["slowed.mp3"].rate === 0.8
      && t["slowed.mp3"].semitones === -3);
    s.check("out-of-range values are clamped, not dropped",
      () => t["clamped.mp3"].rate === 2 && t["clamped.mp3"].semitones === 12);
    s.check("a chosen speed keeps an otherwise empty record alive", () => t["slowed.mp3"] !== undefined);
    s.check("as recorded is not worth storing", () => t["as-recorded.mp3"] === undefined);
    s.check("nonsense is not worth storing", () => t["garbage.mp3"] === undefined);
    s.check("an empty record is pruned", () => t["empty.mp3"] === undefined);
    s.check("a marker keeps a record", () => t["marked.mp3"].marker === 12.5);
    s.check("a measurement keeps a record", () => t["measured.mp3"].bpm === 130);
  }

  // ---- counters ----
  {
    const { saved } = await roundTrip({
      tracks: {
        "barely.mp3": track({ playedSec: 3 }),
        "listened.mp3": track({ playedSec: 240 }),
        "played.mp3": track({ plays: 2 })
      }
    });
    s.check("a few seconds of listening is not a record", () => saved.tracks["barely.mp3"] === undefined);
    s.check("real listening time is kept", () => saved.tracks["listened.mp3"].playedSec === 240);
    s.check("a play count is kept", () => saved.tracks["played.mp3"].plays === 2);
  }

  // ---- migration from the shapes older versions wrote ----
  {
    const { loaded } = await roundTrip({
      startFromPointOnLoad: false,
      tracks: {
        "old-point.mp3": { startPoint: 3.5, plays: 1 },
        "old-markers.mp3": { markers: [{ time: 7 }], plays: 1 },
        "both.mp3": { marker: 1, startPoint: 99, plays: 1 }
      }
    });
    s.check("a pre-1.0 start point becomes the marker", () => loaded.tracks["old-point.mp3"].marker === 3.5);
    s.check("the first named marker becomes the marker", () => loaded.tracks["old-markers.mp3"].marker === 7);
    s.check("a real marker wins over the old field", () => loaded.tracks["both.mp3"].marker === 1);
    s.check("the renamed setting carries over", () => loaded.startFromMarkerOnLoad === false);
  }

  // ---- the tempo window re-folds measurements it is allowed to touch ----
  {
    const { loaded } = await roundTrip({
      tempoWindowLow: 80,
      tracks: {
        "fast.mp3": track({ bpm: 160, plays: 1 }),
        "slow.mp3": track({ bpm: 70, plays: 1 }),
        "by-hand.mp3": track({ bpm: 160, musicalEdited: true, plays: 1 })
      }
    });
    s.check("a tempo above the window is halved into it", () => loaded.tracks["fast.mp3"].bpm === 80);
    s.check("a tempo below the window is doubled into it", () => loaded.tracks["slow.mp3"].bpm === 140);
    s.check("a hand correction is never re-folded", () => loaded.tracks["by-hand.mp3"].bpm === 160);
  }

  // ---- defaults ----
  {
    const { loaded } = await roundTrip({});
    s.check("an empty file yields defaults", () => loaded.pickupMode === "hybrid" && loaded.skipSeconds === 5);
    const missing = await roundTrip(null);
    s.check("no file at all yields defaults", () => missing.loaded.pickupMode === "hybrid");
  }

  // ---- hotkeys became opt-in, without pulling them from under anyone ----
  {
    const fresh = await roundTrip(null);
    s.check("a fresh install starts without hotkeys", () => fresh.loaded.defaultHotkeys === false);

    const upgraded = await roundTrip({ tracks: {} });
    s.check("a vault that was already here keeps them", () => upgraded.loaded.defaultHotkeys === true);

    const declined = await roundTrip({ defaultHotkeys: false, tracks: {} });
    s.check("a choice already made is not overruled", () => declined.loaded.defaultHotkeys === false);
  }

  return s.report();
}

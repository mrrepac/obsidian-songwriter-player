/**
 * What gets handed to the operating system.
 *
 * The platform is entitled to refuse: setActionHandler throws for an action it
 * has not implemented, and setPositionState throws outright on a position past
 * the end of the track or a stopped playback rate. Either one escaping would
 * take down whatever called into the bridge, so the fake platform here is as
 * picky as the real one and the tests push the awkward values through it.
 */
import { bundle, load, suite } from "./harness.mjs";

/** A media session that refuses what a real one refuses. */
function fakePlatform({ refuse = [] } = {}) {
  const handlers = {};
  const positions = [];
  const mediaSession = {
    metadata: undefined,
    playbackState: "none",
    setActionHandler(action, handler) {
      if (refuse.includes(action)) throw new TypeError(`unsupported action: ${action}`);
      handlers[action] = handler;
    },
    setPositionState(state) {
      if (state) {
        if (!(state.duration > 0)) throw new TypeError("duration must be positive");
        if (state.position > state.duration) throw new TypeError("position past the end");
        if (state.playbackRate === 0) throw new TypeError("playback rate of zero");
      }
      positions.push(state ?? null);
    }
  };
  return { handlers, positions, mediaSession, navigator: { mediaSession } };
}

function fakePlugin(over = {}) {
  const engine = {
    file: null,
    queue: [],
    queueSource: null,
    playing: false,
    audio: {
      duration: NaN,
      currentTime: 0,
      playbackRate: 1,
      pause() { engine.playing = false; }
    },
    on() { return {}; },
    safePlay() { engine.playing = true; },
    step() {},
    seekBy(seconds) { engine.audio.currentTime += seconds; },
    seekTo(seconds) { engine.audio.currentTime = seconds; },
    ...over
  };
  return {
    settings: { mediaKeys: true, skipSeconds: 5 },
    engine,
    registerEvent() {},
    registerDomEvent() {}
  };
}

export default async function run() {
  const s = suite("media session — what the system is told");
  const source = await bundle("src/mediasession.ts");

  const bridgeFor = (platform) => load(source, {
    globals: {
      navigator: platform.navigator,
      window: { MediaMetadata: class { constructor(init) { Object.assign(this, init); } } },
      console: { warn() {} }
    }
  }).MediaSessionBridge;

  const bound = (handlers, action) => typeof handlers[action] === "function";

  // ---- nothing loaded ----
  {
    const p = fakePlatform();
    new (bridgeFor(p))(fakePlugin()).start();
    s.check("idle: nothing to show",
      () => p.mediaSession.metadata === null && p.mediaSession.playbackState === "none");
    s.check("idle: no transport offered", () => !bound(p.handlers, "play") && !bound(p.handlers, "pause"));
  }

  // ---- a track, no playlist ----
  {
    const p = fakePlatform();
    const plugin = fakePlugin({ file: { basename: "take 3", parent: { name: "demos" } }, playing: true });
    plugin.engine.audio.duration = 210;
    plugin.engine.audio.currentTime = 12;
    new (bridgeFor(p))(plugin).start();

    s.check("the track names the card", () => p.mediaSession.metadata.title === "take 3");
    s.check("its folder stands in for the artist", () => p.mediaSession.metadata.artist === "demos");
    s.check("the state follows playback", () => p.mediaSession.playbackState === "playing");
    s.check("transport is offered", () => bound(p.handlers, "play") && bound(p.handlers, "pause"));
    s.check("so is seeking", () => bound(p.handlers, "seekbackward")
      && bound(p.handlers, "seekforward") && bound(p.handlers, "seekto"));
    s.check("no playlist, no arrows",
      () => !bound(p.handlers, "previoustrack") && !bound(p.handlers, "nexttrack"));

    const last = p.positions[p.positions.length - 1];
    s.check("the position is reported", () => last.duration === 210 && last.position === 12,
      JSON.stringify(last));

    // the handlers have to drive the engine, not just exist
    s.check("pause reaches the engine", () => {
      p.handlers.pause();
      return plugin.engine.playing === false;
    });
    s.check("seeking uses the plugin's own step", () => {
      p.handlers.seekforward({});
      return plugin.engine.audio.currentTime === 17;
    });
    s.check("but the platform's offset wins when it sends one", () => {
      p.handlers.seekforward({ seekOffset: 30 });
      return plugin.engine.audio.currentTime === 47;
    });
    s.check("the scrubber lands where it was dropped", () => {
      p.handlers.seekto({ seekTime: 99 });
      return plugin.engine.audio.currentTime === 99;
    });
    s.check("a scrub with no time is ignored", () => {
      p.handlers.seekto({});
      return plugin.engine.audio.currentTime === 99;
    });
  }

  // ---- a playlist ----
  {
    const p = fakePlatform();
    const plugin = fakePlugin({
      file: { basename: "b", parent: { name: "demos" } },
      queue: [1, 2, 3],
      queueSource: { name: "Songs in progress" }
    });
    plugin.engine.audio.duration = 100;
    new (bridgeFor(p))(plugin).start();
    s.check("a playlist brings the arrows",
      () => bound(p.handlers, "previoustrack") && bound(p.handlers, "nexttrack"));
    s.check("where the playlist came from stands in for the artist",
      () => p.mediaSession.metadata.artist === "Songs in progress");
  }

  // ---- switched off ----
  {
    const p = fakePlatform();
    const plugin = fakePlugin({ file: { basename: "a", parent: { name: "d" } } });
    plugin.settings.mediaKeys = false;
    new (bridgeFor(p))(plugin).start();
    s.check("switched off, nothing is handed over",
      () => p.mediaSession.metadata === null && !bound(p.handlers, "play"));
  }

  // ---- a platform that refuses some actions ----
  {
    const p = fakePlatform({ refuse: ["seekto", "seekbackward", "nexttrack"] });
    const plugin = fakePlugin({ file: { basename: "a", parent: { name: "d" } }, queue: [1, 2] });
    plugin.engine.audio.duration = 100;
    let threw = null;
    try {
      new (bridgeFor(p))(plugin).start();
    } catch (e) {
      threw = e;
    }
    s.check("a refused action does not take the rest with it",
      () => threw === null && bound(p.handlers, "play"), threw ? String(threw) : "");
  }

  // ---- positions the API would reject ----
  {
    const p = fakePlatform();
    const plugin = fakePlugin({ file: { basename: "a", parent: { name: "d" } } });
    const bridge = new (bridgeFor(p))(plugin);
    let threw = null;
    try {
      bridge.start();                          // duration still unknown
      plugin.engine.audio.duration = 60;
      plugin.engine.audio.currentTime = 61.5;  // past the end, mid seek
      plugin.engine.audio.playbackRate = 0;    // stopped hard by the browser
      bridge.applyEnabled();
    } catch (e) {
      threw = e;
    }
    const reported = p.positions.filter(Boolean);
    s.check("an unknown duration reports nothing at all", () => p.positions.some((state) => state === null));
    s.check("a hostile position does not throw", () => threw === null, threw ? String(threw) : "");
    s.check("the position is clamped into the track", () => reported.every((r) => r.position <= r.duration));
    s.check("a stopped rate is never reported", () => reported.every((r) => r.playbackRate > 0));
  }

  // ---- teardown ----
  {
    const p = fakePlatform();
    const plugin = fakePlugin({ file: { basename: "a", parent: { name: "d" } }, queue: [1, 2] });
    plugin.engine.audio.duration = 100;
    const bridge = new (bridgeFor(p))(plugin);
    bridge.start();
    bridge.destroy();
    const stillBound = ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"]
      .some((action) => bound(p.handlers, action));
    s.check("unloading releases the session", () => !stillBound
      && p.mediaSession.metadata === null && p.mediaSession.playbackState === "none");
  }

  return s.report();
}

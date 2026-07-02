# Songwriter

An advanced sidebar audio player for songwriting.

Obsidian's embedded audio unloads as the note scrolls, and playback cuts off. Songwriter
keeps the player in its own side panel: scroll your lyrics as much as you like — the music
keeps playing. Playback even survives closing the panel (the sound lives in the plugin,
not in the UI).

*Читаете по-русски? Есть [русская версия README](README.ru.md).*

## Features

- **Right-sidebar panel** — opened with the ribbon button (a note icon) or a command.
- **Pickup from the note** — the player takes the audio from the note you open (an
  embed `![[song.mp3]]` or a link `[[song.mp3]]`). If music is already playing, it offers
  to switch with a small banner instead of interrupting. The mode is configurable:
  hybrid / always / manual.
- **Track waveform**:
  - single click — play from there (a click outside the loop zone clears the zone);
  - double click — set the marker;
  - press and drag — select an A-B zone;
  - drag a zone edge — move it (the cursor turns into ↔).
- **Marker (⚑)** — one point per track: mark the spot you keep coming back to while
  working on a song. "Play from marker" always starts there (with no marker — from the
  start). The marker is remembered per file.
- **A-B loop zone** — a selected fragment of the waveform plays in a loop; the zone
  start automatically becomes the marker, so "Play from marker" restarts the loop from
  its beginning. Seeking outside the zone by hand does not drag you back — the loop
  only kicks in when playback itself reaches the B edge. The zone is remembered per
  file; clear it by clicking outside it or with the Clear A-B loop zone command (the
  marker stays).
- **Several audio files in one note** — a dropdown lists the note's tracks.
- **Play count and total listened time** — next to the track name (`▶ 27 · 2h40m`).
  A run only counts once 5 seconds have actually sounded (start-and-stop does not
  count; pause-and-resume keeps accumulating). Every loop-zone pass is a new run.
  Listened time accumulates only while sound is actually playing. Right-click the
  counter to reset both.
- **Back to the track's note** — click the track name (or `Ctrl+Alt+S`) to jump to the
  note the track was picked up from: if it is open in a tab, that tab is focused,
  otherwise the note opens; if the source is unknown, any note linking to the file is
  used.
- **Unload track** — the ⏏ button in the track row (or the `Unload track` command):
  the player clears and holds nothing while you work on other things; the hotkeys
  cannot fire by accident. Load a track again with the "Load audio from the note"
  button or just by opening a note with audio.
- **Open externally** (ported from the Open Audio Externally plugin): a ⧉ button to
  the right of the track name in the panel — and the same button next to every
  embedded audio player in notes. Click opens the file in the default app,
  right-click reveals it in the system explorer. Commands: `Open track in default
  app`, `Reveal track in system explorer`. The embedded-player buttons can be turned
  off in settings.

The marker and the zone are visible right on the waveform (an orange flag and a
highlighted fragment) — there are no separate indicators in the panel. Time, buttons
and volume share a single line under the waveform.

## Hotkeys (defaults)

All commands can be rebound in Settings → Hotkeys. The Russian keyboard layout is
duplicated out of the box.

| Command | Keys |
| --- | --- |
| Play from marker (or from start) | `Ctrl+Alt+X` |
| Stop (double press: the next `Ctrl+Alt+X` plays from the start, marker intact; triple: the marker and the zone are deleted) | `Ctrl+Alt+C` |
| Set marker at current position | `Ctrl+Alt+A` |
| Play/Pause | `Ctrl+Alt+P` |
| Open track's note | `Ctrl+Alt+S` |
| Seek back / forward | `Ctrl+Alt+,` / `Ctrl+Alt+.` |

Without default keys: Clear marker, Clear A-B loop zone, Load audio from current
note, Open player panel, Unload track, Open track in default app, Reveal track in
system explorer.

## Settings

Besides the basics (pickup mode, seek step, start from marker) there is a
fine-tuning section: the play-count threshold, the double-stop window, the waveform
height, and the embedded-player button.

## Data

Markers, loop zones and counters are stored in the plugin's `data.json`, keyed by the
audio file path; when a file is renamed inside the vault, its data moves along
automatically.

The interface follows Obsidian's language (English, or Russian when the app is set to
Russian), works on desktop and mobile ("open externally" needs desktop).

## Building

```bash
npm install
npm run build   # tsc typecheck + esbuild → main.js
npm run dev     # watch mode
```

---

Author: [mrrepac](https://github.com/mrrepac) · MIT

# Разбор папки: план реализации 1.8.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пока звучит музыка, открытие заметок не сбивает плейлист папки; трек
уезжает в заметку копией и наружу файлом; список умеет сортироваться.

**Architecture:** Решение «что делать при открытии файла» уезжает из
`handleFileOpen` в чистый модуль `src/pickup.ts` без единого импорта из
`obsidian` — только такой модуль умеет собрать тестовый харнесс. Туда же,
в чистые модули, уходят сортировка списка (`src/playlist.ts`) и выбор имени для
копии (`src/copy.ts`). `main.ts` остаётся хозяином приложения: слушает события,
читает и пишет диск, зовёт чистые функции. Нативная передача файла живёт в
`external.ts` рядом с «открыть внешне» — там уже собрано всё, что общается
с системой.

**Tech Stack:** TypeScript 4.7, esbuild 0.17, Obsidian API (типы 1.13.1,
`minAppVersion` 1.7.2), тесты — свой харнесс `tests/harness.mjs` на Node без
зависимостей, запуск `npm test`.

**Спека:** [docs/superpowers/specs/2026-08-17-sorting-out-a-folder-design.md](../specs/2026-08-17-sorting-out-a-folder-design.md)

## Global Constraints

- **Код, комментарии и имена — по-английски.** Спеки, планы и разговор — по-русски.
- **Каждый новый ключ i18n добавляется в оба словаря** `en` и `ru` в `src/i18n.ts`.
  Ключ только в одном словаре не существует для типа `I18nKey`.
- **`minAppVersion` 1.7.2.** Любой API новее зовётся через проверку наличия
  (`typeof x === "function"`), иначе линтер каталога даёт `no-unsupported-api`.
- **Плагин не desktop-only.** Всё, что осмысленно только на ПК, проверяет
  `Platform.isDesktopApp` и молча ничего не делает на мобиле.
- **Новые модули не зовут Obsidian API.** `pickup.ts`, `playlist.ts` и чистая
  часть `copy.ts` импортируют только типы из `types.ts`. Это условие
  тестируемости, а не стиль.
- **`npm run build` кладёт `main.js` прямо в хранилище** (локальная правка
  `esbuild.config.mjs`, коммитить её нельзя).
- **Ни `TODO`, ни `console.log`, ни `as any`, ни `innerHTML`** в коде, который
  уходит в релиз.
- Сборка и тесты зелёные перед каждым коммитом: `npm run build && npm test`.

---

### Task 1: Правило подхвата — пока звучит музыка, заметки не командуют

Корень дефекта: `handleFileOpen` зовёт `setQueue` до всех проверок, поэтому
заметка с одним аудиофайлом схлопывает очередь папки из тридцати треков.

**Files:**
- Create: `src/pickup.ts`
- Create: `tests/pickup.test.mjs`
- Modify: `src/main.ts` (`handleFileOpen`, строки ~408–471)
- Modify: `tests/run.mjs` (подключить набор)

**Interfaces:**
- Produces: `decidePickup(input: PickupInput): PickupDecision`
  - `PickupInput = { kind: "note-audio" | "note-empty" | "audio"; playing: boolean; mode: PickupMode; currentPath: string | null; targetPath: string; queuePaths: string[] }`
  - `PickupDecision = { setQueue: boolean; action: "load" | "offer" | "none" }`
- Consumes: `PickupMode` из `src/types.ts`

- [ ] **Шаг 1: Написать падающий тест**

Создать `tests/pickup.test.mjs`:

```js
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

  // ---- the note of the track already playing asks for nothing ----
  s.check("opening the playing track's own note offers nothing",
    () => decide({ targetPath: "beats/01.mp3" }).action === "none");
  s.check("and does not touch the queue either",
    () => decide({ targetPath: "beats/01.mp3" }).setQueue === false);
  s.check("same when the playing track sits further down the note's list", () => {
    const d = decide({ currentPath: "songs/second.mp3" });
    return d.action === "none" && d.setQueue === false;
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
```

Подключить набор в `tests/run.mjs`: импорт `pickup from "./pickup.test.mjs"`
и добавить `pickup` в массив `suites`.

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module 'src/pickup.ts'` или падение сборки.

- [ ] **Шаг 3: Написать `src/pickup.ts`**

```ts
import { PickupMode } from "./types";

/** What was opened: a note with audio in it, a note without, an audio file. */
export type PickupKind = "note-audio" | "note-empty" | "audio";

export interface PickupInput {
  kind: PickupKind;
  /** the player is sounding right now — the human is busy listening */
  playing: boolean;
  mode: PickupMode;
  currentPath: string | null;
  /** the track this open would load */
  targetPath: string;
  /** what the queue would become */
  queuePaths: string[];
}

export interface PickupDecision {
  setQueue: boolean;
  action: "load" | "offer" | "none";
}

/**
 * Who commands the player when a file is opened.
 *
 * The rule: while music plays, reading notes is not an instruction. Opening an
 * audio file is — that is a hand on the file, not a side effect of reading. The
 * "auto" mode sits outside the rule on purpose: it is called "always pick up",
 * and whoever chose it asked for exactly that.
 */
export function decidePickup(input: PickupInput): PickupDecision {
  const { kind, playing, mode, currentPath, targetPath, queuePaths } = input;

  if (kind === "note-empty") return { setQueue: false, action: "none" };

  const held = kind === "note-audio" && playing && mode !== "auto";
  const setQueue = !held;

  // already the loaded track, or already inside the queue this open builds —
  // nothing to load either way. This comes before the hold: offering to switch
  // to the track that is already playing is nonsense, and that is exactly what
  // opening its own note used to do.
  if (currentPath === targetPath) return { setQueue, action: "none" };
  if (kind === "note-audio" && currentPath && queuePaths.includes(currentPath)) {
    return { setQueue, action: "none" };
  }

  if (held) return { setQueue, action: mode === "hybrid" ? "offer" : "none" };

  switch (mode) {
    case "auto": return { setQueue, action: "load" };
    case "hybrid": return { setQueue, action: playing ? "offer" : "load" };
    case "manual": return { setQueue, action: "none" };
  }
}
```

- [ ] **Шаг 4: Убедиться, что тест проходит**

Run: `npm test`
Expected: PASS — набор `pickup` целиком зелёный.

- [ ] **Шаг 5: Переписать `handleFileOpen` под решение**

В `src/main.ts` заменить тело после сбора `audios`/`source` на вызов
`decidePickup`. `setQueue` теперь зовётся **по решению**, а не до него.

Правило целиком живёт в `pickup.ts` — включая пустую заметку, поэтому раннего
выхода для неё в `handleFileOpen` больше нет. `target` при пустой заметке не
существует, отсюда `?? null` и проверка перед загрузкой:

```ts
const audio = isAudioPath(file.path);
const target: TFile | null = audio ? file : (audios[0] ?? null);

const decision = decidePickup({
  kind: audio ? "audio" : (audios.length === 0 ? "note-empty" : "note-audio"),
  playing: this.engine.playing,
  mode: this.settings.pickupMode,
  currentPath: this.engine.file?.path ?? null,
  targetPath: target?.path ?? "",
  queuePaths: audios.map(f => f.path)
});

if (decision.setQueue) this.engine.setQueue(audios, source);
switch (decision.action) {
  case "load":
    if (target) void this.engine.load(target, { autoplay: this.engine.playing, sourceNote: noteSource });
    break;
  case "offer":
    if (target) this.engine.setPendingSwitch(target, noteSource);
    break;
  case "none":
    this.engine.setPendingSwitch(null);
    break;
}
```

Ветка «файл не заметка и не аудио» (`else { return; }`) остаётся как была —
до всякого решения.

- [ ] **Шаг 6: Проверить руками в Obsidian**

`npm run build`, перезапустить плагин. Запустить папку, открыть заметку с
аудио: музыка играет, список папки на месте, `⏭` ходит по папке, плашка
предлагает переключиться. Остановить — открыть ту же заметку: трек берётся.

- [ ] **Шаг 7: Коммит**

```bash
git add src/pickup.ts src/main.ts tests/pickup.test.mjs tests/run.mjs
git commit -m "the playlist holds while the music plays"
```

---

### Task 2: Двойной клик по аудиофайлу играет

**Files:**
- Modify: `src/main.ts` (регистрация обработчика рядом с `registerEvent` в `onload`, ~строка 346)

**Interfaces:**
- Consumes: `isAudioPath` из `types.ts`, `this.engine.load`, `this.collectFolderAudios`

- [ ] **Шаг 1: Добавить обработчик**

```ts
// A click already opens the file, and that goes through the pickup rule. A
// double click is a second, louder statement: play it. The explorer's markup
// is not public API, so a miss here means the gesture quietly does nothing.
this.registerDomEvent(document, "dblclick", (e) => {
  const title = (e.target as HTMLElement)?.closest?.(".nav-file-title");
  const path = title?.getAttribute("data-path");
  if (!path || !isAudioPath(path)) return;
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  this.engine.setPendingSwitch(null);
  this.engine.setQueue(
    this.settings.folderQueue ? this.collectFolderAudios(file) : [file],
    file.parent ? { kind: "folder", name: file.parent.name || "/", path: file.parent.path } : null
  );
  void this.engine.load(file, { autoplay: true });
});
```

- [ ] **Шаг 2: Собрать**

Run: `npm run build`
Expected: сборка без ошибок типов.

- [ ] **Шаг 3: Проверить руками**

Двойной клик по mp3 в проводнике — трек играет сразу, плашка не висит, список
= папка файла. Одинарный клик работает как раньше. Двойной клик по `.md` —
ничего не происходит.

- [ ] **Шаг 4: Коммит**

```bash
git add src/main.ts
git commit -m "a double click on a track plays it"
```

---

### Task 3: Трек наружу — довести пробу до релиза

Проба (коммит `9d6a50d`) работает: обычный рывок кладёт файл на рабочий стол,
`Alt` отдаёт путь нативно и REAPER принимает. Осталось убрать отладку, сменить
момент чтения байтов и назвать жест словами.

**Files:**
- Modify: `src/view.ts` (`makeRowDraggable`, `prepareDragFile`, `onOpen`, строка трека)
- Modify: `src/external.ts` (`dragOutNatively` — снять отладочный вывод)
- Modify: `src/i18n.ts` (подсказка строки)
- Modify: `README.md`, `README.ru.md`

**Interfaces:**
- Consumes: `dragOutNatively(app: App, file: TFile): boolean` из `external.ts`

- [ ] **Шаг 1: Убрать отладку**

Из `src/view.ts` удалить `registerDomEvent(document, "dragstart", …)` целиком
(он был глазами пробы). Из `src/external.ts` — строку
`console.log("[songwriter probe] native drag started:", path)`. Строку
`console.error(...)` в `catch` оставить: молчаливый отказ нативной ветки — это
как раз то, что нужно уметь увидеть. Комментарии `PROBE (1.8.0)` переписать в
обычные: пробы больше нет, есть поведение.

- [ ] **Шаг 2: Перенести чтение байтов на `mousedown`**

Заменить в `makeRowDraggable`:

```ts
row.addEventListener("mouseenter", () => void this.prepareDragFile(file));
```

на

```ts
// the bytes have to be in hand when the gesture starts, and reading them on
// hover means reading the whole pack while the mouse wanders down the list
row.addEventListener("mousedown", () => void this.prepareDragFile(file));
```

- [ ] **Шаг 3: Сделать строку текущего трека перетаскиваемой**

В месте, где строится строка трека (`trackRow`, поиск по `sw-track-name`),
вызвать тот же `this.makeRowDraggable(nameEl, file)` для загруженного файла.
Строка перестраивается при смене трека, так что вызов идёт там же, где
проставляется имя.

- [ ] **Шаг 4: Назвать жест словами**

В оба словаря `src/i18n.ts` добавить ключ:

```ts
// en
rowDragHint: "Drag into a note for a link — hold Alt to drag the file out",
// ru
rowDragHint: "Перетащи в заметку — вставится ссылка; с Alt — сам файл наружу",
```

и повесить его как `aria-label` строки плейлиста. **Не `title` вместе с
`aria-label`** — Obsidian рисует тултип из `aria-label`, и два атрибута дают
две подсказки друг поверх друга.

- [ ] **Шаг 5: Описать в README (оба языка)**

В раздел про плейлист добавить абзац: строка тянется в заметку ссылкой, с
зажатым `Alt` — самим файлом наружу, в проводник или в звуковой редактор;
`Alt`-рывок внутрь Obsidian ничего не вставляет; на мобиле нативной передачи
нет.

- [ ] **Шаг 6: Собрать и проверить руками**

Run: `npm run build && npm test`
Проверить: рывок в заметку — ссылка; рывок на рабочий стол — файл; `Alt`-рывок
в REAPER — файл на дорожке; консоль чистая (ни одной строки `[songwriter …]`).

- [ ] **Шаг 7: Коммит**

```bash
git add src/view.ts src/external.ts src/i18n.ts README.md README.ru.md
git commit -m "a track leaves for the world: a link inside, the file out with Alt"
```

---

### Task 4: Копия трека в текущую заметку

**Files:**
- Create: `src/copy.ts`
- Create: `tests/copy.test.mjs`
- Modify: `src/main.ts` (команда), `src/view.ts` (пункт контекстного меню строки)
- Modify: `src/i18n.ts`
- Modify: `tests/run.mjs`

**Interfaces:**
- Produces:
  - `pickCopyTarget(input: CopyInput): CopyTarget` — чистая, тестируемая
    - `CopyInput = { sourceName: string; sourceSize: number; existing: { name: string; size: number }[] }`
    - `CopyTarget = { reuse: string | null }` — имя уже лежащего файла или `null`, если копию надо создать
  - `copyTrackToNote(app: App, plugin: SongwriterPlugin, file: TFile, note: TFile): Promise<void>`

- [ ] **Шаг 1: Написать падающий тест**

Создать `tests/copy.test.mjs`:

```js
/**
 * Sorting a pack means sending the same track to a note more than once by
 * accident. Doing that must not leave "beat 1.mp3", "beat 2.mp3", "beat 3.mp3"
 * behind — a file that is already there is the file we link to.
 */
import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("copy — a track into a note");
  const { pickCopyTarget } = load(await bundle("src/copy.ts"));

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
```

Подключить в `tests/run.mjs`.

- [ ] **Шаг 2: Убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуля нет.

- [ ] **Шаг 3: Написать чистую часть `src/copy.ts`**

```ts
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
```

- [ ] **Шаг 4: Убедиться, что проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Шаг 5: Написать работу с хранилищем — там же, ниже**

В начало файла — импорты и объявление приватного API:

```ts
import { App, MarkdownView, Notice, TFile, TFolder } from "obsidian";
import type SongwriterPlugin from "./main";
import { t } from "./i18n";

/** Newer than our minAppVersion floor, so it is asked for, not assumed. */
interface FileManagerMaybe {
  getAvailablePathForAttachment?(filename: string, sourcePath?: string): Promise<string>;
}
```

Ниже — сама работа:

```ts
/**
 * Copy the track next to a note and link it there. The vault's own attachment
 * setting decides the folder, so this follows whatever the user already set up.
 * The player is deliberately left alone: filing is not listening.
 */
export async function copyTrackToNote(
  app: App, plugin: SongwriterPlugin, file: TFile, note: TFile
): Promise<void> {
  const manager = app.fileManager as unknown as FileManagerMaybe;
  const suggested = typeof manager.getAvailablePathForAttachment === "function"
    ? await manager.getAvailablePathForAttachment(file.name, note.path)
    : `${note.parent?.path ?? ""}/${file.name}`;

  const folder = await ensureFolder(app, suggested.slice(0, suggested.lastIndexOf("/")));
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

  // the copy inherits marker, loop, counters and measurements: without them it
  // is a stranger to the plugin and gets analysed all over again
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
```

**Плеер не трогается** — ни `load`, ни `setQueue`: прослушивание папки
продолжается, копия уезжает молча.

- [ ] **Шаг 6: Команда и пункт меню**

В `main.ts`:

```ts
this.addCommand({
  id: "copy-track-to-note",
  name: "Copy track to current note",
  callback: () => void this.copyTrackToNote()
});
```

Метод берёт `this.engine.file` и `this.app.workspace.getActiveFile()`; если
трека нет — `Notice` `t("noTrack")`; если активный файл не `.md` — новый ключ
`t("noActiveNote")` (он уже есть). Хоткея по умолчанию нет: таблица встроенных
клавиш и так на четырнадцати командах.

В `view.ts` — пункт в контекстном меню строки плейлиста (`Menu`, как в
существующих меню панели), зовущий тот же путь для файла строки.

- [ ] **Шаг 7: Ключи i18n**

В оба словаря: `copyToNote` (название пункта меню), `copiedToNote(name)` —
успех, `copyFailed` — отказ.

- [ ] **Шаг 8: Проверить руками**

Собрать. Открыть заметку, послать в неё трек из плейлиста: файл появился в
`_resources` рядом с заметкой, в заметке — волна плагина, музыка не
прервалась, счётчик и маркер у копии те же. Послать второй раз — второго файла
не появилось.

- [ ] **Шаг 9: Коммит**

```bash
git add src/copy.ts src/main.ts src/view.ts src/i18n.ts tests/copy.test.mjs tests/run.mjs
git commit -m "a track can be filed into the note you are looking at"
```

---

### Task 5: Сортировка плейлиста

**Files:**
- Create: `src/playlist.ts`
- Create: `tests/playlist.test.mjs`
- Modify: `src/types.ts` (тип и значение по умолчанию), `src/main.ts` (`collectFolderAudios`), `src/view.ts` (меню в шапке списка)
- Modify: `src/i18n.ts`, `tests/run.mjs`

**Interfaces:**
- Produces: `sortTracks<T extends SortableTrack>(files: T[], sort: PlaylistSort): T[]` в `playlist.ts`
  - `SortableTrack = { path: string; basename: string; mtime: number; bpm: number | null; plays: number }`
- Produces: `PlaylistSort = "name" | "tempo" | "plays" | "recent"` — объявляется
  в `src/types.ts` рядом с прочими типами настроек, `playlist.ts` его импортирует

- [ ] **Шаг 1: Написать падающий тест**

```js
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
```

- [ ] **Шаг 2: Убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуля нет.

- [ ] **Шаг 3: Написать `src/playlist.ts`**

```ts
import { PlaylistSort } from "./types";

export interface SortableTrack {
  path: string;
  basename: string;
  mtime: number;
  bpm: number | null;
  plays: number;
}

/**
 * The order of the list is also the order the arrows walk — the view and the
 * queue must never disagree about what "next" means.
 */
export function sortTracks<T extends SortableTrack>(files: T[], sort: PlaylistSort): T[] {
  const byName = (a: T, b: T) =>
    a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" });
  const out = [...files];
  switch (sort) {
    case "tempo":
      // a track nobody measured has no place among tempos: it goes last
      return out.sort((a, b) =>
        (a.bpm ?? Infinity) - (b.bpm ?? Infinity) || byName(a, b));
    case "plays":
      return out.sort((a, b) => b.plays - a.plays || byName(a, b));
    case "recent":
      return out.sort((a, b) => b.mtime - a.mtime || byName(a, b));
    case "name":
    default:
      return out.sort(byName);
  }
}
```

- [ ] **Шаг 4: Убедиться, что проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Шаг 5: Настройка и применение**

В `types.ts`: объявить `export type PlaylistSort = "name" | "tempo" | "plays" | "recent";`
рядом с `PickupMode`, добавить `playlistSort: PlaylistSort` в
`SongwriterSettings` и `playlistSort: "name"` в `DEFAULT_SETTINGS`. В `main.ts` `collectFolderAudios` вместо своей сортировки
зовёт `sortTracks`, собирая `SortableTrack` из `TFile.stat.mtime` и записи
`settings.tracks[path]`.

- [ ] **Шаг 6: Меню порядка в шапке списка**

В `view.ts` — кнопка рядом с заголовком плейлиста, открывающая `Menu` с
четырьмя пунктами; выбранный помечен галочкой (`item.setChecked(true)`).
Выбор пишет настройку, сохраняет и перестраивает очередь тем же путём, каким
её строит `collectFolderAudios`.

- [ ] **Шаг 7: Ключи i18n**

В оба словаря: `sortTitle`, `sortByName`, `sortByTempo`, `sortByPlays`,
`sortByRecent`.

- [ ] **Шаг 8: Проверить руками**

Собрать. Переключить порядок — список перестроился, `⏭` идёт по новому
порядку, после перезапуска порядок тот же.

- [ ] **Шаг 9: Коммит**

```bash
git add src/playlist.ts src/types.ts src/main.ts src/view.ts src/i18n.ts tests/playlist.test.mjs tests/run.mjs
git commit -m "the playlist can be ordered by name, tempo, plays or age"
```

---

### Task 6: Вкладка настроек уезжает из `main.ts`

`main.ts` — 988 строк, из них 213 (775–988) занимает `SongwriterSettingTab`.
Мы добавили в этот файл обработчики и команды, и он продолжит расти.

**Files:**
- Create: `src/settings.ts` (перенос класса `SongwriterSettingTab`)
- Modify: `src/main.ts` (импорт вместо объявления)

- [ ] **Шаг 1: Перенести класс**

Вырезать `SongwriterSettingTab` целиком в `src/settings.ts`, экспортировать,
импортировать в `main.ts`. **Ни одной правки поведения** — только переезд;
любая находка по дороге чинится отдельным коммитом.

- [ ] **Шаг 2: Проверить**

Run: `npm run build && npm test`
Expected: сборка и тесты зелёные. В Obsidian вкладка настроек открывается, все
поля на месте и сохраняются.

- [ ] **Шаг 3: Коммит**

```bash
git add src/settings.ts src/main.ts
git commit -m "the settings tab moves out of main.ts"
```

---

### Task 7: Жёсткий аудит

Задача-исследование: результат — список найденного, а не правки. Каждый дефект
чинится отдельным коммитом **после** того, как список показан Льву: он решает,
что чинить в 1.8.0, а что позже.

**Области и что искать:**

- [ ] **Данные.** `loadSettings` расстилает в настройки все ключи файла
  (`{ ...DEFAULT_SETTINGS, ...rest }`), поэтому мёртвый `autoAnalyze` из
  хранилища Льва переписывается при каждом сохранении. Проверить: фильтрацию
  неизвестных ключей, поведение на битом `data.json`, гонку сохранения, перенос
  записей при переименовании и удалении файла.
- [ ] **Движок.** Утечки при смене треков: объектные адреса (в том числе новый
  `dragFile`), `AudioContext`, поток анализа. Счётчик прогонов и наигранное
  время. Выгрузка трека.
- [ ] **Зона A-B.** Ни у одного из 97 треков Льва она не сохранена. Выяснить
  фактом: не работает, не сохраняется или не нужна.
- [ ] **Известные грабли Obsidian.** Отложенные вьюхи (`getLeavesOfType`
  отдаёт заглушку), регистр путей, `createEl` у документа, `aria-label` вместе
  с `title`, требования линтера каталога.
- [ ] **Гигиена.** Версия в `package.json` (1.6.0) против манифеста (1.7.0).

- [ ] **Показать список Льву и починить согласованное.**

---

### Task 8: Релиз 1.8.0

- [ ] **Шаг 1: Версии**

`manifest.json`, `package.json`, `versions.json` — 1.8.0, `minAppVersion`
остаётся 1.7.2.

- [ ] **Шаг 2: Заметки к релизу**

`release-notes/1.8.0.md` в сложившемся стиле: разделы с эмодзи, живой язык,
внизу ссылка на сравнение с 1.7.0. Обязательно про то, чего нельзя угадать:
жест `Alt` и правило «пока звучит музыка, заметки не командуют».

- [ ] **Шаг 3: Проверка перед тегом**

Run: `npm run build && npm test`
Прогнать руками маршрут целиком: слушаю папку → открываю заметку (список цел)
→ шлю копию в заметку → тяну с `Alt` в REAPER.

- [ ] **Шаг 4: Влить и пометить**

Слить `1.8.0` в `master`, поставить голый тег `1.8.0`, запушить тег — CI
соберёт релиз из исходников и возьмёт заметки из `release-notes/1.8.0.md`.

---

## Порядок и зависимости

Задачи 1, 2, 3 независимы и могут идти в любом порядке. Задача 4 не зависит ни
от чего. Задача 5 трогает `collectFolderAudios`, который правится и в задаче 2 —
делать её после. Задача 6 (переезд вкладки) — после всех, кто трогает
`main.ts`, иначе конфликты на ровном месте. Задачи 7 и 8 — в конце и по порядку.

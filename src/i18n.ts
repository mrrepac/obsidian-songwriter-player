import { moment } from "obsidian";

/**
 * UI language: English by default, Russian when Obsidian runs in Russian.
 * Obsidian sets moment's locale to the app language — read it (not localStorage).
 */
const LANG: "en" | "ru" = (() => {
  try {
    const loc = String(moment.locale() || "").toLowerCase();
    if (loc.split("-")[0] === "ru") return "ru";
  } catch {
    /* ignore */
  }
  return "en";
})();

const en = {
  // notices
  noTrack: "Songwriter: no track is loaded.",
  loadFailed: (name: string) => `Songwriter: could not load “${name}”.`,
  nextFromStart: "Next start plays from the beginning",
  markerAndLoopCleared: "⚑ Marker and loop zone cleared",
  markerCleared: "⚑ Marker cleared",
  loopCleared: "Loop zone cleared",
  markerSet: (time: string) => `⚑ Marker: ${time}`,
  extOpenFailed: "Songwriter: could not open the file in an external app.",
  desktopOnly: "Songwriter: available on desktop only.",
  revealFailed: "Songwriter: could not reveal the file in the system explorer.",
  audioNotFound: "Songwriter: could not find the audio file.",
  noActiveNote: "Songwriter: no active note.",
  noAudioInNote: "Songwriter: the note has no audio files.",
  trackNoteNotFound: "Songwriter: no note with this track was found.",

  // ribbon & buttons
  ribbonOpenPlayer: "Songwriter: open player",
  extBtnTitle: "Open in external player · right-click — reveal in explorer",
  fabTitle: "Play from marker",

  // player panel
  emptyTitle: "No track loaded.",
  emptyHint: "Open a note that links to an audio file — the player picks it up on its own.",
  pickFromNote: "Load audio from the note",
  volume: "Volume",
  playFromMarkerTitle: "Play from marker (or from start)",
  playPauseTitle: "Play/Pause",
  setMarkerTitle: "Set marker here",
  seekBackTitle: (s: number) => `Back ${s}s`,
  seekFwdTitle: (s: number) => `Forward ${s}s`,
  noteAudiosTitle: "Audio files of the current note",
  openTrackNoteTitle: "Open the track's note (Ctrl+Alt+S)",
  playsTitle: "Play count · total listened. Right-click — reset.",
  ejectTitle: "Unload track from the player",
  pendingInNote: (name: string) => `In the note: ${name}`,
  switchBtn: "Switch",
  hideBtn: "Hide",

  waveLoading: "Analyzing waveform…",

  // listened-time units (47s · 12m · 2h05m)
  unitS: "s",
  unitM: "m",
  unitH: "h",

  // settings
  setPickupName: "Audio pickup from the note",
  setPickupDesc:
    "Hybrid: the player takes the track from the opened note only while nothing is playing; if music is playing, it offers to switch. Always: switches right away. Manual: only via the command or the button.",
  pickupHybrid: "Hybrid",
  pickupAuto: "Always automatic",
  pickupManual: "Manual only",
  setSkipName: "Seek step",
  setSkipDesc: "How many seconds the back/forward buttons and hotkeys jump.",
  setStartMarkerName: "Start from marker",
  setStartMarkerDesc: "When a track loads, the position jumps straight to the marker (if one is set).",
  headingFine: "Fine tuning",
  setPlayCountName: "Play-count threshold",
  setPlayCountDesc: "How many seconds must actually sound for a run to land in the play counter.",
  setDoubleStopName: "Double-stop window",
  setDoubleStopDesc: "How many milliseconds between two Stop presses count as a double press (rewind to the start).",
  setWaveHName: "Waveform height",
  setWaveHDesc: "Height of the visible waveform, in pixels.",
  setInlineName: "Waveform players in notes",
  setInlineDesc:
    "Replace the plain embedded audio players in notes with a waveform wired to this player: click to play, drag for an A-B zone, double-click to set the marker. One track plays at a time, shared with the sidebar.",
  setEmbedBtnName: "“Open externally” button",
  setEmbedBtnDesc:
    "Show an “open externally” button on audio players in notes (right-click reveals the file in the system explorer). Applies to both the waveform and the plain player.",
  setFabName: "Floating play button (mobile)",
  setFabDesc:
    "Show a round button over the note on mobile: tap plays from the marker (or the start). No need to swipe to the sidebar player.",
  setFabModeName: "Floating button tap",
  setFabModeDesc:
    "From marker: every tap (re)starts from the marker. Smart: tap plays from the marker while paused, pauses while playing.",
  fabModeMarker: "Always from marker",
  fabModeSmart: "Smart play/pause",
};

const ru: typeof en = {
  noTrack: "Songwriter: трек не загружен.",
  loadFailed: (name: string) => `Songwriter: не удалось загрузить «${name}».`,
  nextFromStart: "Следующий запуск — с начала трека",
  markerAndLoopCleared: "⚑ Маркер и зона повтора удалены",
  markerCleared: "⚑ Маркер удалён",
  loopCleared: "Зона повтора удалена",
  markerSet: (time: string) => `⚑ Маркер: ${time}`,
  extOpenFailed: "Songwriter: не удалось открыть файл во внешнем приложении.",
  desktopOnly: "Songwriter: доступно только на компьютере.",
  revealFailed: "Songwriter: не удалось показать файл в проводнике.",
  audioNotFound: "Songwriter: не удалось найти аудиофайл.",
  noActiveNote: "Songwriter: нет активной заметки.",
  noAudioInNote: "Songwriter: в заметке нет аудиофайлов.",
  trackNoteNotFound: "Songwriter: заметка с этим треком не найдена.",

  ribbonOpenPlayer: "Songwriter: открыть плеер",
  extBtnTitle: "Открыть во внешнем плеере · правый клик — проводник",
  fabTitle: "Играть с маркера",

  emptyTitle: "Трек не загружен.",
  emptyHint: "Откройте заметку со ссылкой на аудиофайл — плеер подхватит его сам.",
  pickFromNote: "Взять аудио из заметки",
  volume: "Громкость",
  playFromMarkerTitle: "Играть с маркера (или с начала)",
  playPauseTitle: "Плей/пауза",
  setMarkerTitle: "Поставить маркер здесь",
  seekBackTitle: (s: number) => `Назад на ${s} сек`,
  seekFwdTitle: (s: number) => `Вперёд на ${s} сек`,
  noteAudiosTitle: "Аудиофайлы текущей заметки",
  openTrackNoteTitle: "Открыть заметку с треком (Ctrl+Alt+S)",
  playsTitle: "Проигрываний · наиграно всего. Правый клик — сброс.",
  ejectTitle: "Выгрузить трек из плеера",
  pendingInNote: (name: string) => `В заметке: ${name}`,
  switchBtn: "Переключить",
  hideBtn: "Скрыть",

  waveLoading: "Анализ волны…",

  unitS: "с",
  unitM: "м",
  unitH: "ч",

  setPickupName: "Подхват аудио из заметки",
  setPickupDesc:
    "Гибрид: плеер сам берёт трек из открытой заметки, только когда музыка не играет; если играет — предлагает переключиться. Всегда: переключается сразу. Вручную: только командой или кнопкой.",
  pickupHybrid: "Гибрид",
  pickupAuto: "Всегда автоматически",
  pickupManual: "Только вручную",
  setSkipName: "Шаг перемотки",
  setSkipDesc: "На сколько секунд перематывают кнопки и хоткеи «назад/вперёд».",
  setStartMarkerName: "Начинать с маркера",
  setStartMarkerDesc: "При загрузке трека позиция сразу ставится на маркер (если он задан).",
  headingFine: "Тонкая настройка",
  setPlayCountName: "Порог зачёта прогона",
  setPlayCountDesc: "Сколько секунд должно реально прозвучать, чтобы прогон попал в счётчик проигрываний.",
  setDoubleStopName: "Окно двойного стопа",
  setDoubleStopDesc: "За сколько миллисекунд два нажатия «стоп» считаются двойным (перемотка в начало).",
  setWaveHName: "Высота волны",
  setWaveHDesc: "Высота видимой волны трека в пикселях.",
  setInlineName: "Волна вместо плеера в заметках",
  setInlineDesc:
    "Заменять штатные встроенные аудиоплееры в заметках волной, привязанной к этому плееру: клик — играть, протяжка — зона A-B, двойной клик — маркер. Играет одна дорожка за раз, общая с панелью.",
  setEmbedBtnName: "Кнопка «открыть внешне»",
  setEmbedBtnDesc:
    "Показывать кнопку «открыть внешне» у аудиоплееров в заметках (правый клик — показать файл в проводнике). Работает и для волны, и для штатного плеера.",
  setFabName: "Плавающая кнопка (мобайл)",
  setFabDesc:
    "Показывать круглую кнопку поверх заметки на телефоне: тап — играть с маркера (или с начала). Не нужно свайпать к панели плеера.",
  setFabModeName: "Действие по тапу",
  setFabModeDesc:
    "С маркера: каждый тап запускает бит с маркера заново. Умный: на паузе играет с маркера, во время игры ставит паузу.",
  fabModeMarker: "Всегда с маркера",
  fabModeSmart: "Умный плей/пауза",
};

const STRINGS = { en, ru };

/** Translated string (or string-building function) for the current UI language. */
export function t<K extends keyof typeof en>(key: K): (typeof en)[K] {
  return STRINGS[LANG][key] ?? en[key];
}

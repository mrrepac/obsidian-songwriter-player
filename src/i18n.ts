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
  openTrackNoteTitle: "Open the track's note (Alt+D)",
  playsTitle: "Play count · total listened. Right-click — reset.",
  ejectTitle: "Unload track from the player",
  pendingSwitchText: (name: string) => `Queued: ${name}`,
  switchBtn: "Switch",
  hideBtn: "Hide",

  // playlist
  prevTrackTitle: "Previous track (Alt+B)",
  nextTrackTitle: "Next track (Alt+N)",
  playlistToggleTitle: "Collapse / expand the playlist",
  playlistFromNote: "Playlist of the note",
  playlistFromFolder: "Playlist of the folder",
  playlistCountTitle: (n: number) => `${n} audio files`,
  rowMarkerTitle: "The track has a marker",

  // tempo & key
  analyseHint: "Tempo and key are not measured yet — click to measure",
  analysing: "Measuring tempo and key…",
  analyseFailed: (name: string) => `Songwriter: could not analyse “${name}”.`,
  musicalTitle: (votes: string, edited: boolean) =>
    edited ? `Tempo and key, corrected by hand · click for options` : `Tempo and key · ${votes} · click for options`,
  votesUnanimous: "all key profiles agree",
  votesSplit: (n: number, total: number, alt: string) => `${n} of ${total} profiles, the rest say ${alt}`,
  menuDouble: "Tempo ×2",
  menuHalf: "Tempo ÷2",
  rateTitle: "Playback speed — the key stays where it is (Alt+- / Alt+= / Alt+0)",
  rateTitleBpm: (now: number, original: number, factor: string) =>
    `Playing at ${now} BPM instead of ${original} (${factor}×) — the key stays where it is. Alt+- / Alt+= step by one bpm, Alt+0 resets.`,
  rateOriginal: (label: string) => `${label} — as recorded`,
  pitchTitle: "Transpose without changing the tempo, desktop only (Alt+PageUp / Alt+PageDown)",
  pitchTitleKey: (now: string, original: string) =>
    `Playing in ${now} instead of ${original}, the tempo is untouched. Alt+PageUp and Alt+PageDown move by a semitone, Alt+0 resets.`,
  pitchOriginal: (label: string) => `${label} — as recorded`,
  pitchUnavailable: "Songwriter: transposing is unavailable here.",
  menuSaveCopy: (name: string) => `Save a copy: ${name}.wav`,
  renderWorking: (name: string) => `Rendering ${name}.wav…`,
  renderDone: (name: string) => `Saved: ${name}.wav`,
  renderNothing: "Songwriter: nothing to bake in — the key and the speed are as recorded.",
  renderFailed: "Songwriter: could not save the copy.",
  menuListen: (label: string) => `Listen: ${label}`,
  menuSwitchMode: (alt: string) => `Switch to ${alt}`,
  menuReanalyse: "Measure again",
  menuForget: "Forget tempo and key",
  modeMajor: "major",
  modeMinor: "minor",

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
  headingPlaylist: "Playlist",
  setFolderQueueName: "Whole folder as a playlist",
  setFolderQueueDesc:
    "Opening an audio file queues up every audio file next to it, so ⏮ ⏭ walk the folder. Off: the file is loaded alone.",
  setAutoAdvanceName: "Play the playlist through",
  setAutoAdvanceDesc:
    "When a track ends, the next one in the playlist starts. The last track just stops. A track with an A-B zone keeps looping and never advances.",
  headingMusical: "Tempo and key",
  setAutoAnalyseName: "Measure a track when it loads",
  setAutoAnalyseDesc:
    "Tempo and key are measured once per file and remembered. It takes a few seconds in the background — playback and typing are not affected. Off: measure by hand from the tempo badge or the command.",
  setTempoWindowName: "Preferred tempo range",
  setTempoWindowDesc: (low: number, high: number) =>
    `Whether a beat is heard at ${low} or at ${low * 2} is a matter of feel, so the measured tempo is halved or doubled into ${low}–${high} — exactly one octave, so every tempo lands on a single value. ×2 and ÷2 on the badge still override it for a given track.`,
  headingFine: "Fine tuning",
  setMediaKeysName: "Media keys",
  setMediaKeysDesc:
    "Hand the loaded track to the system, so the play/pause and next/previous keys on the keyboard reach this player and it appears in the system's now-playing card. Turn it off if another player should keep the media keys.",
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
  openTrackNoteTitle: "Открыть заметку с треком (Alt+D)",
  playsTitle: "Проигрываний · наиграно всего. Правый клик — сброс.",
  ejectTitle: "Выгрузить трек из плеера",
  pendingSwitchText: (name: string) => `На очереди: ${name}`,
  switchBtn: "Переключить",
  hideBtn: "Скрыть",

  prevTrackTitle: "Предыдущий трек (Alt+B)",
  nextTrackTitle: "Следующий трек (Alt+N)",
  playlistToggleTitle: "Свернуть / развернуть плейлист",
  playlistFromNote: "Плейлист заметки",
  playlistFromFolder: "Плейлист папки",
  playlistCountTitle: (n: number) => `Аудиофайлов: ${n}`,
  rowMarkerTitle: "У трека есть маркер",

  analyseHint: "Темп и тональность ещё не измерены — нажми, чтобы измерить",
  analysing: "Считаю темп и тональность…",
  analyseFailed: (name: string) => `Songwriter: не удалось разобрать «${name}».`,
  musicalTitle: (votes: string, edited: boolean) =>
    edited ? "Темп и тональность, исправлены вручную · клик — меню" : `Темп и тональность · ${votes} · клик — меню`,
  votesUnanimous: "все профили согласны",
  votesSplit: (n: number, total: number, alt: string) => `${n} профиля из ${total}, остальные за ${alt}`,
  menuDouble: "Темп ×2",
  menuHalf: "Темп ÷2",
  rateTitle: "Скорость воспроизведения — тональность остаётся на месте (Alt+- / Alt+= / Alt+0)",
  rateTitleBpm: (now: number, original: number, factor: string) =>
    `Играет на ${now} BPM вместо ${original} (${factor}×) — тональность остаётся на месте. Alt+- и Alt+= меняют на один bpm, Alt+0 возвращает.`,
  rateOriginal: (label: string) => `${label} — как записано`,
  pitchTitle: "Транспонировать, не меняя темп; только на компьютере (Alt+PageUp / Alt+PageDown)",
  pitchTitleKey: (now: string, original: string) =>
    `Играет в ${now} вместо ${original}, темп не тронут. Alt+PageUp и Alt+PageDown — на полутон, Alt+0 сбрасывает.`,
  pitchOriginal: (label: string) => `${label} — как записано`,
  pitchUnavailable: "Songwriter: транспонирование здесь недоступно.",
  menuSaveCopy: (name: string) => `Сохранить копию: ${name}.wav`,
  renderWorking: (name: string) => `Считаю ${name}.wav…`,
  renderDone: (name: string) => `Сохранено: ${name}.wav`,
  renderNothing: "Songwriter: запекать нечего — тональность и скорость как в записи.",
  renderFailed: "Songwriter: не удалось сохранить копию.",
  menuListen: (label: string) => `Послушать: ${label}`,
  menuSwitchMode: (alt: string) => `Переключить на ${alt}`,
  menuReanalyse: "Измерить заново",
  menuForget: "Забыть темп и тональность",
  modeMajor: "мажор",
  modeMinor: "минор",

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
  headingPlaylist: "Плейлист",
  setFolderQueueName: "Вся папка как плейлист",
  setFolderQueueDesc:
    "При открытии аудиофайла в очередь встают все аудиофайлы рядом с ним, и кнопки ⏮ ⏭ ходят по папке. Выключено — файл грузится в одиночку.",
  setAutoAdvanceName: "Играть плейлист подряд",
  setAutoAdvanceDesc:
    "Когда трек доиграл, включается следующий из плейлиста. После последнего плеер просто останавливается. Трек с зоной A-B продолжает крутиться и никуда не переключается.",
  headingMusical: "Темп и тональность",
  setAutoAnalyseName: "Измерять трек при загрузке",
  setAutoAnalyseDesc:
    "Темп и тональность считаются один раз на файл и запоминаются. Занимает несколько секунд в фоне — воспроизведение и набор текста не тормозят. Выключено — считать вручную, из плашки с темпом или командой.",
  setTempoWindowName: "Предпочтительный диапазон темпа",
  setTempoWindowDesc: (low: number, high: number) =>
    `Слышится бит на ${low} или на ${low * 2} — вопрос ощущения, поэтому измеренный темп сам делится или умножается вдвое и попадает в ${low}–${high}. Это ровно одна октава, так что любой темп даёт единственное значение. Кнопки ×2 и ÷2 в плашке всё равно перебивают это для отдельного трека.`,
  headingFine: "Тонкая настройка",
  setMediaKeysName: "Медиа-клавиши",
  setMediaKeysDesc:
    "Отдавать загруженный трек системе: клавиши плей/пауза и вперёд/назад на клавиатуре доходят до этого плеера, а сам трек виден в системной карточке «сейчас играет». Выключите, если медиа-клавиши должны остаться за другим плеером.",
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

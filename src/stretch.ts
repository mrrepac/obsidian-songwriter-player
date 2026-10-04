import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";

/**
 * Signalsmith Stretch (MIT) does the transposing, live and in rendered copies.
 * It builds its own AudioWorklet from its source and loads it from a Blob URL,
 * so it fits inside the single main.js Obsidian installs. Its Emscripten glue
 * has no Node branch to take, which matters here: Obsidian's workers have Node
 * (see worker-build.mjs for what that did to the analysis worker).
 */
export type { StretchNode };

export function createStretch(context: BaseAudioContext): Promise<StretchNode> {
  return SignalsmithStretch(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
}

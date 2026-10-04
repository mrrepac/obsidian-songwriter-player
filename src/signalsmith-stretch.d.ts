/**
 * Types for signalsmith-stretch, which ships none. Only what this plugin
 * touches; the remote methods all answer through the node's message port, so
 * every one of them returns a Promise.
 */
declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    /** audio-context time the change takes effect at */
    output?: number;
    active?: boolean;
    /** position in the loaded buffers, seconds (buffer mode only) */
    input?: number;
    /** playback rate, 1 = as recorded (buffer mode only) */
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(change: StretchSchedule): Promise<unknown>;
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    /** one typed array per channel; resolves to the new buffer end, seconds */
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<unknown>;
    /** live-input latency, seconds */
    latency(): Promise<number>;
    configure(config: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: string }): Promise<unknown>;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions
  ): Promise<StretchNode>;
}

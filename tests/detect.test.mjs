/**
 * The tempo and key detectors are ports, so the test is parity with the
 * originals, not plausibility. The pinned numbers below are what the
 * reaperplug TempoCNN engine and the skey package answered on these exact
 * samples (tests/signals.mjs → tools/reference.py). A port that drifts from
 * them is a different detector, however reasonable its answer looks.
 *
 * Real tracks were checked the same way when the port was made — four of
 * them, tempo identical to four decimals, key probabilities within 1.4e-6 —
 * but those files are not in the repository.
 */
import { readFileSync } from "node:fs";
import { bundle, load, suite } from "./harness.mjs";
import { drumLoop, chords } from "./signals.mjs";

const REF_TEMPO = { bpm: 97.0079296922013, bpmCnn: 96.95704875664495 };
const REF_KEY_PROBS = [
  0.0033185614738613367, 0.004695870913565159, 0.0029484331607818604, 0.003581989323720336,
  0.0030687344260513783, 0.00388174201361835, 0.003272206988185644, 0.0030243522487580776,
  0.0031994653400033712, 0.0028090807609260082, 0.003721769666299224, 0.0030319588258862495,
  0.003558248281478882, 0.0034460420720279217, 0.003391820238903165, 0.9190760254859924,
  0.003513308707624674, 0.0039051321800798178, 0.0037222153041511774, 0.003417201805859804,
  0.0044012125581502914, 0.00316194468177855, 0.004559337627142668, 0.003293379908427596
];

export default async function run() {
  const s = suite("detectors — parity with TempoCNN and S-KEY");
  const { readWeights } = load(await bundle("src/detect/weights.ts"));
  const { estimateTempo } = load(await bundle("src/detect/tempo.ts"));
  const { estimateKey } = load(await bundle("src/detect/key.ts"));
  const weights = (name) => readWeights(new Uint8Array(readFileSync(new URL(`../models/${name}`, import.meta.url))));

  const tempo = estimateTempo(weights("tempocnn.bin"), drumLoop(97, 11025));
  s.check("the network's tempo matches the engine's", () => Math.abs(tempo.bpmCnn - REF_TEMPO.bpmCnn) < 1e-4,
    `got ${tempo.bpmCnn}`);
  s.check("the refined tempo matches the engine's", () => tempo.refined && Math.abs(tempo.bpm - REF_TEMPO.bpm) < 1e-4,
    `got ${tempo.bpm}`);

  const key = estimateKey(weights("skey.bin"), chords(22050));
  const drift = Math.max(...REF_KEY_PROBS.map((p, i) => Math.abs(p - key.probs[i])));
  s.check("all 24 key probabilities match S-KEY's", () => drift < 1e-5, `max drift ${drift}`);
  s.check("the D minor progression reads as D minor", () => key.key === "D" && key.scale === "minor",
    `got ${key.key} ${key.scale}`);

  return s.report();
}

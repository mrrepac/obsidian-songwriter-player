"""Reference outputs for the parity check of src/detect against the originals.

    python tools/reference.py <reaperplug engine/src> <out dir> <audio>...

For each file it writes, under <out dir>/<n>/:
  tempo.f32   mono float32 at 11025 Hz, exactly what the TempoCNN engine reads
  tempo.json  the engine's own estimate (bpm_cnn, refined bpm) and the
              averaged 256-class distribution
  key.f32     mono float32 at 22050 Hz, normalised, exactly what S-KEY reads
  key.json    S-KEY's 24 probabilities and a checksum of its log-VQT

The tempo engine is imported from the reaperplug source untouched, and S-KEY
is the installed package, so these are the originals' numbers, not a rewrite.
tests/detect.test.mjs reads the result. Requires: numpy, onnxruntime,
soundfile, soxr, torch, torchaudio, skey.
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, sys.argv[1])
import tempocnn_engine as engine  # noqa: E402

from skey.key_detection import (  # noqa: E402
    load_checkpoint, load_model_components, load_audio)

out_dir = Path(sys.argv[2])
ckpt = load_checkpoint()
hcqt, chromanet, crop = load_model_components(ckpt, torch.device("cpu"))

for index, path in enumerate(sys.argv[3:]):
    target = out_dir / str(index)
    target.mkdir(parents=True, exist_ok=True)

    samples = engine.load_audio(path)
    samples.astype("<f4").tofile(target / "tempo.f32")
    windows, spectrogram = engine.read_features(path)
    import onnxruntime as ort
    session = ort.InferenceSession(str(engine.model_path()), providers=["CPUExecutionProvider"])
    prediction = session.run(None, {session.get_inputs()[0].name: engine.std_normalizer(windows)})[0]
    averaged = np.average(prediction, axis=0)
    result = engine.estimate(path)
    (target / "tempo.json").write_text(json.dumps({
        "path": path,
        "bpm": result["bpm"], "bpm_cnn": result["bpm_cnn"], "origin": result["origin"],
        "windows": int(windows.shape[0]), "frames": int(spectrogram.shape[1]),
        "mel_sum": float(spectrogram.sum()),
        "averaged": [float(v) for v in averaged],
    }, indent=1), encoding="utf-8")

    audio = load_audio(path, ckpt["audio"]["sr"])
    audio[0].numpy().astype("<f4").tofile(target / "key.f32")
    with torch.no_grad():
        spec = hcqt(audio.unsqueeze(0))
        probs = torch.mean(chromanet(crop(spec, torch.zeros(1))), dim=0)
    (target / "key.json").write_text(json.dumps({
        "path": path,
        "vqt_shape": list(spec.shape), "vqt_sum": float(spec.sum()),
        "vqt_head": [float(v) for v in spec[0, 0, :3, :3].reshape(-1)],
        "probs": [float(v) for v in probs],
    }, indent=1), encoding="utf-8")
    print(index, result["bpm"], int(probs.argmax()), Path(path).name, flush=True)

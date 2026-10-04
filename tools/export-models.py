"""Exports the two analysis networks into the plugin's own weight format.

    python tools/export-models.py <deeptemp_k16.onnx> <skey.pt>

Writes models/tempocnn.bin and models/skey.bin. Both are committed: the CI
build embeds them in the worker and has no Python. Rerun only to change a
model.

Sources:
  deeptemp_k16.onnx  tempo-cnn by Hendrik Schreiber (AGPL-3.0), converted to
                     ONNX in D:\\reaperplug (dev/model_conversion)
  skey.pt            S-KEY by Deezer (MIT), github.com/deezer/skey,
                     skey/models/skey.pt

Format: u32 little-endian header length, the header as UTF-8 JSON, zero
padding to a multiple of 4, then float32 little-endian data. The header maps
each tensor name to {shape, offset} in floats; tempocnn also lists its layers
in order. Requires: numpy, onnx, torch.
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "models"


def write(path: Path, header: dict, tensors: dict[str, np.ndarray]) -> None:
    chunks, offset = [], 0
    header["tensors"] = {}
    for name, array in tensors.items():
        array = np.ascontiguousarray(array, dtype="<f4")
        header["tensors"][name] = {"shape": list(array.shape), "offset": offset}
        chunks.append(array.tobytes())
        offset += array.size
    head = json.dumps(header, separators=(",", ":")).encode("utf-8")
    pad = (-(4 + len(head))) % 4
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(head) + pad))
        f.write(head + b" " * pad)
        for chunk in chunks:
            f.write(chunk)
    print(f"{path.name}: {offset} floats, {path.stat().st_size} bytes")


def export_tempocnn(onnx_path: str) -> None:
    """The graph is one straight chain; it is checked op by op, so a different
    model fails here instead of producing wrong numbers in the plugin."""
    import onnx
    from onnx import numpy_helper

    graph = onnx.load(onnx_path).graph
    init = {t.name: numpy_helper.to_array(t) for t in graph.initializer}
    layers, tensors = [], {}
    for node in graph.node:
        attrs = {a.name: onnx.helper.get_attribute_value(a) for a in node.attribute}
        op = node.op_type
        if op == "Reshape":
            assert list(init[node.input[1]]) == [0, 1, 40, -1]
        elif op == "Conv":
            assert attrs["auto_pad"] == b"SAME_UPPER" and attrs["group"] == 1
            assert attrs["strides"] == [1, 1] and attrs["kernel_shape"][0] == 1
            name = f"conv{len(tensors)}"
            tensors[name + ".w"] = init[node.input[1]]
            tensors[name + ".b"] = init[node.input[2]]
            layers.append({"op": "conv", "name": name})
        elif op == "Relu":
            layers.append({"op": "relu"})
        elif op in ("Mul", "Add"):
            name = f"{op.lower()}{len(tensors)}"
            tensors[name] = init[node.input[1]].reshape(-1)
            layers.append({"op": op.lower(), "name": name})
        elif op == "MaxPool":
            assert "pads" not in attrs and attrs["strides"] == attrs["kernel_shape"]
            layers.append({"op": "maxpool", "h": attrs["kernel_shape"][0], "w": attrs["kernel_shape"][1]})
        elif op == "GlobalAveragePool":
            layers.append({"op": "gap"})
        elif op in ("Squeeze", "Softmax"):
            pass
        else:
            raise ValueError(f"unexpected op {op}")
    write(OUT / "tempocnn.bin", {"model": "deeptemp_k16", "layers": layers}, tensors)


def export_skey(pt_path: str) -> None:
    import torch

    ckpt = torch.load(pt_path, map_location="cpu", weights_only=False)
    assert ckpt["audio"]["sr"] == 22050
    tensors = {}
    for name, value in ckpt["stone"].items():
        if name.startswith("hcqt.") or name.startswith("chromanet."):
            if value.dtype.is_floating_point:
                tensors[name] = value.numpy()
    write(OUT / "skey.bin", {"model": "skey", "sr": 22050}, tensors)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    export_tempocnn(sys.argv[1])
    export_skey(sys.argv[2])

/**
 * Reads the weight files written by tools/export-models.py: a u32 header
 * length, a JSON header naming each tensor's shape and offset, then float32
 * data. No Obsidian imports — this runs in the analysis worker and in tests.
 */
export interface Tensor {
  shape: number[];
  data: Float32Array;
}

export interface Weights {
  header: Record<string, unknown>;
  get(name: string): Tensor;
}

export function readWeights(bytes: Uint8Array): Weights {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as {
    tensors: Record<string, { shape: number[]; offset: number }>;
  } & Record<string, unknown>;
  // copied once into an aligned buffer: the embedded bytes may sit at any offset
  const start = 4 + headerLength;
  const floats = new Float32Array(bytes.slice(start).buffer);
  return {
    header,
    get(name) {
      const entry = header.tensors[name];
      if (!entry) throw new Error(`missing tensor ${name}`);
      const size = entry.shape.reduce((a, b) => a * b, 1);
      return { shape: entry.shape, data: floats.subarray(entry.offset, entry.offset + size) };
    }
  };
}

# DTTNet upstream reference snapshot

Selected, unmodified source files from the official [DTTNet-Pytorch](https://github.com/junyuchen-cjy/DTTNet-Pytorch) repository.

- Upstream: Junyu Chen, Susmitha Vekkot, Pancham Shukla
- Paper: ICASSP 2024, Dual-Path TFC-TDF UNet for Music Source Separation
- Upstream source license: Apache License 2.0 (see LICENSE)

## Integration status

This is a source-reference snapshot only. It is **not connected** to Mori's UI,
Capacitor bridge, Android runtime, or download pipeline. It does not yet add an
active audio-separation feature to the installed app.

The upstream implementation is PyTorch/Python. Its inference workflow expects
a downloaded checkpoint and its published separation path uses CUDA-specific
execution in places. It is not a ready-to-use Android/ONNX engine.

The missing `src/dp_tdf/bandsequence.py` module has now been added from
the official DTTNet-Pytorch source snapshot, retaining its original attribution.
The full training/evaluation helper stack under `src/utils` is still not part
of the Android runtime; it pulls in Python training/evaluation packages and is
not a suitable mobile inference dependency.

No Voela source code or Voela ONNX model was copied. Voela's repository states
"All rights reserved", so its native wrapper and bundled model are not being
redistributed here.

## Next engineering work

1. Obtain and verify checkpoint redistribution terms and model provenance.
2. Build a minimal inference-only Python environment and reproduce a known-good checkpoint output.
3. Export the model to ONNX reproducibly and check operator compatibility.
4. Implement Android CPU inference with bounded chunking and memory use.
5. Benchmark on low-memory Android devices before enabling the feature.

The checkpoint weights are not included. Upstream README links to externally
hosted checkpoints; their redistribution terms and integrity need separate
verification.


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

The upstream network imports `BandSequenceModelModule` from
`src/dp_tdf/bandsequence.py`. That file was not copied because it identifies
its implementation as originating from a separate BandSplitRNN-PyTorch
repository for which a clear redistribution license could not be verified.
This dependency must be independently reimplemented or separately cleared.

No Voela source code or Voela ONNX model was copied. Voela's repository states
"All rights reserved", so its native wrapper and bundled model are not being
redistributed here.

## Next engineering work

1. Independently implement/replace the BandSequence block.
2. Obtain and verify checkpoint redistribution terms.
3. Export the model to ONNX reproducibly and check operator compatibility.
4. Implement Android CPU inference with bounded chunking and memory use.
5. Benchmark on low-memory Android devices before enabling the feature.

The checkpoint weights are not included. Upstream README links to externally
hosted checkpoints; their redistribution terms and integrity need separate
verification.


#include <emscripten/emscripten.h>
#include <stdint.h>
#include <algorithm>
#include <vector>
#include "sherpa-onnx/c-api/c-api.h"
extern "C" {
EMSCRIPTEN_KEEPALIVE uintptr_t MoriSpleeterCreate(const char *vocals_path, const char *accompaniment_path) {
  if (!vocals_path || !accompaniment_path) return 0;
  SherpaOnnxOfflineSourceSeparationConfig config{};
  config.model.spleeter.vocals = vocals_path;
  config.model.spleeter.accompaniment = accompaniment_path;
  config.model.num_threads = 1;
  config.model.debug = 0;
  config.model.provider = "cpu";
  const auto *engine = SherpaOnnxCreateOfflineSourceSeparation(&config);
  return reinterpret_cast<uintptr_t>(engine);
}
EMSCRIPTEN_KEEPALIVE int32_t MoriSpleeterProcess(uintptr_t engine_handle, const float *interleaved_input,
 int32_t channels, int32_t frames, int32_t sample_rate, float *interleaved_output,
 int32_t output_capacity_samples, int32_t *output_frames, int32_t *output_sample_rate) {
  if (!engine_handle || !interleaved_input || !interleaved_output || !output_frames ||
      !output_sample_rate || channels != 2 || frames <= 0 || sample_rate <= 0) return -1;
  const auto *engine = reinterpret_cast<const SherpaOnnxOfflineSourceSeparation *>(engine_handle);
  std::vector<float> left(static_cast<size_t>(frames)), right(static_cast<size_t>(frames));
  for (int32_t i = 0; i < frames; ++i) { left[i] = interleaved_input[2*i]; right[i] = interleaved_input[2*i+1]; }
  const float *input_channels[2] = {left.data(), right.data()};
  const auto *result = SherpaOnnxOfflineSourceSeparationProcess(engine, input_channels, 2, frames, sample_rate);
  if (!result || result->num_stems < 1 || !result->stems) {
    if (result) SherpaOnnxDestroySourceSeparationOutput(result);
    return -2;
  }
  const auto &vocals = result->stems[0];
  if (!vocals.samples || vocals.num_channels < 1 || vocals.n <= 0 || vocals.n > output_capacity_samples/2) {
    SherpaOnnxDestroySourceSeparationOutput(result);
    return -3;
  }
  const int32_t output_channels = std::min<int32_t>(2, vocals.num_channels);
  for (int32_t i = 0; i < vocals.n; ++i) {
    const float l = vocals.samples[0][i];
    const float r = output_channels > 1 ? vocals.samples[1][i] : l;
    interleaved_output[2*i] = l; interleaved_output[2*i+1] = r;
  }
  *output_frames = vocals.n;
  *output_sample_rate = result->sample_rate;
  SherpaOnnxDestroySourceSeparationOutput(result);
  return 0;
}
EMSCRIPTEN_KEEPALIVE void MoriSpleeterDestroy(uintptr_t engine_handle) {
  if (!engine_handle) return;
  const auto *engine = reinterpret_cast<const SherpaOnnxOfflineSourceSeparation *>(engine_handle);
  SherpaOnnxDestroyOfflineSourceSeparation(engine);
}
}

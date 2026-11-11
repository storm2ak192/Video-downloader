#include <jni.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#include "sherpa-onnx/c-api/c-api.h"

namespace {
struct Engine {
  const SherpaOnnxOfflineSourceSeparation* handle = nullptr;
  ~Engine() { if (handle) SherpaOnnxDestroyOfflineSourceSeparation(handle); }
};
void throwJava(JNIEnv* env, const char* message) {
  jclass cls = env->FindClass("java/lang/IllegalStateException");
  if (cls) env->ThrowNew(cls, message);
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_mori_downloader_SpleeterAudioProcessor_nativeCreate(JNIEnv* env, jclass, jstring vocalsPath, jstring accompanimentPath, jint threads) {
  if (!vocalsPath || !accompanimentPath) { throwJava(env, "Spleeter model paths are missing."); return 0; }
  const char* vocals = env->GetStringUTFChars(vocalsPath, nullptr);
  const char* accompaniment = env->GetStringUTFChars(accompanimentPath, nullptr);
  SherpaOnnxOfflineSourceSeparationConfig config;
  std::memset(&config, 0, sizeof(config));
  config.model.spleeter.vocals = vocals;
  config.model.spleeter.accompaniment = accompaniment;
  config.model.num_threads = std::max(1, static_cast<int>(threads));
  config.model.provider = "cpu";
  auto engine = std::make_unique<Engine>();
  engine->handle = SherpaOnnxCreateOfflineSourceSeparation(&config);
  env->ReleaseStringUTFChars(vocalsPath, vocals);
  env->ReleaseStringUTFChars(accompanimentPath, accompaniment);
  if (!engine->handle) { throwJava(env, "Spleeter could not load its ONNX models."); return 0; }
  return reinterpret_cast<jlong>(engine.release());
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_mori_downloader_SpleeterAudioProcessor_nativeSeparate(JNIEnv* env, jclass, jlong nativeHandle, jfloatArray input, jint channels, jint frames, jint sampleRate) {
  auto* engine = reinterpret_cast<Engine*>(nativeHandle);
  if (!engine || !engine->handle || !input || channels < 1 || channels > 2 || frames <= 0) {
    throwJava(env, "Invalid Spleeter audio input."); return nullptr;
  }
  const jsize expected = static_cast<jsize>(channels * frames);
  if (env->GetArrayLength(input) != expected) { throwJava(env, "Spleeter received an invalid PCM buffer."); return nullptr; }
  std::vector<jfloat> interleaved(expected);
  env->GetFloatArrayRegion(input, 0, expected, interleaved.data());
  if (env->ExceptionCheck()) return nullptr;
  std::vector<std::vector<float>> planar(channels, std::vector<float>(frames));
  std::vector<const float*> channelPointers(channels);
  for (int c = 0; c < channels; ++c) {
    channelPointers[c] = planar[c].data();
    for (int f = 0; f < frames; ++f) planar[c][f] = interleaved[f * channels + c];
  }
  const auto* separated = SherpaOnnxOfflineSourceSeparationProcess(engine->handle, channelPointers.data(), channels, frames, sampleRate);
  if (!separated || separated->num_stems < 1 || separated->stems[0].num_channels < 1 || separated->stems[0].n <= 0 || separated->sample_rate <= 0) {
    if (separated) SherpaOnnxDestroySourceSeparationOutput(separated);
    throwJava(env, "Spleeter failed to separate the vocals."); return nullptr;
  }
  const auto& vocals = separated->stems[0];
  const int outChannels = std::min<int>(channels, vocals.num_channels);
  std::vector<jfloat> output(static_cast<size_t>(frames) * channels, 0.0f);
  for (int f = 0; f < frames; ++f) {
    const double sourcePosition = static_cast<double>(f) * separated->sample_rate / sampleRate;
    const int left = std::min(vocals.n - 1, static_cast<int>(sourcePosition));
    const int right = std::min(vocals.n - 1, left + 1);
    const float fraction = static_cast<float>(sourcePosition - left);
    for (int c = 0; c < channels; ++c) {
      const int sourceChannel = std::min(c, outChannels - 1);
      const float* source = vocals.samples[sourceChannel];
      const float value = source[left] + (source[right] - source[left]) * fraction;
      output[static_cast<size_t>(f) * channels + c] = std::max(-1.0f, std::min(1.0f, value));
    }
  }
  SherpaOnnxDestroySourceSeparationOutput(separated);
  jfloatArray result = env->NewFloatArray(static_cast<jsize>(output.size()));
  if (result) env->SetFloatArrayRegion(result, 0, static_cast<jsize>(output.size()), output.data());
  return result;
}

extern "C" JNIEXPORT void JNICALL
Java_com_mori_downloader_SpleeterAudioProcessor_nativeDestroy(JNIEnv*, jclass, jlong nativeHandle) {
  delete reinterpret_cast<Engine*>(nativeHandle);
}

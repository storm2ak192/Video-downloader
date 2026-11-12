#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT/.build/spleeter-wasm"
SHERPA_ROOT="$BUILD_ROOT/sherpa-onnx"
EMSDK_ROOT="$BUILD_ROOT/emsdk"
OUTPUT_DIR="$ROOT/public/wasm/spleeter"
mkdir -p "$BUILD_ROOT" "$OUTPUT_DIR"

if [ ! -d "$EMSDK_ROOT/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_ROOT"
fi
(
  cd "$EMSDK_ROOT"
  ./emsdk install 4.0.23
  ./emsdk activate 4.0.23
)
# shellcheck disable=SC1091
source "$EMSDK_ROOT/emsdk_env.sh"

if [ ! -d "$SHERPA_ROOT/.git" ]; then
  git clone --depth 1 --branch v2.0.1 https://github.com/k2-fsa/sherpa-onnx.git "$SHERPA_ROOT"
fi

cp "$ROOT/wasm/spleeter/mori-spleeter-wasm.cc" "$SHERPA_ROOT/wasm/web/mori-spleeter-wasm.cc"

if ! grep -q "add_executable(mori-spleeter-wasm" "$SHERPA_ROOT/wasm/web/CMakeLists.txt"; then
  cat >> "$SHERPA_ROOT/wasm/web/CMakeLists.txt" <<'CMAKE'

# Mori's browser-local Spleeter interface.
add_executable(mori-spleeter-wasm mori-spleeter-wasm.cc)
target_link_libraries(mori-spleeter-wasm sherpa-onnx-core sherpa-onnx-c-api)
target_link_options(mori-spleeter-wasm PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_NAME=createMoriSpleeterModule"
  "-sENVIRONMENT=web,worker"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=128MB"
  "-sSTACK_SIZE=10485760"
  "-sFILESYSTEM=1"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_MoriSpleeterCreate','_MoriSpleeterProcess','_MoriSpleeterDestroy']"
  "-sEXPORTED_RUNTIME_METHODS=['FS','HEAPF32','getValue','stringToUTF8','lengthBytesUTF8']"
)
set_target_properties(mori-spleeter-wasm PROPERTIES OUTPUT_NAME "mori-spleeter")
install(FILES
  "$<TARGET_FILE_DIR:mori-spleeter-wasm>/mori-spleeter.js"
  "$<TARGET_FILE_DIR:mori-spleeter-wasm>/mori-spleeter.wasm"
  DESTINATION bin/wasm/web
)
CMAKE
fi

# Vercel's build image may not include CMake. Install a pinned portable
# binary locally instead of relying on apt or changing the runner image.
if ! command -v cmake >/dev/null 2>&1; then
  CMAKE_VERSION="3.30.5"
  CMAKE_ARCHIVE="$BUILD_ROOT/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz"
  CMAKE_URL="https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz"
  mkdir -p "$BUILD_ROOT/tools"
  curl -fL --retry 3 "$CMAKE_URL" -o "$CMAKE_ARCHIVE"
  tar -xzf "$CMAKE_ARCHIVE" -C "$BUILD_ROOT/tools"
  export PATH="$BUILD_ROOT/tools/cmake-${CMAKE_VERSION}-linux-x86_64/bin:$PATH"
fi
cmake --version

export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
cmake -S "$SHERPA_ROOT" -B "$BUILD_ROOT/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSDK_ROOT/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_ROOT/install" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_WEB=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF \
  -DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF

cmake --build "$BUILD_ROOT/build" --target mori-spleeter-wasm --parallel 2
cmake --install "$BUILD_ROOT/build"

cp "$BUILD_ROOT/install/bin/wasm/web/mori-spleeter.js" "$OUTPUT_DIR/"
cp "$BUILD_ROOT/install/bin/wasm/web/mori-spleeter.wasm" "$OUTPUT_DIR/"
test -s "$OUTPUT_DIR/mori-spleeter.js"
test -s "$OUTPUT_DIR/mori-spleeter.wasm"
echo "Mori Spleeter WebAssembly runtime is ready in $OUTPUT_DIR"

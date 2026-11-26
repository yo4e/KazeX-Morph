#!/usr/bin/env bash
# Rebuild using an activated Emscripten 4.0.23 SDK, CMake 3.31 and Ninja.
# Arguments: unmodified OpenCV 5.1.0 source and an out-of-tree build directory.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "Usage: tools/vision/build.sh OPENCV_SOURCE BUILD_DIRECTORY" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
src="$(cd "$1" && pwd -P)"
mkdir -p "$2" "$root/vendor/vision"
build="$(cd "$2" && pwd -P)"
common="-fexceptions -ffile-prefix-map=$src=opencv -ffile-prefix-map=$build=opencv-build"
if [[ "$src" == /private/* ]]; then common+=" -ffile-prefix-map=${src#/private}=opencv"; fi
if [[ "$build" == /private/* ]]; then common+=" -ffile-prefix-map=${build#/private}=opencv-build"; fi
emcmake cmake -S "$src" -B "$build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_C_FLAGS="$common" -DCMAKE_CXX_FLAGS="$common" \
  -DCMAKE_C_FLAGS_RELEASE='-O3 -DNDEBUG' -DCMAKE_CXX_FLAGS_RELEASE='-O3 -DNDEBUG' \
  -DBUILD_LIST=core,flann,geometry,imgproc,features,video \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
  -DBUILD_opencv_apps=OFF -DBUILD_JAVA=OFF -DBUILD_DOCS=OFF \
  -DWITH_OPENCL=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_EIGEN=OFF \
  -DWITH_LAPACK=OFF -DWITH_OPENMP=OFF -DWITH_PTHREADS_PF=OFF \
  -DWITH_FFMPEG=OFF -DWITH_V4L=OFF -DWITH_GSTREAMER=OFF -DWITH_GTK=OFF \
  -DWITH_AVIF=OFF -DWITH_JPEG=OFF -DWITH_JASPER=OFF -DWITH_OPENJPEG=OFF \
  -DWITH_WEBP=OFF -DWITH_PNG=OFF -DWITH_OPENEXR=OFF -DWITH_TIFF=OFF \
  -DWITH_PROTOBUF=OFF -DWITH_FLATBUFFERS=OFF -DWITH_ADE=OFF \
  -DBUILD_ZLIB=ON -DENABLE_PIC=OFF -DCV_ENABLE_INTRINSICS=OFF -DCPU_BASELINE= -DCPU_DISPATCH=
# OpenCV normally embeds the complete CMake report, including host-specific paths.
printf '"OpenCV 5.1.0, KazeX Morph WebAssembly build\\n"\n' > "$build/modules/core/version_string.inc"
cmake --build "$build" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-6}" --target opencv_video

includes=("-I$build")
for module in core flann geometry imgproc features video; do
  includes+=("-I$src/modules/$module/include")
done
out="$root/vendor/vision/opencv-morph.mjs"
em++ -std=c++17 -O3 -DNDEBUG -fexceptions "-ffile-prefix-map=$root=project" \
  "-ffile-prefix-map=$src=opencv" "-ffile-prefix-map=$build=opencv-build" \
  "-Wl,--why-extract=$build/morph-link.tsv" \
  "${includes[@]}" "$root/tools/vision/morph.cpp" \
  -Wl,--start-group "$build"/lib/libopencv_{video,features,geometry,flann,imgproc,core}.a \
  "$build"/3rdparty/lib/libzlib.a -Wl,--end-group \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createVision \
  -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1073741824 \
  -sSTACK_SIZE=1048576 -sNO_EXIT_RUNTIME=1 -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_morph_prepare","_morph_frame","_morph_close"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -o "$out"
chmod 644 "$root/vendor/vision/opencv-morph.wasm"

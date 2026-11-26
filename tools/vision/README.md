# Rebuilding the vision module

The browser loads the checked-in WebAssembly and ES module from `vendor/vision`. The following steps are for rebuilding them.

Activate [Emscripten SDK 4.0.23](https://github.com/emscripten-core/emsdk/tree/4.0.23) in a shell with CMake 3.31.10 and Ninja 1.13.0 on the path. From the repository root, use an empty directory for the OpenCV source and build.

```sh
work="$(mktemp -d)"
curl -fL https://codeload.github.com/opencv/opencv/tar.gz/refs/tags/5.1.0 -o "$work/opencv.tgz"
echo "638c1dae7e37e45afea21aa217dc667ad7cf57acc66cdf652c074f1e0e5ad6d2  $work/opencv.tgz" | shasum -a 256 -c -
tar -xzf "$work/opencv.tgz" -C "$work"
tools/vision/build.sh "$work/opencv-5.1.0" "$work/build"
```

The build compiles the OpenCV libraries for single-threaded, scalar WebAssembly, links the used code with `morph.cpp`, and writes `opencv-morph.mjs` and `opencv-morph.wasm` under `vendor/vision`. The link inventory remains in the temporary build directory as `morph-link.tsv`. When changing the dependency set, update the adjacent third-party notices. The build substitutes a fixed string for OpenCV's generated host diagnostics and remaps source paths.

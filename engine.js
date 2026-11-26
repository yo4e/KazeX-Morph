// Each transition owns its two keyframes. frame(t) returns an independent RGBA
// buffer; the caller owns easing and emits unmodified keyframes at the boundaries.
let visionPromise;

async function loadVision() {
  if (!visionPromise) {
    visionPromise = import('./vendor/vision/opencv-morph.mjs')
      .then(({ default: createVision }) => createVision())
      .catch((cause) => {
        visionPromise = undefined;
        throw new Error('画像処理エンジンを読み込めませんでした。ページを更新してもう一度お試しください。', { cause });
      });
  }
  return visionPromise;
}

function validateTime(t) {
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    throw new RangeError('補間位置は0から1の間で指定してください。');
  }
}

function samePixels(a, b) {
  if (a === b) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function dissolve(a, b, identical) {
  return {
    frame(t) {
      if (!a) throw new Error('処理済みの区間です。');
      validateTime(t);
      if (t === 0 || identical) return a.slice();
      if (t === 1) return b.slice();
      const out = new Uint8ClampedArray(a.length);
      for (let i = 0; i < out.length; i += 4) {
        out[i] = (1 - t) * a[i] + t * b[i];
        out[i + 1] = (1 - t) * a[i + 1] + t * b[i + 1];
        out[i + 2] = (1 - t) * a[i + 2] + t * b[i + 2];
        out[i + 3] = 255;
      }
      return out;
    },
    close() {
      a = null;
      b = null;
    },
  };
}

export async function prepareTransition(a, b, width, height, method) {
  const bytes = width * height * 4;
  if (!(a instanceof Uint8ClampedArray) || !(b instanceof Uint8ClampedArray)
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || a.length !== bytes || b.length !== bytes) {
    throw new TypeError('画像の大きさと画素データが一致しません。');
  }
  if (!['flow', 'rigid', 'dissolve'].includes(method)) {
    throw new RangeError('補間方式を選び直してください。');
  }
  const identical = samePixels(a, b);
  if (method === 'dissolve' || identical || (method === 'flow' && Math.min(width, height) < 16)) {
    return dissolve(a, b, identical);
  }

  const wasm = await loadVision();
  let first = 0, last = 0, out = 0, handle = 0;
  function close() {
    if (handle) wasm._morph_close(handle);
    if (first) wasm._free(first);
    if (last) wasm._free(last);
    if (out) wasm._free(out);
    first = last = out = handle = 0;
  }

  try {
    first = wasm._malloc(bytes);
    last = wasm._malloc(bytes);
    out = wasm._malloc(bytes);
    if (!first || !last || !out) throw new Error('画像処理に必要なメモリが足りません。');
    // A growing WebAssembly memory invalidates old views. Read HEAPU8 anew
    // after each allocating native operation, including during frame rendering.
    wasm.HEAPU8.set(a, first);
    wasm.HEAPU8.set(b, last);
    handle = wasm._morph_prepare(first, last, width, height, method === 'flow' ? 1 : 2);
    if (!handle) throw new Error('画像の位置合わせを開始できませんでした。小さい画像でもう一度お試しください。');
    return {
      frame(t) {
        if (!handle) throw new Error('処理済みの区間です。');
        validateTime(t);
        if (!wasm._morph_frame(handle, t, out)) {
          throw new Error('中間フレームを作成できませんでした。小さい画像でもう一度お試しください。');
        }
        return new Uint8ClampedArray(wasm.HEAPU8.subarray(out, out + bytes));
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

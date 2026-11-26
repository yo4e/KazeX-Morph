// Each export owns its WASM memory. Only the immutable compiled module is shared.
let compiled;

async function loadCodec() {
  if (!compiled) {
    compiled = (async () => {
      const url = new URL("./vendor/encoder/encoder.wasm", import.meta.url);
      const response = await fetch(url);
      if (!response.ok) throw new Error("MP4エンコーダーを読み込めませんでした。");
      return WebAssembly.compile(await response.arrayBuffer());
    })().catch(error => {
      compiled = undefined;
      throw error;
    });
  }
  return compiled;
}

export async function createEncoder(width, height, fps, frames) {
  if (![width, height].every(n => Number.isInteger(n) && n >= 2 && n <= 1920 && n % 2 === 0)) {
    throw new Error("動画の幅と高さには、2〜1920の偶数を指定してください。");
  }
  if (![12, 15, 24, 25, 30, 48, 50, 60].includes(fps) || !Number.isInteger(frames) || frames < 1) {
    throw new Error("フレームレートまたはフレーム数が正しくありません。");
  }

  // minimp4 backpatches the mdat size. Fixed-size chunks allow random writes
  // without reallocating the entire movie on each growth or retaining RGBA frames.
  const blockSize = 1024 * 1024;
  const blocks = [];
  let length = 0;
  let count = 0;
  let codec;
  function write(offset, address, size) {
    const source = new Uint8Array(codec.memory.buffer, address, size);
    let consumed = 0;
    length = Math.max(length, offset + size);
    while (consumed < size) {
      const position = offset + consumed;
      const index = Math.floor(position / blockSize);
      const inside = position % blockSize;
      if (!blocks[index]) blocks[index] = new Uint8Array(blockSize);
      const bytes = Math.min(size - consumed, blockSize - inside);
      blocks[index].set(source.subarray(consumed, consumed + bytes), inside);
      consumed += bytes;
    }
    return 0;
  }
  const module = await loadCodec();
  codec = (await WebAssembly.instantiate(module, { env: { write } })).exports;
  codec._initialize();
  const input = codec.begin(width, height, fps);
  if (!input) throw new Error("動画を準備するメモリが不足しています。小さい画像でお試しください。");
  const frameBytes = width * height * 4;
  function close() {
    codec = null;
    blocks.length = 0;
  }
  return {
    add(rgba) {
      if (!codec || count >= frames || rgba.BYTES_PER_ELEMENT !== 1 || rgba.byteLength !== frameBytes) {
        throw new Error("書き出すフレームの形式または枚数が正しくありません。");
      }
      new Uint8Array(codec.memory.buffer, input, frameBytes).set(rgba);
      if (codec.add() !== 0) throw new Error("フレームをMP4に書き込めませんでした。");
      count++;
    },
    finish() {
      if (!codec || count !== frames) throw new Error("指定したフレーム数に達していません。");
      try {
        if (codec.finish() !== 0 || !length) throw new Error("MP4を完成できませんでした。");
        const last = blocks.length - 1;
        blocks[last] = blocks[last].subarray(0, length - last * blockSize);
        return new Blob(blocks, { type: "video/mp4" });
      } finally {
        close();
      }
    },
    close,
  };
}

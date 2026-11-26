// Decode in the document so mobile browsers can use their native image decoders.
// Only the pixels for the next transition are transferred to the processing worker.
async function readImage(file, target) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("画像を開けませんでした。JPEG・PNG・WebPのファイルを選んでください。");
    }
    const sw = image.naturalWidth;
    const sh = image.naturalHeight;
    if (!sw || !sh || sw * sh > 40000000) {
      throw new Error("素材は1枚4,000万画素までです。小さくしてお試しください。");
    }
    const scale = Math.min(1, 1920 / Math.max(sw, sh));
    const even = (n) => Math.max(2, Math.floor(Math.round(n * scale) / 2) * 2);
    const {width, height} = target || {width: even(sw), height: even(sh)};
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", {alpha: false, willReadFrequently: true});
    if (!ctx) throw new Error("画像用のメモリを確保できませんでした。小さい画像でもう一度お試しください。");
    const cover = Math.max(width / sw, height / sh);
    const cw = width / cover;
    const ch = height / cover;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, width, height);
    return {width, height, pixels: ctx.getImageData(0, 0, width, height).data};
  } finally {
    canvas.width = canvas.height = 0;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

export async function renderVideo({files, method, fps, frames, onProgress = () => {}}) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 12 ||
      !["flow", "rigid", "dissolve"].includes(method) ||
      ![12, 15, 24, 25, 30, 48, 50, 60].includes(fps) ||
      !Number.isInteger(frames) || frames < files.length || frames > fps * 30) {
    throw new Error("画像・補間方式・長さ・FPSの設定を確認してください。");
  }
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") {
    throw new Error("この端末は必要なブラウザ機能に対応していません。新しいSafari・Chrome・Firefoxで開いてください。");
  }
  onProgress(0.01);
  const {width, height, pixels} = await readImage(files[0]);
  const worker = new Worker(new URL("./render-worker.js", import.meta.url), {type: "module"});
  try {
    return await new Promise((resolve, reject) => {
      worker.onerror = () => reject(new Error("動画の処理を開始または継続できませんでした。ページを再読み込みするか、素材を小さくしてください。"));
      worker.onmessageerror = () => reject(new Error("動画データをブラウザ内で受け取れませんでした。"));
      worker.onmessage = async ({data}) => {
        try {
          switch (data.type) {
            case "image": {
              const next = await readImage(files[data.index], {width, height});
              worker.postMessage({type: "image", pixels: next.pixels}, [next.pixels.buffer]);
              break;
            }
            case "progress": onProgress(data.fraction); break;
            case "done": resolve(data.video); break;
            case "error": reject(new Error(data.message)); break;
          }
        } catch (error) {
          reject(error);
        }
      };
      worker.postMessage({type: "start", width, height, pixels, count: files.length,
        method, fps, frames}, [pixels.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

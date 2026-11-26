import { renderVideo } from "./render.js";

const byId = (id) => document.getElementById(id);
const form = byId("editor");
const seconds = byId("seconds");
const fps = byId("fps");
const method = byId("method");
const renderButton = byId("render");
const statusLine = byId("status");
const progressBar = byId("progress");
const middleInput = byId("file-middle");
const middleList = byId("middle-list");
const middleInfo = byId("middle-info");
const maxFileBytes = 64 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const maxMiddle = 10;
const maxPixels = 40000000;
const descriptions = {
  flow: "近い位置の形を対応させて、画像の各部分を少しずつ変形します。",
  rigid: "画像全体を平行移動・回転・均一に拡大縮小して位置を合わせます。廊下や建物の直線を保ちたいときに向きます。",
  dissolve: "画像の位置と形を固定し、重ねる割合だけを変えて切り替えます。"
};
const endpoints = { a: null, b: null };
const middles = [];
let busy = false;
let decodeQueue = Promise.resolve();
let resultURL = null;

function selectedImages() {
  return [endpoints.a, ...middles, endpoints.b].filter(Boolean);
}

function report(message, error = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", error);
}

function setMiddleInfo(message, error = false) {
  middleInfo.textContent = message;
  middleInfo.classList.toggle("error", error);
}

function timing() {
  const tenths = Math.round(seconds.valueAsNumber * 10);
  const rate = Number(fps.value);
  const frames = Math.floor((rate * tenths + 5) / 10);
  return { rate, tenths, frames, actual: frames / rate };
}

function secondsText(value) {
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 5 });
}

function updateControls() {
  const valid = seconds.validity.valid && seconds.value !== "";
  const t = timing();
  const rule = "長さ × フレームレートを1フレーム単位で四捨五入します。";
  const rounded = valid && t.tenths * t.rate !== t.frames * 10;
  byId("frame-count").textContent = valid ? String(t.frames) : "—";
  byId("timing-note").textContent = (rounded ? "実際の長さは " + secondsText(t.actual) + " 秒（" + t.frames + "枚 ÷ " + t.rate + " fps）です。" : "") + rule;
  byId("method-help").textContent = descriptions[method.value];
  renderButton.disabled = busy || !valid || !endpoints.a || !endpoints.b ||
    selectedImages().some((image) => !image.url);
  middleInput.disabled = busy || middles.length >= maxMiddle;
}

function reportReady() {
  if (busy) return;
  if (!seconds.validity.valid) return report("長さは1〜30秒の範囲で、0.1秒単位で指定してください。", true);
  const images = selectedImages();
  const failed = images.find((image) => image.error);
  if (failed) return report(failed.file.name + "：" + failed.error, true);
  if (images.some((image) => !image.url)) return report("画像を確認中…");
  report(endpoints.a && endpoints.b ? "素材画像が揃いました。" : "開始画像Aと終了画像Bを選ぶと書き出せます。");
}

function validateFile(file) {
  const supported = /^image\/(jpeg|png|webp)$/i.test(file.type) ||
    (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name));
  if (!supported) throw new Error("JPEG・PNG・WebPの画像を選んでください。");
  if (!file.size) throw new Error("空のファイルです。別の画像を選んでください。");
  if (file.size > maxFileBytes) throw new Error("画像は1枚64 MiB以下にしてください。");
}

function validateSelection(files, replaced = null) {
  let bytes = selectedImages().reduce((sum, image) => sum + (image === replaced ? 0 : image.file.size), 0);
  for (const file of files) {
    validateFile(file);
    bytes += file.size;
  }
  if (bytes > maxTotalBytes) throw new Error("素材画像の合計を256 MiB以下にしてください。");
}

function dispose(image) {
  if (image?.url) URL.revokeObjectURL(image.url);
}

// Keep only small previews decoded in the browser. Rendering uses the original files.
async function makePreview(file, maxEdge) {
  const sourceURL = URL.createObjectURL(file);
  const original = new Image();
  original.src = sourceURL;
  try {
    try {
      await original.decode();
    } catch {
      throw new Error("画像を読み込めません。ファイルを確認してください。");
    }
    const width = original.naturalWidth;
    const height = original.naturalHeight;
    if (width * height > maxPixels) throw new Error("画像は1枚4,000万画素以下にしてください。");
    const factor = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * factor));
    canvas.height = Math.max(1, Math.round(height * factor));
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(original, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!thumb) throw new Error("プレビューを作成できませんでした。");
    return { width, height, url: URL.createObjectURL(thumb) };
  } finally {
    original.removeAttribute("src");
    URL.revokeObjectURL(sourceURL);
  }
}

function queuePreview(image, maxEdge, refresh) {
  // Reserve the position when selected, so decoding cannot change the playback order.
  decodeQueue = decodeQueue.then(async () => {
    if (!selectedImages().includes(image)) return;
    try {
      const preview = await makePreview(image.file, maxEdge);
      if (!selectedImages().includes(image)) return dispose(preview);
      Object.assign(image, preview);
    } catch (error) {
      if (!selectedImages().includes(image)) return;
      image.error = error.message;
    }
    refresh();
    updateControls();
    reportReady();
  });
}

function updateEndpoint(key) {
  const asset = endpoints[key];
  const fileInfo = byId("info-" + key);
  const preview = byId("preview-" + key);
  const input = byId("file-" + key);
  const hasPreview = Boolean(asset?.url);
  byId("zone-" + key).classList.toggle("has-image", hasPreview);
  preview.hidden = !hasPreview;
  if (hasPreview) preview.src = asset.url;
  else preview.removeAttribute("src");
  let text = "JPEG / PNG / WebP";
  if (asset) text = asset.error || (!hasPreview ? "画像を確認中…" : asset.file.name + "　·　" + asset.width + " × " + asset.height);
  fileInfo.textContent = text;
  fileInfo.title = text;
  fileInfo.classList.toggle("error", Boolean(asset?.error));
  input.setAttribute("aria-invalid", String(Boolean(asset?.error)));
}

function chooseEndpoint(key, file) {
  if (busy || !file) return;
  const previous = endpoints[key];
  try {
    validateSelection([file], previous);
  } catch (error) {
    report(error.message + (previous?.url ? " 選択済みの画像を保持しました。" : ""), true);
    return;
  }
  dispose(previous);
  const image = { file };
  endpoints[key] = image;
  updateEndpoint(key);
  updateControls();
  reportReady();
  queuePreview(image, 960, () => updateEndpoint(key));
}

for (const key of ["a", "b"]) {
  const input = byId("file-" + key);
  const zone = byId("zone-" + key);
  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = "";
    chooseEndpoint(key, file);
  });
  zone.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (!busy) zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    if (busy) return;
    if (event.dataTransfer.files.length !== 1) return report("開始・終了の欄には画像を1枚ずつドロップしてください。", true);
    chooseEndpoint(key, event.dataTransfer.files[0]);
  });
}
for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}

function createMiddleRow(image) {
  const row = document.createElement("li");
  row.className = "middle-item";
  // Only fixed markup goes into this template; filenames are assigned using textContent.
  row.innerHTML = '<b class="middle-num"></b><span class="thumb"><img alt="" hidden></span><div><span class="middle-name"></span><span class="middle-detail"></span></div><div class="middle-actions"><button type="button" data-action="up">↑</button><button type="button" data-action="down">↓</button><button type="button" data-action="remove">削除</button></div>';
  row.querySelector(".middle-name").textContent = image.file.name;
  for (const button of row.querySelectorAll("button")) {
    button.addEventListener("click", () => editMiddle(image, button.dataset.action));
  }
  return row;
}

function updateMiddleRow(image, index) {
  const row = image.row;
  const number = String(index + 1);
  row.querySelector(".middle-num").textContent = number;
  const thumb = row.querySelector("img");
  thumb.hidden = !image.url;
  if (image.url && thumb.getAttribute("src") !== image.url) thumb.src = image.url;
  const detail = row.querySelector(".middle-detail");
  detail.textContent = image.error || (image.url ? image.width + " × " + image.height : "画像を確認中…");
  detail.classList.toggle("error", Boolean(image.error));
  const actions = { up: "上に移動", down: "下に移動", remove: "削除" };
  for (const button of row.querySelectorAll("button")) {
    const action = button.dataset.action;
    button.disabled = busy || (action === "up" && !index) || (action === "down" && index === middles.length - 1);
    const label = "中間" + number + "「" + image.file.name + "」を" + actions[action];
    button.setAttribute("aria-label", label);
    button.title = label;
  }
}

function syncMiddles() {
  middles.forEach((image, index) => {
    if (middleList.children[index] !== image.row) {
      middleList.insertBefore(image.row, middleList.children[index] || null);
    }
    updateMiddleRow(image, index);
  });
  byId("sequence").textContent = "再生順　" + ["A", ...middles.map((_, i) => "中間" + (i + 1)), "B"].join(" → ");
  updateControls();
}

function editMiddle(image, action) {
  const i = middles.indexOf(image);
  if (busy || i < 0) return;
  if (action === "remove") {
    middles.splice(i, 1);
    image.row.remove();
    dispose(image);
    syncMiddles();
    const next = middles[Math.min(i, middles.length - 1)];
    (next?.row.querySelector('[data-action="remove"]') || middleInput).focus();
    setMiddleInfo(image.file.name + " を中間画像から外しました。");
  } else {
    const target = i + (action === "up" ? -1 : 1);
    if (target < 0 || target >= middles.length) return;
    [middles[i], middles[target]] = [middles[target], middles[i]];
    syncMiddles();
    const sameAction = image.row.querySelector('[data-action="' + action + '"]');
    (sameAction.disabled ? image.row.querySelector("button:not(:disabled)") : sameAction).focus();
    setMiddleInfo(image.file.name + " を中間" + (target + 1) + "に移動しました。");
  }
  reportReady();
}

middleInput.addEventListener("change", () => {
  const files = Array.from(middleInput.files);
  middleInput.value = "";
  if (busy || !files.length) return;
  try {
    if (middles.length + files.length > maxMiddle) throw new Error("中間画像は10枚までです。残り" + (maxMiddle - middles.length) + "枚以内で選んでください。");
    validateSelection(files);
  } catch (error) {
    setMiddleInfo(error.message, true);
    return;
  }
  for (const file of files) {
    const image = { file };
    image.row = createMiddleRow(image);
    middles.push(image);
    queuePreview(image, 220, () => updateMiddleRow(image, middles.indexOf(image)));
  }
  syncMiddles();
  setMiddleInfo(middles.length === 1 ? "中間画像をもう1枚追加すると順番を変更できます。" : "矢印で再生順を変更できます。");
  reportReady();
});

for (const control of [seconds, method, fps]) {
  control.addEventListener("input", () => { updateControls(); reportReady(); });
  control.addEventListener("change", () => { updateControls(); reportReady(); });
}

function setBusy(value) {
  busy = value;
  for (const control of [byId("file-a"), byId("file-b"), seconds, fps, method]) control.disabled = value;
  renderButton.setAttribute("aria-busy", String(value));
  byId("progress-percent").hidden = !value;
  progressBar.hidden = !value;
  progressBar.value = 0;
  byId("progress-percent").textContent = "0%";
  syncMiddles();
}

function showProgress(fraction) {
  if (!busy || !Number.isFinite(fraction)) return;
  const value = Math.max(0, Math.min(1, fraction));
  progressBar.value = value;
  const text = Math.floor(value * 100) + "%";
  if (byId("progress-percent").textContent !== text) byId("progress-percent").textContent = text;
}

function renderError(error) {
  const message = error?.message || "";
  if (/[ぁ-んァ-ヶ一-龯]/.test(message)) return message;
  if (error?.name === "NotSupportedError" || /unsupported|not supported|webcodecs|wasm|webassembly|worker|VideoEncoder/i.test(message)) {
    return "このブラウザでは選択した設定でMP4を書き出せません。最新版のSafari・Chrome・Edgeでお試しください。";
  }
  if (error?.name === "QuotaExceededError" || /memory|allocation/i.test(message)) {
    return "端末のメモリが不足しています。画像を小さくするか、長さ・フレームレートを下げて再度お試しください。";
  }
  if (error?.name === "NetworkError" || /failed to fetch|load failed|module script/i.test(message)) {
    return "動画処理に必要なプログラムを読み込めませんでした。ページを再読み込みしてもう一度お試しください。";
  }
  if (error?.name === "SecurityError" || error?.name === "NotAllowedError") {
    return "ブラウザが動画処理を制限しています。HTTPSでページを開き直し、再度お試しください。";
  }
  return "動画を書き出せませんでした。設定を見直してもう一度試すか、別のブラウザでお試しください。";
}

function showResult(blob, summary) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("MP4データを取得できませんでした。");
  const previousURL = resultURL;
  resultURL = URL.createObjectURL(blob);
  const video = byId("video");
  video.pause();
  video.src = resultURL;
  video.load();
  const saveLink = byId("download");
  const now = new Date();
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0")).join("");
  saveLink.download = "KazeX-Morph-" + stamp + ".mp4";
  saveLink.href = resultURL;
  byId("result-meta").textContent = summary;
  byId("preview-note").hidden = true;
  byId("result").hidden = false;
  if (previousURL) URL.revokeObjectURL(previousURL);
}

byId("video").addEventListener("error", () => {
  if (resultURL) byId("preview-note").hidden = false;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (renderButton.disabled || !form.reportValidity()) return;
  const files = selectedImages().map((image) => image.file);
  const t = timing();
  const mode = method.value;
  const summary = files.map((file) => file.name).join(" → ") + "　·　" + method.selectedOptions[0].textContent +
    "　·　" + secondsText(t.actual) + "秒 / " + t.rate + " fps / " + t.frames + "フレーム";
  setBusy(true);
  report("この端末でモーフ動画を書き出し中…");
  try {
    const blob = await renderVideo({ files, method: mode, fps: t.rate, frames: t.frames, onProgress: showProgress });
    showResult(blob, summary);
    report("書き出しが完了しました。下のプレビューで再生・保存できます。");
  } catch (error) {
    report(renderError(error), true);
  } finally {
    setBusy(false);
  }
});
updateControls();

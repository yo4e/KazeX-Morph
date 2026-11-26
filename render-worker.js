import {createEncoder} from "./encoder.js";
import {prepareTransition} from "./engine.js";

let receiveImage;
function nextImage(index) {
  return new Promise((resolve) => {
    receiveImage = resolve;
    self.postMessage({type: "image", index});
  });
}

async function render(params) {
  const {width, height, count, method, fps, frames} = params;
  let first = params.pixels;
  params.pixels = null;
  const encoder = await createEncoder(width, height, fps, frames);
  let start = 0;
  let lastProgress = 0;
  try {
    await encoder.add(first);
    for (let index = 1; index < count; index++) {
      const last = await nextImage(index);
      const end = Math.round(index * (frames - 1) / (count - 1));
      if (end > start + 1) {
        const transition = await prepareTransition(first, last, width, height, method);
        try {
          for (let frame = start + 1; frame < end; frame++) {
            const p = (frame - start) / (end - start);
            const eased = p * p * (3 - 2 * p);
            await encoder.add(transition.frame(eased));
            if (performance.now() - lastProgress > 100) {
              self.postMessage({type: "progress", fraction: 0.04 + 0.93 * (frame + 1) / frames});
              lastProgress = performance.now();
            }
          }
        } finally {
          transition.close();
        }
      }
      await encoder.add(last);
      first = last;
      start = end;
    }
    self.postMessage({type: "progress", fraction: 0.99});
    const video = await encoder.finish();
    self.postMessage({type: "done", video});
  } finally {
    encoder.close();
  }
}

self.onmessage = async ({data}) => {
  if (data.type === "image" && receiveImage) {
    const resolve = receiveImage;
    receiveImage = undefined;
    resolve(data.pixels);
  } else if (data.type === "start") {
    try {
      await render(data);
    } catch (error) {
      self.postMessage({type: "error", message: error.message || "動画を書き出せませんでした。"});
    }
  }
};

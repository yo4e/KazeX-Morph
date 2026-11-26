// Release check for a running local server or a deployed Pages URL.
// Requires Node 18+, FFmpeg, and Playwright Chromium. From the checkout:
// npm install --no-save --package-lock=false playwright-core
// npx playwright-core install chromium
// node tests/smoke.cjs http://127.0.0.1:8000/
// CHROMIUM_PATH and FFMPEG_BIN optionally select existing executables.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main(url) {
  if (!url) throw new Error('Pass the application URL as the first argument.');
  const width = 160, height = 90;
  const colors = [[64, 128, 80], [70, 102, 176], [178, 125, 73], [112, 95, 143]];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'morph-smoke-'));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
    const page = await browser.newPage({acceptDownloads: true});
    await page.goto(url);
    const inputs = [];
    for (const [index, color] of colors.entries()) {
      const data = await page.evaluate(({width, height, color, index}) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(' + color.join(',') + ')';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#292f2b';
        ctx.fillRect(62 + 2 * index, 24, 25, 55);
        return canvas.toDataURL('image/png').split(',')[1];
      }, {width, height, color, index});
      inputs.push({name: 'test-' + index + '.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64')});
    }
    await page.locator('#file-a').setInputFiles(inputs[0]);
    await page.locator('#file-b').setInputFiles(inputs[3]);
    await page.locator('#file-middle').setInputFiles([inputs[2], inputs[1]]);
    await page.locator('#middle-list > li').nth(1).locator('[data-action="up"]').click();
    await page.locator('#fps').selectOption('25');
    await page.locator('#seconds').fill('1.3');
    assert.equal(await page.locator('#frame-count').textContent(), '33');
    await page.locator('#render').click();
    await page.waitForFunction(() => document.querySelector('#download').href.startsWith('blob:') ||
      document.querySelector('#status').classList.contains('error'), null, {timeout: 120000});
    assert.ok((await page.locator('#download').getAttribute('href') || '').startsWith('blob:'),
      await page.locator('#status').textContent());
    const nextDownload = page.waitForEvent('download');
    await page.locator('#download').click();
    const file = path.join(temp, 'export.mp4');
    await (await nextDownload).saveAs(file);

    // Decode every frame without resampling. FFmpeg's showinfo reports source
    // timestamps, frame rate and dimensions independently of the page UI.
    const ffmpeg = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-i', file, '-map', '0:v:0', '-vf', 'showinfo',
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], {maxBuffer: 16 * 1024 * 1024});
    if (ffmpeg.error) throw ffmpeg.error;
    const info = ffmpeg.stderr.toString();
    assert.equal(ffmpeg.status, 0, info);
    assert.match(info, /Duration: 00:00:01\.32,/);
    assert.match(info, /Video: h264\b/);
    assert.match(info, /frame_rate: 25\/1\b/);
    assert.match(info, /\bs:160x90\b/);
    const times = Array.from(info.matchAll(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:([\d.]+)/g));
    const stride = width * height * 3;
    assert.equal(ffmpeg.stdout.length, 33 * stride);
    assert.equal(times.length, 33);
    times.forEach(([, frame, seconds], i) => {
      assert.equal(Number(frame), i);
      assert.ok(Math.abs(Number(seconds) - i / 25) < 0.0001, 'Frame ' + frame + ' has unexpected timing');
    });
    for (const [i, frame] of [0, 11, 21, 32].entries()) {
      const pixel = frame * stride + (10 * width + 10) * 3;
      const actual = Array.from(ffmpeg.stdout.subarray(pixel, pixel + 3));
      assert.ok(actual.every((v, c) => Math.abs(v - colors[i][c]) < 12),
        'Frame ' + frame + ' expected RGB ' + colors[i] + ', got ' + actual);
    }
    console.log('PASS: H.264, 160×90, 33 decoded frames at 25 fps, 1.32 s, all four sources in order.');
  } finally {
    if (browser) await browser.close();
    await fs.rm(temp, {recursive: true, force: true});
  }
}

main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });

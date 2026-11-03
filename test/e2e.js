'use strict';
// Headless end-to-end test of the browser client.
// Verifies: page loads, WebCodecs decoder configures, frames reach the canvas,
// and the HUD reports a sane fps/latency. Also writes a screenshot.
const puppeteer = require('puppeteer-core');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.argv[2] || 'https://127.0.0.1:8443/';
const WAIT = Number(process.argv[3] || 7000);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: [
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,900',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise((r) => setTimeout(r, WAIT));

  const info = await page.evaluate(() => {
    const hud = document.getElementById('hud');
    const canvas = document.getElementById('screen');
    const c = canvas.getContext('2d');
    // sample the canvas to prove something was actually painted
    let nonBlack = 0;
    try {
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4 * 997) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
      }
    } catch (e) { nonBlack = -1; }
    return {
      hasWebCodecs: typeof window.VideoDecoder === 'function',
      secure: window.isSecureContext,
      canvas: canvas.width + 'x' + canvas.height,
      hud: hud ? hud.innerText : null,
      centerHidden: document.getElementById('center').classList.contains('hidden'),
      nonBlackSamples: nonBlack,
      diag: document.getElementById('diag').textContent,
    };
  });

  await page.screenshot({ path: path.join(__dirname, 'render.png') });

  console.log('=== 客户端运行结果 ===');
  console.log('WebCodecs      :', info.hasWebCodecs);
  console.log('安全上下文     :', info.secure);
  console.log('Canvas 尺寸    :', info.canvas);
  console.log('已绘制非黑像素 :', info.nonBlackSamples);
  console.log('遮罩已隐藏     :', info.centerHidden);
  console.log('--- HUD ---');
  console.log(info.hud || '(空)');
  console.log('--- 诊断 ---');
  console.log(info.diag);
  if (errors.length) {
    console.log('--- 页面错误 ---');
    errors.forEach((e) => console.log(e));
  }
  const interesting = logs.filter((l) => /error|warn|fail|decod/i.test(l));
  if (interesting.length) {
    console.log('--- 相关日志 ---');
    interesting.slice(0, 12).forEach((l) => console.log(l));
  }

  await browser.close();
})().catch((e) => { console.error('测试失败:', e.message); process.exit(1); });

'use strict';
// Runs the client in Playwright's WebKit engine — a much closer proxy for
// iPad Safari than Chromium. Reports WebCodecs availability and whether
// frames actually reach the canvas.
const { webkit } = require('playwright');

const URL = process.argv[2] || 'https://127.0.0.1:8443/';
const WAIT = Number(process.argv[3] || 8000);

(async () => {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 1024 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, WAIT));

  const info = await page.evaluate(() => {
    const canvas = document.getElementById('screen');
    let nonBlack = 0;
    try {
      const c = canvas.getContext('2d');
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4 * 997) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
      }
    } catch (e) { nonBlack = -1; }
    return {
      videoDecoder: typeof window.VideoDecoder,
      secure: window.isSecureContext,
      canvas: `${canvas.width}x${canvas.height}`,
      nonBlack,
      hud: (document.getElementById('hud') || {}).innerText || '',
      diag: (document.getElementById('diag') || {}).textContent || '',
      centerHidden: document.getElementById('center').classList.contains('hidden'),
      ua: navigator.userAgent,
      mjpeg: (() => {
        const img = document.getElementById('mjpeg');
        if (!img) return null;
        return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete };
      })(),
    };
  });

  try {
    await page.screenshot({ path: 'webkit.png', timeout: 5000 });
  } catch {
    // the MJPEG <img> never finishes "loading", so the page never goes idle
    console.log('(截图跳过：MJPEG 流持续加载中)');
  }

  console.log('=== WebKit 引擎测试 ===');
  console.log('UA             :', info.ua);
  console.log('VideoDecoder   :', info.videoDecoder);
  console.log('安全上下文     :', info.secure);
  console.log('Canvas         :', info.canvas);
  console.log('非黑像素采样   :', info.nonBlack);
  console.log('遮罩已隐藏     :', info.centerHidden);
  console.log('MJPEG 兜底     :', info.mjpeg ? `已加载 ${info.mjpeg.naturalWidth}x${info.mjpeg.naturalHeight}` : '未启用');
  console.log('--- HUD ---');
  console.log(info.hud || '(空)');
  console.log('--- 诊断 ---');
  console.log(info.diag);
  if (logs.length) {
    console.log('--- 日志 ---');
    logs.slice(0, 15).forEach((l) => console.log(l));
  }

  await browser.close();
})().catch((e) => { console.error('WebKit 测试失败:', e.message); process.exit(1); });

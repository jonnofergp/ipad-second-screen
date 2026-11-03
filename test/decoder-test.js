'use strict';
// Targeted checks for the client's decoder plumbing:
//   1. annexbToAvcc() produces correct length-prefixed NALs
//   2. the forced ?fmt=avcc path actually decodes a live stream
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'https://127.0.0.1:8443/';

async function open(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return { page, errs };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--ignore-certificate-errors', '--no-sandbox', '--window-size=1280,720'],
  });

  // ---- 1. conversion unit test -------------------------------------------
  let { page } = await open(browser, BASE);
  await new Promise((r) => setTimeout(r, 1500));

  const conv = await page.evaluate(() => {
    // one 4-byte start code NAL (3 bytes) + one 3-byte start code NAL (2 bytes)
    const input = new Uint8Array([
      0, 0, 0, 1, 0x67, 0xaa, 0xbb,
      0, 0, 1, 0x68, 0xcc,
    ]);
    const out = Array.from(window.annexbToAvcc(input));
    return out;
  });
  const expected = [0, 0, 0, 3, 0x67, 0xaa, 0xbb, 0, 0, 0, 2, 0x68, 0xcc];
  const ok = JSON.stringify(conv) === JSON.stringify(expected);
  console.log('annexbToAvcc 单元测试 :', ok ? '✅ 通过' : '❌ 失败');
  if (!ok) {
    console.log('  got     :', conv.map((n) => n.toString(16)).join(' '));
    console.log('  expected:', expected.map((n) => n.toString(16)).join(' '));
  }
  await page.close();

  // ---- 2. forced AVCC end-to-end ----------------------------------------
  ({ page } = await open(browser, BASE + '?fmt=avcc'));
  await new Promise((r) => setTimeout(r, 7000));

  const res = await page.evaluate(() => {
    const canvas = document.getElementById('screen');
    const c = canvas.getContext('2d');
    let nonBlack = 0;
    try {
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4 * 997) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
      }
    } catch { nonBlack = -1; }
    return { hud: document.getElementById('hud').innerText, nonBlack, hidden: document.getElementById('center').classList.contains('hidden') };
  });

  console.log('');
  console.log('强制 AVCC 解码      :', res.nonBlack > 50 ? '✅ 有画面' : '❌ 无画面', `(非黑采样 ${res.nonBlack})`);
  console.log('--- HUD ---');
  console.log(res.hud);

  await browser.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });

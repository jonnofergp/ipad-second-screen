'use strict';
// Capture the live stream to a raw Annex-B file so we can validate it offline.
// Starts writing at the first IDR and stops on a whole access-unit boundary,
// so the resulting file is self-consistent.
const fs = require('fs');
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8080/';
const outPath = process.argv[3] || 'capture.h264';
const wantFrames = Number(process.argv[4] || 120);

const out = fs.createWriteStream(outPath);
let frames = 0, keys = 0, bytes = 0, started = false, done = false;
const ws = new WebSocket(url);

ws.on('message', (data, isBinary) => {
  if (!isBinary || done) return;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint8(0) !== 0x01) return;
  const isKey = dv.getUint8(13) === 1;
  const payload = data.subarray(14);

  if (!started) {
    if (!isKey) return;          // wait for a clean entry point
    started = true;
    console.log('[cap] starting at first IDR');
  }

  out.write(payload);
  frames++;
  if (isKey) keys++;
  bytes += payload.byteLength;

  if (frames >= wantFrames) {
    done = true;
    out.end(() => {
      console.log(`[cap] frames=${frames} keys=${keys} bytes=${bytes} -> ${outPath}`);
      process.exit(0);
    });
  }
});

ws.on('open', () => console.log('[cap] connected'));
ws.on('error', (e) => { console.error('[cap] error', e.message); process.exit(1); });
setTimeout(() => { console.error('[cap] timeout'); process.exit(2); }, 30000);


'use strict';
// Headless verification: connect like the iPad would and validate the stream.
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8080/';
const DURATION = Number(process.argv[3] || 5000);

const stats = { frames: 0, keys: 0, bytes: 0, firstTs: 0, lastTs: 0, sizes: [], errors: [] };
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('[test] connected to', url);
  ws.send(JSON.stringify({ t: 'time', c0: Date.now() }));
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const m = JSON.parse(data.toString());
    console.log('[test] control:', JSON.stringify(m));
    return;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint8(0) !== 0x01) { stats.errors.push('bad magic'); return; }
  const seq = dv.getUint32(1, true);
  const ts = dv.getFloat64(5, true);
  const isKey = dv.getUint8(13) === 1;
  const payload = data.subarray(14);

  // sanity: Annex-B start code at the head
  if (!(payload[0] === 0 && payload[1] === 0 && (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1)))) {
    stats.errors.push(`frame ${seq}: bad start code ${payload[0].toString(16)} ${payload[1].toString(16)} ${payload[2].toString(16)}`);
  }
  if (!stats.firstTs) stats.firstTs = ts;
  stats.lastTs = ts;
  stats.frames++;
  stats.bytes += payload.byteLength;
  if (isKey) stats.keys++;
  if (stats.sizes.length < 600) stats.sizes.push(payload.byteLength);
});

ws.on('error', (e) => { console.log('[test] error:', e.message); });

setTimeout(() => {
  const dur = (stats.lastTs - stats.firstTs) / 1000;
  const avg = stats.sizes.length ? stats.sizes.reduce((a, b) => a + b, 0) / stats.sizes.length : 0;
  console.log('\\n=== 结果 ===');
  console.log('帧数        :', stats.frames);
  console.log('关键帧      :', stats.keys);
  console.log('时长        :', dur.toFixed(2), 's');
  console.log('实测帧率    :', dur > 0 ? (stats.frames / dur).toFixed(1) : 'n/a', 'fps');
  console.log('平均帧大小  :', avg.toFixed(0), 'bytes');
  console.log('总码率      :', dur > 0 ? ((stats.bytes * 8) / dur / 1e6).toFixed(1) : 'n/a', 'Mbps');
  console.log('错误        :', stats.errors.length ? stats.errors.slice(0, 5) : '无');
  process.exit(0);
}, DURATION);

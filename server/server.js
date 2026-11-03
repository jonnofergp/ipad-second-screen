'use strict';

/**
 * ipad-second-screen
 * ------------------
 * Captures the Windows desktop with Desktop Duplication (ffmpeg `ddagrab`),
 * encodes it with NVENC, and pushes raw Annex-B H.264 to browsers over
 * WebSocket. The iPad decodes it with WebCodecs and paints it onto a canvas.
 *
 * Two listeners:
 *   HTTP  :8080  -> page only, works everywhere, no WebCodecs
 *   HTTPS :8443  -> page + stream, required for WebCodecs (secure context)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const TMP_DIR = path.join(ROOT, 'tmp');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.TLS_PORT || 8443);

// Configuration precedence: built-in defaults < config.json < environment.
// config.json lives next to this file so start.bat needs no environment setup.
let FILE_CFG = {};
try {
  FILE_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {
  FILE_CFG = {};
}

const CONFIG = {
  fps: Number(process.env.FPS ?? FILE_CFG.fps ?? 60),
  bitrateMbps: Number(process.env.BITRATE ?? FILE_CFG.bitrateMbps ?? 40),   // cap (maxrate)
  quality: Number(process.env.QUALITY ?? FILE_CFG.quality ?? 21),            // NVENC cq
  preset: process.env.PRESET ?? FILE_CFG.preset ?? 'p6',
  tune: process.env.TUNE ?? FILE_CFG.tune ?? 'hq',
  gopSeconds: 1,
  // null = whole desktop / primary output; 1,2,... = a specific display
  // (output_idx of the virtual display makes this a true second screen)
  outputIdx: process.env.OUTPUT != null
    ? Number(process.env.OUTPUT)
    : (FILE_CFG.outputIdx != null ? Number(FILE_CFG.outputIdx) : null),
  // Width of the captured display, used to stop MJPEG from upscaling.
  captureWidth: Number(FILE_CFG.captureWidth ?? 0) || 0,
  // MJPEG is downscaled to this width; an old tablet decodes 1600px JPEGs too
  // slowly and falls behind, which is what makes the picture drift late.
  mjpegMaxWidth: Number(process.env.MJPEG_MAX_WIDTH ?? FILE_CFG.mjpegMaxWidth ?? 1280),
};

function jpegHash(buf) {
  // FNV-1a, 32-bit. Enough to spot an identical frame.
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// ffmpeg discovery
// ---------------------------------------------------------------------------

function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const vendor = path.join(ROOT, 'vendor');
  if (!fs.existsSync(vendor)) throw new Error('vendor/ missing; run bootstrap first');
  const stack = [vendor];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === 'ffmpeg.exe') return full;
    }
  }
  throw new Error('ffmpeg.exe not found under vendor/');
}

const FFMPEG = findFfmpeg();

// ---------------------------------------------------------------------------
// Annex-B splitter: turns the ffmpeg byte stream into access units
// ---------------------------------------------------------------------------

const NAL_TYPE_SLICE = 1;
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_AUD = 9;

class AnnexBSplitter {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.buf = Buffer.alloc(0);
    this.pending = [];       // NALs of the access unit being assembled
    this.pendingHasSlice = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this._findStartCode(0);
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      const next = this._findStartCode(start + 3);
      if (next < 0) {
        // keep from this start code onward for the next chunk
        this.buf = this.buf.subarray(start);
        return;
      }
      const nal = this.buf.subarray(start, next);
      this._onNal(nal);
      this.buf = this.buf.subarray(next);
    }
  }

  _findStartCode(from) {
    const b = this.buf;
    for (let i = from; i + 3 <= b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        return (i > 0 && b[i - 1] === 0) ? i - 1 : i;
      }
    }
    return -1;
  }

  _onNal(raw) {
    const sc = (raw[0] === 0 && raw[1] === 0 && raw[2] === 0) ? 4 : 3;
    if (raw.length <= sc) return;
    const type = raw[sc] & 0x1f;

    // NVENC emits filler payloads under CBR to pad the target bitrate.
    // They carry no picture data and only waste Wi-Fi bandwidth.
    if (type === 12) return;

    const isSlice = type === NAL_TYPE_SLICE || type === NAL_TYPE_IDR;

    if (isSlice && this.pendingHasSlice) {
      // Emit everything up to and including the last slice. Anything queued
      // after it (SPS/PPS/SEI of the *next* picture) is carried forward, so
      // every access unit we hand out ends exactly on its own picture.
      let lastVcl = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const n = this.pending[i];
        const s = (n[0] === 0 && n[1] === 0 && n[2] === 0) ? 4 : 3;
        const t = n[s] & 0x1f;
        if (t === NAL_TYPE_SLICE || t === NAL_TYPE_IDR) lastVcl = i;
      }
      const emit = this.pending.slice(0, lastVcl + 1);
      const carry = this.pending.slice(lastVcl + 1);
      this.pending = carry;
      this.pendingHasSlice = false;
      this._emit(emit);
    }

    this.pending.push(raw);
    if (isSlice) this.pendingHasSlice = true;
  }

  _emit(parts) {
    if (!parts.length) return;

    let isKey = false;
    let sps = null;
    let pps = null;
    for (const nal of parts) {
      const sc = (nal[0] === 0 && nal[1] === 0 && nal[2] === 0) ? 4 : 3;
      const t = nal[sc] & 0x1f;
      if (t === NAL_TYPE_IDR) isKey = true;
      else if (t === NAL_TYPE_SPS) sps = nal.subarray(sc);        // full NAL, header included
      else if (t === NAL_TYPE_PPS) pps = nal.subarray(sc);
    }
    this.onAccessUnit(Buffer.concat(parts), isKey, sps, pps);
  }
}

// ---------------------------------------------------------------------------
// ffmpeg capture pipeline
// ---------------------------------------------------------------------------

function buildArgs(cfg) {
  const gop = Math.max(1, Math.round(cfg.fps * (cfg.gopSeconds || 1)));
  const grab = cfg.outputIdx === null || cfg.outputIdx === undefined
    ? `ddagrab=framerate=${cfg.fps}`
    : `ddagrab=framerate=${cfg.fps}:output_idx=${cfg.outputIdx}`;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', grab,
    '-an',
    '-c:v', 'h264_nvenc',
    '-preset', cfg.preset,
    '-tune', cfg.tune,
    // VBR + constant-quality: a still desktop costs ~2 Mbps instead of burning
    // the full CBR budget on filler NALs, while movement can still spike.
    '-rc', 'vbr',
    '-cq', String(cfg.quality),
    '-b:v', `${cfg.bitrateMbps}M`,
    '-maxrate', `${cfg.bitrateMbps}M`,
    '-bufsize', `${Math.max(1, Math.round(cfg.bitrateMbps / 3))}M`,
    '-g', String(gop),
    '-bf', '0',
    '-profile:v', 'high',
    '-flush_packets', '1',
    '-f', 'h264',
    'pipe:1',
  ];
}

class Capture {
  constructor() {
    this.proc = null;
    this.splitter = null;
    this.seq = 0;
    this.codec = null;
    this.width = 1920;
    this.height = 1080;
    this.clients = new Set();
    this.restartTimer = null;
    this.idleTimer = null;
    this.lastError = '';
  }

  start() {
    if (this.proc) return;
    this.stop(true);
    const args = buildArgs(CONFIG);
    console.log('[ffmpeg]', FFMPEG);
    console.log('[ffmpeg]', args.join(' '));

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    this.proc = proc;

    this.splitter = new AnnexBSplitter((payload, isKey, sps, pps) => {
      if (!this.codec && sps && pps) {
        const spsPayload = sps.subarray(1);   // strip the NAL header byte
        this.codec = codecStringFromSps(spsPayload);
        const dim = parseSpsDimensions(spsPayload);
        if (dim) { this.width = dim.width; this.height = dim.height; }
        this.spsB64 = sps.toString('base64');
        this.ppsB64 = pps.toString('base64');
        const meta = JSON.stringify({
          t: 'codec', codec: this.codec,
          width: this.width, height: this.height,
          sps: this.spsB64, pps: this.ppsB64,
          ...CONFIG,
        });
        for (const ws of this.clients) {
          if (ws.readyState === 1) ws.send(meta);
        }
        console.log(`[capture] codec=${this.codec} ${this.width}x${this.height}`);
      }
      const seq = this.seq++;
      const ts = Date.now();
      const header = Buffer.allocUnsafe(14);
      header[0] = 0x01;
      header.writeUInt32LE(seq, 1);
      header.writeDoubleLE(ts, 5);
      header[13] = isKey ? 1 : 0;
      const frame = Buffer.concat([header, payload]);
      for (const ws of this.clients) {
        if (ws.readyState === 1) ws.send(frame, { binary: true });
      }
    });

    proc.stdout.on('data', (d) => this.splitter.push(d));

    let errBuf = '';
    proc.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
    });

    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.lastError = errBuf.trim().split('\n').slice(-3).join(' | ');
      console.log(`[ffmpeg] exited code=${code} ${this.lastError}`);
      if (this.clients.size > 0) {
        this.restartTimer = setTimeout(() => this.start(), 1500);
      }
    });

    proc.on('error', (e) => {
      this.lastError = e.message;
      console.log('[ffmpeg] spawn error:', e.message);
    });
  }

  stop(silent) {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch {}
      this.proc = null;
    }
    this.seq = 0;
    this.codec = null;
    setTimeout(() => { this.stopping = false; }, 50);
    if (!silent) console.log('[ffmpeg] stopped');
  }

  add(ws) {
    this.clients.add(ws);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.proc) this.start();
    if (this.codec) ws.send(JSON.stringify({
      t: 'codec', codec: this.codec, width: this.width, height: this.height,
      sps: this.spsB64, pps: this.ppsB64, ...CONFIG,
    }));
    else ws.send(JSON.stringify({ t: 'waiting', ...CONFIG }));
  }

  remove(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => {
        if (this.clients.size === 0) {
          console.log('[capture] no viewers, stopping encoder');
          this.stop();
        }
      }, 15000);
    }
  }
}

function codecStringFromSps(sps) {
  // sps = NAL payload after the 1-byte header
  const profile = sps[0], constraints = sps[1], level = sps[2];
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
}

/**
 * Minimal SPS parser (ITU-T H.264 7.3.2.1.1) — only enough to recover the
 * cropped display size, so the iPad allocates the decoder correctly.
 */
function parseSpsDimensions(sps) {
  try {
    let pos = 0;
    const readBit = () => {
      const byte = sps[pos >> 3];
      const bit = (byte >> (7 - (pos & 7))) & 1;
      pos++;
      return bit;
    };
    const readBits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | readBit();
      return v >>> 0;
    };
    const readUE = () => {
      let zeros = 0;
      while (readBit() === 0 && zeros < 32) zeros++;
      if (zeros === 0) return 0;
      return ((1 << zeros) - 1) + readBits(zeros);
    };
    const readSE = () => {
      const v = readUE();
      return (v & 1) ? (v + 1) / 2 : -(v / 2);
    };

    const profileIdc = readBits(8);   // already known, keep position aligned
    readBits(16);                     // constraint flags + level

    readUE();                         // seq_parameter_set_id

    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = readUE();
      if (chromaFormatIdc === 3) readBits(1);
      readUE();                       // bit_depth_luma_minus8
      readUE();                       // bit_depth_chroma_minus8
      readBits(1);                    // qpprime_y_zero_transform_bypass_flag
      if (readBits(1)) {              // seq_scaling_matrix_present_flag
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (readBits(1)) {
            const size = i < 6 ? 16 : 64;
            let last = 8, next = 8;
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + readSE() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }

    readUE();                         // log2_max_frame_num_minus4
    const pocType = readUE();
    if (pocType === 0) {
      readUE();
    } else if (pocType === 1) {
      readBits(1);
      readSE();
      readSE();
      const n = readUE();
      for (let i = 0; i < n; i++) readSE();
    }

    readUE();                         // max_num_ref_frames
    readBits(1);                      // gaps_in_frame_num_value_allowed_flag

    const widthInMbs = readUE() + 1;
    const heightInMapUnits = readUE() + 1;
    const frameMbsOnly = readBits(1);
    if (!frameMbsOnly) readBits(1);
    readBits(1);                      // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (readBits(1)) {
      cropLeft = readUE();
      cropRight = readUE();
      cropTop = readUE();
      cropBottom = readUE();
    }

    const chromaArrayType = chromaFormatIdc === 0 ? 0 : chromaFormatIdc;
    const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;

    let width = widthInMbs * 16;
    let height = heightInMapUnits * 16 * (2 - frameMbsOnly);
    if (chromaArrayType !== 0) {
      width -= (cropLeft + cropRight) * subWidthC;
      height -= (cropTop + cropBottom) * subHeightC * (2 - frameMbsOnly);
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MJPEG fallback — works in literally any browser, including old iPadOS
// Safari without WebCodecs. Higher bandwidth, lower frame rate, but it always
// renders something instead of a "not supported" message.
// ---------------------------------------------------------------------------

const MJPEG = {
  fps: Number(process.env.MJPEG_FPS ?? (FILE_CFG.mjpeg && FILE_CFG.mjpeg.fps) ?? 12),
  width: Number(process.env.MJPEG_WIDTH ?? (FILE_CFG.mjpeg && FILE_CFG.mjpeg.width) ?? 1366),
  quality: Number(process.env.MJPEG_QUALITY ?? (FILE_CFG.mjpeg && FILE_CFG.mjpeg.quality) ?? 8),
};

class MjpegCapture {
  constructor() {
    this.proc = null;
    this.clients = new Set();
    this.idleTimer = null;
  }

  start(opts) {
    const cfg = opts || MJPEG;
    if (this.proc) return;
    const scale = `hwdownload,format=bgra,scale=${cfg.width}:-2:flags=lanczos`;
    // Honour the same display selection as the WebCodecs pipeline, otherwise
    // the MJPEG path silently keeps mirroring the whole desktop.
    const grab = (CONFIG.outputIdx === null || CONFIG.outputIdx === undefined)
      ? `ddagrab=framerate=${cfg.fps}`
      : `ddagrab=framerate=${cfg.fps}:output_idx=${CONFIG.outputIdx}`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', grab,
      '-vf', scale,
      '-c:v', 'mjpeg',
      '-q:v', String(cfg.quality),
      '-f', 'mjpeg',
      'pipe:1',
    ];
    this.opts = { width: cfg.width, fps: cfg.fps, quality: cfg.quality };
    console.log('[mjpeg]', args.join(' '));
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    this.proc = proc;

    let errBuf = '';
    proc.stderr.on('data', (d) => {
      errBuf = (errBuf + d.toString()).slice(-1500);
      if (d.toString().trim()) console.log('[mjpeg:err]', d.toString().trim());
    });

    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) { buf = Buffer.alloc(0); return; }
        const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) { buf = buf.subarray(start); return; }
        const jpeg = buf.subarray(start, end + 2);
        buf = buf.subarray(end + 2);
        this.broadcast(jpeg);
      }
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (code !== 0 && this.clients.size > 0) console.log('[mjpeg] exited', code, errBuf.trim().split('\n').slice(-2).join(' | '));
    });
    proc.on('error', () => { this.proc = null; });
  }

  broadcast(jpeg) {
    // Skip identical consecutive frames. A secondary display is static most of
    // the time, and re-sending the same JPEG 12 times a second makes an old
    // tablet fall behind on decoding, which shows up as growing latency.
    if (this.dedup !== false) {
      const hash = jpegHash(jpeg);
      const now = Date.now();
      if (hash === this.lastHash && now - (this.lastSentAt || 0) < 1000) {
        this.skipped = (this.skipped || 0) + 1;
        return;
      }
      this.lastHash = hash;
      this.lastSentAt = now;
    }
    this.lastJpeg = jpeg;

    for (const res of this.clients) {
      try {
        // Back-pressure: if this viewer still has a backlog queued, drop the
        // frame instead of stacking more delay on top.
        if (res.writableLength > 200000) { this.dropped = (this.dropped || 0) + 1; continue; }
        this.writeFrame(res, jpeg);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  writeFrame(res, jpeg) {
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n');
    res.write(jpeg);
    res.write('\r\n');
  }

  add(req, res, opts) {
    const cfg = opts || MJPEG;

    // A new viewer may ask for a different resolution/quality. Restart the
    // encoder whenever the settings change — with a single viewer this is
    // harmless, and it avoids serving the previous viewer's mode.
    if (this.proc && this.opts) {
      const same = this.opts.width === cfg.width && this.opts.fps === cfg.fps && this.opts.quality === cfg.quality;
      if (!same) {
        try { this.proc.kill('SIGKILL'); } catch {}
        this.proc = null;
        this.opts = null;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'close',
      Pragma: 'no-cache',
    });
    this.clients.add(res);
    if (res.socket) res.socket.setNoDelay(true);   // don't let Nagle batch our frames
    // New viewer: give it the current picture right away instead of waiting
    // for the desktop to change.
    if (this.lastJpeg) { try { this.writeFrame(res, this.lastJpeg); } catch {} }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.start(cfg);

    const drop = () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.idleTimer = setTimeout(() => {
          if (this.clients.size === 0 && this.proc) {
            try { this.proc.kill('SIGKILL'); } catch {}
            this.proc = null;
          }
        }, 10000);
      }
    };
    req.on('close', drop);
    req.on('error', drop);
  }
}

const mjpeg = new MjpegCapture();

// ---------------------------------------------------------------------------
// static file serving
// ---------------------------------------------------------------------------

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const MIME = {  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  console.log(`[http] ${req.method} ${req.url} ua="${String(req.headers['user-agent'] || '').slice(0, 70)}"`);
  if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (urlPath === '/mjpeg') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const maxW = CONFIG.mjpegMaxWidth || (CONFIG.captureWidth > 0 ? CONFIG.captureWidth : 2560);
    const opts = {
      width: clampInt(q.get('w'), 640, maxW, Math.min(MJPEG.width, maxW)),
      fps: clampInt(q.get('fps'), 5, 30, MJPEG.fps),
      quality: clampInt(q.get('q'), 2, 20, MJPEG.quality),
    };
    mjpeg.dedup = q.get('dedup') !== '0';
    mjpeg.add(req, res, opts);
    return;
  }
  if (urlPath === '/health') {
    const body = JSON.stringify({
      ok: true,
      codec: capture.codec,
      width: capture.width,
      height: capture.height,
      viewers: capture.clients.size,
      mjpegViewers: mjpeg.clients.size,
      mjpegDropped: mjpeg.dropped || 0,
      mjpegSkipped: mjpeg.skipped || 0,
      encoding: !!capture.proc,
      config: CONFIG,
      lastError: capture.lastError || null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(CLIENT_DIR, rel);
  if (!full.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// TLS certificate (self-signed, cached)
// ---------------------------------------------------------------------------

function loadOrCreateCert() {
  const keyPath = path.join(TMP_DIR, 'key.pem');
  const crtPath = path.join(TMP_DIR, 'cert.pem');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
  }
  const selfsigned = require('selfsigned');
  const lan = lanAddresses();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lan.map((ip) => ({ type: 7, ip })),
  ];
  // Apple rejects TLS certificates whose validity exceeds 825 days (for certs
  // issued after 2019-07-01) — a 10-year self-signed cert makes Safari fail the
  // handshake outright, with no "proceed anyway" option. Keep it under the cap.
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'ipad-second-screen.local' }],
    {
      days: 397,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(crtPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const capture = new Capture();

const httpServer = http.createServer(serveStatic);
const httpsServer = https.createServer(loadOrCreateCert(), serveStatic);

// Surfacing handshake failures makes "the iPad can't open the page" debuggable:
// it shows whether the client rejected our certificate or never arrived.
httpsServer.on('tlsClientError', (err, socket) => {
  console.log(`[tls] handshake failed from ${socket && socket.remoteAddress}: ${err.message}`);
});

for (const [server, label] of [[httpServer, 'http'], [httpsServer, 'https']]) {
  // Log upgrade attempts even when they are rejected, so a browser that never
  // completes the WebSocket handshake is visible in the console.
  server.on('upgrade', (req) => {
    console.log(`[upgrade] ${label} ${req.url} ua="${String(req.headers['user-agent'] || '').slice(0, 70)}"`);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const ua = String(req.headers['user-agent'] || '').slice(0, 120);
    console.log(`[ws] + ${label} ${ua}`);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    capture.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'time') {
        ws.send(JSON.stringify({ t: 'time', c0: msg.c0, s: Date.now() }));
      } else if (msg.t === 'stats') {
        process.stdout.write(
          `\r[stats] fps=${msg.fps} kbps=${msg.kbps} decQueue=${msg.q} dropped=${msg.dropped} latency=${msg.lat}ms   `
        );
      }
    });

    ws.on('close', () => {
      console.log('\n[ws] -');
      capture.remove(ws);
    });
    ws.on('error', () => {});
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  wss.on('close', () => clearInterval(timer));

  server.on('error', (e) => {
    console.error(`[${label}] listen error:`, e.message);
  });
}

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP  http://127.0.0.1:${HTTP_PORT}`);
});
httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  const lan = lanAddresses().filter((ip) => !ip.startsWith('169.254.'));
  const primary = lan.find((ip) => ip.startsWith('192.168.')) || lan[0] || '127.0.0.1';
  const url = `https://${primary}:${HTTPS_PORT}`;

  console.log('');
  console.log('  iPad 副屏已就绪');
  console.log('  ────────────────────────────────────────────');
  console.log(`  在 iPad 的 Safari 里打开:  ${url}`);
  console.log('');
  console.log('  用 iPad 相机扫下面的二维码可直接打开:');
  console.log('');
  try {
    require('qrcode-terminal').generate(url, { small: true }, (q) => console.log(q));
  } catch (e) {
    console.log('  (二维码生成失败，直接用上面的地址)');
  }
  console.log('  首次会提示证书不受信任:');
  console.log('    「显示详细信息」→「访问此网站」→ 输入 iPad 解锁密码');
  console.log('');
  for (const ip of lan) {
    if (ip !== primary) console.log(`  备用地址: https://${ip}:${HTTPS_PORT}`);
  }
  console.log('  ────────────────────────────────────────────');
  console.log('');
});

process.on('SIGINT', () => { capture.stop(); process.exit(0); });
process.on('SIGTERM', () => { capture.stop(); process.exit(0); });

import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 1500);
const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 900);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({
  dest: path.join(os.tmpdir(), 'clipforge-uploads'),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

function parseTime(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) throw new Error('Format waktu tidak valid');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function getDuration(start, end) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s < 0 || e <= s) throw new Error('Waktu OUT harus lebih besar dari IN');
  const d = e - s;
  if (d > MAX_CLIP_SECONDS) throw new Error(`Durasi clip maksimal ${MAX_CLIP_SECONDS / 60} menit`);
  return { start: s, duration: d };
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIP(ip) === 6) {
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
  }
  return true;
}

async function validateRemoteUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL tidak valid'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Hanya URL http/https yang didukung');
  if (!u.hostname) throw new Error('Hostname URL tidak valid');
  const found = await dns.lookup(u.hostname, { all: true });
  if (!found.length || found.some((x) => isPrivateIp(x.address))) throw new Error('URL lokal/private tidak diizinkan');
  return u.toString();
}

function videoFilter(ratio, resolution) {
  const heights = { '360': 360, '480': 480, '720': 720, '1080': 1080 };
  const h = heights[String(resolution)] || 720;
  if (ratio === '9:16') {
    const w = Math.round((h * 9 / 16) / 2) * 2;
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
  if (ratio === '1:1') {
    return `scale=${h}:${h}:force_original_aspect_ratio=increase,crop=${h}:${h}`;
  }
  const w = Math.round((h * 16 / 9) / 2) * 2;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
}

function buildFfmpegArgs({ input, start, duration, resolution, ratio, format, targetMB }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', input, '-t', String(duration)];
  if (format === 'mp3') {
    args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1');
    return args;
  }

  args.push('-vf', videoFilter(ratio, resolution), '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', 'frag_keyframe+empty_moov', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');

  const mb = Number(targetMB);
  if (Number.isFinite(mb) && mb >= 2) {
    const totalKbps = (mb * 8192) / duration;
    const videoKbps = Math.max(220, Math.min(12000, Math.floor(totalKbps - 160)));
    args.push('-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.15)}k`, '-bufsize', `${videoKbps * 2}k`);
  } else {
    args.push('-crf', '23');
  }
  args.push('-f', 'mp4', 'pipe:1');
  return args;
}

function streamClip(res, opts, cleanup) {
  const ext = opts.format === 'mp3' ? 'mp3' : 'mp4';
  res.setHeader('Content-Type', opts.format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="clipforge-${Date.now()}.${ext}"`);
  res.setHeader('Cache-Control', 'no-store');

  const ff = spawn('ffmpeg', buildFfmpegArgs(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr += d.toString(); });
  ff.stdout.pipe(res);

  const finishCleanup = async () => {
    if (cleanup) try { await cleanup(); } catch {}
  };
  ff.on('close', async (code) => {
    await finishCleanup();
    if (code !== 0 && !res.headersSent) res.status(500).json({ error: stderr || 'FFmpeg gagal memproses video' });
  });
  ff.on('error', async (err) => {
    await finishCleanup();
    if (!res.headersSent) res.status(500).json({ error: `FFmpeg tidak tersedia: ${err.message}` });
    else res.end();
  });
  reqCloseGuard(res, ff, finishCleanup);
}

function reqCloseGuard(res, ff, cleanup) {
  res.on('close', async () => {
    if (!ff.killed) ff.kill('SIGKILL');
    await cleanup();
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'ClipForge Pro' }));

app.post('/api/clip-url', async (req, res) => {
  try {
    const { url, inTime, outTime, resolution = '720', ratio = '16:9', format = 'mp4', targetMB } = req.body;
    const input = await validateRemoteUrl(url);
    const { start, duration } = getDuration(inTime, outTime);
    streamClip(res, { input, start, duration, resolution, ratio, format, targetMB });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/clip-upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) throw new Error('File video belum dipilih');
    const { inTime, outTime, resolution = '720', ratio = '16:9', format = 'mp4', targetMB } = req.body;
    const { start, duration } = getDuration(inTime, outTime);
    const cleanup = () => fs.rm(req.file.path, { force: true });
    streamClip(res, { input: req.file.path, start, duration, resolution, ratio, format, targetMB }, cleanup);
  } catch (e) {
    if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`ClipForge Pro berjalan di http://localhost:${PORT}`));

'use strict';
/*
 * Dimensiones de imagen (cabecera) y versión WebP opcional.
 * No añade dependencias: si existen cwebp, magick o convert, se genera un sidecar
 * "<archivo>.webp" (máx. 1600 px). Si no hay herramienta, se conserva el original.
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const MAX_EDGE = 1600;
const WEBP_QUALITY = '78';
let toolCache;

function imageSize(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  const gif = buf.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || marker === 0x01) { o += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(o + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(o + 5);
        const width = buf.readUInt16BE(o + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      o += 2 + len;
    }
  }
  return null;
}

function imageSizeFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return imageSize(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
}

function canRun(bin) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 4000 });
  return !r.error && r.status === 0;
}

function webpTool() {
  if (toolCache !== undefined) return toolCache;
  toolCache = ['cwebp', 'magick', 'convert'].find((bin) => canRun(bin)) || null;
  return toolCache;
}

function targetBox(dims) {
  if (!dims || dims.width < 1 || dims.height < 1) return null;
  const edge = Math.max(dims.width, dims.height);
  if (edge <= MAX_EDGE) return { width: dims.width, height: dims.height, resized: false };
  const scale = MAX_EDGE / edge;
  return {
    width: Math.max(1, Math.round(dims.width * scale)),
    height: Math.max(1, Math.round(dims.height * scale)),
    resized: true,
  };
}

function isWebp(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    return n === 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  } catch { return false; }
}

function optimizeFile(src) {
  const tool = webpTool();
  if (!tool) return false;
  if (!fs.existsSync(src)) return false;
  const dest = src + '.webp';
  let srcStat;
  try { srcStat = fs.statSync(src); } catch { return false; }
  if (srcStat.size < 32) return false;
  try {
    if (fs.existsSync(dest)) {
      const d = fs.statSync(dest);
      if (d.size > 32 && d.mtimeMs >= srcStat.mtimeMs) return true;
    }
  } catch { /* se regenera */ }
  let dims = null;
  try { dims = imageSizeFile(src); } catch { dims = null; }
  const box = targetBox(dims);
  const args = tool === 'cwebp'
    ? ['-quiet', '-q', WEBP_QUALITY, '-metadata', 'none', ...(box && box.resized ? ['-resize', String(box.width), String(box.height)] : []), src, '-o', dest]
    : [src, '-auto-orient', ...(box && box.resized ? ['-resize', `${box.width}x${box.height}>`] : ['-resize', `${MAX_EDGE}x${MAX_EDGE}>`]), '-quality', WEBP_QUALITY, dest];
  const r = spawnSync(tool, args, { stdio: 'ignore', timeout: 30000 });
  if (r.status !== 0 || !isWebp(dest)) {
    try { fs.rmSync(dest, { force: true }); } catch { /* */ }
    return false;
  }
  try {
    if (fs.statSync(dest).size >= srcStat.size) {
      fs.rmSync(dest, { force: true });
      return false;
    }
  } catch { return false; }
  return true;
}

module.exports = { imageSize, imageSizeFile, optimizeFile, webpTool, MAX_EDGE };

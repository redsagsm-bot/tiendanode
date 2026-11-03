'use strict';
// Cliente SMTP mínimo (sin dependencias): soporta TLS implícito (465) y STARTTLS (587/25), AUTH LOGIN.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }
function addr(s) { const m = /<([^>]+)>/.exec(s || ''); return (m ? m[1] : String(s || '')).trim(); }
function clean(s) { return String(s || '').replace(/[\r\n]/g, ' '); }

async function sendMail(cfg, msg) {
  const host = cfg.host;
  const port = Number(cfg.port) || 587;
  const implicit = port === 465 || cfg.secure === true;
  let sock = implicit ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  let buf = '';
  let pending = null;
  let lastErr = null;
  const onData = (d) => { buf += d; flush(); };
  const onErr = (e) => { lastErr = e; if (pending) { const p = pending; pending = null; p.reject(e); } };
  function attach(s) {
    s.setEncoding('utf8');
    s.on('data', onData);
    s.on('error', onErr);
    s.setTimeout(20000, () => s.destroy(new Error('Tiempo de espera SMTP agotado')));
  }
  function flush() {
    if (!pending) return;
    let idx = 0;
    for (;;) {
      const e = buf.indexOf('\r\n', idx);
      if (e < 0) return;
      const line = buf.slice(idx, e);
      idx = e + 2;
      if (/^\d{3}( |$)/.test(line)) {
        const text = buf.slice(0, idx);
        buf = buf.slice(idx);
        const p = pending; pending = null;
        p.resolve({ code: Number(line.slice(0, 3)), text });
        return;
      }
    }
  }
  function read() {
    return new Promise((resolve, reject) => {
      if (lastErr) return reject(lastErr);
      pending = { resolve, reject };
      flush();
    });
  }
  async function cmd(c, expect) {
    if (c != null) sock.write(c + '\r\n');
    const r = await read();
    if (!expect.includes(r.code)) throw new Error('SMTP: ' + r.text.trim().slice(0, 300));
    return r;
  }
  attach(sock);
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO tienda.local', [250]);
    if (!implicit && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: host }, () => resolve(t));
        t.once('error', reject);
      });
      attach(sock);
      ehlo = await cmd('EHLO tienda.local', [250]);
    }
    if (cfg.user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(cfg.user), [334]);
      await cmd(b64(cfg.pass || ''), [235]);
    }
    const from = addr(cfg.from || cfg.user);
    const to = addr(msg.to);
    await cmd(`MAIL FROM:<${from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const headers = [
      `From: ${clean(cfg.from || from)}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(clean(msg.subject))}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${from.split('@')[1] || 'tienda'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ];
    await cmd(headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(msg.text)) + '\r\n.', [250]);
    try { await cmd('QUIT', [221]); } catch { /* ignorar */ }
  } finally {
    sock.destroy();
  }
  return true;
}

module.exports = { sendMail };

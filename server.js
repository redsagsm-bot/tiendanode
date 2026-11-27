'use strict';
/*
 * Tienda eSIM / SIM México — servidor Node.js sin dependencias externas.
 * Requiere Node 22+ (node:sqlite). Configuración solo por variables de entorno.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const { sendMail } = require('./lib/smtp');
const { createPayPalClient, createMockPayPalClient } = require('./lib/paypal');
const { createStripeClient, verifyWebhook } = require('./lib/stripe');
const { createConektaClient, createMockConektaClient, extractSpeiMethod, verifyWebhookSignature, normalizePem } = require('./lib/conekta');
const { imageSizeFile, optimizeFile } = require('./lib/images');

// ---------------------------------------------------------------- Config
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const QR_DIR = path.join(DATA_DIR, 'qr');
for (const d of [DATA_DIR, UPLOAD_DIR, QR_DIR]) fs.mkdirSync(d, { recursive: true });

const num = (v, d) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const PORT = num(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_TEST = process.env.NODE_ENV === 'test';
const PAYPAL_MOCK = IS_TEST && process.env.PAYPAL_MOCK === '1';
if (process.env.PAYPAL_MOCK === '1' && !IS_TEST) console.warn('[aviso] PAYPAL_MOCK=1 ignorado: solo funciona con NODE_ENV=test.');
const CONEKTA_MOCK = IS_TEST && process.env.CONEKTA_MOCK === '1';
if (process.env.CONEKTA_MOCK === '1' && !IS_TEST) console.warn('[aviso] CONEKTA_MOCK=1 ignorado: solo funciona con NODE_ENV=test.');
const RESERVA_MIN = num(process.env.RESERVA_MINUTOS, 15);
const RESERVA_MANUAL_H = num(process.env.RESERVA_MANUAL_HORAS, 48);
const EXPIRY_INTERVAL = Math.max(200, num(process.env.EXPIRY_INTERVAL_MS, 30000));
const LOW_STOCK = num(process.env.STOCK_BAJO, 5);
const TZ_OFF = num(process.env.TZ_OFFSET_HORAS, -6) * 3600e3;
const SESSION_TTL = 8 * 3600e3;
const MAX_IMG = 8 * 1024 * 1024;
const JSON_LIMIT = 100 * 1024;
const UPLOAD_LIMIT = Math.ceil(MAX_IMG * 4 / 3) + 64 * 1024; // base64 pesa ~4/3 del archivo

function loadSecret() {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) console.warn('[aviso] SESSION_SECRET es corto; usa 32+ caracteres.');
    return process.env.SESSION_SECRET;
  }
  const f = path.join(DATA_DIR, 'session_secret.txt');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) return s; } catch { /* nuevo */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ---------------------------------------------------------------- DB
const db = new DatabaseSync(path.join(DATA_DIR, 'store.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, carrier TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('esim','sim','electronicos')), price INTEGER NOT NULL CHECK(price >= 0),
  description TEXT NOT NULL DEFAULT '', data_amount TEXT NOT NULL DEFAULT '', validity_days INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, phone TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, token TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id), name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT,
  subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
  payment_method TEXT NOT NULL, paypal_order_id TEXT UNIQUE, paypal_capture_id TEXT UNIQUE, tracking TEXT, ship_carrier TEXT,
  notes TEXT, refund_note TEXT, created_at TEXT NOT NULL, paid_at TEXT, expires_at INTEGER, reserved INTEGER NOT NULL DEFAULT 1,
  email_sent_at TEXT);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, carrier TEXT, type TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty > 0), unit_price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS esim_codes(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT UNIQUE NOT NULL, lpa TEXT, qr_file TEXT, status TEXT NOT NULL DEFAULT 'disponible'
  CHECK(status IN ('disponible','reservado','asignado')), reserved_order_id INTEGER, order_item_id INTEGER REFERENCES order_items(id),
  assigned_at TEXT, created_at TEXT NOT NULL,
  CHECK((status = 'asignado') = (order_item_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS idx_codes_prod ON esim_codes(product_id, status);
CREATE INDEX IF NOT EXISTS idx_codes_item ON esim_codes(order_item_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
  message TEXT NOT NULL, created_at TEXT NOT NULL);
`);
if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'stripe_session_id')) db.exec('ALTER TABLE orders ADD COLUMN stripe_session_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe ON orders(stripe_session_id)');
{
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('conekta_order_id')) db.exec('ALTER TABLE orders ADD COLUMN conekta_order_id TEXT');
  if (!cols.includes('spei_clabe')) db.exec('ALTER TABLE orders ADD COLUMN spei_clabe TEXT');
  if (!cols.includes('spei_bank')) db.exec('ALTER TABLE orders ADD COLUMN spei_bank TEXT');
  if (!cols.includes('spei_expires_at')) db.exec('ALTER TABLE orders ADD COLUMN spei_expires_at INTEGER');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_conekta ON orders(conekta_order_id)');
// Migración: el tipo 'electronicos' no cabía en el CHECK de products. SQLite no permite alterarlo, se reconstruye la tabla.
{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
  if (row && !row.sql.includes("'electronicos'")) {
    const newSql = row.sql.replace("CHECK(type IN ('esim','sim'))", "CHECK(type IN ('esim','sim','electronicos'))").replace(/^CREATE TABLE\s+("?)products("?)/i, 'CREATE TABLE products_new');
    if (!newSql.includes("'electronicos'") || !newSql.startsWith('CREATE TABLE products_new')) throw new Error('Migración de products: esquema inesperado');
    try { fs.copyFileSync(path.join(DATA_DIR, 'store.db'), path.join(DATA_DIR, 'store.db.antes-electronicos.bak')); } catch (e) { console.error('[migracion] sin respaldo:', e.message); }
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('DROP TABLE IF EXISTS products_new');
      db.exec(newSql);
      db.exec('INSERT INTO products_new SELECT * FROM products');
      db.exec('DROP TABLE products');
      db.exec('ALTER TABLE products_new RENAME TO products');
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error('Migración de products: ' + bad.length + ' referencias rotas');
      db.exec('COMMIT');
      console.log('[migracion] products ahora acepta el tipo electronicos');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    finally { db.exec('PRAGMA foreign_keys=ON'); }
  }
}

// Customer accounts: add password support
db.exec(`CREATE TABLE IF NOT EXISTS customer_sessions(id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
if (!db.prepare("PRAGMA table_info(customers)").all().some(c => c.name === 'pass_hash')) {
  db.exec("ALTER TABLE customers ADD COLUMN pass_hash TEXT");
  console.log('[migracion] customers ahora acepta contraseña');
}

const nowIso = () => new Date().toISOString();
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (s, m, e) => { throw new HttpError(s, m, e); };
// Productos físicos: llevan stock propio, dirección y envío (a diferencia de la eSIM, que se entrega con código).
const isPhysical = (t) => t === 'sim' || t === 'electronicos';
const TYPE_LABEL = { esim: 'eSIM', sim: 'SIM física', electronicos: 'Electrónicos' };
let inTx = false;
function tx(fn) {
  if (inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTx = true;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
  finally { inTx = false; }
}

// ---------------------------------------------------------------- Settings
const stGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const stSet = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function setting(k, d = '') { const r = stGet.get(k); return r ? r.value : d; }
function setSetting(k, v) { stSet.run(k, String(v)); }
const DEFAULT_EMAIL = {
  intro: 'Hola {nombre},\n\nGracias por tu compra en {tienda}.',
  instructions: 'Para instalar tu eSIM: Ajustes > Datos móviles / Celular > Agregar eSIM > Usar código QR o ingresar los datos manualmente.\nImportante: la eSIM normalmente solo puede instalarse una vez. Guarda este correo.',
  signature: '{tienda}',
};
function emailTexts() {
  return { intro: setting('email_intro', DEFAULT_EMAIL.intro), instructions: setting('email_instructions', DEFAULT_EMAIL.instructions), signature: setting('email_signature', DEFAULT_EMAIL.signature) };
}
function fillTpl(t, vars) { return String(t).replace(/\{(nombre|tienda|pedido)\}/g, (_, k) => vars[k]); }
const DEFAULT_BANK = 'Realiza tu transferencia SPEI y envíanos el comprobante por WhatsApp con tu número de pedido. (Configura estos datos en Ajustes.)';
const BANNER_RE = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/, MAX_BANNERS = 6;
function bannerList() {
  let l = null;
  try { l = JSON.parse(setting('banners', '')); } catch { l = null; }
  if (!Array.isArray(l)) { const b = setting('banner', ''); l = b ? [b] : []; }
  return l.filter((x) => typeof x === 'string' && BANNER_RE.test(x)).slice(0, MAX_BANNERS);
}
function storeConfig() {
  const banners = bannerList();
  const logo = setting('logo', '');
  const ld = fileDims(logo);
  const cfg = {
    storeName: setting('store_name', process.env.STORE_NAME || 'eSIMGO.MX'),
    logo,
    banner: banners[0] || '',
    banners,
    bannerMeta: banners.map((f) => {
      const d = fileDims(f);
      return d ? { width: d.width, height: d.height } : {};
    }),
    contactEmail: setting('contact_email', process.env.CONTACT_EMAIL || ''),
    whatsapp: setting('whatsapp', process.env.WHATSAPP || ''),
    shippingCost: Number(setting('shipping_cost', String(Math.round(num(process.env.SHIPPING_COST, 99) * 100)))),
    bankInfo: setting('bank_info', DEFAULT_BANK),
  };
  if (ld) { cfg.logoWidth = ld.width; cfg.logoHeight = ld.height; }
  return cfg;
}
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeEnabled = () => /^(sk|rk)_(test|live)_/.test(STRIPE_KEY);
let stripeClient = null;
function stripe() {
  if (!stripeEnabled()) fail(503, 'Stripe no está configurado');
  return (stripeClient ||= createStripeClient({ secretKey: STRIPE_KEY }));
}
async function stripeCall(fn) {
  try { return await fn(stripe()); } catch (e) { if (e instanceof HttpError) throw e; console.error('[stripe]', e.message); fail(502, 'No se pudo comunicar con Stripe. Intenta de nuevo.'); }
}
const CONEKTA_KEY = process.env.CONEKTA_PRIVATE_KEY || '';
const CONEKTA_WEBHOOK_PUBLIC_KEY = normalizePem(process.env.CONEKTA_WEBHOOK_PUBLIC_KEY || '');
const CONEKTA_API_VERSION = process.env.CONEKTA_API_VERSION || '2.3.0';
const conektaEnabled = () => CONEKTA_MOCK || /^key_/.test(CONEKTA_KEY);
let conektaClient = null;
function conekta() {
  if (CONEKTA_MOCK) return (conektaClient ||= createMockConektaClient());
  if (!conektaEnabled()) fail(503, 'Conekta no está configurado');
  return (conektaClient ||= createConektaClient({ privateKey: CONEKTA_KEY, apiVersion: CONEKTA_API_VERSION }));
}
function logConektaError(e) {
  const parts = ['[conekta]'];
  if (e && e.status) parts.push('HTTP ' + e.status);
  if (e && e.type) parts.push(e.type);
  if (e && e.code) parts.push(e.code);
  if (e && e.param) parts.push('param=' + e.param);
  parts.push(e && e.message ? e.message : 'error');
  console.error(parts.join(' '));
}
async function conektaCall(fn) {
  try { return await fn(conekta()); } catch (e) {
    if (e instanceof HttpError) throw e;
    logConektaError(e);
    fail(502, 'No se pudo comunicar con Conekta. Intenta de nuevo.');
  }
}
function formatConektaPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('52') && d.length >= 12) return '+' + d;
  if (d.length === 10) return '+52' + d;
  if (String(phone || '').trim().startsWith('+') && d.length >= 10) return '+' + d;
  return '+52' + d.slice(-10);
}
function paypalConfig() {
  const fromEnv = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
  const clientId = fromEnv ? process.env.PAYPAL_CLIENT_ID : setting('paypal_client_id');
  const secret = fromEnv ? process.env.PAYPAL_SECRET : setting('paypal_secret');
  const mode = ((fromEnv ? process.env.PAYPAL_MODE : setting('paypal_mode')) || 'sandbox') === 'live' ? 'live' : 'sandbox';
  return { clientId, secret, mode, fromEnv, enabled: PAYPAL_MOCK || !!(clientId && secret) };
}
let ppCache = { key: '', client: null };
let mockClient = null;
function paypal() {
  if (PAYPAL_MOCK) return (mockClient ||= createMockPayPalClient());
  const c = paypalConfig();
  if (!c.enabled) fail(503, 'PayPal no está configurado');
  const key = crypto.createHash('sha256').update(c.mode + '|' + c.clientId + '|' + c.secret).digest('hex');
  if (ppCache.key !== key) ppCache = { key, client: createPayPalClient(c) };
  return ppCache.client;
}
// ---------------------------------------------------------------- Telegram (avisos al dueño)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const telegramEnabled = () => !!(TG_TOKEN && TG_CHAT);
async function tgSend(text) {
  const r = await fetch(`${process.env.TELEGRAM_API || 'https://api.telegram.org'}/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: String(text).slice(0, 3500), disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.description || 'HTTP ' + r.status); }
}
function notifyAdmin(text) {
  if (!telegramEnabled()) return;
  setImmediate(() => tgSend(text).catch((e) => console.error('[telegram]', e.message)));
}
// Aviso de visitas: una notificación por visitante (IP) cada VISIT_NOTIFY_COOLDOWN_MIN minutos (0 = todas las visitas).
const VISIT_COOLDOWN = Math.max(0, Number(process.env.VISIT_NOTIFY_COOLDOWN_MIN ?? 10)) * 60000;
const visitSeen = new Map();
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|curl|wget|healthcheck|railway/i;
function notifyVisit(req, p) {
  if (!telegramEnabled() || (req.method !== 'GET')) return;
  if (!(p.endsWith('/') || p.endsWith('.html'))) return;
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_UA.test(ua)) return;
  const ip = clientIp(req), now = Date.now();
  if (visitSeen.size > 5000) for (const [k, t] of visitSeen) if (t < now) visitSeen.delete(k);
  if ((visitSeen.get(ip) || 0) > now) return;
  visitSeen.set(ip, now + VISIT_COOLDOWN);
  const ref = req.headers.referer ? `\nVino de: ${String(req.headers.referer).slice(0, 200)}` : '';
  notifyAdmin(`Nueva visita en ${storeConfig().storeName}\nPágina: ${p}\nIP: ${ip}${ref}`);
}
function orderSummary(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  return { o, items, lines: items.map((i) => `- ${i.qty} x ${i.name}`).join('\n'), total: '$' + (o.total / 100).toFixed(2) + ' MXN' };
}
function notifyLowStock(items) {
  if (!telegramEnabled()) return;
  const seen = new Set(), low = [];
  for (const i of items) {
    if (seen.has(i.product_id)) continue; seen.add(i.product_id);
    const row = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(i.product_id);
    const p = row && row.active ? productOut(row) : null;
    if (p && p.stock < LOW_STOCK) low.push(`- ${p.name}: quedan ${p.stock}`);
  }
  if (low.length) notifyAdmin('Stock bajo:\n' + low.join('\n'));
}

function smtpConfig() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return { host, port: num(process.env.SMTP_PORT, 587), user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '' };
}

// ---------------------------------------------------------------- Crypto helpers
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(p, salt, 64, SCRYPT).toString('hex')}`;
}
function verifyPassword(p, stored) {
  try {
    const [alg, s, k] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const kb = Buffer.from(k, 'hex');
    return crypto.timingSafeEqual(crypto.scryptSync(String(p), Buffer.from(s, 'hex'), kb.length, SCRYPT), kb);
  } catch { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
function safeEq(a, b) {
  const h = (x) => crypto.createHmac('sha256', SECRET).update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update('sid:' + v).digest('base64url');
function randomPassword(n = 16) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
}

// ---------------------------------------------------------------- First admin
function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) n FROM admins').get().n;
  const u = (process.env.ADMIN_USER || '').trim(), p = process.env.ADMIN_PASSWORD || '';
  if (count > 0) {
    if (process.env.ADMIN_RESET_PASSWORD === '1' && u && p.length >= 8) {
      const r = db.prepare('UPDATE admins SET pass_hash = ?, must_change = 0 WHERE username = ?').run(hashPassword(p), u);
      if (!r.changes) db.prepare('INSERT INTO admins(username, pass_hash, must_change, created_at) VALUES(?,?,0,?)').run(u, hashPassword(p), nowIso());
      db.prepare('DELETE FROM sessions').run();
      console.log(`[admin] Contraseña del usuario "${u}" restablecida desde variables de entorno (ADMIN_RESET_PASSWORD=1). Quita esa variable.`);
    }
    return;
  }
  if (u && p) {
    if (p.length < 8) { console.warn('[admin] ADMIN_PASSWORD debe tener al menos 8 caracteres; se ignora.'); }
    else {
      db.prepare('INSERT INTO admins(username, pass_hash, must_change, created_at) VALUES(?,?,0,?)').run(u, hashPassword(p), nowIso());
      console.log(`[admin] Administrador "${u}" creado desde variables de entorno.`);
      return;
    }
  }
  if (process.env.SETUP_TOKEN) {
    console.log('[admin] No hay administrador. Abre /admin y usa tu SETUP_TOKEN para crearlo.');
    return;
  }
  const pass = randomPassword(16);
  db.prepare('INSERT INTO admins(username, pass_hash, must_change, created_at) VALUES(?,?,1,?)').run('admin', hashPassword(pass), nowIso());
  console.log('\n==================================================================');
  console.log('  ADMINISTRADOR TEMPORAL CREADO (se muestra UNA sola vez)');
  console.log('  Usuario:     admin');
  console.log('  Contraseña:  ' + pass);
  console.log('  Entra a /admin; se te pedirá cambiarla en el primer inicio.');
  console.log('==================================================================\n');
}

// ---------------------------------------------------------------- Seed
function seed() {
  if (process.env.SEED_EJEMPLOS === '0') return;
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) return;
  const desc = 'Producto de EJEMPLO para demostrar la tienda. No es una oferta oficial de la compañía. Edita o elimina este producto desde el panel de administración.';
  const items = [
    ['[EJEMPLO] eSIM Telcel 5 GB · 30 días', 'Telcel', 'esim', 29900, '5 GB', 30, 0, 1],
    ['[EJEMPLO] eSIM Telcel 10 GB · 30 días', 'Telcel', 'esim', 44900, '10 GB', 30, 0, 1],
    ['[EJEMPLO] eSIM AT&T 8 GB · 30 días', 'AT&T', 'esim', 34900, '8 GB', 30, 0, 1],
    ['[EJEMPLO] eSIM Bait 5 GB · 30 días', 'Bait', 'esim', 19900, '5 GB', 30, 0, 1],
    ['[EJEMPLO] eSIM Movistar 6 GB · 30 días', 'Movistar', 'esim', 24900, '6 GB', 30, 0, 0],
    ['[EJEMPLO] SIM física Telcel (chip)', 'Telcel', 'sim', 14900, 'Recarga aparte', 0, 25, 1],
    ['[EJEMPLO] SIM física Unefon (chip)', 'Unefon', 'sim', 9900, 'Recarga aparte', 0, 20, 0],
    ['[EJEMPLO] SIM física Bait (chip)', 'Bait', 'sim', 7900, 'Recarga aparte', 0, 30, 0],
  ];
  const ins = db.prepare(`INSERT INTO products(name, carrier, type, price, description, data_amount, validity_days, stock, featured, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const insCode = db.prepare('INSERT INTO esim_codes(product_id, code, lpa, created_at) VALUES(?,?,?,?)');
  tx(() => {
    for (const it of items) {
      const r = ins.run(it[0], it[1], it[2], it[3], desc, it[4], it[5], it[6], it[7], nowIso());
      if (it[2] === 'esim') for (let i = 1; i <= 3; i++) {
        const c = `EJEMPLO-NO-VALIDO-${r.lastInsertRowid}-${i}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        insCode.run(r.lastInsertRowid, c, `LPA:1$smdp.ejemplo.invalid$${c}`, nowIso());
      }
    }
  });
  console.log('[seed] Productos de ejemplo creados ([EJEMPLO]). Edítalos o elimínalos desde /admin.');
}

// ---------------------------------------------------------------- Validation
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function str(v, { min = 0, max = 200, name = 'Campo', re, multiline = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${name}: valor inválido`);
  v = String(v).replace(CTRL, '');
  if (!multiline) v = v.replace(/[\r\n\t]+/g, ' ');
  v = v.trim();
  if (v.length < min) fail(400, min <= 1 ? `${name} es obligatorio` : `${name}: mínimo ${min} caracteres`);
  if (v.length > max) fail(400, `${name}: máximo ${max} caracteres`);
  if (re && v && !re.test(v)) fail(400, `${name} no es válido`);
  return v;
}
function int(v, { min = 0, max = 1e9, name = 'Valor' } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} no es válido`);
  return n;
}
function pesosToCents(v, name = 'Precio') {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < 0 || n > 1e6) fail(400, `${name} no es válido`);
  return Math.round(n * 100);
}
const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{10,20}$/;
const ESTADOS = ['Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche', 'Chiapas', 'Chihuahua', 'Ciudad de México',
  'Coahuila', 'Colima', 'Durango', 'Estado de México', 'Guanajuato', 'Guerrero', 'Hidalgo', 'Jalisco', 'Michoacán', 'Morelos', 'Nayarit',
  'Nuevo León', 'Oaxaca', 'Puebla', 'Querétaro', 'Quintana Roo', 'San Luis Potosí', 'Sinaloa', 'Sonora', 'Tabasco', 'Tamaulipas',
  'Tlaxcala', 'Veracruz', 'Yucatán', 'Zacatecas'];

// ---------------------------------------------------------------- Rate limit
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > max) fail(429, 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------- Images
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  return null;
}
function saveImage(img, dir) {
  if (!img || typeof img !== 'object' || typeof img.data !== 'string') fail(400, 'Imagen requerida');
  const b64 = img.data.replace(/^data:[a-z/+.-]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) fail(400, 'Imagen inválida');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) fail(400, 'Imagen vacía');
  if (buf.length > MAX_IMG) fail(413, 'La imagen supera 8 MB');
  const ext = sniff(buf);
  if (!ext) fail(415, 'Formato no permitido. Solo PNG, JPG, WEBP o GIF.');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buf, { mode: 0o644 });
  if (dir === UPLOAD_DIR && ext !== 'gif') {
    try { optimizeFile(full); } catch (e) { console.error('[img]', e.message); }
  }
  return name;
}
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const FILE_RE = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
const dimCache = new Map();
function fileDims(filename) {
  if (!filename || !FILE_RE.test(filename)) return null;
  const full = path.join(UPLOAD_DIR, filename);
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  const hit = dimCache.get(filename);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.dims;
  let dims = null;
  try { dims = imageSizeFile(full); } catch { dims = null; }
  dimCache.set(filename, { mtimeMs: st.mtimeMs, dims });
  return dims;
}

// ---------------------------------------------------------------- Products
const availStmt = db.prepare("SELECT COUNT(*) n FROM esim_codes WHERE product_id = ? AND status = 'disponible'");
function productOut(p, admin = false) {
  const stock = p.type === 'esim' ? availStmt.get(p.id).n : p.stock;
  const dims = p.image ? fileDims(p.image) : null;
  const o = { id: p.id, name: p.name, carrier: p.carrier, type: p.type, price: p.price, description: p.description,
    dataAmount: p.data_amount, validityDays: p.validity_days, image: p.image ? '/uploads/' + p.image : '', stock, featured: !!p.featured };
  if (dims) { o.imageWidth = dims.width; o.imageHeight = dims.height; }
  if (admin) { o.active = !!p.active; o.createdAt = p.created_at; }
  return o;
}
const SORTS = { precio_asc: 'price ASC, id ASC', precio_desc: 'price DESC, id ASC', nombre: 'name COLLATE NOCASE ASC', recientes: 'id DESC', destacados: 'featured DESC, id ASC' };
function likeArg(s) { return '%' + String(s).slice(0, 80).replace(/[\\%_]/g, (m) => '\\' + m) + '%'; }
function listProducts(q, admin = false) {
  const where = ['deleted = 0'], args = [];
  if (!admin) where.push('active = 1');
  if (q.carrier) { where.push('carrier = ?'); args.push(String(q.carrier).slice(0, 40)); }
  if (q.type === 'esim' || isPhysical(q.type)) { where.push('type = ?'); args.push(q.type); }
  if (q.featured === '1') where.push('featured = 1');
  if (q.q) {
    const like = likeArg(q.q);
    where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR carrier LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const order = SORTS[q.sort] || SORTS.destacados;
  return db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args).map((p) => productOut(p, admin));
}
function productInput(b, partial = false) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, { min: 2, max: 120, name: 'Nombre' });
  if (has('carrier')) out.carrier = str(b.carrier, { min: 2, max: 40, name: 'Compañía' });
  if (has('type')) { if (!['esim', 'sim', 'electronicos'].includes(b.type)) fail(400, 'Tipo debe ser esim, sim o electronicos'); out.type = b.type; }
  if (has('price')) out.price = pesosToCents(b.price);
  if (has('description')) out.description = str(b.description, { max: 3000, name: 'Descripción', multiline: true });
  if (has('dataAmount')) out.data_amount = str(b.dataAmount, { max: 60, name: 'Datos' });
  if (has('validityDays')) out.validity_days = int(b.validityDays ?? 0, { min: 0, max: 3650, name: 'Vigencia' });
  if (has('stock')) out.stock = int(b.stock ?? 0, { min: 0, max: 1e6, name: 'Stock' });
  if (has('active')) out.active = b.active === false || b.active === 0 || b.active === '0' ? 0 : 1;
  if (has('featured')) out.featured = b.featured ? 1 : 0;
  if (b.image !== undefined) {
    if (b.image === '' || b.image === null) out.image = '';
    else { const m = /^(?:\/uploads\/)?([a-f0-9]{32}\.(?:png|jpg|webp|gif))$/.exec(String(b.image)); if (!m) fail(400, 'Imagen inválida'); out.image = m[1]; }
  }
  return out;
}

// ---------------------------------------------------------------- Orders
const STATUS_LABEL = { pendiente_pago: 'Pendiente de pago', pagado: 'Pagado', preparando: 'Preparando envío', enviado: 'Enviado',
  entregado: 'Entregado', cancelado: 'Cancelado', expirado: 'Expirado', reembolsado: 'Reembolsado' };
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function orderNumber() {
  const d = new Date(Date.now() + TZ_OFF).toISOString().slice(2, 10).replace(/-/g, '');
  return 'MX' + d + '-' + Array.from(crypto.randomBytes(6), (b) => ALPH[b % ALPH.length]).join('');
}
const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');

function releaseReservation(o) {
  if (!o.reserved) return;
  for (const it of itemsStmt.all(o.id)) if (isPhysical(it.type)) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
  db.prepare("UPDATE esim_codes SET status = 'disponible', reserved_order_id = NULL WHERE reserved_order_id = ? AND status = 'reservado'").run(o.id);
  db.prepare('UPDATE orders SET reserved = 0 WHERE id = ?').run(o.id);
}
function expireOrders() {
  const rows = db.prepare("SELECT id FROM orders WHERE status = 'pendiente_pago' AND reserved = 1 AND expires_at < ?").all(Date.now());
  for (const { id } of rows) {
    tx(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!o || o.status !== 'pendiente_pago' || !o.reserved || o.expires_at >= Date.now()) return;
      releaseReservation(o);
      db.prepare("UPDATE orders SET status = 'expirado' WHERE id = ?").run(id);
    });
  }
  return rows.length;
}

function createOrder(b) {
  const res = createOrderTx(b);
  try {
    const row = db.prepare('SELECT id FROM orders WHERE number = ?').get(res.number);
    if (row && telegramEnabled()) {
      const s = orderSummary(row.id);
      const how = res.paymentMethod === 'paypal' ? 'pago con PayPal pendiente'
        : res.paymentMethod === 'stripe' ? 'pago con Stripe pendiente'
        : res.paymentMethod === 'spei' ? 'SPEI Conekta: esperando transferencia'
        : 'transferencia/manual: esperando comprobante';
      notifyAdmin(`Pedido nuevo ${res.number}\n${s.o.name} - ${s.total}\n${how}\n${s.lines}`);
    }
  } catch (e) { console.error('[telegram]', e.message); }
  return res;
}
function createOrderTx(b) {
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) fail(400, 'El carrito está vacío o es inválido');
  const merged = new Map();
  for (const it of b.items) {
    const id = int(it && it.id, { min: 1, name: 'Producto' });
    const qty = int(it && it.qty, { min: 1, max: 10, name: 'Cantidad' });
    merged.set(id, Math.min(10, (merged.get(id) || 0) + qty));
  }
  const c = b.customer || {};
  const name = str(c.name, { min: 2, max: 100, name: 'Nombre' });
  const email = str(c.email, { min: 5, max: 160, name: 'Correo', re: EMAIL_RE }).toLowerCase();
  const phone = str(c.phone, { min: 10, max: 20, name: 'Teléfono / WhatsApp', re: PHONE_RE });
  const method = b.payment === 'paypal' ? 'paypal' : b.payment === 'stripe' ? 'stripe' : b.payment === 'spei' ? 'spei' : b.payment === 'manual' ? 'manual' : fail(400, 'Método de pago inválido');
  if (method === 'paypal' && !paypalConfig().enabled) fail(400, 'PayPal no está disponible. Elige pago por transferencia/WhatsApp.');
  if (method === 'stripe' && !stripeEnabled()) fail(400, 'Stripe no está disponible. Elige otro método de pago.');
  if (method === 'spei' && !conektaEnabled()) fail(400, 'La transferencia SPEI no está disponible. Elige otro método de pago.');
  expireOrders();
  return tx(() => {
    const products = [];
    for (const [id, qty] of merged) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1 AND deleted = 0').get(id);
      if (!p) fail(400, 'Un producto del carrito ya no está disponible');
      products.push({ p, qty });
    }
    const needsShipping = products.some((x) => isPhysical(x.p.type));
    let address = null;
    if (needsShipping) {
      const a = b.address || {};
      address = {
        street: str(a.street, { min: 3, max: 160, name: 'Calle y número' }),
        colonia: str(a.colonia, { min: 2, max: 100, name: 'Colonia' }),
        cp: str(a.cp, { min: 5, max: 5, name: 'Código postal', re: /^\d{5}$/ }),
        city: str(a.city, { min: 2, max: 100, name: 'Ciudad / Municipio' }),
        state: str(a.state, { min: 2, max: 60, name: 'Estado' }),
        refs: str(a.refs, { max: 200, name: 'Referencias' }),
      };
      if (!ESTADOS.includes(address.state)) fail(400, 'Estado no válido');
    }
    const cfg = storeConfig();
    const subtotal = products.reduce((s, x) => s + x.p.price * x.qty, 0);
    const shipping = needsShipping ? cfg.shippingCost : 0;
    const total = subtotal + shipping;
    if (method === 'paypal' && total < 100) fail(400, 'El total mínimo para PayPal es $1.00 MXN');
    if (method === 'stripe' && total < 1000) fail(400, 'El total mínimo para pagar con tarjeta es $10.00 MXN');
    if (method === 'spei' && total < 1500) fail(400, 'El total mínimo para transferencia SPEI es $15.00 MXN');
    const cust = db.prepare(`INSERT INTO customers(email, name, phone, created_at) VALUES(?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = excluded.phone RETURNING id`).get(email, name, phone, nowIso());
    const slowPay = method === 'manual' || method === 'spei';
    const expires = Date.now() + (slowPay ? RESERVA_MANUAL_H * 3600e3 : RESERVA_MIN * 60e3);
    const number = orderNumber();
    const token = crypto.randomBytes(24).toString('base64url');
    const o = db.prepare(`INSERT INTO orders(number, token, customer_id, name, email, phone, address, subtotal, shipping, total, status,
      payment_method, created_at, expires_at, reserved) VALUES(?,?,?,?,?,?,?,?,?,?, 'pendiente_pago', ?, ?, ?, 1)`)
      .run(number, token, cust.id, name, email, phone, address ? JSON.stringify(address) : null, subtotal, shipping, total, method, nowIso(), expires);
    const orderId = Number(o.lastInsertRowid);
    for (const { p, qty } of products) {
      db.prepare('INSERT INTO order_items(order_id, product_id, name, carrier, type, qty, unit_price) VALUES(?,?,?,?,?,?,?)')
        .run(orderId, p.id, p.name, p.carrier, p.type, qty, p.price);
      if (isPhysical(p.type)) {
        const r = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, p.id, qty);
        if (r.changes !== 1) fail(409, `Sin existencias suficientes de "${p.name}"`);
      } else {
        const r = db.prepare(`UPDATE esim_codes SET status = 'reservado', reserved_order_id = ? WHERE id IN (
          SELECT id FROM esim_codes WHERE product_id = ? AND status = 'disponible' ORDER BY id LIMIT ?)`).run(orderId, p.id, qty);
        if (r.changes !== qty) fail(409, `Sin existencias suficientes de "${p.name}"`);
      }
    }
    return { number, token, total, paymentMethod: method, expiresAt: new Date(expires).toISOString() };
  });
}

function speiPublic(o) {
  if (o.payment_method !== 'spei' || o.status !== 'pendiente_pago') return null;
  return {
    clabe: o.spei_clabe || '',
    bank: o.spei_bank || '',
    expiresAt: o.spei_expires_at ? new Date(o.spei_expires_at).toISOString() : (o.expires_at ? new Date(o.expires_at).toISOString() : null),
  };
}

const speiInflight = new Map();
async function attachSpeiPayment(orderRow) {
  let o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderRow.id);
  if (!o) fail(404, 'Pedido no encontrado');
  if (o.payment_method !== 'spei') fail(400, 'Este pedido no usa SPEI');
  if (o.conekta_order_id && o.spei_clabe) return { spei: speiPublic(o), first: false };
  if (speiInflight.has(o.id)) return speiInflight.get(o.id);
  const job = (async () => {
    o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    if (o.conekta_order_id && o.spei_clabe) return { spei: speiPublic(o), first: false };
    if (o.status !== 'pendiente_pago') fail(409, 'El pedido ya no está pendiente de pago');
    if (o.expires_at < Date.now()) fail(409, 'La reserva de tu pedido expiró. Vuelve a hacer tu pedido.');
    const items = itemsStmt.all(o.id);
    const payload = {
      currency: 'MXN',
      customer_info: { name: o.name, email: o.email, phone: formatConektaPhone(o.phone) },
      line_items: items.map((it) => ({ name: String(it.name).slice(0, 250), unit_price: it.unit_price, quantity: it.qty })),
      charges: [{ payment_method: { type: 'spei', expires_at: Math.floor(o.expires_at / 1000) } }],
      metadata: { order_number: o.number, order_id: String(o.id) },
    };
    // Conekta exige shipping_lines aunque el envío sea $0 (p. ej. eSIM).
    payload.shipping_lines = [{ amount: o.shipping || 0, carrier: 'Envío' }];
    if (o.address) {
      try {
        const a = JSON.parse(o.address);
        payload.shipping_contact = {
          phone: formatConektaPhone(o.phone),
          receiver: o.name,
          address: { street1: a.street, postal_code: a.cp, country: 'MX', city: a.city, state: a.state },
        };
      } catch { /* sin dirección válida */ }
    }
    const created = await conektaCall((c) => c.createOrder(payload));
    const info = extractSpeiMethod(created);
    if (!info || !created.id || !info.clabe) fail(502, 'Conekta no devolvió la CLABE. Intenta de nuevo.');
    const expMs = info.expiresAt ? info.expiresAt * 1000 : o.expires_at;
    const u = db.prepare('UPDATE orders SET conekta_order_id = ?, spei_clabe = ?, spei_bank = ?, spei_expires_at = ? WHERE id = ? AND conekta_order_id IS NULL')
      .run(created.id, info.clabe, info.bank || '', expMs, o.id);
    if (!u.changes) {
      o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
      return { spei: speiPublic(o), first: false };
    }
    o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    return { spei: speiPublic(o), first: true };
  })().finally(() => speiInflight.delete(o.id));
  speiInflight.set(o.id, job);
  return job;
}

function confirmPaid(orderId, { captureId = null, by = 'sistema' } = {}) {
  const res = tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) fail(404, 'Pedido no encontrado');
    if (o.paid_at) return { already: true, order: o };
    if (!['pendiente_pago', 'expirado'].includes(o.status)) fail(409, `No se puede confirmar un pedido en estado "${STATUS_LABEL[o.status] || o.status}"`);
    const items = itemsStmt.all(o.id);
    const problems = [];
    for (const it of items) {
      if (isPhysical(it.type)) {
        if (!o.reserved) {
          const r = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(it.qty, it.product_id, it.qty);
          if (r.changes !== 1) problems.push(`Sin stock físico para "${it.name}"`);
        }
        continue;
      }
      const already = db.prepare('SELECT COUNT(*) n FROM esim_codes WHERE order_item_id = ?').get(it.id).n;
      for (let k = already; k < it.qty; k++) {
        const code = db.prepare(`SELECT id FROM esim_codes WHERE product_id = ? AND
            ((status = 'reservado' AND reserved_order_id = ?) OR status = 'disponible')
            ORDER BY CASE WHEN reserved_order_id = ? THEN 0 ELSE 1 END, id LIMIT 1`).get(it.product_id, o.id, o.id);
        if (!code) { problems.push(`Sin códigos eSIM disponibles para "${it.name}"`); break; }
        const r = db.prepare(`UPDATE esim_codes SET status = 'asignado', order_item_id = ?, reserved_order_id = ?, assigned_at = ?
          WHERE id = ? AND status IN ('disponible','reservado') AND order_item_id IS NULL`).run(it.id, o.id, nowIso(), code.id);
        if (r.changes !== 1) fail(500, 'Conflicto al asignar código');
      }
    }
    db.prepare("UPDATE esim_codes SET status = 'disponible', reserved_order_id = NULL WHERE reserved_order_id = ? AND status = 'reservado'").run(o.id);
    const hasSim = items.some((i) => isPhysical(i.type));
    const status = hasSim || problems.length ? 'pagado' : 'entregado';
    const note = [o.notes, problems.length ? `ATENCIÓN (${nowIso()}): ${problems.join('; ')}` : '', `Pago confirmado por ${by} (${nowIso()})`]
      .filter(Boolean).join('\n');
    db.prepare('UPDATE orders SET status = ?, paid_at = ?, paypal_capture_id = COALESCE(?, paypal_capture_id), reserved = 0, notes = ? WHERE id = ?')
      .run(status, nowIso(), captureId, note, o.id);
    return { already: false, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), problems };
  });
  if (!res.already && telegramEnabled()) {
    try {
      const s = orderSummary(orderId);
      notifyAdmin(`Pago confirmado ${s.o.number}\n${s.o.name} - ${s.total}\n${s.lines}${res.problems && res.problems.length ? '\nATENCION: ' + res.problems.join('; ') : ''}`);
      notifyLowStock(s.items);
    } catch (e) { console.error('[telegram]', e.message); }
  }
  if (!res.already) setImmediate(() => sendDeliveryEmail(orderId).catch((e) => console.error('[email]', e.message)));
  return res;
}

// Completa códigos faltantes de un pedido ya pagado (p. ej. si no había inventario al pagar).
function fillMissingCodes(orderId) {
  return tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o || !o.paid_at || o.status === 'reembolsado') return 0;
    let added = 0, missing = 0;
    for (const it of itemsStmt.all(o.id)) {
      if (it.type !== 'esim') continue;
      const have = db.prepare('SELECT COUNT(*) n FROM esim_codes WHERE order_item_id = ?').get(it.id).n;
      for (let k = have; k < it.qty; k++) {
        const r = db.prepare(`UPDATE esim_codes SET status = 'asignado', order_item_id = ?, reserved_order_id = ?, assigned_at = ?
          WHERE id = (SELECT id FROM esim_codes WHERE product_id = ? AND status = 'disponible' ORDER BY id LIMIT 1)`).run(it.id, o.id, nowIso(), it.product_id);
        if (r.changes === 1) added++; else { missing++; break; }
      }
    }
    if (added && !missing && o.status === 'pagado' && !itemsStmt.all(o.id).some((i) => isPhysical(i.type))) db.prepare("UPDATE orders SET status = 'entregado' WHERE id = ?").run(o.id);
    return added;
  });
}

// Cupos de entrega manual: ocupan inventario (stock) pero el código real se envía por correo al cliente.
const MANUAL_PREFIX = 'MANUAL-';
function codesFor(itemId, reveal) {
  return db.prepare('SELECT code, lpa, qr_file FROM esim_codes WHERE order_item_id = ? ORDER BY id').all(itemId).map((c) => {
    if (c.code.startsWith(MANUAL_PREFIX)) return reveal ? { manual: true, code: '', lpa: '', qr: '' } : { code: 'Entrega manual' };
    if (!reveal) return { code: mask(c.code) };
    let qr = '';
    if (c.qr_file && FILE_RE.test(c.qr_file)) {
      try { qr = `data:${IMG_TYPES[c.qr_file.split('.').pop()]};base64,` + fs.readFileSync(path.join(QR_DIR, c.qr_file)).toString('base64'); } catch { /* */ }
    }
    return { code: c.code, lpa: c.lpa || '', qr };
  });
}
const mask = (s) => (s.length <= 4 ? '••••' : '••••••' + s.slice(-4));
function orderPublic(o, reveal) {
  const cfg = storeConfig();
  const items = itemsStmt.all(o.id).map((it) => ({
    name: it.name, carrier: it.carrier, type: it.type, qty: it.qty, unitPrice: it.unit_price,
    codes: it.type === 'esim' && o.paid_at && reveal && o.status !== 'reembolsado' ? codesFor(it.id, true) : [],
  }));
  return {
    number: o.number, status: o.status, statusLabel: STATUS_LABEL[o.status] || o.status, paymentMethod: o.payment_method,
    createdAt: o.created_at, paidAt: o.paid_at, subtotal: o.subtotal, shipping: o.shipping, total: o.total, name: o.name,
    tracking: o.tracking || '', shipCarrier: o.ship_carrier || '', items, needsShipping: items.some((i) => isPhysical(i.type)),
    expiresAt: o.status === 'pendiente_pago' && o.expires_at ? new Date(o.expires_at).toISOString() : null,
    bankInfo: o.payment_method === 'manual' && o.status === 'pendiente_pago' ? cfg.bankInfo : '',
    spei: speiPublic(o),
    whatsapp: cfg.whatsapp,
  };
}
function orderByToken(number, token) {
  const n = str(number, { min: 5, max: 40, name: 'Número de pedido' }).toUpperCase();
  const t = str(token, { min: 10, max: 100, name: 'Token' });
  const o = db.prepare('SELECT * FROM orders WHERE number = ?').get(n);
  if (!o || !safeEq(o.token, t)) fail(404, 'Pedido no encontrado o enlace inválido');
  return o;
}
function verifyCapture(result, o) {
  if (!result || result.id !== o.paypal_order_id) return { ok: false, reason: 'orden distinta' };
  if (result.status !== 'COMPLETED') return { ok: false, reason: 'estado ' + result.status };
  const pu = result.purchase_units && result.purchase_units[0];
  const cap = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  if (!cap || cap.status !== 'COMPLETED') return { ok: false, reason: 'captura no completada' };
  if (!cap.amount || cap.amount.currency_code !== 'MXN') return { ok: false, reason: 'moneda distinta' };
  if (Math.round(parseFloat(cap.amount.value) * 100) !== o.total) return { ok: false, reason: 'monto distinto al total del pedido' };
  return { ok: true, captureId: cap.id };
}

// ---------------------------------------------------------------- Email
function publicBase() { return (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); }
let lastBase = '';
function statusLink(o) { return `${publicBase() || lastBase}/estado.html?n=${encodeURIComponent(o.number)}&t=${encodeURIComponent(o.token)}`; }
async function sendDeliveryEmail(orderId, force = false) {
  const smtp = smtpConfig();
  if (!smtp) return { sent: false, reason: 'SMTP no configurado' };
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || !o.paid_at) return { sent: false, reason: 'Pedido no pagado' };
  if (o.email_sent_at && !force) return { sent: false, reason: 'Ya enviado' };
  const cfg = storeConfig();
  const pub = orderPublic(o, true);
  const tx = emailTexts(), vars = { nombre: o.name, tienda: cfg.storeName, pedido: o.number };
  const lines = [fillTpl(tx.intro, vars), '', `Pedido: ${o.number}`, `Estado: ${pub.statusLabel}`,
    `Total: $${(o.total / 100).toFixed(2)} MXN`, ''];
  for (const it of pub.items) {
    lines.push(`• ${it.qty} x ${it.name}`);
    for (const c of it.codes) { if (c.manual) { lines.push('   Tu código de activación eSIM te llegará por correo en breve.'); continue; } lines.push(`   Código de activación: ${c.code}`); if (c.lpa) lines.push(`   LPA: ${c.lpa}`); }
  }
  if (pub.tracking) lines.push('', `Guía de envío: ${pub.tracking} ${pub.shipCarrier}`);
  lines.push('', `Ver tu pedido (y el código QR si aplica): ${statusLink(o)}`, '');
  if (tx.instructions.trim()) lines.push(fillTpl(tx.instructions, vars), '');
  lines.push(fillTpl(tx.signature, vars));
  await sendMail(smtp, { to: o.email, subject: `${cfg.storeName} - Pedido ${o.number} (${pub.statusLabel})`, text: lines.join('\n') });
  db.prepare('UPDATE orders SET email_sent_at = ? WHERE id = ?').run(nowIso(), o.id);
  return { sent: true };
}

async function sendSpeiInstructionsEmail(orderId) {
  const smtp = smtpConfig();
  if (!smtp) return { sent: false, reason: 'SMTP no configurado' };
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.payment_method !== 'spei' || o.status !== 'pendiente_pago' || !o.spei_clabe) return { sent: false, reason: 'Sin CLABE pendiente' };
  const cfg = storeConfig();
  const tx = emailTexts(), vars = { nombre: o.name, tienda: cfg.storeName, pedido: o.number };
  const exp = o.spei_expires_at || o.expires_at;
  const expTxt = exp ? new Date(exp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }) : '';
  const lines = [
    fillTpl(tx.intro, vars),
    '',
    `Pedido: ${o.number}`,
    'Estado: Pendiente de pago (transferencia SPEI)',
    `Total a pagar (monto exacto): $${(o.total / 100).toFixed(2)} MXN`,
    '',
    'Datos para tu transferencia SPEI:',
    o.spei_bank ? `Banco: ${o.spei_bank}` : '',
    `CLABE: ${o.spei_clabe}`,
    'Paga el monto exacto desde tu banca en línea. Al recibirlo, confirmamos tu pedido automáticamente.',
    expTxt ? `La CLABE y la reserva vencen el ${expTxt}.` : '',
    '',
    `Ver tu pedido: ${statusLink(o)}`,
    '',
    fillTpl(tx.signature, vars),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  await sendMail(smtp, { to: o.email, subject: `${cfg.storeName} - Datos SPEI de tu pedido ${o.number}`, text: lines.join('\n') });
  return { sent: true };
}

// ---------------------------------------------------------------- HTTP helpers
// Chat de Tidio (opcional): TIDIO_KEY es la "Public Key" del panel de Tidio (no es secreta).
const TIDIO_KEY = /^[A-Za-z0-9]{16,64}$/.test(process.env.TIDIO_KEY || '') ? process.env.TIDIO_KEY : '';
const TD = TIDIO_KEY ? ' https://*.tidio.co https://*.tidio.com' : '';
const TDW = TIDIO_KEY ? ' wss://*.tidio.co wss://*.tidio.com' : '';
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.paypal.com https://*.paypal.com https://*.paypalobjects.com" + TD,
  "style-src 'self' 'unsafe-inline'" + TD,
  "img-src 'self' data: blob: https://*.paypal.com https://*.paypalobjects.com" + TD,
  "connect-src 'self' https://*.paypal.com https://*.paypalobjects.com" + TD + TDW,
  'frame-src https://*.paypal.com https://*.paypalobjects.com' + TD,
  "font-src 'self' data:" + TD,
  "media-src 'self'" + TD,
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
function secHeaders(res, nonce) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const csp = nonce ? CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) : CSP;
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
}
function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length']);
    if (cl > limit) { req.resume(); return reject(new HttpError(413, 'Solicitud demasiado grande')); }
    let size = 0, too = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { too = true; chunks.length = 0; if (size > limit * 4) req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => (too ? reject(new HttpError(413, 'Solicitud demasiado grande')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isHttps(req) { return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || process.env.COOKIE_SECURE === '1'; }
function cookie(req, val, maxAge) { return `sid=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`; }
function getSession(req) {
  const c = parseCookies(req).sid;
  if (!c) return null;
  const i = c.lastIndexOf('.');
  if (i < 1) return null;
  const id = c.slice(0, i), sig = c.slice(i + 1);
  if (!safeEq(sig, sign(id))) return null;
  const s = db.prepare('SELECT s.*, a.username, a.must_change FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = ?').get(id);
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
function newSession(adminId) {
  const id = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(id, admin_id, csrf, expires_at) VALUES(?,?,?,?)').run(id, adminId, csrf, Date.now() + SESSION_TTL);
  return { id, csrf, value: id + '.' + sign(id) };
}

// ---------------------------------------------------------------- Router
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}
const admin = (m, p, h, o = {}) => route(m, p, h, { ...o, admin: true });

// ---- Public API
route('GET', '/api/config', () => {
  const c = storeConfig(), pp = paypalConfig();
  return { ...c, currency: 'MXN', paypal: { enabled: pp.enabled, clientId: PAYPAL_MOCK ? 'test' : pp.enabled ? pp.clientId : '', mode: pp.mode, mock: PAYPAL_MOCK },
    stripe: { enabled: stripeEnabled() },
    conekta: { enabled: conektaEnabled() },
    estados: ESTADOS, reservaMinutos: RESERVA_MIN, reservaManualHoras: RESERVA_MANUAL_H, tidio: TIDIO_KEY };
});
route('GET', '/api/productos', ({ query }) => ({ productos: listProducts(query) }));
route('GET', '/api/productos/:id', ({ params }) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1 AND deleted = 0').get(params.id);
  if (!p) fail(404, 'Producto no encontrado');
  return { producto: productOut(p) };
});
route('POST', '/api/pedidos', async ({ body, ip }) => {
  rateLimit('order:' + ip, IS_TEST ? 1000 : 30, 10 * 60e3);
  const res = createOrder(body);
  if (res.paymentMethod !== 'spei') return res;
  try {
    const o = db.prepare('SELECT * FROM orders WHERE number = ?').get(res.number);
    const att = await attachSpeiPayment(o);
    if (att.first) setImmediate(() => sendSpeiInstructionsEmail(o.id).catch((e) => console.error('[email]', e.message)));
    return { ...res, spei: att.spei };
  } catch (e) {
    if (e instanceof HttpError && e.status >= 500) console.error('[conekta]', e.message);
    else console.error('[conekta]', e && e.message);
    return res;
  }
});
route('GET', '/api/pedidos/estado', ({ query }) => ({ pedido: orderPublic(orderByToken(query.n, query.t), true) }));
route('POST', '/api/pedidos/consulta', ({ body, ip }) => {
  rateLimit('consulta:' + ip, 20, 10 * 60e3);
  const n = str(body.number, { min: 5, max: 40, name: 'Número de pedido' }).toUpperCase();
  const e = str(body.email, { min: 5, max: 160, name: 'Correo' }).toLowerCase();
  const o = db.prepare('SELECT * FROM orders WHERE number = ?').get(n);
  if (!o || !safeEq(o.email, e)) fail(404, 'No encontramos un pedido con esos datos');
  return { pedido: orderPublic(o, false), nota: 'Por seguridad, los códigos eSIM solo se muestran con el enlace privado que recibiste al comprar (o en tu correo). Si lo perdiste, escríbenos por WhatsApp.' };
});
route('POST', '/api/paypal/crear', async ({ body }) => {
  const o = orderByToken(body.number, body.token);
  if (o.payment_method !== 'paypal') fail(400, 'Este pedido no usa PayPal');
  if (o.status !== 'pendiente_pago') fail(409, 'El pedido ya no está pendiente de pago');
  if (o.expires_at < Date.now()) fail(409, 'La reserva de tu pedido expiró. Vuelve a hacer tu pedido.');
  if (o.paypal_order_id) return { id: o.paypal_order_id };
  const r = await paypal().createOrder({ reference: o.number, amount: (o.total / 100).toFixed(2), currency: 'MXN', description: `${storeConfig().storeName} ${o.number}` });
  const u = db.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ? AND paypal_order_id IS NULL').run(r.id, o.id);
  if (!u.changes) return { id: db.prepare('SELECT paypal_order_id FROM orders WHERE id = ?').get(o.id).paypal_order_id };
  return { id: r.id };
});
route('POST', '/api/paypal/capturar', async ({ body }) => {
  let o = orderByToken(body.number, body.token);
  if (o.paid_at) return { ok: true, already: true, status: o.status };
  if (!o.paypal_order_id) fail(400, 'Primero crea el pago con PayPal');
  if (!['pendiente_pago', 'expirado'].includes(o.status)) fail(409, 'El pedido no puede pagarse en su estado actual');
  const result = await paypal().captureOrder(o.paypal_order_id);
  o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  if (o.paid_at) return { ok: true, already: true, status: o.status };
  const v = verifyCapture(result, o);
  if (!v.ok) {
    db.prepare("UPDATE orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?").run(`PayPal rechazado: ${v.reason} (${nowIso()})`, o.id);
    fail(402, 'No se pudo verificar el pago: ' + v.reason);
  }
  const r = confirmPaid(o.id, { captureId: v.captureId, by: 'PayPal' });
  return { ok: true, already: r.already, status: r.order.status };
});
// ---- Stripe Checkout
function stripeBase(req) {
  const pub = publicBase();
  if (pub) return pub;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}
function verifyStripeSession(sess, o) {
  if (!sess || sess.id !== o.stripe_session_id) return { ok: false, reason: 'sesión distinta' };
  if (sess.client_reference_id !== o.number) return { ok: false, reason: 'pedido distinto' };
  if (sess.payment_status !== 'paid') return { ok: false, reason: 'estado ' + sess.payment_status };
  if (String(sess.currency).toLowerCase() !== 'mxn') return { ok: false, reason: 'moneda distinta' };
  if (sess.amount_total !== o.total) return { ok: false, reason: 'monto distinto al total del pedido' };
  return { ok: true, ref: typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.id };
}
route('POST', '/api/stripe/crear', async ({ body, req }) => {
  const o = orderByToken(body.number, body.token);
  if (o.payment_method !== 'stripe') fail(400, 'Este pedido no usa Stripe');
  if (o.status !== 'pendiente_pago') fail(409, 'El pedido ya no está pendiente de pago');
  if (o.expires_at < Date.now()) fail(409, 'La reserva de tu pedido expiró. Vuelve a hacer tu pedido.');
  if (o.stripe_session_id) {
    const prev = await stripeCall((c) => c.retrieveCheckoutSession(o.stripe_session_id)).catch(() => null);
    if (prev && prev.status === 'open' && prev.url) return { url: prev.url };
  }
  const base = stripeBase(req);
  const link = `${base}/gracias.html?n=${encodeURIComponent(o.number)}&t=${encodeURIComponent(o.token)}`;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  const line_items = items.map((it) => ({ quantity: it.qty, price_data: { currency: 'mxn', unit_amount: it.unit_price, product_data: { name: String(it.name).slice(0, 200) } } }));
  if (o.shipping > 0) line_items.push({ quantity: 1, price_data: { currency: 'mxn', unit_amount: o.shipping, product_data: { name: 'Envío' } } });
  const sess = await stripeCall((c) => c.createCheckoutSession({
    mode: 'payment', line_items, client_reference_id: o.number, customer_email: o.email,
    metadata: { order_number: o.number }, payment_intent_data: { metadata: { order_number: o.number } },
    success_url: `${link}&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/gracias.html?n=${encodeURIComponent(o.number)}&t=${encodeURIComponent(o.token)}&cancelado=1`,
  }));
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(sess.id, o.id);
  return { url: sess.url };
});
// El cliente vuelve de Stripe: se consulta la sesión a Stripe (no se confía en la URL) y se confirma el pago.
route('POST', '/api/stripe/confirmar', async ({ body }) => {
  let o = orderByToken(body.number, body.token);
  if (o.paid_at) return { ok: true, already: true, status: o.status };
  if (!o.stripe_session_id) fail(400, 'Este pedido no tiene un pago de Stripe iniciado');
  const sess = await stripeCall((c) => c.retrieveCheckoutSession(o.stripe_session_id));
  if (sess.payment_status !== 'paid') return { ok: false, pending: true, status: o.status };
  o = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  const v = verifyStripeSession(sess, o);
  if (!v.ok) {
    db.prepare("UPDATE orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?").run(`Stripe rechazado: ${v.reason} (${nowIso()})`, o.id);
    fail(402, 'No se pudo verificar el pago: ' + v.reason);
  }
  const r = confirmPaid(o.id, { captureId: null, by: 'Stripe' });
  return { ok: true, already: r.already, status: r.order.status };
});
// Webhook de Stripe: respaldo por si el cliente cierra el navegador antes de volver a la tienda.
route('POST', '/api/stripe/webhook', async ({ rawBody, req }) => {
  if (!STRIPE_WEBHOOK_SECRET) fail(503, 'STRIPE_WEBHOOK_SECRET no configurado');
  if (!verifyWebhook(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) fail(400, 'Firma inválida');
  let ev; try { ev = JSON.parse(rawBody.toString('utf8')); } catch { fail(400, 'JSON inválido'); }
  const sess = ev && ev.data && ev.data.object;
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    const o = sess && db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(sess.id);
    if (o && !o.paid_at) {
      const v = verifyStripeSession(sess, o);
      if (v.ok) confirmPaid(o.id, { by: 'Stripe (webhook)' });
      else db.prepare("UPDATE orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?").run(`Stripe webhook rechazado: ${v.reason} (${nowIso()})`, o.id);
    }
  }
  return { received: true };
}, { raw: true });

function conektaOrderFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.object === 'order' && obj.id) return db.prepare('SELECT * FROM orders WHERE conekta_order_id = ?').get(obj.id) || null;
  if (obj.order_id) return db.prepare('SELECT * FROM orders WHERE conekta_order_id = ?').get(obj.order_id) || null;
  return null;
}
function handleConektaPaid(obj) {
  const o = conektaOrderFromEvent(obj);
  if (!o || o.paid_at) return;
  const currency = String(obj.currency || '').toUpperCase();
  const amount = Number(obj.amount);
  if (currency !== 'MXN' || amount !== o.total) {
    db.prepare("UPDATE orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?")
      .run(`Conekta webhook rechazado: monto o moneda distintos (${nowIso()})`, o.id);
    return;
  }
  confirmPaid(o.id, { by: 'Conekta (webhook)' });
}
function handleConektaExpired(obj) {
  const o = conektaOrderFromEvent(obj);
  if (!o || o.paid_at || o.status !== 'pendiente_pago') return;
  tx(() => {
    const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    if (!cur || cur.paid_at || cur.status !== 'pendiente_pago') return;
    releaseReservation(cur);
    db.prepare("UPDATE orders SET status = 'expirado' WHERE id = ?").run(cur.id);
  });
}
function handleConektaRefunded(obj) {
  const o = conektaOrderFromEvent(obj);
  if (!o) return;
  db.prepare("UPDATE orders SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?")
    .run(`Conekta avisó un reembolso (${nowIso()}). Revísalo en el panel de Conekta y márcalo aquí si aplica.`, o.id);
}

route('POST', '/api/conekta/crear', async ({ body }) => {
  const o = orderByToken(body.number, body.token);
  if (o.payment_method !== 'spei') fail(400, 'Este pedido no usa SPEI');
  if (o.status !== 'pendiente_pago') fail(409, 'El pedido ya no está pendiente de pago');
  if (o.expires_at < Date.now()) fail(409, 'La reserva de tu pedido expiró. Vuelve a hacer tu pedido.');
  const att = await attachSpeiPayment(o);
  if (att.first) setImmediate(() => sendSpeiInstructionsEmail(o.id).catch((e) => console.error('[email]', e.message)));
  if (!att.spei || !att.spei.clabe) fail(502, 'No se pudo obtener la CLABE. Intenta de nuevo.');
  return { ok: true, spei: att.spei };
});
route('POST', '/api/conekta/webhook', async ({ rawBody, req }) => {
  if (!CONEKTA_WEBHOOK_PUBLIC_KEY) fail(503, 'CONEKTA_WEBHOOK_PUBLIC_KEY no configurado');
  const digest = req.headers['digest'] || req.headers['Digest'];
  if (!verifyWebhookSignature(rawBody, digest, CONEKTA_WEBHOOK_PUBLIC_KEY)) fail(400, 'Firma inválida');
  let ev; try { ev = JSON.parse(rawBody.toString('utf8')); } catch { fail(400, 'JSON inválido'); }
  const type = ev && ev.type;
  const obj = ev && ev.data && ev.data.object;
  if (type === 'order.paid') handleConektaPaid(obj);
  else if (type === 'order.expired' || type === 'charge.expired') handleConektaExpired(obj);
  else if (type === 'order.refunded' || type === 'charge.refunded') handleConektaRefunded(obj);
  return { received: true };
}, { raw: true, skipOrigin: true });
route('POST', '/api/contacto', ({ body, ip }) => {
  rateLimit('contact:' + ip, IS_TEST ? 100 : 5, 10 * 60e3);
  const name = str(body.name, { min: 2, max: 100, name: 'Nombre' });
  const email = str(body.email, { min: 5, max: 160, name: 'Correo', re: EMAIL_RE });
  const phone = str(body.phone, { max: 20, name: 'Teléfono', re: PHONE_RE });
  const message = str(body.message, { min: 5, max: 2000, name: 'Mensaje', multiline: true });
  db.prepare('INSERT INTO messages(name, email, phone, message, created_at) VALUES(?,?,?,?,?)').run(name, email, phone, message, nowIso());
  return { ok: true };
});

// ---- Customer accounts (optional registration)
function getCustomerSession(req) {
  const cookies = parseCookies(req);
  const c = cookies.csid;
  if (!c) return null;
  const i = c.lastIndexOf('.');
  if (i < 1) return null;
  const id = c.slice(0, i), sig = c.slice(i + 1);
  if (!safeEq(sig, sign(id))) return null;
  const s = db.prepare('SELECT s.*, c.email, c.name FROM customer_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?').get(id);
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
function newCustomerSession(customerId) {
  const id = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO customer_sessions(id, customer_id, csrf, expires_at) VALUES(?,?,?,?)').run(id, customerId, csrf, Date.now() + SESSION_TTL);
  return { id, csrf, value: id + '.' + sign(id) };
}
function customerCookie(req, val, maxAge) { return `csid=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`; }

route('POST', '/api/cuenta/registro', ({ body, req, res }) => {
  const name = str(body.name, { min: 2, max: 100, name: 'Nombre' });
  const email = str(body.email, { min: 5, max: 160, name: 'Correo', re: EMAIL_RE }).toLowerCase();
  const phone = str(body.phone || '', { max: 20, name: 'Teléfono' });
  const password = String(body.password || '');
  if (password.length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
  const exists = db.prepare('SELECT id, pass_hash FROM customers WHERE email = ?').get(email);
  if (exists && exists.pass_hash) fail(409, 'Ya existe una cuenta con ese correo');
  const hash = hashPassword(password);
  let id;
  if (exists) {
    db.prepare('UPDATE customers SET name = ?, phone = ?, pass_hash = ? WHERE id = ?').run(name, phone || null, hash, exists.id);
    id = exists.id;
  } else {
    id = db.prepare('INSERT INTO customers(email, name, phone, pass_hash, created_at) VALUES(?,?,?,?,?)').run(email, name, phone || null, hash, nowIso()).lastInsertRowid;
  }
  const sess = newCustomerSession(id);
  res.setHeader('Set-Cookie', customerCookie(req, sess.value, Math.floor(SESSION_TTL / 1000)));
  return { ok: true, user: { id, email, name } };
});

route('POST', '/api/cuenta/login', ({ body, req, res }) => {
  const email = str(body.email, { min: 5, max: 160, name: 'Correo', re: EMAIL_RE }).toLowerCase();
  const password = String(body.password || '');
  const c = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  const ok = c && c.pass_hash && verifyPassword(password, c.pass_hash);
  if (!ok) fail(401, 'Correo o contraseña incorrectos');
  const sess = newCustomerSession(c.id);
  res.setHeader('Set-Cookie', customerCookie(req, sess.value, Math.floor(SESSION_TTL / 1000)));
  return { ok: true, user: { id: c.id, email: c.email, name: c.name } };
});

route('POST', '/api/cuenta/logout', ({ req, res }) => {
  const s = getCustomerSession(req);
  if (s) db.prepare('DELETE FROM customer_sessions WHERE id = ?').run(s.id);
  res.setHeader('Set-Cookie', customerCookie(req, '', 0));
  return { ok: true };
});

route('GET', '/api/cuenta/me', ({ req }) => {
  const s = getCustomerSession(req);
  if (!s) return { user: null };
  return { user: { id: s.customer_id, email: s.email, name: s.name } };
});

route('POST', '/api/cuenta/recuperar', async ({ body }) => {
  const email = str(body.email, { min: 5, max: 160, name: 'Correo', re: EMAIL_RE }).toLowerCase();
  const c = db.prepare('SELECT * FROM customers WHERE email = ? AND pass_hash IS NOT NULL').get(email);
  if (!c) return { ok: true, message: 'Si el correo existe, te enviamos instrucciones.' };
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + 3600e3; // 1 hora
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('reset_' + c.id, JSON.stringify({ token, expires }));
  const smtp = smtpConfig();
  if (smtp) {
    const link = (process.env.PUBLIC_URL || 'https://esimgo.mx') + '/restablecer.html?reset=' + token + '&id=' + c.id;
    try {
      await sendMail(smtp, { to: email, subject: 'Restablecer contraseña - ' + storeConfig().storeName, text: `Hola,\n\nPara restablecer tu contraseña visita este enlace (válido por 1 hora):\n${link}\n\nSi no solicitaste esto, ignora este mensaje.` });
    } catch (e) { console.error('[reset]', e.message); }
  }
  return { ok: true, message: 'Si el correo existe, te enviamos instrucciones.' };
});

route('POST', '/api/cuenta/restablecer', ({ body }) => {
  const id = Number(body.id);
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (password.length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('reset_' + id);
  if (!row) fail(400, 'Enlace inválido o expirado');
  const data = JSON.parse(row.value);
  if (data.token !== token || data.expires < Date.now()) fail(400, 'Enlace inválido o expirado');
  db.prepare('UPDATE customers SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id);
  db.prepare("DELETE FROM settings WHERE key = ?").run('reset_' + id);
  return { ok: true };
});

// Rutas SOLO de pruebas. No agregar rutas normales dentro de este bloque: solo se registran con PAYPAL_MOCK=1.
if (PAYPAL_MOCK) {
  // (requieren NODE_ENV=test y PAYPAL_MOCK=1)
  route('POST', '/api/test/paypal-tamper', ({ body }) => { if (mockClient) mockClient._tamper(String(body.id), String(body.value)); return { ok: true }; });
}
if (CONEKTA_MOCK) {
  route('GET', '/api/test/conekta-last', () => {
    const c = conektaClient;
    return { ok: true, payload: c && c.lastPayload ? c.lastPayload : null };
  });
}

// ---- Admin auth
route('GET', '/api/admin/setup', () => ({ needsSetup: db.prepare('SELECT COUNT(*) n FROM admins').get().n === 0, setupTokenRequired: !!process.env.SETUP_TOKEN }));
route('POST', '/api/admin/setup', ({ body, ip }) => {
  rateLimit('setup:' + ip, 10, 15 * 60e3);
  if (!process.env.SETUP_TOKEN) fail(403, 'Configuración inicial deshabilitada');
  if (!safeEq(String(body.token || ''), process.env.SETUP_TOKEN)) fail(403, 'Token de configuración incorrecto');
  const u = str(body.username, { min: 3, max: 40, name: 'Usuario', re: /^[A-Za-z0-9_.-]+$/ });
  const p = String(body.password || '');
  if (p.length < 10 || p.length > 200) fail(400, 'La contraseña debe tener al menos 10 caracteres');
  return tx(() => {
    if (db.prepare('SELECT COUNT(*) n FROM admins').get().n > 0) fail(409, 'Ya existe un administrador');
    db.prepare('INSERT INTO admins(username, pass_hash, must_change, created_at) VALUES(?,?,0,?)').run(u, hashPassword(p), nowIso());
    return { ok: true };
  });
});
route('POST', '/api/admin/login', ({ body, ip, req, res }) => {
  rateLimit('login:' + ip, 10, 15 * 60e3);
  const u = String(body.username || '').slice(0, 60), p = String(body.password || '').slice(0, 200);
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(u);
  const ok = verifyPassword(p, a ? a.pass_hash : DUMMY_HASH);
  if (!ok || !a) fail(401, 'Usuario o contraseña incorrectos');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const s = newSession(a.id);
  res.setHeader('Set-Cookie', cookie(req, s.value, SESSION_TTL / 1000));
  return { ok: true, csrf: s.csrf, mustChange: !!a.must_change, username: a.username };
});
admin('POST', '/api/admin/logout', ({ session, req, res }) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  return { ok: true };
}, { allowMustChange: true });
admin('GET', '/api/admin/me', ({ session }) => ({ username: session.username, csrf: session.csrf, mustChange: !!session.must_change }), { allowMustChange: true });
admin('POST', '/api/admin/password', ({ session, body }) => {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(session.admin_id);
  if (!verifyPassword(String(body.current || ''), a.pass_hash)) fail(400, 'La contraseña actual no es correcta');
  const p = String(body.password || '');
  if (p.length < 10 || p.length > 200) fail(400, 'La nueva contraseña debe tener al menos 10 caracteres');
  if (p === body.current) fail(400, 'La nueva contraseña debe ser distinta');
  db.prepare('UPDATE admins SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(p), a.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND id != ?').run(a.id, session.id);
  return { ok: true };
}, { allowMustChange: true });

// ---- Admin: dashboard
function startOf(kind) {
  const l = new Date(Date.now() + TZ_OFF);
  l.setUTCHours(0, 0, 0, 0);
  if (kind === 'week') l.setUTCDate(l.getUTCDate() - ((l.getUTCDay() + 6) % 7));
  if (kind === 'month') l.setUTCDate(1);
  return new Date(l.getTime() - TZ_OFF).toISOString();
}
admin('GET', '/api/admin/dashboard', () => {
  const sales = (since) => db.prepare("SELECT COALESCE(SUM(total),0) total, COUNT(*) n FROM orders WHERE paid_at >= ? AND status != 'reembolsado'").get(since);
  const todayStart = Date.parse(startOf('day'));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = todayStart - i * 864e5;
    days.push({ date: new Date(from + TZ_OFF).toISOString().slice(0, 10), total: 0, from });
  }
  const rows = db.prepare("SELECT paid_at, total FROM orders WHERE paid_at >= ? AND status != 'reembolsado'").all(new Date(days[0].from).toISOString());
  for (const r of rows) { const t = Date.parse(r.paid_at); for (let i = days.length - 1; i >= 0; i--) if (t >= days[i].from) { days[i].total += r.total; break; } }
  const low = db.prepare('SELECT * FROM products WHERE deleted = 0 AND active = 1').all().map((p) => productOut(p)).filter((p) => p.stock < LOW_STOCK);
  return {
    today: sales(startOf('day')), week: sales(startOf('week')), month: sales(startOf('month')),
    byStatus: db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().map((r) => ({ ...r, label: STATUS_LABEL[r.status] || r.status })),
    daily: days.map(({ date, total }) => ({ date, total })), lowStock: low.map((p) => ({ id: p.id, name: p.name, stock: p.stock, type: p.type })),
    pendingManual: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pendiente_pago' AND payment_method = 'manual'").get().n,
    toShip: db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('pagado','preparando')").get().n,
    messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n, lowStockThreshold: LOW_STOCK,
  };
});

// ---- Admin: products
admin('GET', '/api/admin/productos', ({ query }) => ({ productos: listProducts({ ...query, sort: query.sort || 'recientes' }, true) }));
admin('POST', '/api/admin/productos', ({ body }) => {
  const p = productInput(body);
  const r = db.prepare(`INSERT INTO products(name, carrier, type, price, description, data_amount, validity_days, image, stock, active, featured, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.name, p.carrier, p.type, p.price, p.description, p.data_amount, p.validity_days, p.image || '', p.stock, p.active, p.featured, nowIso());
  return { producto: productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid), true) };
});
admin('PUT', '/api/admin/productos/:id', ({ body, params }) => {
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(params.id);
  if (!cur) fail(404, 'Producto no encontrado');
  const p = productInput(body, true);
  if (p.type && p.type !== cur.type && db.prepare('SELECT COUNT(*) n FROM esim_codes WHERE product_id = ?').get(cur.id).n > 0) fail(400, 'No puedes cambiar el tipo de un producto que tiene códigos eSIM');
  const keys = Object.keys(p);
  if (keys.length) db.prepare(`UPDATE products SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => p[k]), cur.id);
  return { producto: productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(cur.id), true) };
});
admin('DELETE', '/api/admin/productos/:id', ({ params }) => tx(() => {
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(params.id);
  if (!cur) fail(404, 'Producto no encontrado');
  const used = db.prepare("SELECT (SELECT COUNT(*) FROM order_items WHERE product_id = ?) + (SELECT COUNT(*) FROM esim_codes WHERE product_id = ? AND status != 'disponible') n").get(cur.id, cur.id).n;
  if (used) { db.prepare('UPDATE products SET deleted = 1, active = 0 WHERE id = ?').run(cur.id); return { ok: true, archived: true }; }
  db.prepare('DELETE FROM esim_codes WHERE product_id = ?').run(cur.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(cur.id);
  return { ok: true, archived: false };
}));
admin('POST', '/api/admin/upload', ({ body }) => ({ url: '/uploads/' + saveImage(body, UPLOAD_DIR) }), { limit: UPLOAD_LIMIT });

// ---- Admin: inventory
admin('GET', '/api/admin/inventario', ({ query }) => {
  const pid = query.product_id ? int(query.product_id, { min: 1, name: 'Producto' }) : null;
  const summary = db.prepare(`SELECT p.id, p.name, p.carrier,
      SUM(CASE WHEN c.status = 'disponible' THEN 1 ELSE 0 END) disponibles,
      SUM(CASE WHEN c.status = 'reservado' THEN 1 ELSE 0 END) reservados,
      SUM(CASE WHEN c.status = 'asignado' THEN 1 ELSE 0 END) asignados
    FROM products p LEFT JOIN esim_codes c ON c.product_id = p.id WHERE p.type = 'esim' AND p.deleted = 0 GROUP BY p.id ORDER BY p.name`).all();
  let codes = [];
  if (pid) {
    codes = db.prepare(`SELECT c.id, c.code, c.status, c.created_at, c.assigned_at, c.qr_file, o.number order_number
      FROM esim_codes c LEFT JOIN orders o ON o.id = c.reserved_order_id WHERE c.product_id = ? ORDER BY c.status, c.id DESC LIMIT 1000`).all(pid)
      .map((c) => ({ id: c.id, status: c.status, code: c.status === 'disponible' ? c.code : mask(c.code), hasQr: !!c.qr_file,
        createdAt: c.created_at, assignedAt: c.assigned_at, order: c.status === 'disponible' ? '' : c.order_number || '' }));
  }
  return { resumen: summary.map((s) => ({ ...s, disponibles: s.disponibles || 0, reservados: s.reservados || 0, asignados: s.asignados || 0 })), codigos: codes };
});
admin('POST', '/api/admin/inventario', ({ body }) => {
  const pid = int(body.product_id, { min: 1, name: 'Producto' });
  const p = db.prepare("SELECT * FROM products WHERE id = ? AND type = 'esim' AND deleted = 0").get(pid);
  if (!p) fail(400, 'Elige un producto eSIM válido');
  const entries = [];
  if (body.code) entries.push({ code: body.code, lpa: body.lpa || '', qr: body.qr || null });
  if (body.bulk) {
    const lines = String(body.bulk).split(/\r?\n/);
    if (lines.length > 5000) fail(400, 'Máximo 5000 líneas por carga');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const [code, ...rest] = t.split(/[,;\t]/);
      if (/^(codigo|código|code)$/i.test(code.trim())) continue;
      entries.push({ code: code.replace(/^"|"$/g, ''), lpa: rest.join(',').trim().replace(/^"|"$/g, '') });
    }
  }
  if (!entries.length) fail(400, 'No hay códigos para agregar');
  const valid = entries.map((e) => ({ code: str(e.code, { min: 4, max: 300, name: 'Código', re: /^[\x21-\x7e]+$/ }), lpa: str(e.lpa, { max: 500, name: 'LPA' }), qr: e.qr }));
  let added = 0, duplicates = 0;
  tx(() => {
    for (const e of valid) {
      const qr = e.qr ? saveImage(e.qr, QR_DIR) : null;
      const r = db.prepare('INSERT OR IGNORE INTO esim_codes(product_id, code, lpa, qr_file, created_at) VALUES(?,?,?,?,?)').run(pid, e.code, e.lpa || null, qr, nowIso());
      if (r.changes) added++; else duplicates++;
    }
  });
  return { added, duplicates };
}, { limit: UPLOAD_LIMIT });
admin('POST', '/api/admin/inventario-manual', ({ body }) => {
  const qty = int(body.qty, { min: 1, max: 1000, name: 'Cantidad' });
  const products = body.product_id
    ? db.prepare("SELECT id FROM products WHERE id = ? AND type = 'esim' AND deleted = 0").all(int(body.product_id, { min: 1, name: 'Producto' }))
    : db.prepare("SELECT id FROM products WHERE type = 'esim' AND deleted = 0").all();
  if (!products.length) fail(400, 'No hay productos eSIM');
  const ins = db.prepare('INSERT INTO esim_codes(product_id, code, created_at) VALUES(?,?,?)');
  tx(() => { for (const p of products) for (let i = 0; i < qty; i++) ins.run(p.id, MANUAL_PREFIX + p.id + '-' + crypto.randomBytes(6).toString('hex'), nowIso()); });
  return { added: qty * products.length, products: products.length };
});
admin('DELETE', '/api/admin/inventario/:id', ({ params }) => {
  const r = db.prepare("DELETE FROM esim_codes WHERE id = ? AND status = 'disponible'").run(params.id);
  if (!r.changes) fail(400, 'Solo se pueden borrar códigos disponibles');
  return { ok: true };
});

// ---- Admin: orders
function orderAdmin(o) {
  const items = itemsStmt.all(o.id).map((it) => ({ id: it.id, name: it.name, carrier: it.carrier, type: it.type, qty: it.qty, unitPrice: it.unit_price,
    codes: it.type === 'esim' ? codesFor(it.id, false) : [] }));
  return { id: o.id, number: o.number, status: o.status, statusLabel: STATUS_LABEL[o.status] || o.status, name: o.name, email: o.email, phone: o.phone,
    address: o.address ? JSON.parse(o.address) : null, subtotal: o.subtotal, shipping: o.shipping, total: o.total, paymentMethod: o.payment_method,
    paypalOrderId: o.paypal_order_id || '', paypalCaptureId: o.paypal_capture_id || '',
    conektaOrderId: o.conekta_order_id || '', speiClabe: o.spei_clabe || '', speiBank: o.spei_bank || '',
    tracking: o.tracking || '', shipCarrier: o.ship_carrier || '',
    notes: o.notes || '', refundNote: o.refund_note || '', createdAt: o.created_at, paidAt: o.paid_at, emailSentAt: o.email_sent_at,
    expiresAt: o.expires_at ? new Date(o.expires_at).toISOString() : null, items, next: NEXT[o.status] || [] };
}
const NEXT = { pagado: ['preparando', 'enviado'], preparando: ['enviado'], enviado: ['entregado'] };
admin('GET', '/api/admin/pedidos', ({ query }) => {
  const where = [], args = [];
  if (query.status && STATUS_LABEL[query.status]) { where.push('status = ?'); args.push(query.status); }
  if (query.q) { const l = likeArg(query.q); where.push("(number LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); args.push(l, l, l, l); }
  const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args);
  return { pedidos: rows.map((o) => ({ id: o.id, number: o.number, status: o.status, statusLabel: STATUS_LABEL[o.status], name: o.name, email: o.email,
    total: o.total, paymentMethod: o.payment_method, createdAt: o.created_at, paidAt: o.paid_at })), statuses: STATUS_LABEL };
});
const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || fail(404, 'Pedido no encontrado');
admin('GET', '/api/admin/pedidos/:id', ({ params }) => ({ pedido: orderAdmin(getOrder(params.id)), enlace: statusLink(getOrder(params.id)) }));
admin('POST', '/api/admin/pedidos/:id/confirmar', ({ params, session }) => {
  const o = getOrder(params.id);
  if (o.payment_method !== 'manual' && !o.paid_at) fail(400, 'Los pedidos PayPal, Stripe y SPEI se confirman automáticamente al pagar');
  const r = confirmPaid(o.id, { by: 'admin ' + session.username });
  const filled = r.already ? fillMissingCodes(o.id) : 0;
  return { ok: true, already: r.already, filled, problems: r.problems || [], pedido: orderAdmin(getOrder(o.id)) };
});
admin('POST', '/api/admin/pedidos/:id/estado', ({ params, body }) => {
  const o = getOrder(params.id);
  const st = String(body.status || '');
  if (!(NEXT[o.status] || []).includes(st)) fail(400, `No se puede pasar de "${STATUS_LABEL[o.status]}" a "${STATUS_LABEL[st] || st}"`);
  let tracking = o.tracking, shipCarrier = o.ship_carrier;
  if (st === 'enviado') {
    tracking = str(body.tracking, { min: 4, max: 80, name: 'Número de guía' });
    shipCarrier = str(body.shipCarrier, { max: 60, name: 'Paquetería' });
  }
  db.prepare('UPDATE orders SET status = ?, tracking = ?, ship_carrier = ? WHERE id = ?').run(st, tracking, shipCarrier, o.id);
  if (st === 'enviado') setImmediate(() => sendDeliveryEmail(o.id, true).catch((e) => console.error('[email]', e.message)));
  return { ok: true, pedido: orderAdmin(getOrder(o.id)) };
});
admin('POST', '/api/admin/pedidos/:id/cancelar', ({ params }) => {
  tx(() => {
    const o = getOrder(params.id);
    if (!['pendiente_pago', 'expirado'].includes(o.status)) fail(400, 'Solo se pueden cancelar pedidos no pagados');
    releaseReservation(o);
    db.prepare("UPDATE orders SET status = 'cancelado' WHERE id = ?").run(o.id);
  });
  return { ok: true, pedido: orderAdmin(getOrder(params.id)) };
});
admin('POST', '/api/admin/pedidos/:id/reembolso', ({ params, body }) => {
  const o = getOrder(params.id);
  if (!o.paid_at) fail(400, 'El pedido no está pagado');
  const note = str(body.note, { min: 3, max: 1000, name: 'Nota de reembolso', multiline: true });
  db.prepare("UPDATE orders SET status = 'reembolsado', refund_note = ? WHERE id = ?").run(`${note} (${nowIso()})`, o.id);
  return { ok: true, pedido: orderAdmin(getOrder(o.id)) };
});
admin('POST', '/api/admin/pedidos/:id/nota', ({ params, body }) => {
  const o = getOrder(params.id);
  db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(str(body.notes, { max: 4000, name: 'Notas', multiline: true }), o.id);
  return { ok: true };
});
admin('POST', '/api/admin/pedidos/:id/reenviar', async ({ params }) => {
  const o = getOrder(params.id);
  if (!o.paid_at) fail(400, 'El pedido no está pagado');
  if (!smtpConfig()) fail(400, 'El correo (SMTP) no está configurado. Comparte al cliente su enlace privado del pedido.', { link: statusLink(o) });
  try { return await sendDeliveryEmail(o.id, true); } catch (e) { fail(502, 'Error al enviar correo: ' + e.message); }
});

// ---- Admin: customers & messages
admin('GET', '/api/admin/clientes', () => ({
  clientes: db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.created_at createdAt, COUNT(o.id) pedidos,
      COALESCE(SUM(CASE WHEN o.paid_at IS NOT NULL AND o.status != 'reembolsado' THEN o.total ELSE 0 END), 0) gastado
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id DESC LIMIT 1000`).all(),
}));
admin('GET', '/api/admin/mensajes', () => ({ mensajes: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 300').all() }));
admin('DELETE', '/api/admin/mensajes/:id', ({ params }) => { db.prepare('DELETE FROM messages WHERE id = ?').run(params.id); return { ok: true }; });

// ---- Admin: settings
admin('GET', '/api/admin/ajustes', () => {
  const pp = paypalConfig(), smtp = smtpConfig();
  return { ...storeConfig(), email: emailTexts(), emailDefaults: DEFAULT_EMAIL, paypal: { mode: pp.mode, clientId: pp.clientId || '', secretSet: !!pp.secret, secretMasked: pp.secret ? '••••••••' + pp.secret.slice(-4) : '',
    fromEnv: pp.fromEnv, mock: PAYPAL_MOCK }, smtp: { configured: !!smtp, host: smtp ? smtp.host : '', from: smtp ? smtp.from : '' }, telegram: { configured: telegramEnabled() } };
});
admin('PUT', '/api/admin/ajustes', ({ body }) => {
  const sets = [];
  if (body.storeName !== undefined) sets.push(['store_name', str(body.storeName, { min: 2, max: 80, name: 'Nombre de la tienda' })]);
  if (body.logo !== undefined) sets.push(['logo', str(body.logo, { max: 80, name: 'Logotipo', re: /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/ })]);
  if (body.banners === undefined && body.banner !== undefined) body.banners = body.banner ? [body.banner] : [];
  if (body.banners !== undefined) {
    if (!Array.isArray(body.banners) || body.banners.length > MAX_BANNERS) fail(400, 'Máximo ' + MAX_BANNERS + ' imágenes en el banner');
    const l = body.banners.map((x) => str(x, { max: 80, name: 'Banner', re: BANNER_RE }));
    sets.push(['banners', JSON.stringify(l)], ['banner', l[0] || '']);
  }
  if (body.contactEmail !== undefined) sets.push(['contact_email', str(body.contactEmail, { max: 160, name: 'Correo de contacto', re: EMAIL_RE })]);
  if (body.whatsapp !== undefined) sets.push(['whatsapp', str(body.whatsapp, { max: 20, name: 'WhatsApp (solo dígitos con lada, ej. 5215512345678)', re: /^\+?[0-9]{10,15}$/ }).replace('+', '')]);
  if (body.shippingCost !== undefined) sets.push(['shipping_cost', pesosToCents(body.shippingCost, 'Costo de envío')]);
  if (body.bankInfo !== undefined) sets.push(['bank_info', str(body.bankInfo, { max: 2000, name: 'Instrucciones de pago', multiline: true })]);
  for (const [k, col, nm, min] of [['emailIntro', 'email_intro', 'Texto inicial del correo', 1], ['emailInstructions', 'email_instructions', 'Instrucciones del correo', 0], ['emailSignature', 'email_signature', 'Firma del correo', 1]])
    if (body[k] !== undefined) sets.push([col, str(body[k], { min, max: 2000, name: nm, multiline: true })]);
  if (body.paypal && typeof body.paypal === 'object') {
    const b = body.paypal;
    const touches = b.clientId !== undefined || b.secret || b.clearSecret || b.mode !== undefined;
    if (touches && paypalConfig().fromEnv) fail(400, 'PayPal está configurado por variables de entorno; cámbialo en Railway');
    if (b.mode !== undefined) sets.push(['paypal_mode', b.mode === 'live' ? 'live' : 'sandbox']);
    if (b.clientId !== undefined) sets.push(['paypal_client_id', str(b.clientId, { max: 200, name: 'Client ID', re: /^[A-Za-z0-9_-]+$/ })]);
    if (b.secret) sets.push(['paypal_secret', str(b.secret, { max: 200, name: 'Secret', re: /^[A-Za-z0-9_-]+$/ })]);
    if (b.clearSecret) sets.push(['paypal_secret', '']);
  }
  tx(() => { for (const [k, v] of sets) setSetting(k, v); });
  return { ok: true };
});
admin('POST', '/api/admin/smtp-test', async ({ body }) => {
  const smtp = smtpConfig();
  if (!smtp) fail(400, 'SMTP no configurado. Define SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y SMTP_FROM en Railway.');
  const to = str(body.to, { min: 5, max: 160, name: 'Correo destino', re: EMAIL_RE });
  try { await sendMail(smtp, { to, subject: `${storeConfig().storeName}: prueba de correo`, text: 'Si recibes este mensaje, el correo de la tienda funciona correctamente.' }); }
  catch (e) { fail(502, 'Error SMTP: ' + e.message); }
  return { ok: true };
});
admin('GET', '/api/admin/respaldo', ({ res }) => {
  // Copia consistente de la base (VACUUM INTO) + carpeta de imágenes, empaquetadas en .tar.gz
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldo-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try { db.exec(`VACUUM INTO '${path.join(tmp, 'store.db').replace(/'/g, "''")}'`); }
  catch (e) { cleanup(); fail(500, 'No se pudo copiar la base de datos: ' + e.message); }
  const args = ['-czf', '-', '-C', tmp, 'store.db'];
  if (fs.existsSync(UPLOAD_DIR)) args.push('-C', DATA_DIR, 'uploads');
  const tar = require('node:child_process').spawn('tar', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const name = `respaldo-tienda-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  tar.stdout.pipe(res);
  tar.on('error', (e) => { console.error('[respaldo]', e.message); res.destroy(); cleanup(); });
  tar.on('close', cleanup);
  res.on('close', () => { tar.kill(); });
});
admin('POST', '/api/admin/telegram-test', async () => {
  if (!telegramEnabled()) fail(400, 'Telegram no configurado. Define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Railway.');
  try { await tgSend(`${storeConfig().storeName}: prueba de avisos por Telegram. Si lees esto, funciona.`); }
  catch (e) { fail(502, 'Error Telegram: ' + e.message); }
  return { ok: true };
});
admin('POST', '/api/admin/paypal-test', async () => {
  if (PAYPAL_MOCK) return { ok: true, mock: true };
  const c = paypalConfig();
  if (!c.enabled) fail(400, 'Falta Client ID o Secret');
  try { await createPayPalClient(c).createOrder({ reference: 'PRUEBA-' + Date.now(), amount: '1.00', currency: 'MXN', description: 'Prueba de conexión (no se cobra)' }); }
  catch (e) { fail(502, e.message); }
  return { ok: true, mode: c.mode };
});

// ---------------------------------------------------------------- HTML público (SEO)
const CARRIER_COLORS = { Telcel: '#0033a0', 'AT&T': '#00a8e0', Bait: '#d39e00', Movistar: '#5bc500', Unefon: '#c9a600', Virgin: '#cc0000', Otro: '#6b7280' };
const PAGE_SEO = {
  'index.html': {
    title: (n) => `eSIM y chips para México | Telcel, AT&T, Bait y más | ${n}`,
    description: 'Compra eSIM y chips SIM de Telcel, AT&T, Bait, Movistar y Unefon para México. Pago con PayPal, tarjeta o transferencia. Precios en pesos (MXN).',
    path: '/',
  },
  'productos.html': {
    title: (n) => `Catálogo de eSIM y chips: Telcel, AT&T, Bait, Movistar y Unefon | ${n}`,
    description: 'Catálogo de eSIM y chips físicos para México: Telcel, AT&T, Bait, Movistar y Unefon. Compara datos, vigencia y precios en MXN.',
    path: '/productos.html',
  },
  'contacto.html': {
    title: (n) => `Contacto | ${n}`,
    description: 'Contacto para dudas sobre eSIM, chips SIM, pedidos y envíos en México. Escríbenos por el formulario o por WhatsApp.',
    path: '/contacto.html',
  },
  'carrito.html': {
    title: (n) => `Carrito | ${n}`,
    description: 'Revisa tu carrito de eSIM y chips SIM antes de pagar. Precios en pesos mexicanos (MXN).',
    path: '/carrito.html',
    noindex: true,
  },
  'checkout.html': {
    title: (n) => `Pago | ${n}`,
    description: 'Completa tus datos y paga tu eSIM o chip SIM con PayPal, tarjeta o transferencia SPEI.',
    path: '/checkout.html',
    noindex: true,
  },
  'estado.html': {
    title: (n) => `Estado de mi pedido | ${n}`,
    description: 'Consulta el estado de tu pedido, la guía de envío y tus códigos eSIM.',
    path: '/estado.html',
    noindex: true,
  },
  'gracias.html': {
    title: (n) => `Gracias por tu compra | ${n}`,
    description: 'Tu pedido quedó registrado. Consulta el pago y, cuando aplica, tus códigos eSIM.',
    path: '/gracias.html',
    noindex: true,
  },
  'aviso-privacidad.html': {
    title: (n) => `Aviso de privacidad | ${n}`,
    description: 'Plantilla de aviso de privacidad. El titular de la tienda debe completar los datos marcados antes de publicarla como texto vigente.',
    path: '/aviso-privacidad.html',
  },
  'terminos.html': {
    title: (n) => `Términos y condiciones | ${n}`,
    description: 'Plantilla de términos y condiciones de compra. El titular de la tienda debe completar los datos marcados antes de publicarla como texto vigente.',
    path: '/terminos.html',
  },
  'devoluciones.html': {
    title: (n) => `Política de devoluciones | ${n}`,
    description: 'Política de devoluciones y reembolsos de eSIM, chips físicos y electrónicos.',
    path: '/devoluciones.html',
  },
  'guias/index.html': {
    title: (n) => `Guías de eSIM y chips en México | ${n}`,
    description: 'Guías para entender la eSIM, activarla en iPhone y Android, saber si tu celular es compatible y qué significa un chip registrado y vinculado en México.',
    path: '/guias',
  },
  'guias/que-es-una-esim-mexico.html': {
    title: (n) => `Qué es una eSIM y cómo funciona en México | ${n}`,
    description: 'Una eSIM es un chip digital en tu celular. Te explicamos cómo funciona en México, qué necesitas y en qué se diferencia del chip físico.',
    path: '/guias/que-es-una-esim-mexico.html',
  },
  'guias/como-activar-esim-iphone-android.html': {
    title: (n) => `Cómo activar una eSIM en iPhone y Android | ${n}`,
    description: 'Pasos para activar una eSIM en iPhone, Samsung y Android con el código QR. Qué hacer antes de instalarla y cómo revisar si ya quedó con datos.',
    path: '/guias/como-activar-esim-iphone-android.html',
  },
  'guias/celulares-compatibles-esim-mexico.html': {
    title: (n) => `Celulares compatibles con eSIM en México | ${n}`,
    description: 'Cómo saber si tu celular es compatible con eSIM en México: busca el EID, revisa iPhone, Samsung y Android, y consulta las listas de cada compañía.',
    path: '/guias/celulares-compatibles-esim-mexico.html',
  },
  'guias/chip-registrado-y-vinculado.html': {
    title: (n) => `Chip registrado y vinculado: qué significa | ${n}`,
    description: 'Qué significa que un chip o eSIM esté registrado y vinculado en México, cómo funciona el registro con CURP y qué pasa si la línea no se vincula.',
    path: '/guias/chip-registrado-y-vinculado.html',
  },
  'producto.html': {
    title: (n) => `Producto | ${n}`,
    description: 'Detalle, precio en MXN y descripción del producto.',
    path: '/producto.html',
  },
  '404.html': {
    title: (n) => `Página no encontrada | ${n}`,
    description: 'La página que buscas no existe o ya no está disponible.',
    noindex: true,
    skipCanonical: true,
  },
};
function siteOrigin() {
  const pub = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(pub)) return pub;
  return 'https://www.esimgo.mx';
}
function absoluteUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return siteOrigin() + (String(p).startsWith('/') ? p : '/' + p);
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeBasic(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function formatMxn(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  const pesos = Math.floor(n / 100);
  const cent = String(n % 100).padStart(2, '0');
  const body = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + body + '.' + cent + ' MXN';
}
function metaDesc(text, fallback) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const s = clean || fallback;
  if (s.length <= 160) return s;
  const cut = s.slice(0, 157);
  const sp = cut.lastIndexOf(' ');
  return (sp > 80 ? cut.slice(0, sp) : cut).trim() + '…';
}
function dimAttrs(p) {
  const w = Number(p.imageWidth), h = Number(p.imageHeight);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return '';
  return ` width="${w}" height="${h}"`;
}
function productCardHtml(p) {
  const color = CARRIER_COLORS[p.carrier] || '#475569';
  const href = 'producto.html?id=' + p.id;
  const img = p.image ? `<img src="${escHtml(p.image)}" alt="${escHtml(p.name)}"${dimAttrs(p)} loading="lazy" decoding="async">` : '';
  const tags = [
    `<span class="tag ${p.type === 'esim' ? 'esim' : 'sim'}">${TYPE_LABEL[p.type] || 'SIM física'}</span>`,
    p.validityDays ? `<span class="tag">${escHtml(String(p.validityDays))} días</span>` : '',
    /\[EJEMPLO\]/.test(p.name) ? '<span class="tag example">Ejemplo</span>' : '',
    p.stock < 1 ? '<span class="tag out">Agotado</span>' : '',
  ].filter(Boolean).join('');
  const caption = escHtml(p.carrier) + (p.dataAmount ? ' · ' + escHtml(p.dataAmount) : '');
  return `<article class="card"><a href="${href}"><div class="thumb" style="--c:${color}"><span>${caption}</span>${img}</div></a><div class="body"><div class="meta">${tags}</div><h3><a href="${href}">${escHtml(p.name)}</a></h3><div class="price">${escHtml(formatMxn(p.price))}</div><div class="actions"><a class="btn sm secondary" href="${href}">Ver detalle</a></div></div></article>`;
}
function productDetailHtml(p) {
  const kind = p.type === 'esim' ? 'eSIM (digital)' : p.type === 'electronicos' ? 'Electrónicos' : 'SIM física (chip)';
  const bits = [];
  if (p.dataAmount) bits.push(`<li>Datos: ${escHtml(p.dataAmount)}</li>`);
  if (p.validityDays) bits.push(`<li>Vigencia: ${escHtml(String(p.validityDays))} días</li>`);
  bits.push(`<li>${p.type === 'esim' ? 'Entrega: inmediata por código QR al confirmar tu pago' : 'Entrega: envío a domicilio con número de guía'}</li>`);
  bits.push(`<li>${p.stock > 0 ? 'Disponible' : 'Agotado'}</li>`);
  const color = CARRIER_COLORS[p.carrier] || '#475569';
  const img = p.image ? `<img src="${escHtml(p.image)}" alt="${escHtml(p.name)}"${dimAttrs(p)} loading="eager" decoding="async" fetchpriority="high">` : '';
  const caption = escHtml(p.carrier) + (p.dataAmount ? ' · ' + escHtml(p.dataAmount) : '');
  return `<div class="product-detail"><div class="thumb" style="--c:${color}"><span>${caption}</span>${img}</div><div><p class="meta"><span class="tag ${p.type === 'esim' ? 'esim' : 'sim'}">${kind}</span> <span class="tag">${escHtml(p.carrier)}</span></p><h1>${escHtml(p.name)}</h1><p class="price">${escHtml(formatMxn(p.price))}</p><p class="muted">Precio con IVA incluido.</p><ul>${bits.join('')}</ul><p class="product-desc">${escHtml(p.description || '')}</p></div></div>`;
}
function featuredProducts() {
  let list = listProducts({ featured: '1' });
  if (!list.length) list = listProducts({});
  return list.slice(0, 8);
}
let faqCache = null;
function homeFaq() {
  if (faqCache) return faqCache;
  let html = '';
  try { html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); } catch { html = ''; }
  const out = [];
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g;
  let m;
  while ((m = re.exec(html))) out.push({ q: decodeBasic(m[1].trim()), a: decodeBasic(m[2].trim()) });
  faqCache = out;
  return out;
}
function homeJsonLd(cfg) {
  const org = {
    '@type': ['Store', 'Organization'],
    name: cfg.storeName,
    url: absoluteUrl('/'),
    currenciesAccepted: 'MXN',
    areaServed: { '@type': 'Country', name: 'México' },
    logo: absoluteUrl(cfg.logo && FILE_RE.test(cfg.logo) ? '/uploads/' + cfg.logo : '/img/favicon.svg'),
    sameAs: ['https://www.facebook.com/profile.php?id=61596325626434'],
  };
  const pay = [];
  if (paypalConfig().enabled) pay.push('PayPal');
  if (stripeEnabled()) pay.push('Tarjeta');
  pay.push('Transferencia SPEI');
  org.paymentAccepted = pay.join(', ');
  if (cfg.contactEmail) org.email = cfg.contactEmail;
  if (cfg.whatsapp) org.telephone = '+' + String(cfg.whatsapp).replace(/\D/g, '');
  const graph = [org];
  const faqs = homeFaq();
  if (faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}
function productJsonLd(p, storeName, url) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: String(p.description || `${p.name}. ${p.carrier}.`).slice(0, 5000),
    sku: String(p.id),
    brand: { '@type': 'Brand', name: p.carrier },
    category: p.type === 'esim' ? 'eSIM' : p.type === 'electronicos' ? 'Electrónicos' : 'SIM',
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'MXN',
      price: (Number(p.price) / 100).toFixed(2),
      availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: storeName },
    },
  };
  if (p.image) data.image = [absoluteUrl(p.image)];
  return data;
}
function fillSlot(html, slot, inner) {
  const re = new RegExp(`<!--ssr:${slot}-->[\\s\\S]*?<!--/ssr:${slot}-->`);
  if (!re.test(html)) return html;
  return html.replace(re, () => `<!--ssr:${slot}-->${inner}<!--/ssr:${slot}-->`);
}
function markSsr(html, id) {
  return html.replace(`id="${id}"`, `id="${id}" data-ssr="1"`);
}
function setTitle(html, title) {
  const tag = `<title>${escHtml(title)}</title>`;
  if (/<title>[\s\S]*?<\/title>/.test(html)) return html.replace(/<title>[\s\S]*?<\/title>/, () => tag);
  return html.replace('</head>', tag + '\n</head>');
}
function setMeta(html, name, content) {
  const tag = `<meta name="${name}" content="${escHtml(content)}">`;
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="[^"]*"\\s*>`, 'i');
  if (re.test(html)) return html.replace(re, () => tag);
  return html.replace('</head>', tag + '\n</head>');
}
function shareImage(cfg) {
  if (cfg.logo && FILE_RE.test(cfg.logo)) return absoluteUrl('/uploads/' + cfg.logo);
  return absoluteUrl('/img/favicon.svg');
}
function buildHead({ title, description, canonical, image, name, jsonLd, nonce, ogType }) {
  const lines = ['<link rel="icon" href="/favicon.ico" sizes="any">'];
  if (canonical) lines.push(`<link rel="canonical" href="${escHtml(canonical)}">`);
  lines.push(`<meta property="og:type" content="${ogType || 'website'}">`);
  lines.push('<meta property="og:locale" content="es_MX">');
  lines.push(`<meta property="og:site_name" content="${escHtml(name)}">`);
  lines.push(`<meta property="og:title" content="${escHtml(title)}">`);
  if (description) lines.push(`<meta property="og:description" content="${escHtml(description)}">`);
  if (canonical) lines.push(`<meta property="og:url" content="${escHtml(canonical)}">`);
  if (image) lines.push(`<meta property="og:image" content="${escHtml(image)}">`);
  lines.push('<meta name="twitter:card" content="summary_large_image">');
  lines.push(`<meta name="twitter:title" content="${escHtml(title)}">`);
  if (description) lines.push(`<meta name="twitter:description" content="${escHtml(description)}">`);
  if (image) lines.push(`<meta name="twitter:image" content="${escHtml(image)}">`);
  if (jsonLd) {
    const json = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
    const n = nonce ? ` nonce="${escHtml(nonce)}"` : '';
    lines.push(`<script type="application/ld+json"${n}>${json}</script>`);
  }
  return lines.join('\n');
}
function renderPublicHtml(file, opts = {}) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const cfg = storeConfig();
  const name = cfg.storeName || 'eSIMGO.MX';
  html = html.replaceAll('{tienda}', () => escHtml(name));
  const seo = PAGE_SEO[file] || {};
  let title = seo.title ? seo.title(name) : '';
  let description = seo.description || '';
  let canonicalPath = seo.path || '/' + file;
  let image = shareImage(cfg);
  let jsonLd = null;
  let ogType = 'website';
  if (file === 'index.html') {
    const list = featuredProducts();
    html = fillSlot(html, 'featured', list.length ? list.map(productCardHtml).join('') : '<p class="muted">Pronto agregaremos productos.</p>');
    html = markSsr(html, 'featured');
    jsonLd = homeJsonLd(cfg);
  }
  if (file === 'productos.html') {
    const list = listProducts({});
    const count = list.length === 1 ? '1 producto' : list.length + ' productos';
    html = fillSlot(html, 'count', escHtml(count));
    html = fillSlot(html, 'list', list.length ? list.map(productCardHtml).join('') : '<p class="muted">Pronto agregaremos productos.</p>');
    html = markSsr(html, 'list');
  }
  if (opts.product) {
    const p = opts.product;
    title = `${p.name} | ${name}`;
    description = metaDesc(p.description, `${p.name} de ${p.carrier}. Precio ${formatMxn(p.price)}.`);
    canonicalPath = '/producto.html?id=' + p.id;
    html = fillSlot(html, 'detail', productDetailHtml(p));
    html = markSsr(html, 'detail');
    if (p.image) image = absoluteUrl(p.image);
    jsonLd = productJsonLd(p, name, absoluteUrl(canonicalPath));
    ogType = 'product';
  }
  if (opts.message) html = fillSlot(html, 'message', escHtml(opts.message));
  if (!title) {
    const m = /<title>([^<]*)<\/title>/.exec(html);
    title = m ? decodeBasic(m[1]) : name;
  }
  if (!description) {
    const m = /<meta name="description" content="([^"]*)">/.exec(html);
    description = m ? decodeBasic(m[1]) : '';
  }
  html = setTitle(html, title);
  if (description) html = setMeta(html, 'description', description);
  if (opts.noindex || seo.noindex) html = setMeta(html, 'robots', 'noindex');
  const skipCanonical = opts.skipCanonical || seo.skipCanonical;
  const canonical = skipCanonical ? '' : absoluteUrl(canonicalPath);
  const head = buildHead({ title, description, canonical, image, name, jsonLd, nonce: opts.nonce, ogType });
  return html.replace('</head>', () => head + '\n</head>');
}
function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}
function fileLastmod(rel) {
  try { return ymd(fs.statSync(path.join(PUBLIC_DIR, rel)).mtime); } catch { return ymd(new Date()); }
}
function sitemapXml(base) {
  const pages = [
    ['/', 'index.html'],
    ['/productos.html', 'productos.html'],
    ['/contacto.html', 'contacto.html'],
    ['/aviso-privacidad.html', 'aviso-privacidad.html'],
    ['/terminos.html', 'terminos.html'],
    ['/devoluciones.html', 'devoluciones.html'],
    ['/guias', 'guias/index.html'],
    ['/guias/que-es-una-esim-mexico.html', 'guias/que-es-una-esim-mexico.html'],
    ['/guias/como-activar-esim-iphone-android.html', 'guias/como-activar-esim-iphone-android.html'],
    ['/guias/celulares-compatibles-esim-mexico.html', 'guias/celulares-compatibles-esim-mexico.html'],
    ['/guias/chip-registrado-y-vinculado.html', 'guias/chip-registrado-y-vinculado.html'],
  ];
  const urls = pages.map(([loc, file]) => ({ loc: base + loc, lastmod: fileLastmod(file) }));
  for (const row of db.prepare('SELECT id, created_at FROM products WHERE active = 1 AND deleted = 0 ORDER BY id').all()) {
    urls.push({ loc: base + '/producto.html?id=' + row.id, lastmod: ymd(row.created_at) });
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `<url><loc>${xmlEsc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n') + '\n</urlset>\n';
}
function warmImageCache() {
  let names = [];
  try { names = fs.readdirSync(UPLOAD_DIR); } catch { return; }
  for (const name of names) {
    if (!FILE_RE.test(name) || name.endsWith('.gif')) continue;
    try { optimizeFile(path.join(UPLOAD_DIR, name)); } catch (e) { console.error('[img]', name, e.message); }
  }
}

// ---------------------------------------------------------------- Static
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
function sendHtml(req, res, status, html) {
  const body = Buffer.from(html, 'utf8');
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': status === 200 ? 'no-cache' : 'no-store' };
  if (status === 404) headers['X-Robots-Tag'] = 'noindex';
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
function notFound(req, res, message) {
  let html;
  try {
    html = renderPublicHtml('404.html', { nonce: req && req.seoNonce, message, noindex: true, skipCanonical: true });
  } catch (e) {
    console.error('[404]', e.message);
    html = '<!doctype html><html lang="es-MX"><meta charset="utf-8"><title>Página no encontrada</title><p>Página no encontrada. <a href="/">Ir al inicio</a></p></html>';
  }
  sendHtml(req, res, 404, html);
}
function serveFile(req, res, root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return notFound(req, res); }
  if (p.includes('\0') || p.includes('\\')) return notFound(req, res);
  if (p.endsWith('/')) p += 'index.html';
  const rel = path.posix.normalize('/' + p);
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return notFound(req, res);
  const full = path.resolve(root, '.' + rel);
  if (!full.startsWith(root + path.sep)) return notFound(req, res);
  fs.stat(full, (err, st) => {
    if (err) return notFound(req, res);
    if (st.isDirectory()) { res.writeHead(301, { Location: '/' }); return res.end(); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}
function acceptsWebp(req) {
  return /image\/webp/i.test(String(req.headers.accept || ''));
}
function serveUpload(req, res, name) {
  if (!FILE_RE.test(name)) return notFound(req, res);
  const orig = path.join(UPLOAD_DIR, name);
  const side = orig + '.webp';
  const useWebp = acceptsWebp(req) && fs.existsSync(side);
  fs.readFile(useWebp ? side : orig, (err, buf) => {
    if (err) return notFound(req, res);
    res.writeHead(200, { 'Content-Type': useWebp ? 'image/webp' : IMG_TYPES[name.split('.').pop()], 'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400', 'Vary': 'Accept',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Content-Disposition': 'inline' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ---------------------------------------------------------------- Main handler
async function handle(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  req.seoNonce = nonce;
  secHeaders(res, nonce);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { error: 'URL inválida' }); }
  const p = url.pathname;
  const host = String(req.headers.host || '');
  if (!lastBase && /^[A-Za-z0-9.:-]+$/.test(host) && !/^(localhost|127\.|0\.0\.0\.0)/.test(host)) lastBase = (isHttps(req) ? 'https://' : 'http://') + host;
  if (p === '/health') return json(res, 200, { ok: true, status: 'ok', uptime: Math.round(process.uptime()), time: nowIso() });
  if (p.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido' });
  if (p.startsWith('/uploads/')) return serveUpload(req, res, p.slice(9));
  if (p === '/robots.txt' || p === '/sitemap.xml') {
    const fh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const h = /^[A-Za-z0-9.:-]+$/.test(fh) ? fh : (/^[A-Za-z0-9.:-]+$/.test(host) ? host : '');
    const base = publicBase() || (h ? (isHttps(req) ? 'https://' : 'http://') + h : '');
    let body, type;
    if (p === '/robots.txt') {
      type = 'text/plain; charset=utf-8';
      body = 'User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: /carrito.html\nDisallow: /checkout.html\nDisallow: /gracias.html\nDisallow: /estado.html\n' + (base ? `\nSitemap: ${base}/sitemap.xml\n` : '');
    } else {
      type = 'application/xml; charset=utf-8';
      body = sitemapXml(base);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (p === '/admin') { res.writeHead(301, { Location: '/admin/' }); return res.end(); }
  if (p.startsWith('/admin/')) return serveFile(req, res, ADMIN_DIR, p.slice(6));
  if (p === '/index.html') {
    res.writeHead(301, { Location: '/' + url.search, 'Cache-Control': 'public, max-age=86400' });
    return res.end();
  }
  if (p === '/guias/' || p === '/guias/index.html') {
    res.writeHead(301, { Location: '/guias' + url.search, 'Cache-Control': 'public, max-age=86400' });
    return res.end();
  }
  try { notifyVisit(req, p); } catch (e) { console.error('[visita]', e.message); }
  if (p === '/guias') {
    try { return sendHtml(req, res, 200, renderPublicHtml('guias/index.html', { nonce })); }
    catch (e) { console.error('[html]', e); return notFound(req, res); }
  }
  if (/^\/guias\/[A-Za-z0-9._-]+\.html$/.test(p)) {
    const file = p.slice(1);
    if (!fs.existsSync(path.join(PUBLIC_DIR, file))) return notFound(req, res);
    try { return sendHtml(req, res, 200, renderPublicHtml(file, { nonce })); }
    catch (e) { console.error('[html]', e); return notFound(req, res); }
  }
  if (p === '/producto.html') {
    const idRaw = url.searchParams.get('id');
    const id = /^\d{1,15}$/.test(idRaw || '') ? Number(idRaw) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return notFound(req, res, 'No encontramos ese producto. Revisa el enlace o vuelve al catálogo.');
    const row = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1 AND deleted = 0').get(id);
    if (!row) return notFound(req, res, 'Este producto no existe o ya no está disponible.');
    try { return sendHtml(req, res, 200, renderPublicHtml('producto.html', { nonce, product: productOut(row) })); }
    catch (e) { console.error('[html]', e); return notFound(req, res); }
  }
  if (p === '/' || /^\/[A-Za-z0-9._-]+\.html$/.test(p)) {
    const file = p === '/' ? 'index.html' : p.slice(1);
    if (!fs.existsSync(path.join(PUBLIC_DIR, file))) return notFound(req, res);
    const status = file === '404.html' ? 404 : 200;
    try { return sendHtml(req, res, status, renderPublicHtml(file, { nonce })); }
    catch (e) { console.error('[html]', e); return notFound(req, res); }
  }
  return serveFile(req, res, PUBLIC_DIR, p);
}
async function handleApi(req, res, url) {
  const p = url.pathname;
  let found = null, methodMismatch = false;
  for (const r of routes) {
    const m = r.re.exec(p);
    if (!m) continue;
    if (r.method !== req.method) { methodMismatch = true; continue; }
    found = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])) };
    break;
  }
  if (!found) return json(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'Método no permitido' : 'No encontrado' });
  const { r, params } = found;
  const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), body: {}, ip: clientIp(req), session: null };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (!r.opts.skipOrigin && origin && origin !== 'null') {
      let oh = '';
      try { oh = new URL(origin).host; } catch { /* */ }
      if (oh !== req.headers.host && oh !== req.headers['x-forwarded-host']) fail(403, 'Origen no permitido');
    }
    const raw = await readBody(req, r.opts.limit || JSON_LIMIT);
    if (r.opts.raw) ctx.rawBody = raw;
    else if (raw.length) {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) fail(415, 'Se esperaba JSON');
      try { ctx.body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'JSON inválido'); }
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) fail(400, 'JSON inválido');
    }
  }
  if (r.opts.admin) {
    const s = getSession(req);
    if (!s) fail(401, 'Sesión no válida. Inicia sesión.');
    if (req.method !== 'GET' && !safeEq(String(req.headers['x-csrf-token'] || ''), s.csrf)) fail(403, 'Token CSRF inválido. Recarga la página.');
    if (s.must_change && !r.opts.allowMustChange) fail(403, 'Debes cambiar tu contraseña antes de continuar', { mustChange: true });
    ctx.session = s;
  }
  const out = await r.handler(ctx);
  if (!res.headersSent) json(res, 200, out === undefined ? { ok: true } : out);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    if (e && /UNIQUE constraint/.test(e.message)) return json(res, 409, { error: 'Registro duplicado' });
    console.error('[error]', e);
    json(res, 500, { error: 'Error interno del servidor' });
  });
});
server.requestTimeout = 60000;
server.headersTimeout = 20000;

bootstrapAdmin();
seed();
setImmediate(() => { try { warmImageCache(); } catch (e) { console.error('[img]', e.message); } });
const timer = setInterval(() => {
  try { expireOrders(); } catch (e) { console.error('[expirar]', e.message); }
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, EXPIRY_INTERVAL);
timer.unref();
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.listen(PORT, HOST, () => {
  const a = server.address();
  const pp = paypalConfig();
  console.log(`[tienda] Escuchando en http://${HOST}:${a.port}  (DATA_DIR=${DATA_DIR})`);
  console.log(`[tienda] PayPal: ${PAYPAL_MOCK ? 'SIMULADO (solo pruebas)' : pp.enabled ? 'activo (' + pp.mode + ')' : 'no configurado'} | Stripe: ${stripeEnabled() ? 'activo' : 'no configurado'} | Conekta SPEI: ${CONEKTA_MOCK ? 'SIMULADO (solo pruebas)' : conektaEnabled() ? 'activo' : 'no configurado'} | Correo SMTP: ${smtpConfig() ? 'configurado' : 'no configurado (opcional)'} | Telegram: ${telegramEnabled() ? 'configurado' : 'no configurado (opcional)'} | Tidio: ${TIDIO_KEY ? 'activo' : 'no configurado (opcional)'}`);
});
function shutdown() {
  console.log('[tienda] Cerrando...');
  server.close(() => { try { db.close(); } catch { /* */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

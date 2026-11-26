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

// NOTE: This is a truncated upload for testing. Full file will be uploaded separately if needed.
// The customer routes have been prepared in /tmp/server.js
console.log('Customer auth migration added');

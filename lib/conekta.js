'use strict';
// Cliente mínimo de Conekta API v2.3 (órdenes SPEI + verificación de webhooks) con fetch global. Sin dependencias.
const crypto = require('node:crypto');

const API = 'https://api.conekta.io';
const DEFAULT_VERSION = '2.3.0';

function normalizePem(s) {
  let t = String(s || '').trim();
  if (t.includes('\\n') && !t.includes('\n')) t = t.replace(/\\n/g, '\n');
  return t;
}

const DIGITAL_SHIPPING_ADDRESS = {
  street1: 'Entrega digital eSIM',
  postal_code: '06600',
  country: 'MX',
  city: 'Ciudad de México',
  state: 'Ciudad de México',
};

function formatConektaPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('52') && d.length >= 12) return '+' + d;
  if (d.length === 10) return '+52' + d;
  if (String(phone || '').trim().startsWith('+') && d.length >= 10) return '+' + d;
  return '+52' + d.slice(-10);
}

function shippingAddressFrom(address) {
  const a = address && typeof address === 'object' ? address : null;
  if (!a) return { ...DIGITAL_SHIPPING_ADDRESS };
  const street1 = String(a.street1 || a.street || '').trim();
  const postal_code = String(a.postal_code || a.cp || '').replace(/\D/g, '').slice(0, 5);
  const city = String(a.city || '').trim();
  const state = String(a.state || '').trim();
  if (!street1 || postal_code.length !== 5) return { ...DIGITAL_SHIPPING_ADDRESS };
  return {
    street1,
    postal_code,
    country: 'MX',
    city: city || DIGITAL_SHIPPING_ADDRESS.city,
    state: state || DIGITAL_SHIPPING_ADDRESS.state,
  };
}

// Payload exacto que se envía a POST /orders para un cargo SPEI.
function buildSpeiOrderPayload({ name, email, phone, items, shipping = 0, address = null, expiresAtMs, metadata = {} }) {
  const payload = {
    currency: 'MXN',
    customer_info: { name, email, phone: formatConektaPhone(phone) },
    line_items: (items || []).map((it) => ({ name: String(it.name).slice(0, 250), unit_price: it.unit_price, quantity: it.qty })),
    charges: [{ payment_method: { type: 'spei', expires_at: Math.floor(expiresAtMs / 1000) } }],
    metadata,
    // Conekta exige shipping_lines y shipping_contact aunque el envío sea $0 (p. ej. eSIM).
    shipping_lines: [{ amount: shipping || 0, carrier: 'Envío' }],
    shipping_contact: {
      phone: formatConektaPhone(phone),
      receiver: name,
      address: shippingAddressFrom(address),
    },
  };
  return payload;
}

function createConektaClient({ privateKey, apiVersion = DEFAULT_VERSION }) {
  const accept = `application/vnd.conekta-v${apiVersion}+json`;
  async function call(method, p, body) {
    const r = await fetch(API + p, {
      method,
      headers: {
        Authorization: 'Bearer ' + privateKey,
        Accept: accept,
        'Accept-Language': 'es',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const d = j.details && j.details[0] ? j.details[0] : {};
      const msg = d.debug_message || d.message || j.message || ('error ' + r.status);
      const err = new Error('Conekta: ' + msg);
      err.status = r.status;
      err.code = d.code || j.code || '';
      err.type = j.type || '';
      err.param = d.param || '';
      throw err;
    }
    return j;
  }
  return {
    createOrder(payload) { return call('POST', '/orders', payload); },
    retrieveOrder(id) { return call('GET', '/orders/' + encodeURIComponent(id)); },
    cancelOrder(id) { return call('POST', '/orders/' + encodeURIComponent(id) + '/cancel'); },
  };
}

function extractSpeiMethod(order) {
  const ch = order && order.charges && Array.isArray(order.charges.data) ? order.charges.data[0] : null;
  const pm = ch && ch.payment_method ? ch.payment_method : null;
  if (!pm) return null;
  const clabe = String(pm.receiving_account_number || pm.clabe || '').replace(/\s+/g, '');
  const bank = String(pm.receiving_account_bank || pm.bank || '').trim();
  const expiresAt = pm.expires_at ? Number(pm.expires_at) : null;
  if (!clabe) return null;
  return { orderId: order.id, chargeId: ch && ch.id ? ch.id : '', clabe, bank, expiresAt };
}

// Cliente simulado SOLO para pruebas automáticas (NODE_ENV=test y CONEKTA_MOCK=1).
function createMockConektaClient() {
  const orders = new Map();
  let n = 0;
  return {
    mock: true,
    async createOrder(payload) {
      this.lastPayload = payload;
      const id = 'ord_mock_' + (++n) + crypto.randomBytes(3).toString('hex');
      const clabe = ('734180000000000000' + n).slice(-18);
      const expiresAt = (payload.charges && payload.charges[0] && payload.charges[0].payment_method
        && payload.charges[0].payment_method.expires_at) || Math.floor(Date.now() / 1000) + 48 * 3600;
      const amount = (payload.line_items || []).reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0)
        + (payload.shipping_lines || []).reduce((s, i) => s + Number(i.amount), 0);
      const order = {
        id,
        livemode: false,
        amount,
        currency: payload.currency || 'MXN',
        payment_status: 'pending_payment',
        charges: {
          data: [{
            id: 'chg_mock_' + n,
            status: 'pending_payment',
            amount,
            currency: payload.currency || 'MXN',
            payment_method: {
              object: 'bank_transfer_payment',
              type: 'spei',
              receiving_account_number: clabe,
              receiving_account_bank: 'FINCO PAY',
              clabe,
              bank: 'FINCO PAY',
              expires_at: expiresAt,
            },
          }],
        },
      };
      orders.set(id, order);
      return order;
    },
    async retrieveOrder(id) {
      const o = orders.get(id);
      if (!o) throw new Error('Conekta (mock): orden inexistente');
      return o;
    },
  };
}

// Verifica el header DIGEST (Base64 de RSA-SHA256 del cuerpo UTF-8 crudo).
function verifyWebhookSignature(rawBody, digestHeader, publicKeyPem) {
  const pem = normalizePem(publicKeyPem);
  const sigB64 = String(digestHeader || '').trim();
  if (!pem || !sigB64) return false;
  try {
    const data = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const signature = Buffer.from(sigB64, 'base64');
    if (!signature.length) return false;
    return crypto.verify('sha256', data, crypto.createPublicKey(pem), signature);
  } catch {
    return false;
  }
}

module.exports = {
  createConektaClient,
  createMockConektaClient,
  extractSpeiMethod,
  verifyWebhookSignature,
  normalizePem,
  formatConektaPhone,
  buildSpeiOrderPayload,
  DIGITAL_SHIPPING_ADDRESS,
};

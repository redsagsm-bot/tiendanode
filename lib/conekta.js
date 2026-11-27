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
};

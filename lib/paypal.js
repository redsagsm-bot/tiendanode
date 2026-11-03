'use strict';
// Cliente PayPal Orders API v2 (server-side) usando fetch global.
const crypto = require('node:crypto');

function createPayPalClient({ mode, clientId, secret }) {
  const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  let token = null;
  let tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp) return token;
    const r = await fetch(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('PayPal: no se pudo autenticar (revisa Client ID / Secret y modo)');
    token = j.access_token;
    tokenExp = Date.now() + Math.max(60, (j.expires_in || 300) - 120) * 1000;
    return token;
  }

  async function call(method, p, body, extraHeaders = {}) {
    const t = await getToken();
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  }

  return {
    async createOrder({ reference, amount, currency, description }) {
      const r = await call('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: reference,
          custom_id: reference,
          description: String(description || '').slice(0, 120),
          amount: { currency_code: currency, value: amount },
        }],
      }, { 'PayPal-Request-Id': 'create-' + reference + '-' + crypto.randomBytes(4).toString('hex') });
      if (!r.ok || !r.json.id) throw new Error('PayPal: error al crear la orden (' + r.status + ')');
      return r.json;
    },
    async getOrder(id) {
      const r = await call('GET', '/v2/checkout/orders/' + encodeURIComponent(id));
      if (!r.ok) throw new Error('PayPal: error al consultar la orden (' + r.status + ')');
      return r.json;
    },
    async captureOrder(id) {
      const r = await call('POST', '/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {},
        { 'PayPal-Request-Id': 'capture-' + id });
      if (r.ok) return r.json;
      const issue = (r.json.details && r.json.details[0] && r.json.details[0].issue) || r.json.name || '';
      if (r.status === 422 && issue === 'ORDER_ALREADY_CAPTURED') return this.getOrder(id);
      throw new Error('PayPal: no se pudo capturar el pago (' + (issue || r.status) + ')');
    },
  };
}

// Cliente simulado SOLO para pruebas automáticas (NODE_ENV=test y PAYPAL_MOCK=1).
function createMockPayPalClient() {
  const orders = new Map();
  return {
    mock: true,
    async createOrder({ reference, amount, currency }) {
      const id = 'MOCK-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      orders.set(id, { reference, amount, currency, captured: false, captureId: 'CAP-' + crypto.randomBytes(6).toString('hex') });
      return { id, status: 'CREATED' };
    },
    async getOrder(id) { return this.captureOrder(id); },
    async captureOrder(id) {
      const o = orders.get(id);
      if (!o) throw new Error('PayPal (mock): orden inexistente');
      o.captured = true;
      return {
        id, status: 'COMPLETED',
        purchase_units: [{ reference_id: o.reference, payments: { captures: [{ id: o.captureId, status: 'COMPLETED', amount: { currency_code: o.currency, value: o.amount } }] } }],
      };
    },
    _tamper(id, value) { const o = orders.get(id); if (o) o.amount = value; },
  };
}

module.exports = { createPayPalClient, createMockPayPalClient };

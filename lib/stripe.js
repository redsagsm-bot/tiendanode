'use strict';
// Cliente mínimo de Stripe (Checkout Sessions + verificación de webhooks) con fetch global. Sin dependencias.
const crypto = require('node:crypto');

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? flatten(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)])));
    else if (typeof v === 'object') flatten(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

function createStripeClient({ secretKey }) {
  async function call(method, p, body, headers = {}) {
    const r = await fetch('https://api.stripe.com' + p, {
      method,
      headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: body ? new URLSearchParams(flatten(body)).toString() : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || 'error ' + r.status));
    return j;
  }
  return {
    createCheckoutSession(params, idempotencyKey) { return call('POST', '/v1/checkout/sessions', params, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}); },
    retrieveCheckoutSession(id) { return call('GET', '/v1/checkout/sessions/' + encodeURIComponent(id)); },
  };
}

// Verifica la cabecera Stripe-Signature (esquema v1, HMAC-SHA256 de `${t}.${payload}`).
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  const parts = String(header || '').split(',').map((s) => s.trim().split('='));
  const t = (parts.find((p) => p[0] === 't') || [])[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !sigs.length || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const exp = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest();
  return sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === exp.length && crypto.timingSafeEqual(b, exp); });
}

module.exports = { createStripeClient, verifyWebhook };

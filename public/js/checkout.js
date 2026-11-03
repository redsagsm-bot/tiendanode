'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, clear, h, $, money, Cart, config, notice, waLink } = App;
  const form = $('#checkout-form'), msg = $('#form-msg'), summary = $('#summary');
  const cfg = await config();
  let products;
  try { products = new Map((await api('/api/productos')).productos.map((p) => [p.id, p])); }
  catch (e) { notice(msg, e.message); return; }
  const items = Cart.get().filter((i) => products.has(i.id));
  if (!items.length) {
    clear(summary).append(h('p', { text: 'Tu carrito está vacío.' }), h('a', { class: 'btn', href: 'productos.html', text: 'Ver productos' }));
    form.classList.add('hidden'); return;
  }
  const needsShip = items.some((i) => products.get(i.id).type === 'sim');
  const subtotal = items.reduce((s, i) => s + products.get(i.id).price * i.qty, 0);
  const ship = needsShip ? cfg.shippingCost || 0 : 0;
  clear(summary).append(
    ...items.map((i) => { const p = products.get(i.id); return h('div', { class: 'summary-line' }, h('span', { text: `${i.qty} × ${p.name}` }), h('span', { text: money(p.price * i.qty) })); }),
    h('div', { class: 'summary-line' }, h('span', { text: 'Envío' }), h('span', { text: needsShip ? money(ship) : 'Sin envío' })),
    h('div', { class: 'summary-line total' }, h('span', { text: 'Total' }), h('span', { text: money(subtotal + ship) })));
  if (needsShip) {
    $('#address-box').classList.remove('hidden');
    for (const id of ['a-street', 'a-colonia', 'a-cp', 'a-city', 'a-state']) $('#' + id).required = true;
    const sel = $('#a-state');
    for (const e of cfg.estados || []) sel.append(h('option', { value: e, text: e }));
  }
  // Métodos de pago
  const pm = $('#pay-methods');
  const opt = (value, title, desc, checked) => h('label', { class: 'radio-card' }, h('input', { type: 'radio', name: 'payment', value, checked }),
    h('span', {}, h('strong', { text: title }), h('br'), h('span', { class: 'muted', text: desc })));
  if (cfg.paypal && cfg.paypal.enabled) pm.append(opt('paypal', 'PayPal o tarjeta', 'Pago inmediato y seguro. Tu eSIM se entrega al instante.', true));
  pm.append(opt('manual', 'Transferencia SPEI / depósito (por WhatsApp)', 'Te damos los datos bancarios; envía tu comprobante por WhatsApp y confirmamos tu pedido.', !(cfg.paypal && cfg.paypal.enabled)));

  // Prellenado
  try { const saved = JSON.parse(localStorage.getItem('cliente_v1') || '{}'); for (const k of ['name', 'email', 'phone']) if (saved[k]) form.elements[k].value = saved[k]; } catch { /* */ }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.classList.add('hidden');
    if (!form.reportValidity()) return;
    const f = form.elements;
    const body = {
      items, payment: f.payment.value,
      customer: { name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim() },
    };
    if (needsShip) body.address = { street: f.street.value.trim(), colonia: f.colonia.value.trim(), cp: f.cp.value.trim(), city: f.city.value.trim(), state: f.state.value, refs: f.refs.value.trim() };
    const btn = $('#place'); btn.disabled = true; btn.textContent = 'Procesando…';
    try {
      const r = await api('/api/pedidos', { method: 'POST', body });
      localStorage.setItem('cliente_v1', JSON.stringify(body.customer));
      localStorage.setItem('ultimo_pedido', JSON.stringify({ n: r.number, t: r.token }));
      Cart.clear();
      const link = `gracias.html?n=${encodeURIComponent(r.number)}&t=${encodeURIComponent(r.token)}`;
      if (r.paymentMethod === 'paypal') { form.classList.add('hidden'); startPayPal(r, link); }
      else location.href = link;
    } catch (err) {
      notice(msg, err.message);
      btn.disabled = false; btn.textContent = 'Confirmar pedido';
    }
  });

  function startPayPal(order, link) {
    $('#pay-step').classList.remove('hidden');
    $('#pay-number').textContent = order.number;
    const pmsg = $('#pay-msg'), box = $('#paypal-buttons');
    const ids = { number: order.number, token: order.token };
    const capture = async () => {
      const r = await api('/api/paypal/capturar', { method: 'POST', body: ids });
      if (r.ok) location.href = link;
    };
    box.append(h('p', { class: 'muted' }, 'Si cierras esta página puedes retomar el pago desde ', h('a', { href: link, text: 'la página de tu pedido' }), '.'));
    if (cfg.paypal.mock) {
      // Modo de PRUEBAS (NODE_ENV=test + PAYPAL_MOCK=1): sin SDK real.
      box.append(h('button', { class: 'btn', type: 'button', id: 'mock-pay', onclick: async () => {
        try { await api('/api/paypal/crear', { method: 'POST', body: ids }); await capture(); } catch (e) { notice(pmsg, e.message); }
      }, text: 'Pagar (simulado, modo prueba)' }));
      return;
    }
    App.loadPayPal(cfg.paypal.clientId).then((paypal) => {
      paypal.Buttons({
        style: { layout: 'vertical', label: 'pay' },
        createOrder: async () => (await api('/api/paypal/crear', { method: 'POST', body: ids })).id,
        onApprove: async () => { try { await capture(); } catch (e) { notice(pmsg, e.message); } },
        onCancel: () => notice(pmsg, 'Cancelaste el pago. Puedes intentarlo de nuevo.', 'info'),
        onError: () => notice(pmsg, 'PayPal no pudo procesar el pago. Intenta de nuevo o elige transferencia.' + (cfg.whatsapp ? '' : '')),
      }).render(box);
    }).catch(() => {
      notice(pmsg, 'No se pudo cargar PayPal. Revisa tu conexión o desactiva bloqueadores de anuncios.');
      if (cfg.whatsapp) box.append(h('a', { class: 'btn green', href: waLink(cfg.whatsapp, 'Quiero pagar mi pedido ' + order.number), target: '_blank', rel: 'noopener', text: 'Pedir ayuda por WhatsApp' }));
    });
  }
});

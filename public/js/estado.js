'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, clear, h, $, money, notice, config, waLink } = App;
  const box = $('#order');
  const qs = new URLSearchParams(location.search);
  const n = qs.get('n'), t = qs.get('t');
  const isThanks = /gracias/.test(location.pathname);
  const cfg = await config();
  const sessionId = qs.get('session_id');
  const FLOW_SIM = ['pagado', 'preparando', 'enviado', 'entregado'];
  const fmtDate = (s) => (s ? new Date(s).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }) : '');
  const copyBtn = (text) => h('button', { class: 'btn sm secondary', type: 'button', onclick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = '¡Copiado!'; } catch { e.target.textContent = 'Copia manualmente'; }
  }, text: 'Copiar' });

  function render(o, full) {
    clear(box);
    const wrap = h('div', { class: 'panel' });
    box.append(wrap);
    if (isThanks && full) wrap.append(h('h1', { text: o.status === 'pendiente_pago' ? '¡Pedido recibido!' : '¡Gracias por tu compra!' }));
    else wrap.append(h('h1', { text: 'Pedido ' + o.number }));
    wrap.append(h('p', {}, 'Número de pedido: ', h('strong', { text: o.number }), ' · ', fmtDate(o.createdAt)),
      h('p', {}, 'Estado: ', h('span', { class: 'tag ' + (o.status === 'entregado' ? 'esim' : o.status === 'pendiente_pago' ? 'sim' : ''), text: o.statusLabel })));
    if (o.needsShipping && FLOW_SIM.includes(o.status)) {
      const idx = FLOW_SIM.indexOf(o.status);
      wrap.append(h('div', { class: 'timeline' }, ...['Pagado', 'Preparando', 'Enviado', 'Entregado'].map((l, i) => h('span', { class: i <= idx ? 'on' : '', text: l }))));
    }
    if (o.tracking) wrap.append(h('p', { class: 'notice info' }, 'Paquetería: ', h('strong', { text: o.shipCarrier || '—' }), ' · Guía: ', h('strong', { text: o.tracking }), ' ', copyBtn(o.tracking)));
    if (o.status === 'pendiente_pago') {
      if (o.paymentMethod === 'manual') {
        wrap.append(h('div', { class: 'notice' }, h('strong', { text: 'Instrucciones de pago' }), h('p', { style: { whiteSpace: 'pre-line', margin: '.4rem 0' }, text: o.bankInfo }),
          h('p', {}, 'Total a pagar: ', h('strong', { text: money(o.total) }), '. Incluye tu número de pedido ', h('strong', { text: o.number }), ' en el concepto.'),
          o.expiresAt ? h('p', { class: 'muted', text: 'Reservamos tu pedido hasta el ' + fmtDate(o.expiresAt) + '.' }) : null,
          cfg.whatsapp ? h('a', { class: 'btn green', href: waLink(cfg.whatsapp, `Hola, envío el comprobante de mi pedido ${o.number} por ${money(o.total)}`), target: '_blank', rel: 'noopener', text: 'Enviar comprobante por WhatsApp' }) : null));
      } else if (o.paymentMethod === 'stripe') {
        if (full) {
          const smsg = h('div', { class: 'hidden' });
          const go = async (e) => {
            e.target.disabled = true;
            try { const s = await api('/api/stripe/crear', { method: 'POST', body: { number: n, token: t } }); location.href = s.url; } catch (err) { notice(smsg, err.message); e.target.disabled = false; }
          };
          wrap.append(h('div', { class: 'notice info' }, h('p', { text: qs.get('cancelado') ? 'Cancelaste el pago. Puedes intentarlo de nuevo' + (o.expiresAt ? ' antes del ' + fmtDate(o.expiresAt) : '') + '.' : 'Tu pago está pendiente. Puedes completarlo con tarjeta' + (o.expiresAt ? ' antes del ' + fmtDate(o.expiresAt) : '') + '.' }),
            h('button', { class: 'btn', type: 'button', onclick: go, text: 'Pagar con tarjeta' }), smsg));
        }
      } else if (full && cfg.paypal && cfg.paypal.enabled) {
        const pbox = h('div', { id: 'paypal-buttons' }), pmsg = h('div', { class: 'hidden' });
        wrap.append(h('div', { class: 'notice info' }, h('p', { text: 'Tu pago está pendiente. Puedes completarlo aquí' + (o.expiresAt ? ' antes del ' + fmtDate(o.expiresAt) : '') + '.' }), pbox, pmsg));
        const ids = { number: n, token: t };
        const capture = async () => { await api('/api/paypal/capturar', { method: 'POST', body: ids }); load(); };
        if (cfg.paypal.mock) pbox.append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('/api/paypal/crear', { method: 'POST', body: ids }); await capture(); } catch (e) { notice(pmsg, e.message); } }, text: 'Pagar (simulado, modo prueba)' }));
        else App.loadPayPal(cfg.paypal.clientId).then((pp) => pp.Buttons({
          createOrder: async () => (await api('/api/paypal/crear', { method: 'POST', body: ids })).id,
          onApprove: async () => { try { await capture(); } catch (e) { notice(pmsg, e.message); } },
          onError: () => notice(pmsg, 'PayPal no pudo procesar el pago.'),
        }).render(pbox)).catch(() => notice(pmsg, 'No se pudo cargar PayPal.'));
      }
    }
    if (o.status === 'expirado') wrap.append(h('p', { class: 'notice err', text: 'La reserva de este pedido expiró sin pago. Si ya pagaste, contáctanos con tu comprobante.' }));
    if (o.status === 'cancelado') wrap.append(h('p', { class: 'notice err', text: 'Este pedido fue cancelado.' }));
    if (o.status === 'reembolsado') wrap.append(h('p', { class: 'notice', text: 'Este pedido fue reembolsado.' }));

    const list = h('div', { class: 'mt' });
    wrap.append(h('h2', { text: 'Productos' }), list);
    for (const it of o.items) {
      const el = h('div', { class: 'cart-item' }, h('div', {}, h('strong', { text: `${it.qty} × ${it.name}` }), h('div', { class: 'muted', text: it.type === 'esim' ? 'eSIM' : 'SIM física' })), h('div', { text: money(it.unitPrice * it.qty) }));
      list.append(el);
      if (it.codes && it.codes.length) {
        const cbox = h('div', { style: { gridColumn: '1 / -1' } });
        el.append(cbox);
        it.codes.forEach((c, i) => {
          cbox.append(h('div', { class: 'panel', style: { margin: '.5rem 0' } },
            h('strong', { text: `eSIM ${i + 1} de ${it.codes.length}` }),
            c.qr ? h('img', { class: 'qr', src: c.qr, alt: 'Código QR de la eSIM' }) : null,
            c.lpa ? h('div', {}, h('div', { class: 'muted', text: 'Código de activación (LPA):' }), h('div', { class: 'code-box', text: c.lpa }), copyBtn(c.lpa)) : null,
            h('div', {}, h('div', { class: 'muted', text: 'Código / ICCID:' }), h('div', { class: 'code-box', text: c.code }), copyBtn(c.code))));
        });
        cbox.append(h('p', { class: 'notice info', text: 'Instala tu eSIM con conexión Wi‑Fi. iPhone: Ajustes › Celular › Agregar eSIM. Android: Ajustes › Conexiones › Administrador de SIM › Agregar eSIM. Guarda esta página: es tu comprobante.' }));
      }
    }
    wrap.append(h('div', { class: 'summary-line' }, h('span', { text: 'Subtotal' }), h('span', { text: money(o.subtotal) })),
      h('div', { class: 'summary-line' }, h('span', { text: 'Envío' }), h('span', { text: o.shipping ? money(o.shipping) : 'Sin envío' })),
      h('div', { class: 'summary-line total' }, h('span', { text: 'Total' }), h('span', { text: money(o.total) })));
    if (full) wrap.append(h('p', { class: 'muted mt', text: 'Guarda el enlace de esta página: es privado y te permite ver tu pedido y tus códigos eSIM.' }));
  }

  async function load() {
    try { const { pedido } = await api(`/api/pedidos/estado?n=${encodeURIComponent(n)}&t=${encodeURIComponent(t)}`); render(pedido, true); }
    catch (e) { clear(box).append(h('p', { class: 'notice err', text: e.message })); $('#lookup').classList.remove('hidden'); }
  }
  if (n && t && sessionId) {
    // Regreso desde Stripe: el servidor consulta el pago a Stripe y confirma el pedido (reintenta por si tarda).
    box.append(h('p', { class: 'notice info', text: 'Confirmando tu pago…' }));
    (async () => {
      for (let i = 0; i < 5; i++) {
        try { const r = await api('/api/stripe/confirmar', { method: 'POST', body: { number: n, token: t } }); if (r.ok) break; } catch { break; }
        await new Promise((res) => setTimeout(res, 1500));
      }
      load();
    })();
  } else if (n && t) load();
  else {
    $('#lookup').classList.remove('hidden');
    try { const last = JSON.parse(localStorage.getItem('ultimo_pedido') || 'null'); if (last && last.n && last.t) box.append(h('p', { class: 'notice info' }, 'Tu último pedido: ', h('a', { href: `estado.html?n=${encodeURIComponent(last.n)}&t=${encodeURIComponent(last.t)}`, text: last.n }))); } catch { /* */ }
  }
  $('#lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements, m = $('#lookup-msg');
    try {
      const r = await api('/api/pedidos/consulta', { method: 'POST', body: { number: f.number.value.trim(), email: f.email.value.trim() } });
      render(r.pedido, false);
      box.firstChild.append(h('p', { class: 'notice info', text: r.nota }));
      m.classList.add('hidden');
    } catch (err) { notice(m, err.message); }
  });
});

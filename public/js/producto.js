'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, clear, h, $, money, thumb, Cart, toast } = App;
  const box = $('#detail');
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isInteger(id) || id < 1) { clear(box).append(h('p', { class: 'notice err', text: 'Producto no válido.' })); return; }
  try {
    const { producto: p } = await api('/api/productos/' + id);
    document.title = p.name + ' · ' + document.title.split(' · ').pop();
    const out = p.stock < 1;
    let qty = 1;
    const qv = h('span', { text: '1', 'aria-live': 'polite' });
    const setQ = (n) => { qty = Math.max(1, Math.min(10, Math.min(p.stock || 1, n))); qv.textContent = String(qty); };
    clear(box).append(h('div', { class: 'product-detail' },
      thumb(p),
      h('div', {},
        h('div', { class: 'card-meta' }, h('span', { class: 'tag ' + p.type, text: p.type === 'esim' ? 'eSIM (digital)' : 'SIM física (chip)' }), ' ', h('span', { class: 'tag', text: p.carrier })),
        h('h1', { text: p.name }),
        h('p', { class: 'price', style: { fontSize: '1.8rem', fontWeight: '800', margin: '0' }, text: money(p.price) }),
        h('p', { class: 'muted', text: 'Precio con IVA incluido.' }),
        h('ul', {},
          p.dataAmount ? h('li', { text: 'Datos: ' + p.dataAmount }) : null,
          p.validityDays ? h('li', { text: 'Vigencia: ' + p.validityDays + ' días' }) : null,
          h('li', { text: p.type === 'esim' ? 'Entrega: inmediata por código QR al confirmar tu pago' : 'Entrega: envío a domicilio con número de guía' }),
          h('li', { text: out ? 'Agotado' : p.stock <= 5 ? `¡Últimas ${p.stock} piezas!` : 'Disponible' })),
        h('p', { style: { whiteSpace: 'pre-line' }, text: p.description || '' }),
        out ? h('p', { class: 'notice', text: 'Este producto está agotado por el momento. Escríbenos para avisarte cuando vuelva.' }) :
          h('div', { style: { display: 'flex', gap: '.75rem', alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { class: 'qty', role: 'group', 'aria-label': 'Cantidad' },
              h('button', { type: 'button', 'aria-label': 'Menos', onclick: () => setQ(qty - 1), text: '−' }), qv,
              h('button', { type: 'button', 'aria-label': 'Más', onclick: () => setQ(qty + 1), text: '+' })),
            h('button', { class: 'btn', type: 'button', onclick: () => { Cart.add(p.id, qty); toast('Agregado al carrito'); }, text: 'Agregar al carrito' }),
            h('a', { class: 'btn green', href: 'carrito.html', onclick: () => Cart.add(p.id, qty), text: 'Comprar ahora' })))));
  } catch (e) { clear(box).append(h('p', { class: 'notice err', text: e.status === 404 ? 'Este producto no existe o ya no está disponible.' : e.message })); }
});

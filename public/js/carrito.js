'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, clear, h, $, money, Cart, config } = App;
  const box = $('#items');
  let products = new Map();
  const cfg = await config();
  try { const { productos } = await api('/api/productos'); products = new Map(productos.map((p) => [p.id, p])); }
  catch (e) { clear(box).append(h('p', { class: 'notice err', text: e.message })); return; }
  function render() {
    let items = Cart.get();
    const valid = items.filter((i) => products.has(i.id));
    if (valid.length !== items.length) { Cart.save(valid); items = valid; }
    clear(box);
    if (!items.length) {
      box.append(h('p', { text: 'Tu carrito está vacío.' }), h('a', { class: 'btn', href: 'productos.html', text: 'Ver productos' }));
      $('#go-checkout').classList.add('hidden');
    }
    let subtotal = 0, sim = false, problem = false;
    for (const it of items) {
      const p = products.get(it.id);
      subtotal += p.price * it.qty; if (p.type === 'sim') sim = true;
      const over = it.qty > p.stock; if (over) problem = true;
      box.append(h('div', { class: 'cart-item' },
        h('div', {}, h('a', { href: 'producto.html?id=' + p.id, text: p.name }),
          h('div', { class: 'muted', text: (p.type === 'esim' ? 'eSIM' : 'SIM física') + ' · ' + money(p.price) + ' c/u' }),
          over ? h('div', { class: 'tag out', text: p.stock < 1 ? 'Agotado' : 'Solo hay ' + p.stock + ' disponibles' }) : null),
        h('div', { style: { textAlign: 'right' } },
          h('strong', { text: money(p.price * it.qty) }),
          h('div', { class: 'qty', style: { marginTop: '.4rem' } },
            h('button', { type: 'button', 'aria-label': 'Menos', onclick: () => { Cart.set(p.id, it.qty - 1); render(); }, text: '−' }),
            h('span', { text: String(it.qty) }),
            h('button', { type: 'button', 'aria-label': 'Más', onclick: () => { Cart.set(p.id, it.qty + 1); render(); }, text: '+' })),
          h('div', {}, h('button', { type: 'button', class: 'btn sm secondary', style: { marginTop: '.4rem' }, onclick: () => { Cart.set(p.id, 0); render(); }, text: 'Quitar' })))));
    }
    const ship = sim ? cfg.shippingCost || 0 : 0;
    $('#subtotal').textContent = money(subtotal);
    $('#shipping').textContent = sim ? money(ship) : 'Sin envío (eSIM digital)';
    $('#total').textContent = money(subtotal + ship);
    const msg = $('#cart-msg');
    if (problem) { App.notice(msg, 'Ajusta las cantidades: algunos productos no tienen suficientes existencias.'); $('#go-checkout').classList.add('hidden'); }
    else { msg.classList.add('hidden'); if (items.length) $('#go-checkout').classList.remove('hidden'); }
  }
  render();
});

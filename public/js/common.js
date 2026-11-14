'use strict';
// Utilidades compartidas. Nunca usamos innerHTML con datos: todo se construye con h() + textContent.
(function () {
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const money = (cents) => fmt.format((Number(cents) || 0) / 100) + ' MXN';
  const clear = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); return el; };
  const $ = (s, r = document) => r.querySelector(s);

  async function api(url, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(url, init); } catch { throw new Error('No hay conexión con el servidor. Revisa tu internet.'); }
    let data = {};
    try { data = await res.json(); } catch { /* */ }
    if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  const KEY = 'carrito_v1';
  const Cart = {
    get() { try { const c = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(c) ? c.filter((i) => i && Number.isInteger(i.id) && i.qty > 0) : []; } catch { return []; } },
    save(items) { localStorage.setItem(KEY, JSON.stringify(items)); Cart.badge(); },
    add(id, qty = 1) { const c = Cart.get(); const it = c.find((i) => i.id === id); if (it) it.qty = Math.min(10, it.qty + qty); else c.push({ id, qty: Math.min(10, qty) }); Cart.save(c); },
    set(id, qty) { let c = Cart.get(); if (qty <= 0) c = c.filter((i) => i.id !== id); else { const it = c.find((i) => i.id === id); if (it) it.qty = Math.min(10, qty); } Cart.save(c); },
    clear() { Cart.save([]); },
    count() { return Cart.get().reduce((s, i) => s + i.qty, 0); },
    badge() { document.querySelectorAll('[data-cart-count]').forEach((b) => { b.textContent = String(Cart.count()); }); },
  };

  let cfgPromise = null;
  const config = () => (cfgPromise ||= api('/api/config').catch(() => ({ storeName: 'Tienda eSIM México', whatsapp: '', paypal: { enabled: false }, estados: [] })));

  const CARRIER_COLORS = { Telcel: '#0033a0', 'AT&T': '#00a8e0', Bait: '#d39e00', Movistar: '#5bc500', Unefon: '#c9a600', Virgin: '#cc0000', Otro: '#6b7280' };
  const carrierColor = (c) => CARRIER_COLORS[c] || '#475569';

  function thumb(p) {
    const t = h('div', { class: 'thumb', style: { '--c': carrierColor(p.carrier) } }, h('span', { text: p.carrier + (p.dataAmount ? ' · ' + p.dataAmount : '') }));
    if (p.image) t.append(h('img', { src: p.image, alt: p.name, loading: 'lazy' }));
    return t;
  }
  function productCard(p) {
    const out = p.stock < 1;
    return h('article', { class: 'card' },
      h('a', { href: 'producto.html?id=' + p.id, 'aria-label': p.name, style: { textDecoration: 'none' } }, thumb(p)),
      h('div', { class: 'body' },
        h('div', { class: 'meta' },
          h('span', { class: 'tag ' + p.type, text: p.type === 'esim' ? 'eSIM' : 'SIM física' }),
          p.validityDays ? h('span', { class: 'tag', text: p.validityDays + ' días' }) : null,
          /\[EJEMPLO\]/.test(p.name) ? h('span', { class: 'tag example', text: 'Ejemplo' }) : null,
          out ? h('span', { class: 'tag out', text: 'Agotado' }) : null),
        h('h3', {}, h('a', { href: 'producto.html?id=' + p.id, style: { color: 'inherit', textDecoration: 'none' }, text: p.name })),
        h('div', { class: 'price', text: money(p.price) }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', disabled: out, onclick: () => { Cart.add(p.id, 1); toast('Agregado al carrito'); }, text: out ? 'Agotado' : 'Agregar' }),
          h('a', { class: 'btn sm secondary', href: 'producto.html?id=' + p.id, text: 'Ver detalle' }))));
  }

  let toastTimer;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
  }
  function notice(el, msg, kind = 'err') { clear(el); el.className = 'notice ' + kind; el.textContent = msg; el.classList.remove('hidden'); el.setAttribute('role', kind === 'err' ? 'alert' : 'status'); }
  const waLink = (num, text) => 'https://wa.me/' + String(num).replace(/\D/g, '') + (text ? '?text=' + encodeURIComponent(text) : '');

  function layout() {
    const toggle = $('.nav-toggle'), menu = $('#menu');
    if (toggle && menu) toggle.addEventListener('click', () => { const o = menu.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(o)); });
    const here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('#menu a').forEach((a) => { if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page'); });
    Cart.badge();
    window.addEventListener('storage', Cart.badge);
    const y = $('#year'); if (y) y.textContent = String(new Date().getFullYear());
    config().then((c) => {
      document.querySelectorAll('[data-store-name]').forEach((e) => { e.textContent = c.storeName; });
      const hb = document.querySelector('.hero-banner'); const bl = c.banners && c.banners.length ? c.banners : c.banner ? [c.banner] : []; if (hb && bl.length) { App.carousel(hb, bl); hb.hidden = false; }
      if (c.logo) document.querySelectorAll('.brand .logo').forEach((e) => { e.classList.add('has-img'); e.textContent = ''; e.append(h('img', { src: '/uploads/' + c.logo, alt: '' })); });
      if (document.title.includes('{tienda}')) document.title = document.title.replace('{tienda}', c.storeName);
      if (c.whatsapp) {
        document.body.append(h('a', { class: 'wa-float' + (c.tidio ? ' wa-left' : ''), href: waLink(c.whatsapp, 'Hola, tengo una pregunta sobre la tienda'), target: '_blank', rel: 'noopener', text: 'WhatsApp' }));
        const f = $('#footer-wa'); if (f) f.append(h('a', { href: waLink(c.whatsapp), target: '_blank', rel: 'noopener', text: 'WhatsApp: +' + c.whatsapp }));
      }
      if (c.tidio && !document.querySelector('script[data-tidio]')) document.head.append(h('script', { src: 'https://code.tidio.co/' + encodeURIComponent(c.tidio) + '.js', async: '', 'data-tidio': '' }));
      const fb = $('#footer-email');
      if (fb && fb.parentElement) fb.parentElement.append(h('p', {}, h('a', { href: 'https://www.facebook.com/profile.php?id=61596325626434', target: '_blank', rel: 'noopener noreferrer', text: 'Facebook' })));
      const fe = $('#footer-email'); if (fe && c.contactEmail) fe.append(h('a', { href: 'mailto:' + c.contactEmail, text: c.contactEmail }));
    });
  }
  document.addEventListener('DOMContentLoaded', layout);
  const footer = document.querySelector('.site-footer');
  if (footer) {
    const copy = footer.querySelector(':scope > .container:last-child');
    const badges = h('div', { class: 'container pay-badges' },
      h('img', { src: '/img/paypal.svg', alt: 'Pagos con PayPal', width: 120, height: 40, loading: 'lazy' }),
      h('img', { src: '/img/pago-seguro.svg', alt: 'Pago seguro', width: 150, height: 40, loading: 'lazy' }));
    if (copy) footer.insertBefore(badges, copy); else footer.append(badges);
  }
  window.App = { h, money, clear, $, api, Cart, config, productCard, thumb, toast, notice, waLink, carrierColor };
})();
// Carga del SDK de PayPal bajo demanda (client-id viene de /api/config).
App.loadPayPal = (clientId) => new Promise((resolve, reject) => {
  if (window.paypal) return resolve(window.paypal);
  const s = document.createElement('script');
  s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=MXN&intent=capture&locale=es_MX';
  s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal')));
  s.onerror = reject;
  document.head.append(s);
});

// Carrusel del banner de inicio: cambia solo cada 5 s, se pausa al pasar el mouse y tiene puntos para navegar.
App.carousel = (el, files) => {
  const h = App.h, slides = files.map((f, i) => h('img', { src: '/uploads/' + f, alt: '', class: 'slide' + (i === 0 ? ' on' : ''), loading: i === 0 ? 'eager' : 'lazy' }));
  el.append(...slides);
  if (slides.length < 2) return;
  let cur = 0, timer = null;
  const dots = slides.map((_, i) => h('button', { type: 'button', class: 'dot' + (i === 0 ? ' on' : ''), 'aria-label': 'Imagen ' + (i + 1), onclick: () => { go(i); start(); } }));
  el.append(h('div', { class: 'dots' }, ...dots));
  const go = (i) => { slides[cur].classList.remove('on'); dots[cur].classList.remove('on'); cur = (i + slides.length) % slides.length; slides[cur].classList.add('on'); dots[cur].classList.add('on'); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const start = () => { stop(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => go(cur + 1), 5000); };
  el.addEventListener('mouseenter', stop); el.addEventListener('mouseleave', start);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
};

'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const { api, clear, productCard, h, $ } = App;
  const form = $('#filters'), list = $('#list'), count = $('#count');
  const params = new URLSearchParams(location.search);
  for (const k of ['q', 'carrier', 'type', 'sort']) if (params.get(k) && form.elements[k]) form.elements[k].value = params.get(k);
  let seq = 0, t;
  async function load() {
    const my = ++seq;
    const q = new URLSearchParams();
    for (const k of ['q', 'carrier', 'type', 'sort']) { const v = form.elements[k].value.trim(); if (v) q.set(k, v); }
    history.replaceState(null, '', q.toString() ? '?' + q : location.pathname);
    try {
      const { productos } = await api('/api/productos?' + q);
      if (my !== seq) return;
      clear(list);
      count.textContent = productos.length === 1 ? '1 producto' : productos.length + ' productos';
      if (!productos.length) list.append(h('p', { class: 'muted', text: 'No encontramos productos con esos filtros.' }));
      else list.append(...productos.map(productCard));
    } catch (e) { clear(list).append(h('p', { class: 'notice err', text: e.message })); }
  }
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  form.addEventListener('change', load);
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
});

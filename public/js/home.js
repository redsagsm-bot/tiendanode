'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, clear, productCard, h, $ } = App;
  const box = $('#featured');
  try {
    let { productos } = await api('/api/productos?featured=1');
    if (!productos.length) ({ productos } = await api('/api/productos'));
    clear(box).append(...productos.slice(0, 8).map(productCard));
    if (!productos.length) box.append(h('p', { class: 'muted', text: 'Pronto agregaremos productos.' }));
  } catch (e) { clear(box).append(h('p', { class: 'notice err', text: e.message })); }
});

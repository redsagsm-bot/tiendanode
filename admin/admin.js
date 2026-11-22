'use strict';
// Panel de administración. Todo el DOM se construye con textContent (sin innerHTML).
(() => {
  const app = document.getElementById('app');
  let CSRF = '', ME = null, current = 'dashboard';
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v; else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const money = (c) => fmt.format((Number(c) || 0) / 100);
  const date = (s) => (s ? new Date(s).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' }) : '—');
  const field = (label, input) => h('div', { class: 'field' }, h('label', {}, label, input));
  function msgBox() { return h('div', { class: 'hidden', role: 'status' }); }
  function show(box, text, kind = 'err') { box.className = 'notice ' + kind; box.textContent = text; }
  function toast(t) { let el = document.getElementById('toast'); if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(el); } el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2600); }

  async function api(url, method = 'GET', body) {
    const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method !== 'GET') init.headers['x-csrf-token'] = CSRF;
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res; try { res = await fetch(url, init); } catch { throw new Error('Sin conexión con el servidor'); }
    let data = {}; try { data = await res.json(); } catch { /* */ }
    if (res.status === 401 && !url.endsWith('/login')) { ME = null; renderLogin('Tu sesión expiró. Inicia sesión de nuevo.'); throw new Error('Sesión expirada'); }
    if (res.status === 403 && data.mustChange) { renderChangePassword(true); throw new Error(data.error); }
    if (!res.ok) { const e = new Error(data.error || 'Error ' + res.status); e.data = data; throw e; }
    return data;
  }
  const fileToB64 = (file) => new Promise((resolve, reject) => {
    if (file.size > 8 * 1024 * 1024) return reject(new Error('La imagen supera 8 MB'));
    const r = new FileReader(); r.onload = () => resolve({ filename: file.name, data: String(r.result).split(',')[1] }); r.onerror = () => reject(new Error('No se pudo leer el archivo')); r.readAsDataURL(file);
  });

  // ------------------------------------------------------------ Auth screens
  async function start() {
    try { const me = await api('/api/admin/me'); ME = me; CSRF = me.csrf; if (me.mustChange) return renderChangePassword(true); return renderShell(); }
    catch (e) { if (ME) return; }
    try { const s = await (await fetch('/api/admin/setup')).json(); if (s.needsSetup) return renderSetup(s); } catch { /* */ }
    renderLogin();
  }
  function renderLogin(info) {
    const m = msgBox();
    const u = h('input', { id: 'login-user', autocomplete: 'username', required: true, maxlength: 60 });
    const p = h('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
    const form = h('form', { class: 'auth-box', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api('/api/admin/login', 'POST', { username: u.value.trim(), password: p.value }); CSRF = r.csrf; ME = r; r.mustChange ? renderChangePassword(true) : renderShell(); }
      catch (err) { show(m, err.message); p.value = ''; }
    } }, h('h1', { text: 'Panel de administración' }), info ? h('p', { class: 'notice info', text: info }) : null,
      field('Usuario', u), field('Contraseña', p), m, h('button', { class: 'btn', type: 'submit', style: { width: '100%' }, text: 'Entrar' }),
      h('p', { class: 'muted', text: '¿Primera vez? La contraseña temporal aparece en los registros (logs) del servidor al primer arranque.' }));
    clear(app).append(form); u.focus();
  }
  function renderSetup(s) {
    const m = msgBox();
    const tok = h('input', { type: 'password', autocomplete: 'off', required: true }), u = h('input', { required: true, value: 'admin', autocomplete: 'username' }),
      p = h('input', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' }), p2 = h('input', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' });
    clear(app).append(h('form', { class: 'auth-box', onsubmit: async (e) => {
      e.preventDefault();
      if (p.value !== p2.value) return show(m, 'Las contraseñas no coinciden');
      try { await api('/api/admin/setup', 'POST', { token: tok.value, username: u.value.trim(), password: p.value }); renderLogin('Administrador creado. Ahora inicia sesión.'); }
      catch (err) { show(m, err.message); }
    } }, h('h1', { text: 'Configuración inicial' }),
      s.setupTokenRequired ? null : h('p', { class: 'notice', text: 'No hay administradores. Define ADMIN_USER y ADMIN_PASSWORD (o SETUP_TOKEN) en las variables de entorno y reinicia, o revisa los logs para la contraseña temporal.' }),
      field('Token de configuración (SETUP_TOKEN)', tok), field('Usuario', u), field('Contraseña (mín. 10 caracteres)', p), field('Repite la contraseña', p2), m,
      h('button', { class: 'btn', type: 'submit', text: 'Crear administrador' })));
  }
  function renderChangePassword(forced) {
    const m = msgBox();
    const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' }), p = h('input', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' }), p2 = h('input', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' });
    const form = h('form', { class: forced ? 'auth-box' : 'panel', onsubmit: async (e) => {
      e.preventDefault();
      if (p.value !== p2.value) return show(m, 'Las contraseñas no coinciden');
      try { await api('/api/admin/password', 'POST', { current: cur.value, password: p.value }); toast('Contraseña actualizada'); if (forced) { ME.mustChange = false; renderShell(); } else { form.reset(); show(m, 'Contraseña actualizada', 'ok'); } }
      catch (err) { show(m, err.message); }
    } }, h(forced ? 'h1' : 'h2', { text: 'Cambiar contraseña' }), forced ? h('p', { class: 'notice', text: 'Por seguridad debes cambiar la contraseña temporal antes de continuar.' }) : null,
      field('Contraseña actual', cur), field('Nueva contraseña (mín. 10 caracteres)', p), field('Repite la nueva contraseña', p2), m, h('button', { class: 'btn', type: 'submit', text: 'Guardar contraseña' }));
    if (forced) clear(app).append(form);
    return form;
  }

  // ------------------------------------------------------------ Shell
  const TABS = [['dashboard', 'Dashboard'], ['productos', 'Productos'], ['inventario', 'Inventario eSIM'], ['pedidos', 'Pedidos'], ['clientes', 'Clientes'], ['mensajes', 'Mensajes'], ['ajustes', 'Ajustes']];
  let main;
  function renderShell() {
    main = h('main', { class: 'container admin-main', id: 'main' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'data-tab': k, 'aria-selected': String(k === current), onclick: () => go(k), text: l })));
    clear(app).append(
      h('header', { class: 'admin-top' }, h('div', { class: 'container nav' }, h('strong', { text: 'Administración' }),
        h('div', { class: 'inline' }, h('a', { href: '/', target: '_blank', rel: 'noopener', text: 'Ver tienda' }), h('span', { text: ME.username || '' }),
          h('button', { class: 'btn sm secondary', type: 'button', onclick: async () => { try { await api('/api/admin/logout', 'POST'); } catch { /* */ } ME = null; renderLogin('Sesión cerrada.'); }, text: 'Salir' })))),
      tabs, main);
    const hash = location.hash.slice(1);
    go(TABS.some(([k]) => k === hash) ? hash : current);
  }
  function go(k) {
    current = k; history.replaceState(null, '', '#' + k);
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
    clear(main).append(h('div', { class: 'spinner' }));
    VIEWS[k]().catch((e) => { clear(main).append(h('p', { class: 'notice err', text: e.message })); });
  }

  // ------------------------------------------------------------ Dashboard
  function drawChart(canvas, data) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 600, H = canvas.clientHeight || 240;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext('2d'); c.scale(dpr, dpr);
    const pad = { l: 60, r: 10, t: 15, b: 30 }, max = Math.max(100, ...data.map((d) => d.total));
    const bw = (W - pad.l - pad.r) / data.length;
    c.font = '11px system-ui'; c.fillStyle = '#64748b'; c.strokeStyle = '#e2e8f0';
    for (let i = 0; i <= 4; i++) { const y = pad.t + (H - pad.t - pad.b) * (1 - i / 4); c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke(); c.fillText('$' + Math.round(max * i / 4 / 100).toLocaleString('es-MX'), 4, y + 4); }
    data.forEach((d, i) => {
      const bh = (H - pad.t - pad.b) * (d.total / max), x = pad.l + i * bw + bw * 0.15;
      c.fillStyle = '#0b5fff'; c.fillRect(x, H - pad.b - bh, bw * 0.7, bh);
      if (i % 2 === 0 || data.length < 10) { c.fillStyle = '#64748b'; c.fillText(d.date.slice(8, 10) + '/' + d.date.slice(5, 7), x, H - 10); }
    });
  }
  const VIEWS = {};
  VIEWS.dashboard = async () => {
    const d = await api('/api/admin/dashboard');
    const kpi = (label, v, sub) => h('div', { class: 'kpi' }, h('span', { text: label }), h('b', { text: v }), sub ? h('span', { text: sub }) : null);
    const canvas = h('canvas', { class: 'chart', 'aria-label': 'Ventas de los últimos 14 días', role: 'img' });
    clear(main).append(h('h1', { text: 'Dashboard' }),
      h('div', { class: 'kpis' }, kpi('Ventas hoy', money(d.today.total), d.today.n + ' pedidos'), kpi('Esta semana', money(d.week.total), d.week.n + ' pedidos'), kpi('Este mes', money(d.month.total), d.month.n + ' pedidos'),
        kpi('Transferencias por confirmar', String(d.pendingManual)), kpi('Por enviar / preparar', String(d.toShip)), kpi('Mensajes', String(d.messages))),
      h('h2', { text: 'Ventas últimos 14 días' }), canvas,
      h('div', { class: 'layout mt' },
        h('div', { class: 'panel' }, h('h2', { text: `Stock bajo (menos de ${d.lowStockThreshold})` }),
          d.lowStock.length ? h('ul', {}, d.lowStock.map((p) => h('li', { text: `${p.name}: ${p.stock} ${p.type === 'esim' ? 'códigos' : 'piezas'}` }))) : h('p', { class: 'muted', text: 'Todo en orden.' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Pedidos por estado' }), d.byStatus.length ? h('ul', {}, d.byStatus.map((s) => h('li', { text: `${s.label}: ${s.n}` }))) : h('p', { class: 'muted', text: 'Aún no hay pedidos.' }))));
    requestAnimationFrame(() => drawChart(canvas, d.daily));
  };

  // ------------------------------------------------------------ Productos
  VIEWS.productos = async () => {
    const { productos } = await api('/api/admin/productos');
    const tbody = h('tbody');
    for (const p of productos) tbody.append(h('tr', {},
      h('td', {}, p.image ? h('img', { src: p.image, alt: '', style: { width: '48px', height: '36px', objectFit: 'cover', borderRadius: '6px' } }) : '—'),
      h('td', {}, h('strong', { text: p.name }), h('div', { class: 'muted', text: p.carrier + ' · ' + (p.type === 'esim' ? 'eSIM' : p.type === 'electronicos' ? 'Electrónicos' : 'SIM física') })),
      h('td', { text: money(p.price) }), h('td', { text: String(p.stock) }),
      h('td', { text: (p.active ? 'Activo' : 'Oculto') + (p.featured ? ' · Destacado' : '') }),
      h('td', {}, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => productDialog(p), text: 'Editar' }), ' ',
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!confirm(`¿Eliminar "${p.name}"? Si tiene ventas se archivará.`)) return;
          try { const r = await api('/api/admin/productos/' + p.id, 'DELETE'); toast(r.archived ? 'Producto archivado (tiene historial)' : 'Producto eliminado'); go('productos'); } catch (e) { alert(e.message); }
        }, text: 'Eliminar' }))));
    clear(main).append(h('div', { class: 'toolbar' }, h('h1', { style: { margin: 0, flex: 1 }, text: 'Productos' }), h('button', { class: 'btn', type: 'button', onclick: () => productDialog(null), text: '+ Nuevo producto' })),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Imagen', 'Producto', 'Precio', 'Stock', 'Estado', ''].map((t) => h('th', { text: t })))), tbody)),
      h('p', { class: 'muted', text: 'El stock de eSIM es la cantidad de códigos disponibles (se administra en Inventario eSIM). El stock de SIM física y Electrónicos se edita aquí.' }));
  };
  function dialog(title, body, actions) {
    const d = h('dialog', {}, h('div', { class: 'dlg-body' }, h('h2', { text: title }), body), h('div', { class: 'dlg-foot' }, actions, h('button', { class: 'btn secondary', type: 'button', onclick: () => d.close(), text: 'Cerrar' })));
    d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal(); return d;
  }
  function productDialog(p) {
    const f = {
      name: h('input', { value: p ? p.name : '', maxlength: 120, required: true }),
      carrier: h('input', { value: p ? p.carrier : 'Telcel', maxlength: 40, list: 'carriers', required: true }),
      type: h('select', {}, h('option', { value: 'esim', text: 'eSIM' }), h('option', { value: 'sim', text: 'SIM física (chip)' }), h('option', { value: 'electronicos', text: 'Electrónicos' })),
      price: h('input', { type: 'number', step: '0.01', min: '0', value: p ? (p.price / 100).toFixed(2) : '', required: true }),
      dataAmount: h('input', { value: p ? p.dataAmount || '' : '', maxlength: 60, placeholder: 'Ej. 10 GB' }),
      validityDays: h('input', { type: 'number', min: '0', value: p ? p.validityDays || 0 : 30 }),
      stock: h('input', { type: 'number', min: '0', value: p && p.type === 'sim' ? p.stock : 0 }),
      description: h('textarea', { rows: 4, maxlength: 3000, value: p ? p.description || '' : '' }),
      codes: h('textarea', { rows: 5, placeholder: 'Un código por línea. Opcional: código,LPA' }),
      active: h('input', { type: 'checkbox', checked: p ? p.active : true }), featured: h('input', { type: 'checkbox', checked: p ? p.featured : false }),
      file: h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' }),
    };
    f.type.value = p ? p.type : 'esim';
    let image = p && p.image ? p.image.replace('/uploads/', '') : '';
    const preview = h('div', {}, image ? h('img', { src: '/uploads/' + image, alt: '', style: { maxWidth: '160px', borderRadius: '8px' } }) : null);
    const m = msgBox();
    const stockField = field('Stock (piezas físicas / electrónicos)', f.stock);
    const codesField = field('Inventario eSIM: agregar códigos (opcional)', f.codes);
    const syncType = () => { stockField.classList.toggle('hidden', !['sim','electronicos'].includes(f.type.value)); codesField.classList.toggle('hidden', f.type.value !== 'esim'); };
    f.type.addEventListener('change', syncType); syncType();
    f.file.addEventListener('change', async () => {
      if (!f.file.files[0]) return;
      try { const r = await api('/api/admin/upload', 'POST', await fileToB64(f.file.files[0])); image = r.url.replace('/uploads/', ''); clear(preview).append(h('img', { src: r.url, alt: '', style: { maxWidth: '160px', borderRadius: '8px' } })); show(m, 'Imagen subida', 'ok'); }
      catch (e) { show(m, e.message); f.file.value = ''; }
    });
    const body = h('div', {}, h('datalist', { id: 'carriers' }, ['Telcel', 'AT&T', 'Bait', 'Movistar', 'Unefon', 'Virgin', 'Otro'].map((c) => h('option', { value: c }))),
      field('Nombre', f.name), h('div', { class: 'row two' }, field('Compañía', f.carrier), field('Tipo', f.type)),
      h('div', { class: 'row three' }, field('Precio (MXN, IVA incluido)', f.price), field('Datos', f.dataAmount), field('Vigencia (días)', f.validityDays)),
      stockField, codesField, field('Descripción', f.description),
      h('div', { class: 'inline' }, h('label', { class: 'inline' }, f.active, ' Visible en la tienda'), h('label', { class: 'inline' }, f.featured, ' Destacado')),
      field('Imagen (PNG, JPG, WEBP o GIF, máx. 8 MB)', f.file), preview,
      image ? h('button', { class: 'btn sm secondary', type: 'button', onclick: () => { image = ''; clear(preview); }, text: 'Quitar imagen' }) : null, m);
    const d = dialog(p ? 'Editar producto' : 'Nuevo producto', body, h('button', { class: 'btn', type: 'button', onclick: async () => {
      const data = { name: f.name.value.trim(), carrier: f.carrier.value.trim(), type: f.type.value, price: f.price.value, dataAmount: f.dataAmount.value.trim(),
        validityDays: Number(f.validityDays.value || 0), stock: Number(f.stock.value || 0), description: f.description.value, active: f.active.checked, featured: f.featured.checked, image };
      try {
        const r = await api(p ? '/api/admin/productos/' + p.id : '/api/admin/productos', p ? 'PUT' : 'POST', data);
        let msg = 'Producto guardado';
        const bulk = f.codes.value.trim();
        if (data.type === 'esim' && bulk) {
          const pid = p ? p.id : r.producto.id;
          try { const inv = await api('/api/admin/inventario', 'POST', { product_id: pid, bulk }); msg += `. Códigos agregados: ${inv.added}, duplicados ignorados: ${inv.duplicates}`; }
          catch (e2) { show(m, 'Producto guardado, pero los códigos fallaron: ' + e2.message + '. Agrégalos en Inventario eSIM.'); go('productos'); return; }
        }
        d.close(); toast(msg); go('productos');
      } catch (e) { show(m, e.message); }
    }, text: 'Guardar' }));
  }

  // ------------------------------------------------------------ Inventario
  let invProduct = '';
  VIEWS.inventario = async () => {
    const { resumen } = await api('/api/admin/inventario');
    if (!invProduct && resumen[0]) invProduct = String(resumen[0].id);
    const sel = h('select', { onchange: () => { invProduct = sel.value; go('inventario'); } }, resumen.map((r) => h('option', { value: String(r.id), text: `${r.name} (${r.disponibles} disp.)` })));
    sel.value = invProduct;
    const { codigos } = invProduct ? await api('/api/admin/inventario?product_id=' + encodeURIComponent(invProduct)) : { codigos: [] };
    const m = msgBox();
    const code = h('input', { placeholder: 'Código de activación' }), lpa = h('input', { placeholder: 'LPA (opcional)' });
    clear(main).append(h('h1', { text: 'Inventario eSIM' }),
      h('div', { class: 'toolbar' }, field('Producto', sel)),
      h('form', { class: 'panel', onsubmit: async (e) => {
        e.preventDefault();
        if (!invProduct) return show(m, 'Selecciona un producto');
        try { await api('/api/admin/inventario', 'POST', { product_id: Number(invProduct), code: code.value.trim(), lpa: lpa.value.trim() }); toast('Código agregado'); code.value = ''; lpa.value = ''; go('inventario'); }
        catch (err) { show(m, err.message); }
      } }, h('h2', { text: 'Agregar un código' }), h('div', { class: 'row two' }, field('Código', code), field('LPA', lpa)), m, h('button', { class: 'btn', type: 'submit', text: 'Agregar' })),
      h('h2', { text: 'Códigos' }),
      codigos.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Código', 'Estado', 'Pedido', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, codigos.map((c) => h('tr', {}, h('td', {}, h('code', { text: c.code })), h('td', { text: c.status }), h('td', { text: c.orderNumber || '—' }),
          h('td', {}, c.status === 'disponible' ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            if (!confirm('¿Eliminar este código?')) return;
            try { await api('/api/admin/inventario/' + c.id, 'DELETE'); toast('Eliminado'); go('inventario'); } catch (e) { alert(e.message); }
          }, text: 'Eliminar' }) : null)))))) : h('p', { class: 'muted', text: 'Sin códigos para este producto.' }));
  };

  // ------------------------------------------------------------ Pedidos
  VIEWS.pedidos = async () => {
    const { pedidos } = await api('/api/admin/pedidos');
    clear(main).append(h('h1', { text: 'Pedidos' }),
      pedidos.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Pedido', 'Cliente', 'Total', 'Estado', 'Fecha', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, pedidos.map((o) => h('tr', {}, h('td', {}, h('strong', { text: o.number })), h('td', { text: o.name + ' · ' + o.email }), h('td', { text: money(o.total) }),
          h('td', { text: o.status }), h('td', { text: date(o.created_at) }),
          h('td', {}, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => orderDialog(o), text: 'Ver' }))))))) : h('p', { class: 'muted', text: 'Aún no hay pedidos.' }));
  };
  function orderDialog(o) {
    const m = msgBox();
    const body = h('div', {},
      h('p', {}, h('strong', { text: 'Cliente: ' }), o.name + ' · ' + o.email + (o.phone ? ' · ' + o.phone : '')),
      o.address ? h('p', {}, h('strong', { text: 'Dirección: ' }), o.address) : null,
      h('p', {}, h('strong', { text: 'Total: ' }), money(o.total) + ' · ' + o.payment_method),
      h('p', {}, h('strong', { text: 'Estado: ' }), o.status),
      o.items ? h('ul', {}, o.items.map((i) => h('li', { text: `${i.qty} × ${i.name}` }))) : null,
      m);
    dialog('Pedido ' + o.number, body, null);
  }

  // ------------------------------------------------------------ Clientes
  VIEWS.clientes = async () => {
    const { clientes } = await api('/api/admin/clientes');
    clear(main).append(h('h1', { text: 'Clientes' }),
      clientes.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nombre', 'Correo', 'Teléfono', 'Pedidos', 'Gastado'].map((t) => h('th', { text: t })))),
        h('tbody', {}, clientes.map((c) => h('tr', {}, h('td', { text: c.name || '—' }), h('td', { text: c.email }), h('td', { text: c.phone || '—' }), h('td', { text: String(c.orders) }), h('td', { text: money(c.spent) })))))) : h('p', { class: 'muted', text: 'Sin clientes.' }));
  };

  // ------------------------------------------------------------ Mensajes
  VIEWS.mensajes = async () => {
    const { mensajes } = await api('/api/admin/mensajes');
    clear(main).append(h('h1', { text: 'Mensajes de contacto' }),
      mensajes.length ? mensajes.map((m) => h('div', { class: 'panel', style: { marginBottom: '1rem' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('strong', { text: m.name + ' · ' + m.email }), h('span', { class: 'muted', text: date(m.created_at) })),
        m.phone ? h('p', { class: 'muted', text: m.phone }) : null,
        h('p', { text: m.message }))) : h('p', { class: 'muted', text: 'Sin mensajes.' }));
  };

  // ------------------------------------------------------------ Ajustes
  VIEWS.ajustes = async () => {
    const s = await api('/api/admin/ajustes');
    const m = msgBox();
    const fields = {
      storeName: h('input', { value: s.storeName || '' }),
      contactEmail: h('input', { type: 'email', value: s.contactEmail || '' }),
      whatsapp: h('input', { value: s.whatsapp || '' }),
      shippingCost: h('input', { type: 'number', step: '0.01', value: ((s.shippingCost || 0) / 100).toFixed(2) }),
      bankInfo: h('textarea', { rows: 4, value: s.bankInfo || '' }),
    };
    clear(main).append(h('h1', { text: 'Ajustes de la tienda' }),
      h('form', { class: 'panel', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/admin/ajustes', 'POST', {
            storeName: fields.storeName.value.trim(),
            contactEmail: fields.contactEmail.value.trim(),
            whatsapp: fields.whatsapp.value.trim(),
            shippingCost: Math.round(Number(fields.shippingCost.value || 0) * 100),
            bankInfo: fields.bankInfo.value,
          });
          toast('Ajustes guardados');
        } catch (err) { show(m, err.message); }
      } },
        field('Nombre de la tienda', fields.storeName),
        field('Correo de contacto', fields.contactEmail),
        field('WhatsApp', fields.whatsapp),
        field('Costo de envío (MXN)', fields.shippingCost),
        field('Instrucciones de transferencia SPEI', fields.bankInfo),
        m,
        h('button', { class: 'btn', type: 'submit', text: 'Guardar' })));
  };

  start();
})();

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
      h('td', {}, h('strong', { text: p.name }), h('div', { class: 'muted', text: p.carrier + ' · ' + (p.type === 'esim' ? 'eSIM' : 'SIM física') })),
      h('td', { text: money(p.price) }), h('td', { text: String(p.stock) }),
      h('td', { text: (p.active ? 'Activo' : 'Oculto') + (p.featured ? ' · Destacado' : '') }),
      h('td', {}, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => productDialog(p), text: 'Editar' }), ' ',
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!confirm(`¿Eliminar "${p.name}"? Si tiene ventas se archivará.`)) return;
          try { const r = await api('/api/admin/productos/' + p.id, 'DELETE'); toast(r.archived ? 'Producto archivado (tiene historial)' : 'Producto eliminado'); go('productos'); } catch (e) { alert(e.message); }
        }, text: 'Eliminar' }))));
    clear(main).append(h('div', { class: 'toolbar' }, h('h1', { style: { margin: 0, flex: 1 }, text: 'Productos' }), h('button', { class: 'btn', type: 'button', onclick: () => productDialog(null), text: '+ Nuevo producto' })),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Imagen', 'Producto', 'Precio', 'Stock', 'Estado', ''].map((t) => h('th', { text: t })))), tbody)),
      h('p', { class: 'muted', text: 'El stock de eSIM es la cantidad de códigos disponibles (se administra en Inventario eSIM). El stock de SIM física se edita aquí.' }));
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
      type: h('select', {}, h('option', { value: 'esim', text: 'eSIM' }), h('option', { value: 'sim', text: 'SIM física (chip)' })),
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
    const stockField = field('Stock (piezas físicas)', f.stock);
    const codesField = field('Inventario eSIM: agregar códigos (opcional)', f.codes);
    const syncType = () => { stockField.classList.toggle('hidden', f.type.value !== 'sim'); codesField.classList.toggle('hidden', f.type.value !== 'esim'); };
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
    const code = h('input', { placeholder: 'Código / ICCID / código de activación', maxlength: 300 }), lpa = h('input', { placeholder: 'LPA:1$smdp.ejemplo.com$XXXX (opcional)', maxlength: 500 }),
      qr = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' }), bulk = h('textarea', { rows: 6, placeholder: 'Un código por línea. Opcional: código,LPA' }),
      csv = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
    csv.addEventListener('change', () => { const file = csv.files[0]; if (!file) return; if (file.size > 1024 * 1024) return show(m, 'Archivo demasiado grande (máx. 1 MB)'); file.text().then((t) => { bulk.value = t; show(m, 'CSV cargado: revisa y presiona "Agregar en lote"', 'info'); }); });
    const send = async (payload) => {
      try { const r = await api('/api/admin/inventario', 'POST', { product_id: Number(invProduct), ...payload }); toast(`Agregados: ${r.added}. Duplicados ignorados: ${r.duplicates}`); go('inventario'); }
      catch (e) { show(m, e.message); }
    };
    const manualQty = h('input', { type: 'number', min: '1', max: '1000', value: '50' });
    const sendManual = async (extra) => {
      try { const r = await api('/api/admin/inventario-manual', 'POST', { qty: Number(manualQty.value), ...extra }); toast(`Cupos agregados: ${r.added} (${r.products} producto/s)`); go('inventario'); }
      catch (e) { show(m, e.message); }
    };
    const tbody = h('tbody');
    for (const c of codigos) tbody.append(h('tr', {}, h('td', { text: c.code, style: { fontFamily: 'monospace', wordBreak: 'break-all' } }), h('td', { text: c.status + (c.hasQr ? ' · QR' : '') }), h('td', { text: c.order || '—' }), h('td', { text: date(c.createdAt) }),
      h('td', {}, c.status === 'disponible' ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (!confirm('¿Borrar este código?')) return; try { await api('/api/admin/inventario/' + c.id, 'DELETE'); go('inventario'); } catch (e) { alert(e.message); } }, text: 'Borrar' }) : null)));
    clear(main).append(h('h1', { text: 'Inventario eSIM' }),
      resumen.length ? null : h('p', { class: 'notice', text: 'Primero crea un producto de tipo eSIM.' }),
      h('div', { class: 'toolbar' }, h('label', {}, 'Producto ', sel)),
      h('div', { class: 'layout' },
        h('div', { class: 'panel' }, h('h2', { text: 'Agregar un código' }), field('Código', code), field('LPA (opcional)', lpa), field('Imagen QR (opcional)', qr),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            try { const payload = { code: code.value.trim(), lpa: lpa.value.trim() }; if (qr.files[0]) payload.qr = await fileToB64(qr.files[0]); await send(payload); } catch (e) { show(m, e.message); }
          }, text: 'Agregar código' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Cupos de entrega manual' }),
          h('p', { class: 'muted', text: 'Suma stock sin códigos reales: al venderse, el cliente ve "te enviaremos tu eSIM por correo" y tú le mandas el código.' }),
          manualQty,
          h('div', { class: 'inline' },
            h('button', { class: 'btn sm', type: 'button', onclick: () => sendManual({ product_id: Number(invProduct) }), text: 'Agregar a este producto' }),
            h('button', { class: 'btn sm secondary', type: 'button', onclick: () => confirm('¿Agregar esa cantidad a TODOS los productos eSIM?') && sendManual({}), text: 'Agregar a todos los eSIM' }))),
        h('div', { class: 'panel' }, h('h2', { text: 'Carga masiva / CSV' }), field('Códigos', bulk), field('O importa un archivo CSV (columnas: codigo,lpa)', csv),
          h('button', { class: 'btn', type: 'button', onclick: () => send({ bulk: bulk.value }), text: 'Agregar en lote' }))),
      m, h('h2', { class: 'mt', text: `Códigos (${codigos.length})` }),
      h('p', { class: 'muted', text: 'Los códigos reservados o asignados se muestran enmascarados por seguridad.' }),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Código', 'Estado', 'Pedido', 'Alta', ''].map((t) => h('th', { text: t })))), tbody)));
  };

  // ------------------------------------------------------------ Pedidos
  let pedQ = '', pedStatus = '';
  VIEWS.pedidos = async () => {
    const qs = new URLSearchParams(); if (pedQ) qs.set('q', pedQ); if (pedStatus) qs.set('status', pedStatus);
    const { pedidos, statuses } = await api('/api/admin/pedidos?' + qs);
    const q = h('input', { type: 'search', placeholder: 'Número, nombre, correo o teléfono', value: pedQ });
    const st = h('select', {}, h('option', { value: '', text: 'Todos los estados' }), Object.entries(statuses).map(([k, v]) => h('option', { value: k, text: v })));
    st.value = pedStatus;
    const tbody = h('tbody');
    for (const o of pedidos) tbody.append(h('tr', {}, h('td', {}, h('button', { class: 'btn sm secondary', type: 'button', onclick: () => orderDialog(o.id), text: o.number })),
      h('td', { text: date(o.createdAt) }), h('td', {}, o.name, h('div', { class: 'muted', text: o.email })), h('td', { text: money(o.total) }),
      h('td', { text: o.paymentMethod === 'paypal' ? 'PayPal' : o.paymentMethod === 'stripe' ? 'Stripe' : 'Transferencia' }), h('td', { text: o.statusLabel })));
    clear(main).append(h('h1', { text: 'Pedidos' }),
      h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); pedQ = q.value.trim(); pedStatus = st.value; go('pedidos'); } }, q, st, h('button', { class: 'btn sm', type: 'submit', text: 'Buscar' })),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Pedido', 'Fecha', 'Cliente', 'Total', 'Pago', 'Estado'].map((t) => h('th', { text: t })))), tbody)),
      pedidos.length ? null : h('p', { class: 'muted', text: 'No hay pedidos.' }));
  };
  async function orderDialog(id) {
    const { pedido: o, enlace } = await api('/api/admin/pedidos/' + id);
    const m = msgBox();
    const act = async (path, body, okText) => { try { const r = await api(`/api/admin/pedidos/${id}/${path}`, 'POST', body); toast(okText || 'Listo'); d.close(); if (r.problems && r.problems.length) alert('Atención: ' + r.problems.join('; ')); go('pedidos'); orderDialog(id); } catch (e) { show(m, e.message + (e.data && e.data.link ? ' Enlace: ' + e.data.link : '')); } };
    const notes = h('textarea', { rows: 3, value: o.notes });
    const a = o.address;
    const actions = h('div', { class: 'inline mt' });
    if (o.status === 'pendiente_pago' || o.status === 'expirado') {
      if (o.paymentMethod === 'manual') actions.append(h('button', { class: 'btn green sm', type: 'button', onclick: () => confirm('¿Confirmar que recibiste el pago de ' + money(o.total) + '? Se entregarán los códigos eSIM.') && act('confirmar', {}, 'Pago confirmado'), text: 'Confirmar pago recibido' }));
      actions.append(h('button', { class: 'btn sm danger', type: 'button', onclick: () => confirm('¿Cancelar el pedido y liberar el stock?') && act('cancelar', {}, 'Pedido cancelado'), text: 'Cancelar pedido' }));
    }
    if (o.paidAt && o.status === 'pagado' && o.items.some((i) => i.type === 'esim' && i.codes.length < i.qty)) actions.append(h('button', { class: 'btn sm', type: 'button', onclick: () => act('confirmar', {}, 'Códigos asignados'), text: 'Asignar códigos faltantes' }));
    for (const n of o.next) {
      if (n === 'enviado') {
        const tr = h('input', { placeholder: 'Número de guía', maxlength: 80, style: { width: 'auto' } }), sc = h('input', { placeholder: 'Paquetería (ej. Estafeta)', maxlength: 60, style: { width: 'auto' } });
        actions.append(h('span', { class: 'inline' }, tr, sc, h('button', { class: 'btn sm', type: 'button', onclick: () => act('estado', { status: 'enviado', tracking: tr.value.trim(), shipCarrier: sc.value.trim() }, 'Marcado como enviado'), text: 'Marcar enviado' })));
      } else actions.append(h('button', { class: 'btn sm', type: 'button', onclick: () => act('estado', { status: n }, 'Estado actualizado'), text: 'Marcar ' + (n === 'preparando' ? 'preparando' : n) }));
    }
    if (o.paidAt && o.status !== 'reembolsado') {
      actions.append(h('button', { class: 'btn sm secondary', type: 'button', onclick: () => act('reenviar', {}, 'Correo enviado'), text: 'Reenviar correo' }));
      actions.append(h('button', { class: 'btn sm danger', type: 'button', onclick: () => { const note = prompt('Nota de reembolso (hazlo primero en PayPal o por transferencia):'); if (note) act('reembolso', { note }, 'Marcado como reembolsado'); }, text: 'Marcar reembolsado' }));
    }
    const body = h('div', {},
      h('p', {}, h('strong', { text: o.statusLabel }), ' · ', o.paymentMethod === 'paypal' ? 'PayPal' : o.paymentMethod === 'stripe' ? 'Stripe' : 'Transferencia/WhatsApp', ' · Creado ', date(o.createdAt), o.paidAt ? ' · Pagado ' + date(o.paidAt) : ''),
      h('p', {}, o.name, ' · ', h('a', { href: 'mailto:' + o.email, text: o.email }), ' · ', o.phone),
      a ? h('p', { text: `Envío: ${a.street}, Col. ${a.colonia}, C.P. ${a.cp}, ${a.city}, ${a.state}${a.refs ? ' (' + a.refs + ')' : ''}` }) : null,
      o.tracking ? h('p', { text: `Guía: ${o.tracking} ${o.shipCarrier}` }) : null,
      o.paypalOrderId ? h('p', { class: 'muted', text: `PayPal orden ${o.paypalOrderId}${o.paypalCaptureId ? ' · captura ' + o.paypalCaptureId : ''}` }) : null,
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, o.items.map((i) => h('tr', {}, h('td', { text: `${i.qty} × ${i.name}` }), h('td', { text: money(i.unitPrice * i.qty) }),
        h('td', { text: i.type === 'esim' ? (i.codes.length ? i.codes.map((c) => c.code).join(', ') : 'Sin códigos asignados') : 'SIM física' })))),
        h('tr', {}, h('td', { text: 'Envío' }), h('td', { text: money(o.shipping) }), h('td')), h('tr', {}, h('th', { text: 'Total' }), h('th', { text: money(o.total) }), h('th')))),
      h('p', { class: 'mt' }, 'Enlace privado del cliente: ', h('input', { readonly: true, value: enlace, onfocus: (e) => e.target.select() })),
      o.refundNote ? h('p', { class: 'notice', text: 'Reembolso: ' + o.refundNote }) : null,
      field('Notas internas', notes), h('button', { class: 'btn sm secondary', type: 'button', onclick: async () => { try { await api(`/api/admin/pedidos/${id}/nota`, 'POST', { notes: notes.value }); toast('Notas guardadas'); } catch (e) { show(m, e.message); } }, text: 'Guardar notas' }),
      actions, m);
    const d = dialog('Pedido ' + o.number, body, null);
  }

  // ------------------------------------------------------------ Clientes / mensajes
  VIEWS.clientes = async () => {
    const { clientes } = await api('/api/admin/clientes');
    clear(main).append(h('h1', { text: 'Clientes' }), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nombre', 'Correo', 'Teléfono', 'Pedidos', 'Total pagado', 'Alta'].map((t) => h('th', { text: t })))),
      h('tbody', {}, clientes.map((c) => h('tr', {}, h('td', { text: c.name }), h('td', { text: c.email }), h('td', { text: c.phone }), h('td', { text: String(c.pedidos) }), h('td', { text: money(c.gastado) }), h('td', { text: date(c.createdAt) })))))),
      clientes.length ? null : h('p', { class: 'muted', text: 'Aún no hay clientes.' }));
  };
  VIEWS.mensajes = async () => {
    const { mensajes } = await api('/api/admin/mensajes');
    clear(main).append(h('h1', { text: 'Mensajes de contacto' }), mensajes.length ? null : h('p', { class: 'muted', text: 'No hay mensajes.' }),
      mensajes.map((x) => h('div', { class: 'panel', style: { marginBottom: '.7rem' } }, h('strong', { text: x.name }), ' · ', h('a', { href: 'mailto:' + x.email, text: x.email }), x.phone ? ' · ' + x.phone : '', h('span', { class: 'muted', text: ' · ' + date(x.created_at) }),
        h('p', { style: { whiteSpace: 'pre-wrap' }, text: x.message }),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (confirm('¿Borrar mensaje?')) { await api('/api/admin/mensajes/' + x.id, 'DELETE'); go('mensajes'); } }, text: 'Borrar' }))));
  };

  // ------------------------------------------------------------ Ajustes
  VIEWS.ajustes = async () => {
    const s = await api('/api/admin/ajustes');
    const m = msgBox();
    const f = { storeName: h('input', { value: s.storeName, maxlength: 80 }), contactEmail: h('input', { type: 'email', value: s.contactEmail, maxlength: 160 }), whatsapp: h('input', { value: s.whatsapp, maxlength: 20, placeholder: '5215512345678' }),
      shippingCost: h('input', { type: 'number', step: '0.01', min: '0', value: (s.shippingCost / 100).toFixed(2) }), bankInfo: h('textarea', { rows: 4, maxlength: 2000, value: s.bankInfo }),
      ppMode: h('select', {}, h('option', { value: 'sandbox', text: 'Sandbox (pruebas)' }), h('option', { value: 'live', text: 'Live (producción)' })), ppClient: h('input', { value: s.paypal.clientId, maxlength: 200, autocomplete: 'off' }),
      ppSecret: h('input', { type: 'password', maxlength: 200, autocomplete: 'new-password', placeholder: s.paypal.secretSet ? 'Guardado: ' + s.paypal.secretMasked + ' (deja vacío para conservar)' : 'Secret de PayPal' }) };
    let logo = s.logo || '';
    const logoPrev = h('div', {}, logo ? h('img', { src: '/uploads/' + logo, alt: '', style: { maxHeight: '60px' } }) : null);
    const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    logoFile.addEventListener('change', async () => {
      if (!logoFile.files[0]) return;
      try { const r = await api('/api/admin/upload', 'POST', await fileToB64(logoFile.files[0])); logo = r.url.replace('/uploads/', ''); clear(logoPrev).append(h('img', { src: r.url, alt: '', style: { maxHeight: '60px' } })); show(m, 'Logotipo subido: pulsa "Guardar ajustes"', 'ok'); }
      catch (e) { show(m, e.message); logoFile.value = ''; }
    });
    let banners = (s.banners || (s.banner ? [s.banner] : [])).slice();
    const banList = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.6rem', margin: '.4rem 0' } });
    const drawBanners = () => { clear(banList); banners.forEach((b, i) => banList.append(h('div', { style: { textAlign: 'center' } },
      h('img', { src: '/uploads/' + b, alt: '', style: { height: '70px', borderRadius: '8px', display: 'block' } }),
      h('button', { class: 'btn sm secondary', type: 'button', onclick: () => { banners.splice(i, 1); drawBanners(); show(m, 'Imagen quitada: pulsa "Guardar ajustes"', 'info'); }, text: 'Quitar' })))); };
    drawBanners();
    const banFile = h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif' });
    banFile.addEventListener('change', async () => {
      const files = [...banFile.files]; banFile.value = '';
      if (!files.length) return;
      let added = 0, err = '';
      for (const file of files) {
        if (banners.length >= 6) { err = 'Máximo 6 imágenes en el banner'; break; }
        try { const r = await api('/api/admin/upload', 'POST', await fileToB64(file)); banners.push(r.url.replace('/uploads/', '')); added++; drawBanners(); }
        catch (e) { err = file.name + ': ' + e.message; }
      }
      if (added && !err) show(m, added + (added === 1 ? ' imagen agregada' : ' imágenes agregadas') + ': pulsa "Guardar ajustes"', 'ok');
      else if (added) show(m, added + ' agregada(s). ' + err + '. Pulsa "Guardar ajustes"', 'info');
      else show(m, err);
    });
    f.ppMode.value = s.paypal.mode;
    if (s.paypal.fromEnv) [f.ppMode, f.ppClient, f.ppSecret].forEach((x) => { x.disabled = true; });
    const tgm = msgBox();
    const testTo = h('input', { type: 'email', placeholder: 'correo@ejemplo.com', value: s.contactEmail, style: { width: 'auto' } }), tm = msgBox();
    clear(main).append(h('h1', { text: 'Ajustes' }),
      h('div', { class: 'layout' },
        h('div', {},
          h('div', { class: 'panel' }, h('h2', { text: 'Tienda' }), field('Nombre de la tienda', f.storeName), field('Logotipo (PNG, JPG, WEBP o GIF, máx. 8 MB)', logoFile), logoPrev,
            h('button', { class: 'btn sm secondary', type: 'button', onclick: () => { logo = ''; clear(logoPrev); show(m, 'Logotipo quitado: pulsa "Guardar ajustes"', 'info'); }, text: 'Quitar logotipo' }),
            field('Banner de la página de inicio: agrega hasta 6 imágenes (puedes elegir varias a la vez) y se mueven solas (PNG, JPG, WEBP o GIF, máx. 8 MB c/u; ideal 1600×500)', banFile), banList,
            h('div', { class: 'row two' }, field('Correo de contacto', f.contactEmail), field('WhatsApp (con lada, ej. 5215512345678)', f.whatsapp)),
            field('Costo de envío para SIM física (MXN)', f.shippingCost), field('Instrucciones para transferencia / depósito', f.bankInfo)),
          h('div', { class: 'panel mt' }, h('h2', { text: 'PayPal' }),
            s.paypal.fromEnv ? h('p', { class: 'notice info', text: 'PayPal está configurado con variables de entorno (PAYPAL_CLIENT_ID / PAYPAL_SECRET). Para cambiarlo edítalas en Railway.' }) : null,
            s.paypal.mock ? h('p', { class: 'notice', text: 'Modo de PRUEBAS: PayPal simulado.' }) : null,
            field('Modo', f.ppMode), field('Client ID', f.ppClient), field('Secret (nunca se envía al navegador)', f.ppSecret),
            h('div', { class: 'inline' }, s.paypal.secretSet && !s.paypal.fromEnv ? h('button', { class: 'btn sm secondary', type: 'button', onclick: async () => { if (!confirm('¿Borrar el Secret de PayPal? Se desactivará el pago con PayPal.')) return; try { await api('/api/admin/ajustes', 'PUT', { paypal: { clearSecret: true } }); go('ajustes'); } catch (e) { show(m, e.message); } }, text: 'Borrar Secret' }) : null,
              h('button', { class: 'btn sm secondary', type: 'button', onclick: async () => { try { const r = await api('/api/admin/paypal-test', 'POST'); show(m, 'Conexión con PayPal correcta' + (r.mode ? ' (' + r.mode + ')' : ''), 'ok'); } catch (e) { show(m, e.message); } }, text: 'Probar conexión PayPal' }))),
          m, h('button', { class: 'btn mt', type: 'button', onclick: async () => {
            const body = { logo, banners, storeName: f.storeName.value.trim(), contactEmail: f.contactEmail.value.trim(), whatsapp: f.whatsapp.value.trim(), shippingCost: f.shippingCost.value, bankInfo: f.bankInfo.value };
            if (!s.paypal.fromEnv) { body.paypal = { mode: f.ppMode.value, clientId: f.ppClient.value.trim() }; if (f.ppSecret.value) body.paypal.secret = f.ppSecret.value.trim(); }
            try { await api('/api/admin/ajustes', 'PUT', body); toast('Ajustes guardados'); go('ajustes'); } catch (e) { show(m, e.message); }
          }, text: 'Guardar ajustes' })),
        h('div', {},
          h('div', { class: 'panel' }, h('h2', { text: 'Correo (SMTP)' }),
            h('p', { class: s.smtp.configured ? 'notice ok' : 'notice', text: s.smtp.configured ? `Configurado: ${s.smtp.host} (remitente ${s.smtp.from})` : 'No configurado (opcional). Define SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y SMTP_FROM en las variables de entorno.' }),
            h('div', { class: 'inline' }, testTo, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/smtp-test', 'POST', { to: testTo.value.trim() }); show(tm, 'Correo de prueba enviado', 'ok'); } catch (e) { show(tm, e.message); } }, text: 'Enviar prueba' })), tm),
          h('div', { class: 'panel mt' }, h('h2', { text: 'Avisos por Telegram' }),
            h('p', { class: s.telegram.configured ? 'notice ok' : 'notice', text: s.telegram.configured ? 'Configurado: recibirás avisos de pedidos nuevos, pagos confirmados y stock bajo.' : 'No configurado (opcional). Define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en las variables de entorno.' }),
            h('div', { class: 'inline' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/telegram-test', 'POST'); show(tgm, 'Mensaje de prueba enviado a Telegram', 'ok'); } catch (e) { show(tgm, e.message); } }, text: 'Enviar prueba' })), tgm),
          h('div', { class: 'panel mt' }, h('h2', { text: 'Copia de seguridad' }),
            h('p', { class: 'notice', text: 'Descarga la base de datos (productos, pedidos, ajustes) y las imágenes en un archivo .tar.gz. Guárdalo en un lugar seguro: contiene datos de clientes.' }),
            h('a', { class: 'btn sm', href: '/api/admin/respaldo', download: '', text: 'Descargar respaldo' })),
          h('div', { class: 'mt' }, renderChangePassword(false)))));
  };

  document.addEventListener('DOMContentLoaded', start);
})();

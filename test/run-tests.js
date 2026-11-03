'use strict';
/*
 * Pruebas de extremo a extremo: levanta el servidor en un puerto aleatorio con un DATA_DIR temporal
 * y lo prueba con fetch. Uso:  node test/run-tests.js
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0, skipped = 0;
const failures = [];
const servers = [];
const temps = [];

function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; failures.push(name); console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
function skip(name, why) { skipped++; console.log(`  ○ OMITIDA: ${name} (${why})`); }
const section = (t) => console.log('\n# ' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function startServer(env, label) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tienda-test-'));
  temps.push(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch { /* aún no */ }
    if (child.exitCode !== null) throw new Error(`Servidor ${label} terminó: ${log}`);
    await sleep(100);
  }
  return { base, dir, child, log: () => log, port };
}

// Cliente HTTP con cookies + CSRF
function client(base) {
  let cookie = '', csrf = '';
  async function req(method, p, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    if (csrf && method !== 'GET' && !opts.noCsrf) headers['x-csrf-token'] = csrf;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0] === 'sid=' ? '' : sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, headers: r.headers, text, json, setCookie: sc };
  }
  return {
    req, get: (p, o) => req('GET', p, undefined, o), post: (p, b, o) => req('POST', p, b, o), put: (p, b, o) => req('PUT', p, b, o), del: (p, o) => req('DELETE', p, undefined, o),
    async login(u, pw) { const r = await req('POST', '/api/admin/login', { username: u, password: pw }); if (r.json && r.json.csrf) csrf = r.json.csrf; return r; },
    get cookie() { return cookie; }, set cookie(v) { cookie = v; }, get csrf() { return csrf; },
  };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CUSTOMER = { name: 'Cliente Prueba', email: 'cliente@ejemplo.com', phone: '5512345678' };
const ADDRESS = { street: 'Av. Reforma 123', colonia: 'Juárez', cp: '06600', city: 'Ciudad de México', state: 'Ciudad de México', refs: '' };

async function main() {
  const ADMIN_PW = 'ClaveDePrueba-' + Math.random().toString(36).slice(2);
  const A = await startServer({ NODE_ENV: 'test', PAYPAL_MOCK: '1', ADMIN_USER: 'dueno', ADMIN_PASSWORD: ADMIN_PW, SHIPPING_COST: '120' }, 'A');
  const pub = client(A.base);
  const adm = client(A.base);

  section('Arranque, salud y configuración');
  let r = await pub.get('/health');
  ok(r.status === 200 && r.json.ok === true && /application\/json/.test(r.headers.get('content-type')), 'GET /health responde 200 JSON');
  ok(fs.existsSync(path.join(A.dir, 'store.db')) && fs.existsSync(path.join(A.dir, 'uploads')) && fs.existsSync(path.join(A.dir, 'session_secret.txt')), 'DATA_DIR crea store.db, uploads y secreto de sesión');
  r = await pub.get('/api/config');
  ok(r.status === 200 && r.json.currency === 'MXN' && r.json.paypal.enabled && r.json.paypal.mock, '/api/config: MXN y PayPal simulado en modo test');
  ok(!/secret/i.test(JSON.stringify(r.json.paypal).replace('"mock"', '')) && r.json.shippingCost === 12000, '/api/config no expone el secret; envío configurable (SHIPPING_COST=120)');
  ok(Array.isArray(r.json.estados) && r.json.estados.length === 32, '/api/config incluye los 32 estados');

  section('Cabeceras de seguridad y archivos estáticos');
  r = await pub.get('/');
  const csp = r.headers.get('content-security-policy') || '';
  ok(r.status === 200 && /text\/html/.test(r.headers.get('content-type')), 'GET / sirve index.html');
  ok(/paypal\.com/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), 'CSP permite PayPal y no permite scripts inline');
  ok(r.headers.get('x-content-type-options') === 'nosniff' && !!r.headers.get('referrer-policy') && !!r.headers.get('x-frame-options'), 'nosniff, Referrer-Policy y X-Frame-Options presentes');
  for (const bad of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/css/..%2f..%2fserver.js', '/.env', '/%2eenv', '/js/%00.js', '/admin/../server.js', '/uploads/../store.db', '/uploads/..%2fstore.db', '/uploads/session_secret.txt', '/package.json', '/data/store.db']) {
    const rr = await fetch(A.base + bad);
    const t = await rr.text();
    ok(rr.status === 404 && !/DatabaseSync|SQLite format|createServer/.test(t), 'Bloqueado path traversal / archivo privado: ' + bad, rr.status);
  }
  r = await pub.post('/api/contacto', 'x'.repeat(200 * 1024));
  ok(r.status === 413, 'Cuerpo demasiado grande → 413', r.status);
  r = await pub.post('/api/contacto', 'name=a', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  ok(r.status === 415, 'Content-Type no JSON → 415', r.status);
  r = await pub.post('/api/contacto', '{malo', {});
  ok(r.status === 400, 'JSON inválido → 400', r.status);
  r = await pub.get('/api/no-existe');
  ok(r.status === 404 && r.json.error, 'API inexistente → 404 JSON');

  section('Páginas públicas y referencias (JS/CSS/fetch)');
  const pages = ['index.html', 'productos.html', 'producto.html?id=1', 'carrito.html', 'checkout.html', 'contacto.html', 'estado.html', 'gracias.html'];
  const assets = new Set();
  for (const p of pages) {
    r = await pub.get('/' + p);
    ok(r.status === 200 && /lang="es-MX"/.test(r.text), 'Página ' + p + ' (es-MX)');
    ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text) && !/\son[a-z]+=/i.test(r.text), 'Sin scripts ni handlers inline en ' + p);
    for (const m of r.text.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css|svg))"/g)) assets.add(new URL(m[1], A.base + '/' + p).pathname);
  }
  r = await pub.get('/admin/');
  ok(r.status === 200 && /admin\.js/.test(r.text), 'Página /admin/');
  for (const m of r.text.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css|svg))"/g)) assets.add(new URL(m[1], A.base + '/admin/').pathname);
  r = await fetch(A.base + '/admin'); ok(r.redirected || r.url.endsWith('/admin/'), '/admin redirige a /admin/');
  const apiUrls = new Set();
  for (const a of assets) {
    const rr = await fetch(A.base + a);
    const t = await rr.text();
    ok(rr.status === 200 && t.length > 0, 'Recurso referenciado existe: ' + a, rr.status);
    if (a.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', path.join(ROOT, a.startsWith('/admin/') ? a.slice(1) : 'public' + a)]); ok(true, 'Sintaxis JS válida: ' + a); } catch (e) { ok(false, 'Sintaxis JS válida: ' + a, String(e.stderr)); }
      for (const m of t.matchAll(/['`](\/api\/[a-z0-9/_-]*)/gi)) apiUrls.add(m[1].replace(/\/$/, ''));
    }
  }
  ok(apiUrls.size >= 15, 'Se encontraron URLs de API en el JS (' + apiUrls.size + ')');
  for (const u of apiUrls) {
    const probe = u.endsWith('/productos') || u.endsWith('/pedidos') || u.endsWith('/mensajes') || u.endsWith('/inventario') ? u + (u.includes('/admin/') ? '' : '') : u;
    const g = await fetch(A.base + probe); const pz = await fetch(A.base + probe, { method: 'POST' });
    const exists = g.status !== 404 || pz.status !== 404 || (await fetch(A.base + probe + '/1')).status !== 404;
    ok(exists, 'URL de fetch del frontend existe en el servidor: ' + u, [g.status, pz.status]);
  }

  section('Catálogo y filtros');
  r = await pub.get('/api/productos');
  const prods = r.json.productos;
  ok(prods.length === 8 && prods.every((p) => p.name.startsWith('[EJEMPLO]')), '8 productos [EJEMPLO] sembrados');
  ok(prods.every((p) => Number.isInteger(p.price)), 'Precios en centavos enteros');
  r = await pub.get('/api/productos?carrier=Telcel'); ok(r.json.productos.length >= 2 && r.json.productos.every((p) => p.carrier === 'Telcel'), 'Filtro por compañía');
  r = await pub.get('/api/productos?type=sim'); ok(r.json.productos.length === 3 && r.json.productos.every((p) => p.type === 'sim'), 'Filtro por tipo SIM');
  r = await pub.get('/api/productos?sort=precio_asc'); const ps = r.json.productos.map((p) => p.price); ok(ps.every((v, i) => i === 0 || ps[i - 1] <= v), 'Orden por precio ascendente');
  r = await pub.get('/api/productos?q=' + encodeURIComponent("%' OR 1=1 --")); ok(r.status === 200 && r.json.productos.length === 0, 'Búsqueda con inyección SQL no devuelve todo');
  r = await pub.get('/api/productos?q=Bait'); ok(r.json.productos.length === 2, 'Búsqueda por texto');
  r = await pub.get('/api/productos/9999'); ok(r.status === 404, 'Producto inexistente → 404');
  const esim = prods.find((p) => p.type === 'esim' && p.carrier === 'Telcel' && p.price === 29900);
  const esim2 = prods.find((p) => p.carrier === 'AT&T');
  const sim = prods.find((p) => p.type === 'sim' && p.carrier === 'Telcel');
  ok(esim.stock === 3 && sim.stock === 25, 'Stock inicial: 3 códigos eSIM, 25 chips');

  section('Admin: autenticación y seguridad');
  r = await adm.login('dueno', 'incorrecta');
  ok(r.status === 401, 'Login con contraseña incorrecta → 401');
  r = await adm.login('noexiste', 'x');
  ok(r.status === 401, 'Usuario inexistente → 401 (mismo mensaje)');
  r = await adm.get('/api/admin/dashboard');
  ok(r.status === 401, 'Ruta admin sin sesión → 401');
  r = await adm.login('dueno', ADMIN_PW);
  ok(r.status === 200 && r.json.csrf && !r.json.mustChange, 'Login correcto');
  ok(/HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie) && /Path=\//.test(r.setCookie), 'Cookie httpOnly + SameSite=Lax');
  const sid = adm.cookie;
  r = await adm.post('/api/admin/productos', { name: 'X' }, { noCsrf: true });
  ok(r.status === 403, 'POST admin sin token CSRF → 403');
  r = await adm.post('/api/admin/productos', { name: 'X' }, { headers: { Origin: 'https://malicioso.example' } });
  ok(r.status === 403, 'POST con Origin ajeno → 403');
  const forged = sid.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  r = await client(A.base).req('GET', '/api/admin/me', undefined, { headers: { Cookie: forged } });
  ok(r.status === 401, 'Cookie con firma alterada → 401');
  r = await adm.get('/api/admin/me');
  ok(r.status === 200 && r.json.username === 'dueno', 'GET /api/admin/me');
  r = await adm.get('/api/admin/dashboard');
  ok(r.status === 200 && r.json.daily.length === 14 && r.json.today, 'Dashboard con serie de 14 días');

  section('Admin: productos e imágenes');
  r = await adm.post('/api/admin/upload', { filename: 'x.png', data: PNG.toString('base64') });
  ok(r.status === 200 && /^\/uploads\/[a-f0-9]+\.png$/.test(r.json.url), 'Subida PNG válida', r.json);
  const imgUrl = r.json.url;
  r = await pub.get(imgUrl);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && /sandbox/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff', 'Imagen servida con tipo fijo, CSP sandbox y nosniff');
  r = await adm.post('/api/admin/upload', { filename: 'x.png', data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') });
  ok(r.status === 415, 'Subida HTML disfrazado de PNG → rechazada');
  r = await adm.post('/api/admin/upload', { filename: 'x.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64') });
  ok(r.status === 415, 'Subida SVG → rechazada');
  r = await adm.post('/api/admin/upload', { filename: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(2.2 * 1024 * 1024)]).toString('base64') });
  ok(r.status === 400 || r.status === 413, 'Imagen > 2 MB → rechazada', r.status);
  r = await adm.post('/api/admin/productos', { name: 'eSIM Prueba <b>1</b>', carrier: 'Telcel', type: 'esim', price: '150.50', description: 'desc', dataAmount: '3 GB', validityDays: 15, image: imgUrl.replace('/uploads/', ''), active: true, featured: false });
  ok(r.status === 200 && r.json.producto.price === 15050 && r.json.producto.image === imgUrl, 'Crear producto (precio en pesos → centavos, con imagen)', r.json);
  const newId = r.json.producto.id;
  r = await adm.post('/api/admin/productos', { name: 'Malo', carrier: 'Telcel', type: 'esim', price: '-5' });
  ok(r.status === 400, 'Precio negativo → 400');
  r = await adm.post('/api/admin/productos', { name: 'Malo', carrier: 'Telcel', type: 'raro', price: '5' });
  ok(r.status === 400, 'Tipo inválido → 400');
  r = await adm.post('/api/admin/productos', { name: 'Malo', carrier: 'Telcel', type: 'esim', price: '5', image: '../../server.js' });
  ok(r.status === 400, 'Imagen con ruta inválida → 400');
  r = await adm.put('/api/admin/productos/' + newId, { price: '199', featured: true });
  ok(r.status === 200 && r.json.producto.price === 19900 && r.json.producto.featured, 'Editar producto');
  r = await pub.get('/api/productos/' + newId);
  ok(r.json.producto.name === 'eSIM Prueba <b>1</b>' && r.json.producto.stock === 0, 'Nombre guardado tal cual (se muestra con textContent); stock 0 sin códigos');
  r = await adm.put('/api/admin/productos/' + newId, { active: false });
  r = await pub.get('/api/productos/' + newId);
  ok(r.status === 404, 'Producto oculto no es visible al público');
  r = await adm.post('/api/admin/productos', { name: 'Para borrar', carrier: 'Otro', type: 'sim', price: '10', stock: 1 });
  r = await adm.del('/api/admin/productos/' + r.json.producto.id);
  ok(r.status === 200 && r.json.archived === false, 'Borrar producto sin historial');

  section('Admin: inventario eSIM');
  r = await adm.post('/api/admin/inventario', { product_id: newId, code: 'ICCID-UNICO-0001', lpa: 'LPA:1$smdp.ejemplo$AAA', qr: { filename: 'qr.png', data: PNG.toString('base64') } });
  ok(r.status === 200 && r.json.added === 1, 'Agregar código individual con QR');
  r = await adm.post('/api/admin/inventario', { product_id: newId, bulk: 'codigo,lpa\nLOTE-0001,LPA:1$x$1\nLOTE-0002\n\nLOTE-0003;LPA:1$x$3\nICCID-UNICO-0001\n' });
  ok(r.status === 200 && r.json.added === 3 && r.json.duplicates === 1, 'Carga masiva/CSV con encabezado y duplicados', r.json);
  r = await adm.post('/api/admin/inventario', { product_id: newId, code: 'con espacio' });
  ok(r.status === 400, 'Código con caracteres inválidos → 400');
  r = await adm.post('/api/admin/inventario', { product_id: sim.id, code: 'ABCDEF' });
  ok(r.status === 400, 'No se pueden cargar códigos en producto SIM física');
  r = await adm.get('/api/admin/inventario?product_id=' + newId);
  ok(r.json.codigos.length === 4 && r.json.resumen.some((x) => x.id === newId && x.disponibles === 4), 'Listado de inventario y resumen');
  await adm.put('/api/admin/productos/' + newId, { active: true });

  section('Checkout: validaciones');
  r = await pub.post('/api/pedidos', { items: [], customer: CUSTOMER, payment: 'paypal' });
  ok(r.status === 400, 'Carrito vacío → 400');
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 1 }], customer: { ...CUSTOMER, email: 'no-es-correo' }, payment: 'paypal' });
  ok(r.status === 400 && /Correo/.test(r.json.error), 'Correo inválido → 400 en español');
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 1 }], customer: { ...CUSTOMER, phone: '123' }, payment: 'paypal' });
  ok(r.status === 400, 'Teléfono inválido → 400');
  r = await pub.post('/api/pedidos', { items: [{ id: sim.id, qty: 1 }], customer: CUSTOMER, payment: 'manual' });
  ok(r.status === 400, 'SIM física sin dirección → 400');
  r = await pub.post('/api/pedidos', { items: [{ id: sim.id, qty: 1 }], customer: CUSTOMER, address: { ...ADDRESS, cp: '123' }, payment: 'manual' });
  ok(r.status === 400, 'Código postal inválido → 400');
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 11 }], customer: CUSTOMER, payment: 'paypal' });
  ok(r.status === 400, 'Cantidad > 10 → 400');
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 1 }], customer: CUSTOMER, payment: 'bitcoin' });
  ok(r.status === 400, 'Método de pago inválido → 400');

  section('PayPal (simulado): pago, verificación y entrega');
  r = await pub.post('/api/pedidos', { items: [{ id: newId, qty: 2 }], customer: CUSTOMER, payment: 'paypal', total: 1 });
  ok(r.status === 200 && r.json.number && r.json.token && r.json.total === 39800, 'Crear pedido PayPal (total calculado en servidor, ignora total del cliente)', r.json);
  const o1 = r.json;
  r = await pub.get(`/api/pedidos/estado?n=${o1.number}&t=${o1.token}`);
  ok(r.json.pedido.status === 'pendiente_pago' && r.json.pedido.items[0].codes.length === 0, 'Pedido pendiente: sin códigos visibles');
  r = await adm.get('/api/admin/inventario?product_id=' + newId);
  ok(r.json.resumen.find((x) => x.id === newId).reservados === 2, 'Stock reservado (2 códigos) al crear el pedido');
  r = await pub.post('/api/paypal/capturar', { number: o1.number, token: o1.token });
  ok(r.status === 400, 'Capturar sin crear orden PayPal → 400');
  r = await pub.post('/api/paypal/crear', { number: o1.number, token: 'token-incorrecto-123' });
  ok(r.status === 404, 'Crear orden PayPal con token incorrecto → 404');
  r = await pub.post('/api/paypal/crear', { number: o1.number, token: o1.token });
  ok(r.status === 200 && /^MOCK-/.test(r.json.id), 'Crear orden PayPal');
  const ppid = r.json.id;
  r = await pub.post('/api/paypal/crear', { number: o1.number, token: o1.token });
  ok(r.json.id === ppid, 'Crear orden PayPal es idempotente');
  const caps = await Promise.all(Array.from({ length: 6 }, () => pub.post('/api/paypal/capturar', { number: o1.number, token: o1.token })));
  ok(caps.every((c) => c.status === 200 && c.json.ok), '6 capturas simultáneas (Promise.all) responden OK', caps.map((c) => c.status));
  ok(caps.filter((c) => !c.json.already).length === 1, 'Solo una captura confirma el pedido (idempotente)', caps.map((c) => c.json));
  r = await pub.get(`/api/pedidos/estado?n=${o1.number}&t=${o1.token}`);
  const codes1 = r.json.pedido.items[0].codes;
  ok(r.json.pedido.status === 'entregado' && codes1.length === 2, 'Pedido entregado con exactamente 2 códigos', r.json.pedido);
  ok(codes1[0].code === 'ICCID-UNICO-0001' && codes1[0].lpa && /^data:image\/png;base64,/.test(codes1[0].qr), 'Código, LPA y QR (data URL) visibles con token');
  r = await adm.get('/api/admin/inventario?product_id=' + newId);
  const inv = r.json.resumen.find((x) => x.id === newId);
  ok(inv.asignados === 2 && inv.reservados === 0 && inv.disponibles === 2, 'Inventario: 2 asignados, 2 disponibles', inv);
  ok(r.json.codigos.filter((c) => c.status === 'asignado').every((c) => c.code.startsWith('••') && !c.code.includes('ICCID-UNICO')), 'Códigos asignados enmascarados en admin');
  r = await pub.post('/api/pedidos/consulta', { number: o1.number, email: CUSTOMER.email });
  ok(r.status === 200 && r.json.pedido.items[0].codes.length === 0 && !r.text.includes('ICCID-UNICO'), 'Consulta por número+correo no revela códigos');
  r = await pub.post('/api/pedidos/consulta', { number: o1.number, email: 'otro@ejemplo.com' });
  ok(r.status === 404, 'Consulta con correo distinto → 404');
  r = await pub.get(`/api/pedidos/estado?n=${o1.number}&t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  ok(r.status === 404, 'Estado con token incorrecto → 404');
  r = await pub.get(`/api/pedidos/estado?n=${o1.number}`);
  ok(r.status === 400, 'Estado sin token → 400');
  r = await pub.get(`/gracias.html?n=${o1.number}&t=${o1.token}`);
  ok(r.status === 200, 'Página de gracias carga');

  section('PayPal: monto manipulado no entrega');
  r = await pub.post('/api/pedidos', { items: [{ id: esim2.id, qty: 1 }], customer: CUSTOMER, payment: 'paypal' });
  const o2 = r.json;
  r = await pub.post('/api/paypal/crear', { number: o2.number, token: o2.token });
  await pub.post('/api/test/paypal-tamper', { id: r.json.id, value: '1.00' });
  r = await pub.post('/api/paypal/capturar', { number: o2.number, token: o2.token });
  ok(r.status === 402 && /monto/.test(r.json.error), 'Captura con monto distinto → 402', r.json);
  r = await pub.get(`/api/pedidos/estado?n=${o2.number}&t=${o2.token}`);
  ok(r.json.pedido.status === 'pendiente_pago' && r.json.pedido.items[0].codes.length === 0, 'Pedido manipulado sigue pendiente y sin códigos');

  section('Pago manual (transferencia/WhatsApp) y confirmaciones concurrentes');
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 2 }], customer: { ...CUSTOMER, email: 'manual@ejemplo.com' }, payment: 'manual' });
  ok(r.status === 200 && r.json.paymentMethod === 'manual', 'Crear pedido con pago manual');
  const o3 = r.json;
  r = await pub.get(`/api/pedidos/estado?n=${o3.number}&t=${o3.token}`);
  ok(r.json.pedido.bankInfo.length > 10, 'Estado muestra instrucciones de pago');
  r = await pub.post('/api/paypal/crear', { number: o3.number, token: o3.token });
  ok(r.status === 400, 'Pedido manual no puede usar PayPal');
  r = await adm.get('/api/admin/pedidos?q=' + o3.number);
  const o3id = r.json.pedidos[0].id;
  ok(r.json.pedidos.length === 1, 'Buscar pedido en admin');
  const confs = await Promise.all(Array.from({ length: 8 }, () => adm.post(`/api/admin/pedidos/${o3id}/confirmar`, {})));
  ok(confs.every((c) => c.status === 200), '8 confirmaciones simultáneas responden OK', confs.map((c) => c.status));
  ok(confs.filter((c) => !c.json.already).length === 1, 'Solo una confirmación asigna códigos');
  r = await adm.get('/api/admin/pedidos/' + o3id);
  ok(r.json.pedido.status === 'entregado' && r.json.pedido.items[0].codes.length === 2 && r.json.enlace.includes(o3.token), 'Pedido manual entregado con 2 códigos; enlace privado disponible');
  r = await adm.get('/api/admin/inventario?product_id=' + esim.id);
  const invE = r.json.resumen.find((x) => x.id === esim.id);
  ok(invE.asignados === 2 && invE.disponibles === 1, 'Sin doble asignación de códigos', invE);
  r = await pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 2 }], customer: CUSTOMER, payment: 'manual' });
  ok(r.status === 409, 'Sin stock suficiente → 409');
  const orders = await Promise.all(Array.from({ length: 5 }, () => pub.post('/api/pedidos', { items: [{ id: esim.id, qty: 1 }], customer: CUSTOMER, payment: 'manual' })));
  ok(orders.filter((x) => x.status === 200).length === 1 && orders.filter((x) => x.status === 409).length === 4, 'Pedidos simultáneos por el último código: solo 1 reserva', orders.map((x) => x.status));
  const o4 = orders.find((x) => x.status === 200).json;
  r = await adm.get('/api/admin/pedidos?q=' + o4.number);
  const o4id = r.json.pedidos[0].id;
  r = await adm.post(`/api/admin/pedidos/${o4id}/cancelar`, {});
  ok(r.status === 200 && r.json.pedido.status === 'cancelado', 'Cancelar pedido pendiente');
  r = await pub.get('/api/productos/' + esim.id);
  ok(r.json.producto.stock === 1, 'Cancelar libera el código reservado');
  r = await adm.post(`/api/admin/pedidos/${o4id}/confirmar`, {});
  ok(r.status === 409, 'No se puede confirmar un pedido cancelado');

  section('SIM física: envío, estados y guía');
  r = await pub.post('/api/pedidos', { items: [{ id: sim.id, qty: 2 }, { id: newId, qty: 1 }], customer: CUSTOMER, address: ADDRESS, payment: 'paypal' });
  ok(r.status === 200 && r.json.total === 2 * 14900 + 19900 + 12000, 'Pedido mixto con costo de envío', r.json);
  const o5 = r.json;
  r = await pub.get('/api/productos/' + sim.id);
  ok(r.json.producto.stock === 23, 'Stock físico reservado (25 → 23)');
  await pub.post('/api/paypal/crear', { number: o5.number, token: o5.token });
  r = await pub.post('/api/paypal/capturar', { number: o5.number, token: o5.token });
  ok(r.status === 200 && r.json.status === 'pagado', 'Pedido con SIM queda en "pagado"');
  r = await adm.get('/api/admin/pedidos?q=' + o5.number);
  const o5id = r.json.pedidos[0].id;
  r = await adm.get('/api/admin/pedidos/' + o5id);
  ok(r.json.pedido.address.cp === '06600' && r.json.pedido.items.find((i) => i.type === 'esim').codes.length === 1, 'Admin ve dirección; eSIM del pedido mixto entregada');
  r = await adm.post(`/api/admin/pedidos/${o5id}/estado`, { status: 'entregado' });
  ok(r.status === 400, 'Transición inválida pagado → entregado → 400');
  r = await adm.post(`/api/admin/pedidos/${o5id}/estado`, { status: 'preparando' });
  ok(r.status === 200 && r.json.pedido.status === 'preparando', 'pagado → preparando');
  r = await adm.post(`/api/admin/pedidos/${o5id}/estado`, { status: 'enviado' });
  ok(r.status === 400, 'Enviado sin número de guía → 400');
  r = await adm.post(`/api/admin/pedidos/${o5id}/estado`, { status: 'enviado', tracking: 'EST123456789', shipCarrier: 'Estafeta' });
  ok(r.status === 200 && r.json.pedido.tracking === 'EST123456789', 'preparando → enviado con guía');
  r = await pub.get(`/api/pedidos/estado?n=${o5.number}&t=${o5.token}`);
  ok(r.json.pedido.tracking === 'EST123456789' && r.json.pedido.status === 'enviado', 'Cliente ve la guía');
  r = await adm.post(`/api/admin/pedidos/${o5id}/estado`, { status: 'entregado' });
  ok(r.status === 200 && r.json.pedido.status === 'entregado', 'enviado → entregado');
  r = await adm.post(`/api/admin/pedidos/${o5id}/reembolso`, { note: 'Reembolso de prueba en PayPal' });
  ok(r.status === 200 && r.json.pedido.status === 'reembolsado', 'Marcar reembolsado');
  r = await pub.get(`/api/pedidos/estado?n=${o5.number}&t=${o5.token}`);
  ok(r.json.pedido.items.every((i) => i.codes.length === 0), 'Pedido reembolsado ya no muestra códigos');
  r = await adm.post(`/api/admin/pedidos/${o5id}/reenviar`, {});
  ok(r.status === 400, 'Reenviar correo en pedido reembolsado/sin SMTP → 400');
  r = await adm.post(`/api/admin/pedidos/${o3id}/reenviar`, {});
  ok(r.status === 400 && r.json.link && r.json.link.includes(o3.token), 'Sin SMTP: reenviar devuelve enlace privado para compartir');
  r = await adm.post(`/api/admin/pedidos/${o3id}/nota`, { notes: 'Cliente pidió factura' });
  ok(r.status === 200, 'Guardar notas internas');

  section('Contacto, clientes y ajustes');
  r = await pub.post('/api/contacto', { name: 'Ana', email: 'ana@ejemplo.com', phone: '', message: 'Hola, ¿tienen eSIM Bait?' });
  ok(r.status === 200, 'Enviar mensaje de contacto');
  r = await pub.post('/api/contacto', { name: 'A', email: 'malo', message: 'x' });
  ok(r.status === 400, 'Contacto inválido → 400');
  r = await adm.get('/api/admin/mensajes');
  ok(r.json.mensajes.length === 1, 'Admin ve mensajes');
  r = await adm.del('/api/admin/mensajes/' + r.json.mensajes[0].id);
  ok(r.status === 200, 'Borrar mensaje');
  r = await adm.get('/api/admin/clientes');
  ok(r.json.clientes.length >= 2 && r.json.clientes.some((c) => c.email === 'cliente@ejemplo.com' && c.gastado > 0), 'Clientes con total gastado');
  r = await adm.put('/api/admin/ajustes', { storeName: 'Mi Tienda Prueba', whatsapp: '5215512345678', shippingCost: '89.90', bankInfo: 'CLABE 000000000000000000', contactEmail: 'hola@ejemplo.com' });
  ok(r.status === 200, 'Guardar ajustes');
  r = await adm.put('/api/admin/ajustes', { whatsapp: 'abc' });
  ok(r.status === 400, 'WhatsApp inválido → 400');
  r = await adm.put('/api/admin/ajustes', { paypal: { mode: 'sandbox', clientId: 'CLIENTE_ID_DE_PRUEBA', secret: 'SECRETO_SUPER_PRIVADO_123' } });
  ok(r.status === 200, 'Guardar credenciales PayPal desde el panel');
  r = await adm.get('/api/admin/ajustes');
  ok(r.json.paypal.secretSet && !r.text.includes('SECRETO_SUPER_PRIVADO_123') && r.json.paypal.secretMasked.endsWith('_123'), 'Secret de PayPal enmascarado en admin');
  r = await pub.get('/api/config');
  ok(r.json.storeName === 'Mi Tienda Prueba' && r.json.shippingCost === 8990 && !r.text.includes('SECRETO'), '/api/config refleja ajustes sin exponer el secret');
  r = await adm.post('/api/admin/smtp-test', { to: 'x@ejemplo.com' });
  ok(r.status === 400 && /SMTP/.test(r.json.error), 'Prueba SMTP sin configurar → 400 claro');
  r = await adm.post('/api/admin/paypal-test', {});
  ok(r.status === 200, 'Prueba PayPal (simulado)');
  r = await adm.post('/api/admin/password', { current: 'mala', password: 'NuevaClaveSegura123' });
  ok(r.status === 400, 'Cambio de contraseña con actual incorrecta → 400');
  r = await adm.post('/api/admin/password', { current: ADMIN_PW, password: 'corta' });
  ok(r.status === 400, 'Nueva contraseña corta → 400');
  r = await adm.post('/api/admin/password', { current: ADMIN_PW, password: 'NuevaClaveSegura123' });
  ok(r.status === 200, 'Cambiar contraseña');
  r = await client(A.base).login('dueno', 'NuevaClaveSegura123');
  ok(r.status === 200, 'Login con la nueva contraseña');
  r = await adm.post('/api/admin/logout', {});
  ok(r.status === 200, 'Logout');
  r = await adm.get('/api/admin/me');
  ok(r.status === 401, 'Sesión invalidada tras logout');
  r = await adm.get('/api/admin/dashboard', { headers: { Cookie: sid } });
  ok(r.status === 401, 'Cookie antigua ya no sirve');

  section('Sin variables de admin: contraseña temporal + cambio obligatorio + rate limit');
  const B = await startServer({ NODE_ENV: 'test' }, 'B');
  const m = B.log().match(/Contraseña:\s+(\S+)/);
  ok(!!m, 'Contraseña temporal impresa en logs');
  if (m) fs.writeFileSync(path.join(B.dir, 'admin_password_prueba.txt'), 'admin / ' + m[1] + '\n');
  const b = client(B.base);
  r = await b.login('admin', m ? m[1] : 'x');
  ok(r.status === 200 && r.json.mustChange === true, 'Login con contraseña temporal pide cambio');
  r = await b.get('/api/admin/dashboard');
  ok(r.status === 403 && r.json.mustChange, 'Bloqueado hasta cambiar la contraseña');
  r = await b.post('/api/admin/password', { current: m ? m[1] : '', password: 'OtraClaveSegura456' });
  ok(r.status === 200, 'Cambio obligatorio de contraseña');
  r = await b.get('/api/admin/dashboard');
  ok(r.status === 200, 'Acceso al panel tras el cambio');
  const rl = [];
  for (let i = 0; i < 12; i++) rl.push((await client(B.base).login('admin', 'mala' + i)).status);
  ok(rl.includes(429), 'Rate limit de login (429 tras varios intentos)', rl);
  r = await b.get('/api/config');
  ok(r.json.paypal.enabled === false && r.json.paypal.mock === false, 'Sin credenciales: PayPal desactivado (solo transferencia)');
  const bp = (await b.get('/api/productos')).json.productos.find((p) => p.type === 'esim');
  r = await b.post('/api/pedidos', { items: [{ id: bp.id, qty: 1 }], customer: CUSTOMER, payment: 'paypal' });
  ok(r.status === 400, 'Pedido PayPal rechazado si PayPal no está configurado');

  section('SETUP_TOKEN y expiración de reservas');
  const C = await startServer({ NODE_ENV: 'test', SETUP_TOKEN: 'token-de-instalacion-123', RESERVA_MANUAL_HORAS: '0.0003', EXPIRY_INTERVAL_MS: '200', SEED_EJEMPLOS: '1' }, 'C');
  const c = client(C.base);
  r = await c.get('/api/admin/setup');
  ok(r.json.needsSetup && r.json.setupTokenRequired, 'Setup pendiente con SETUP_TOKEN');
  ok(!/Contraseña:/.test(C.log()), 'Con SETUP_TOKEN no se genera contraseña temporal');
  r = await c.post('/api/admin/setup', { token: 'incorrecto', username: 'jefa', password: 'ClaveLarga12345' });
  ok(r.status === 403, 'Setup con token incorrecto → 403');
  r = await c.post('/api/admin/setup', { token: 'token-de-instalacion-123', username: 'jefa', password: 'ClaveLarga12345' });
  ok(r.status === 200, 'Setup con token correcto crea admin');
  r = await c.post('/api/admin/setup', { token: 'token-de-instalacion-123', username: 'otro', password: 'ClaveLarga12345' });
  ok(r.status === 409, 'Setup repetido → 409');
  r = await c.login('jefa', 'ClaveLarga12345');
  ok(r.status === 200 && !r.json.mustChange, 'Login del admin creado por setup');
  const cp = (await c.get('/api/productos')).json.productos;
  const ce = cp.find((p) => p.type === 'esim'), cs = cp.find((p) => p.type === 'sim');
  r = await c.post('/api/pedidos', { items: [{ id: ce.id, qty: 3 }, { id: cs.id, qty: 5 }], customer: CUSTOMER, address: ADDRESS, payment: 'manual' });
  ok(r.status === 200, 'Pedido manual con reserva corta (~1 s)');
  const oc = r.json;
  ok((await c.get('/api/productos/' + ce.id)).json.producto.stock === 0, 'Códigos reservados (stock 0)');
  await sleep(2000);
  r = await c.get(`/api/pedidos/estado?n=${oc.number}&t=${oc.token}`);
  ok(r.json.pedido.status === 'expirado', 'Pedido expira automáticamente', r.json.pedido.status);
  ok((await c.get('/api/productos/' + ce.id)).json.producto.stock === 3 && (await c.get('/api/productos/' + cs.id)).json.producto.stock === cs.stock + 0, 'Stock liberado tras expirar');
  const ocid = (await c.get('/api/admin/pedidos?q=' + oc.number)).json.pedidos[0].id;
  r = await c.post(`/api/admin/pedidos/${ocid}/confirmar`, {});
  ok(r.status === 200 && (r.json.pedido.status === 'pagado') && r.json.pedido.items.find((i) => i.type === 'esim').codes.length === 3, 'Pago tardío confirmado retoma stock y asigna códigos', r.json.pedido && r.json.pedido.status);

  section('PAYPAL_MOCK no se activa fuera de NODE_ENV=test');
  const D = await startServer({ NODE_ENV: 'production', PAYPAL_MOCK: '1', ADMIN_USER: 'x', ADMIN_PASSWORD: 'ClaveLarga12345' }, 'D');
  r = await client(D.base).get('/api/config');
  ok(r.json.paypal.mock === false && r.json.paypal.enabled === false, 'PAYPAL_MOCK=1 ignorado en producción');
  r = await client(D.base).post('/api/test/paypal-tamper', { id: 'x', value: '1' });
  ok(r.status === 404, 'Ruta de prueba inexistente en producción');
  ok(/PAYPAL_MOCK=1 ignorado/.test(D.log()), 'Aviso en logs');
  r = await fetch(D.base + '/health');
  ok(r.status === 200, 'Arranca sin SMTP ni PayPal (config opcional)');

  section('Navegador (Chromium)');
  await browserTests(A);

}

// ---------------------------------------------------------------- Navegador real vía Chrome DevTools Protocol
async function browserTests(A) {
  const bin = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!bin) return skip('Pruebas en navegador real', 'Chromium no está instalado; se validaron sintaxis JS y referencias');
  if (typeof WebSocket !== 'function') return skip('Pruebas en navegador real', 'WebSocket global no disponible');
  const port = await freePort();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tienda-chrome-')); temps.push(prof);
  const ch = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  servers.push(ch);
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) wsUrl = pg.webSocketDebuggerUrl; } catch { /* */ } }
  if (!wsUrl) return skip('Pruebas en navegador real', 'Chromium no abrió el puerto de depuración');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/paypal\.com|favicon|\/api\/admin\/me/.test(msg.params.entry.url || '')) errors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch { /* */ } await sleep(100); } return false; };
  const nav = async (u) => { await send('Page.navigate', { url: A.base + u }); await sleep(150); await waitFor('document.readyState === "complete"'); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  try {
    for (const p of ['index.html', 'productos.html', 'carrito.html', 'contacto.html', 'estado.html']) {
      errors.length = 0; await nav('/' + p); await sleep(400);
      ok(errors.length === 0, `Navegador: ${p} sin errores de JS/CSP`, errors);
    }
    await nav('/index.html');
    ok(await waitFor('document.querySelectorAll("#featured .card").length > 0'), 'Navegador: inicio muestra destacados');
    await nav('/productos.html?type=sim');
    ok(await waitFor('document.querySelectorAll("#list .card").length > 0 && [...document.querySelectorAll("#list .tag.sim")].length === document.querySelectorAll("#list .card").length'), 'Navegador: filtro de productos desde la URL');
    const pid = await evalJs('fetch("/api/productos?carrier=AT%26T").then(r=>r.json()).then(j=>j.productos[0].id)');
    await nav('/producto.html?id=' + pid);
    ok(await waitFor('!!document.querySelector("#detail h1")'), 'Navegador: detalle de producto');
    await evalJs('localStorage.clear(); [...document.querySelectorAll("#detail button")].find(b=>b.textContent==="Agregar al carrito").click(); true');
    ok(await evalJs('JSON.parse(localStorage.getItem("carrito_v1"))[0].qty === 1'), 'Navegador: agregar al carrito (localStorage)');
    await nav('/carrito.html');
    ok(await waitFor('document.querySelectorAll("#items .cart-item").length === 1 && document.querySelector("[data-cart-count]").textContent === "1"'), 'Navegador: carrito muestra el producto y el contador');
    await nav('/checkout.html');
    ok(await waitFor('!!document.querySelector("input[name=payment][value=paypal]")'), 'Navegador: checkout ofrece PayPal');
    await evalJs(`(()=>{const f=document.getElementById("checkout-form").elements;f.name.value="Navegador Prueba";f.email.value="nav@ejemplo.com";f.phone.value="5511112222";f.payment.value="paypal";document.getElementById("place").click();return true})()`);
    ok(await waitFor('!!document.getElementById("mock-pay")'), 'Navegador: pedido creado y paso de pago visible');
    await evalJs('document.getElementById("mock-pay").click(); true');
    ok(await waitFor('location.pathname.endsWith("gracias.html") && document.querySelectorAll(".code-box").length >= 1', 8000), 'Navegador: tras pagar, la página de gracias muestra el código eSIM');
    ok(await evalJs('document.body.textContent.includes("Entregado")'), 'Navegador: estado "Entregado"');
    // Pago manual con SIM física
    const sid2 = await evalJs('fetch("/api/productos?type=sim").then(r=>r.json()).then(j=>j.productos[0].id)');
    await evalJs(`localStorage.setItem("carrito_v1", JSON.stringify([{id:${sid2},qty:1}])); true`);
    await nav('/checkout.html');
    await waitFor('!document.getElementById("address-box").classList.contains("hidden") && document.querySelectorAll("#a-state option").length > 30');
    await evalJs(`(()=>{const f=document.getElementById("checkout-form").elements;f.street.value="Calle 1 #2";f.colonia.value="Centro";f.cp.value="44100";f.city.value="Guadalajara";f.state.value="Jalisco";f.payment.value="manual";document.getElementById("place").click();return true})()`);
    ok(await waitFor('location.pathname.endsWith("gracias.html") && document.body.textContent.includes("Instrucciones de pago")', 8000), 'Navegador: pago manual con dirección muestra instrucciones');
    // Contacto
    await nav('/contacto.html');
    await evalJs(`(()=>{const f=document.getElementById("contact-form").elements;f.name.value="Nav";f.email.value="nav@ejemplo.com";f.message.value="Mensaje desde el navegador";document.querySelector("#contact-form button").click();return true})()`);
    ok(await waitFor('document.getElementById("contact-msg").textContent.includes("Gracias")'), 'Navegador: formulario de contacto');
    // Admin
    errors.length = 0;
    await nav('/admin/');
    ok(await waitFor('!!document.getElementById("login-user")'), 'Navegador: login del panel');
    await evalJs(`(()=>{document.getElementById("login-user").value="dueno";document.getElementById("login-pass").value="NuevaClaveSegura123";document.querySelector("form button[type=submit]").click();return true})()`);
    ok(await waitFor('!!document.querySelector("canvas.chart")'), 'Navegador: dashboard con gráfica');
    for (const tab of ['productos', 'inventario', 'pedidos', 'clientes', 'mensajes', 'ajustes']) {
      await evalJs(`document.querySelector('[data-tab="${tab}"]').click(); true`);
      ok(await waitFor(`!document.querySelector("#main .spinner") && document.querySelector("#main h1") && !document.querySelector("#main > .notice.err")`), 'Navegador: pestaña ' + tab);
    }
    await evalJs(`document.querySelector('[data-tab="pedidos"]').click(); true`);
    await waitFor('document.querySelectorAll("#main tbody tr").length > 0');
    await evalJs('document.querySelector("#main tbody button").click(); true');
    ok(await waitFor('!!document.querySelector("dialog[open]")'), 'Navegador: detalle de pedido en diálogo');
    ok(errors.length === 0, 'Navegador: panel sin errores de JS/CSP', errors);
  } finally { try { ws.close(); } catch { /* */ } }
}

main().catch((e) => { failed++; failures.push('Excepción: ' + e.message); console.error(e); }).finally(async () => {
  for (const s of servers) try { s.kill('SIGTERM'); } catch { /* */ }
  await sleep(300);
  if (process.env.KEEP_TMP !== '1') for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} aprobadas, ${failed} fallidas, ${skipped} omitidas`);
  if (failures.length) console.log('Fallidas:\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
});

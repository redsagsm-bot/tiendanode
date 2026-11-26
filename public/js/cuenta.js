'use strict';
// Externo (no en línea): la CSP del sitio bloquea scripts en línea sin nonce.
(() => {
const $ = (s) => document.querySelector(s);
const notice = (msg, kind='err') => { const e = $('#msg'); e.className = 'notice ' + kind; e.textContent = msg; e.classList.remove('hidden'); };
async function api(url, opts={}) {
  const r = await fetch(url, { method: opts.method||'GET', headers: { 'Content-Type':'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials:'same-origin' });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}
async function checkSession() {
  try {
    const d = await api('/api/cuenta/me');
    if (d.user) showAccount(d.user);
  } catch {}
}
function showAccount(u) {
  $('#login-box').classList.add('hidden');
  $('#register-box').classList.add('hidden');
  $('#account-box').classList.remove('hidden');
  $('#acc-name').textContent = u.name || u.email;
  $('#acc-email').textContent = u.email;
}
$('#show-register').onclick = (e) => { e.preventDefault(); $('#login-box').classList.add('hidden'); $('#register-box').classList.remove('hidden'); };
$('#show-login').onclick = (e) => { e.preventDefault(); $('#register-box').classList.add('hidden'); $('#login-box').classList.remove('hidden'); };
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/cuenta/login', { method:'POST', body:{ email:$('#login-email').value, password:$('#login-pass').value } });
    location.reload();
  } catch (err) { notice(err.message); }
};
$('#register-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/cuenta/registro', { method:'POST', body:{ name:$('#reg-name').value, email:$('#reg-email').value, phone:$('#reg-phone').value, password:$('#reg-pass').value } });
    location.reload();
  } catch (err) { notice(err.message); }
};
$('#logout-btn').onclick = async () => { await api('/api/cuenta/logout', { method:'POST' }); location.reload(); };
checkSession();
})();

'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const { api, h, $, notice, config, waLink } = App;
  const form = $('#contact-form'), msg = $('#contact-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await api('/api/contacto', { method: 'POST', body: { name: form.elements.name.value.trim(), email: form.elements.email.value.trim(), phone: form.elements.phone.value.trim(), message: form.elements.message.value.trim() } });
      form.reset(); notice(msg, '¡Gracias! Recibimos tu mensaje y te responderemos pronto.', 'ok');
    } catch (err) { notice(msg, err.message); } finally { btn.disabled = false; }
  });
  const c = await config();
  if (c.whatsapp) $('#contact-wa').append(' ', h('a', { class: 'btn green sm', href: waLink(c.whatsapp, 'Hola, tengo una pregunta'), target: '_blank', rel: 'noopener', text: 'Abrir WhatsApp' }));
  if (c.contactEmail) $('#contact-email').append('Correo: ', h('a', { href: 'mailto:' + c.contactEmail, text: c.contactEmail }));
});

# Tienda de eSIM y chips SIM (México)

Tienda en línea en español (es-MX), con precios en MXN, para vender **eSIM** (código y QR entregados de forma automática) y **chips SIM físicos** (con envío) de Telcel, Bait, AT&T, Movistar, Unefon y otras compañías.

- Backend: Node.js 22 o superior, solo con módulos incluidos (`node:http`, `node:crypto`, `node:sqlite`). No necesita `npm install`.
- Frontend: HTML, CSS y JavaScript sin compilación.
- Base de datos: SQLite en `DATA_DIR`. Por defecto es `./data` y se crea sola.
- Pagos: PayPal (Orders v2: creación y captura en el servidor). Si PayPal no está configurado, se ofrece pago manual por transferencia o WhatsApp.

> Se cargan 8 productos **[EJEMPLO]** solo si la base de datos está vacía. Edítalos o bórralos desde el panel.

## Uso local

```bash
node server.js            # http://localhost:3000  · panel: http://localhost:3000/admin/
npm test                  # pruebas completas (servidores temporales, PayPal simulado)
PORT=8080 DATA_DIR=/tmp/tienda node server.js
docker build -t tienda . && docker run -p 3000:3000 -v tienda-data:/data tienda
```

**Primer administrador.** Si no defines `ADMIN_USER` y `ADMIN_PASSWORD` ni `SETUP_TOKEN`, al arrancar por primera vez se imprime **una sola vez** en la consola un bloque con el usuario `admin` y una contraseña temporal. Al entrar, el panel te obliga a cambiarla.

## Publicar en Railway paso a paso

1. **Sube el código a GitHub, desde la web.** Crea un repositorio nuevo (puede ser privado) en github.com y entra en *Add file → Upload files*. Descomprime `tienda-node.zip` y arrastra **el contenido** (server.js, package.json, Dockerfile y las carpetas lib, public, admin y test), sin la carpeta que lo contiene. Luego pulsa *Commit changes*.
2. En railway.app entra en **New Project → Deploy from GitHub repo** y elige el repositorio. Railway detecta el `Dockerfile` y lo construye.
3. **Volumen (obligatorio para no perder datos).** En el servicio, abre *Settings → Volumes* (o haz clic derecho en el lienzo y elige *Add Volume*). Créalo con **Mount path `/data`**.
4. **Variables.** En la pestaña *Variables* agrega como mínimo:
   - `DATA_DIR=/data`
   - `SESSION_SECRET=` (una cadena aleatoria larga)
   - `STORE_NAME`, `WHATSAPP` (por ejemplo `5215512345678`), `CONTACT_EMAIL`
   - Opcionales: `ADMIN_USER` y `ADMIN_PASSWORD`, las variables de PayPal y las de SMTP (ver la tabla).
5. **Dominio.** En *Settings → Networking → Generate Domain* obtienes la URL pública. Ponla en `PUBLIC_URL` (por ejemplo `https://mitienda.up.railway.app`).
6. **Primera contraseña.** Si no definiste `ADMIN_PASSWORD`, abre *Deployments → (el despliegue) → View Logs* y busca el bloque `CONTRASEÑA TEMPORAL`. Entra en `/admin/` con el usuario `admin` y esa contraseña, y cámbiala. Solo se imprime en el primer arranque. Si la pierdes, define `ADMIN_USER`, `ADMIN_PASSWORD` y `ADMIN_RESET_PASSWORD=1`, vuelve a desplegar, entra y después quita `ADMIN_RESET_PASSWORD`.
7. **PayPal.** En developer.paypal.com crea una app y copia el *Client ID* y el *Secret*. Ponlos en `PAYPAL_CLIENT_ID` y `PAYPAL_SECRET` (o en el panel, en *Ajustes*) y usa `PAYPAL_MODE=sandbox` para pruebas o `live` para cobrar de verdad. El botón *Probar PayPal* en Ajustes verifica las credenciales.
8. Revisa que `https://TU-DOMINIO/health` responda `{"ok":true,...}`.

## Variables de entorno (todas opcionales)

| Variable | Uso | Por defecto |
|---|---|---|
| `PORT` / `HOST` | Puerto y dirección de escucha | `3000` / `0.0.0.0` |
| `DATA_DIR` | Carpeta de la base de datos, imágenes y QR | `./data` (`/data` en Docker) |
| `PUBLIC_URL` | URL pública, usada en los enlaces de los correos | — |
| `SESSION_SECRET` | Clave para firmar las cookies. Si falta, se genera y se guarda en DATA_DIR | autogenerada |
| `COOKIE_SECURE=1` | Fuerza cookies Secure (se detecta sola con `x-forwarded-proto`) | — |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Crea el primer administrador (contraseña de 8 caracteres o más) | — |
| `ADMIN_RESET_PASSWORD=1` | Restablece la contraseña de ese usuario al arrancar | — |
| `SETUP_TOKEN` | Permite crear el primer admin desde `/admin/` con este token | — |
| `STORE_NAME`, `WHATSAPP`, `CONTACT_EMAIL` | Datos de la tienda (también se editan en Ajustes) | — |
| `SHIPPING_COST` | Costo de envío de SIM física, en MXN | `99` (editable en Ajustes) |
| `RESERVA_MINUTOS` | Minutos que se reservan los códigos y el stock mientras se paga con PayPal | `15` |
| `RESERVA_MANUAL_HORAS` | Horas de reserva cuando el pago es manual | `48` |
| `STOCK_BAJO` | Límite para la alerta de inventario bajo | `5` |
| `TZ_OFFSET_HORAS` | Desfase horario de la gráfica del dashboard | `-6` |
| `SEED_EJEMPLOS=0` | No cargar los productos de ejemplo | — |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_MODE` | PayPal (`sandbox` o `live`). Si están definidas aquí, el panel no las puede editar | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Correo de confirmación (opcional) | puerto `587` |
| `PAYPAL_MOCK=1` | PayPal simulado. **Solo funciona con `NODE_ENV=test`** | — |

El *secret* de PayPal y la contraseña SMTP nunca se envían al navegador. En el panel aparecen enmascarados.

## Cómo funciona

- **eSIM:** el código y el QR se entregan solo cuando PayPal confirma una captura `COMPLETED` cuyo monto y moneda coinciden con el pedido. Los pagos manuales se entregan cuando el admin pulsa «Confirmar pago». La asignación es atómica (transacciones SQLite) y la captura es idempotente. Los códigos reservados se liberan al vencer la reserva.
- **SIM física:** pasa por pagado → preparando → enviado (con número de guía) → entregado.
- **Seguimiento:** `/estado.html` funciona con el número de pedido y el correo, o con el enlace con token.
- **Panel `/admin/`:** dashboard con gráfica, productos (con imágenes), inventario eSIM (individual, masivo o CSV `codigo,pin,puk,qr_url`, con códigos enmascarados), pedidos, clientes, mensajes y ajustes (prueba de SMTP y de PayPal, cambio de contraseña).
- **Seguridad:** contraseñas con scrypt, cookie firmada httpOnly con SameSite=Lax, CSRF, verificación de Origin, límite de intentos de login, CSP y cabeceras de seguridad, límites de tamaño, protección contra path traversal. Las imágenes se validan por su contenido (solo PNG, JPG, WEBP o GIF) y se sirven con CSP *sandbox*.

## Limitaciones

- Una sola instancia (SQLite). Para escalar hay que cambiar a otra base de datos.
- Sin volumen en `/data`, Railway borra los datos en cada despliegue.
- No hay webhooks de PayPal: el pago se confirma al capturar desde el navegador. Si el cliente cierra la ventana justo después de pagar, el admin puede revisarlo en PayPal y confirmar el pedido a mano.
- Los reembolsos se marcan en el panel, pero se hacen desde PayPal.
- El correo SMTP usa STARTTLS o TLS básico, sin colas de reintento.
- No se probó contra PayPal real ni contra un servidor SMTP real; se usó el simulador.

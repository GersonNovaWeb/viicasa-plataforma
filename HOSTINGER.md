# VIICASA en Hostinger

## Configuración actual: plataforma real, pagos Stripe de prueba (11 octubre 2026)

Esta sección sustituye la configuración inicial sin pagos que aparece más abajo.
Los clientes y pedidos se guardan en Firestore real y SMTP envía a los destinatarios
del pedido. Solo el procesamiento de la tarjeta continúa en el sandbox de Stripe.

```dotenv
PLATFORM_MODE=live
VIILIFE_MODE=live
PAYMENT_PROVIDER=stripe
STRIPE_MODE=test
MAIL_MODE=smtp
COMMERCE_ENABLED=true
VIILIFE_DEMO_MAIL_MODE=outbox
```

Conservar `SITE_URL` HTTPS sin barra final, Firebase, proveedores de acceso,
SMTP y `PRIVACY_APPROVED=true` si las condiciones ya fueron aprobadas.
No importar valores vacíos de `.env.example` sobre credenciales existentes.
El archivo privado `.env.hostinger.viilife.local` es un complemento, no contiene
necesariamente toda la configuración de la aplicación. No se sube a GitHub.

- `STRIPE_SECRET_KEY`: conservar la clave `sk_test_` del sandbox. Por defecto el
  servidor rechaza claves `sk_live_`; cobrar dinero real requerirá optar
  explícitamente por `STRIPE_MODE=live` en una fase posterior.
- `STRIPE_WEBHOOK_SECRET`: secreto del destino HTTPS en ese mismo sandbox,
  no el secreto local de `stripe listen`. Ruta: `/v1/webhooks/stripe`.
- `MAIL_FROM` y `SMTP_USER`: buzón remitente autorizado; `SMTP_PASSWORD`: su contraseña.
- `ADMIN_EMAIL`: destinatario de avisos administrativos, no reemplaza al comprador.
- El recibo se envía al `customer_email` guardado en el pedido, tras confirmar
  el pago por webhook; el aviso al administrador es independiente. Los recibos
  del sandbox llevan `[STRIPE TEST]` y aclaran que no se cobró dinero real.
- Índice `mail_outbox`: `status` ascendente, `next_attempt` ascendente, colección.

Guardar variables y volver a desplegar. Comprobar `/api/config`: `demo:false`,
`viilifeMode:"live"`, `payment:"stripe"`. La publicación rechaza explícitamente
`VIILIFE_MODE=demo` para evitar desviar correos al buzón fijo de demostración.
No se migran ni reenvían automáticamente los pedidos/correos de la demo anterior.
Los scripts locales `npm run dev` y `npm run dev:stripe` permanecen aislados y
no envían correos reales; el flujo completo con SMTP se valida en Hostinger.

## Referencia histórica: despliegue inicial Google y Firestore, sin pagos

### Correos de toda la plataforma (ViiShop, ViiConcierge y ViiLife)

Los tres servicios usan la cola `mail_outbox`, el mismo remitente y SMTP. No se
necesitan nuevas variables ni índices adicionales. El cambio no toca Coming Soon.

- Bienvenida en inglés: una por **nueva cuenta verificada** en VIICASA, tras el
  primer acceso con Google, Apple o correo/contraseña. Los proveedores deben
  estar habilitados externamente. La verificación de email sigue siendo de
  Firebase; la bienvenida no la sustituye. Reingresos, cuentas antiguas y
  proveedores enlazados con el mismo UID no generan otra bienvenida.
- Compras ViiShop: confirmación, productos, variantes/SKU, cantidades, precios,
  envío o recogida y total. No anuncia un envío o recogida ya realizados.
- Reservas ViiConcierge: propiedad, fechas, huéspedes, anticipo o pago completo,
  total y saldo pendiente. Un anticipo nunca se presenta como pago total.
- Recibos PDF para el cliente: solo tras un pago confirmado o recibido en revisión.
  El administrador recibe su aviso separado sin PDF. Los correos de pago fallido,
  vencimiento o cancelación no adjuntan recibo ni confirman cobros/reembolsos.
- Los pagos `sk_test_` permanecen marcados como prueba, sin dinero real.

No se reenvían mensajes anteriores ni se generan bienvenidas masivas. Crear una
cuenta verificada nueva para probar la bienvenida. Para compras, pagar un pedido
nuevo de cada sección y comprobar webhook, estado del pedido, correo y PDF del
comprador más aviso del administrador. Esas pruebas de entrega deben realizarse
en Hostinger; las pruebas locales automatizadas usan Stripe/SMTP simulados.

`npm run test:platform-mail` prueba registro, deduplicación, depósitos, destinatarios
y adjuntos; `npm run preview:platform-mail` crea muestras con datos ficticios.

### Generación de recibos PDF

Los nuevos pagos confirmados (o recibidos en revisión) encolan un PDF solamente
para el comprador, junto con su correo habitual. Los avisos al administrador,
solicitudes y aprobaciones para pagar no adjuntan recibos. Stripe test genera un
PDF claramente marcado como prueba, sin cobro real ni factura fiscal.

No requiere variables nuevas: desplegar `package.json`, `package-lock.json` y
`viicasa-backend/assets/logo-email.png` junto con el código. El PDF se genera en
memoria con PDFKit; no requiere Python, navegador o almacenamiento público.
Los datos del recibo quedan congelados en `mail_outbox.receipt` al confirmar el
pago. Un fallo de generación conserva el correo en la cola para reintento y
muestra `PDF_RECEIPT_FAILED` en el diagnóstico. Los correos antiguos no cambian
y los ya enviados no se reenvían automáticamente.

Vista previa sin datos reales: `npm run preview:viilife-receipt`.
Pruebas sin conexiones externas: `npm run test:viilife-receipt`.

Crear una aplicación nueva para pruebas. No reemplazar la aplicación de Coming Soon
ni apuntar todavía el dominio principal a esta plataforma.

## Ajustes del repositorio

| Campo | Valor |
| --- | --- |
| Repositorio | GersonNovaWeb/viicasa-plataforma |
| Rama | main |
| Raíz | ./ |
| Aplicación | Backend Node.js / Fastify (no Next.js, no sitio estático) |
| Node | 24.x |
| Instalación, si se puede personalizar | npm ci --omit=dev |
| Compilación | npm run build |
| Arranque, si solicita comando | npm start |
| Archivo de entrada | server.js |

No existe `.next` ni `dist`: se ejecuta `server.js` de la raíz y se conservan ambas
carpetas hijas. Si el panel solo ofrece un directorio estático, no es el tipo de
aplicación correcto. Revisar los campos que muestre el panel antes de confirmar.
El lanzador LiteSpeed de Hostinger carga `server.js` con `require()`: este archivo
debe conservar la importación dinámica sin `await` en el nivel principal.
`npm run test:startup` comprueba ambos modos de carga y los errores de arranque
con un módulo de prueba aislado, sin conectarse a Firebase ni Stripe.
Referencia oficial: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/

## Variables de entorno

Usar el hostname HTTPS temporal asignado para `SITE_URL`, sin barra final:

```dotenv
NODE_ENV=production
PLATFORM_MODE=live
SITE_URL=https://DOMINIO-TEMPORAL-ASIGNADO
FIREBASE_PROJECT_ID=viicasa
FIREBASE_AUTH_DOMAIN=viicasa.firebaseapp.com
FIREBASE_WEB_APP_ID=1:159084480889:web:f193adc5bcde06897fc7a8
ADMIN_EMAILS=viicasa.database@gmail.com
PAYMENT_PROVIDER=disabled
COMMERCE_ENABLED=false
PRIVACY_APPROVED=false
MAIL_MODE=outbox
ADMIN_EMAIL=viicasa.database@gmail.com
```

Además, configurar los valores en el gestor privado del hosting:

- `FIREBASE_WEB_API_KEY`: clave web de la aplicación Firebase ya proporcionada.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: contenido completo del JSON privado vigente.
  No agregar comillas exteriores ni reemplazar los `\n` internos. Nunca ponerlo
  en GitHub ni en una variable con prefijo público.
- `MEDIA_DIR`: ruta privada persistente confirmada por Hostinger. Se puede usar
  una ruta de prueba para validar Google, pero antes de cargar fotos reales hay
  que comprobar que sobrevivan a un redeploy.
- `TRUSTED_PROXY_IPS`: solo direcciones exactas del proxy confirmadas por Hostinger,
  para reconocer al visitante tras el proxy. Sin esto, el país puede ser el del
  servidor o no detectable; no inventar la clasificación.

Dejar que el hosting proporcione `PORT`. No configurar `FIRESTORE_EMULATOR_HOST`,
un proyecto `demo-`, ni una ruta `GOOGLE_APPLICATION_CREDENTIALS` del escritorio.
No configurar claves Stripe en esta fase. Las operaciones comerciales quedan
bloqueadas; Google, perfiles y administración sí pueden probarse.

## Firebase y cuentas de clientes

Para Google, Apple y correo con contraseña, consultar `ACCESOS-CLIENTES.md`.
Apple/correo requieren configuración externa y `AUTH_APPLE_ENABLED=true` /
`AUTH_EMAIL_ENABLED=true`; por defecto están desactivados. Facebook se descarta.
No cambia el acceso administrativo exclusivo de Google. Para validar pagos de
ViiLife después de la prueba inicial de identidad, seguir `VALIDACION-FASE-1.md`.

1. Firebase → Authentication: confirmar proveedor Google habilitado.
2. En Configuración → Dominios autorizados, agregar el hostname temporal exacto,
   sin `https://` ni rutas. No borrar los dominios de la landing.
3. Confirmar credencial del mismo proyecto, acceso IAM a Firestore y Firebase Auth,
   y existencia de la base `(default)`. Nunca abrir lecturas/escrituras públicas.
4. Revisar índices actuales antes de aplicar los de este repositorio. Mantener
   todas las excepciones/TTL de `cs_*` y cualquier índice remoto adicional.
5. Si Google limita la aplicación OAuth a usuarios de prueba, autorizar las cuentas
   concretas de prueba desde su configuración; no modificar el administrador para
   permitir clientes normales.

Documentación: https://firebase.google.com/docs/auth/web/google-signin

## Recorrido de aceptación

### Propiedades de prueba incluidas en el código

Después de desplegar, iniciar sesión con el administrador y abrir `/admin` →
Propiedades → **Cargar 4 propiedades de prueba**. Confirmar la publicación.
Las fichas están definidas en `viicasa-backend/src/demo-properties.js`:
Casa Brisa, Villa Oliva, Casa Lumbre y Residencia Arena, con tres imágenes cada
una, descripciones ES/EN y tarifas ficticias USD/CAD. Las imágenes `/assets/`
forman parte del repositorio y sobreviven a los despliegues.

La carga requiere rol admin y pagos desactivados en producción. No se ejecuta
automáticamente al arrancar ni al desplegar. Es transaccional e idempotente:
repetirla no duplica registros ni sobrescribe cambios, incluso si posteriormente
se archivan o renombran las propiedades creadas. Tampoco toca las colecciones
`cs_*` de la landing ni crea productos, clientes, reservas o cobros.

Estas propiedades llevan `is_demo=true`, conservado al editarlas; el servidor
rechaza reservas de ellas en producción aunque más adelante se habiliten pagos.
Para operar una propiedad real, crear una ficha nueva con sus datos reales.
Después de cargar el catálogo, los datos quedan en Firestore sin otro despliegue.

### Productos de ejemplo de ViiShop

Después de desplegar, entra como administrador a **Productos → Cargar 4 productos
de prueba**. Las definiciones están en `viicasa-backend/src/demo-products.js`:
Terra Ceramic Vase, Natural Linen Throw, Sculptural Wood Object y Home Ritual Set.
Incluyen fotos ilustrativas locales, textos ES/EN, precios CAD/USD independientes
y 20 unidades ficticias por producto. No representan mercancía para entrega real.

La carga es explícita, transaccional e idempotente; no se ejecuta al desplegar,
no sobrescribe productos/SKU existentes y no modifica configuración de entregas.
Puedes editar precios desde **Inventario** y quitar las fichas con **Editar →
Archivar**. Repetir la carga no restaura fichas archivadas ni repone existencias.
La marca `is_demo` se conserva aunque cambies nombre, descripción o precio.

Para comprar estos ejemplos: `PAYMENT_PROVIDER=stripe`, `STRIPE_MODE=test`,
`STRIPE_SECRET_KEY=sk_test_...` y webhook del mismo entorno de pruebas.
El servidor bloquea su compra con claves reales, incluso si la operación se creó
antes de cambiar de modo. No cambies ViiLife ni toda la plataforma a demo.
Los ajustes existentes de recolección/envío siguen aplicándose. Un pago de prueba
confirmado por webhook sigue el flujo normal de pedidos, notificaciones y recibo
PDF marcado como prueba; con SMTP activo se envían correos reales a sus destinatarios.
Para vender mercancía real, crea fichas nuevas con datos reales.

Validación local sin servicios externos: `npm run test:demo-products`.

### Validación real

- Abrir `/cuenta`; registrarse con una cuenta Google que no sea la del admin.
- Recargar y cerrar sesión; comprobar que la sesión se valida en servidor.
- Ese cliente debe ver su perfil, pero no poder acceder a `/api/admin/customers`.
- Iniciar sesión como `viicasa.database@gmail.com`, abrir `/admin` → Clientes registrados.
- Confirmar que aparece el cliente, su email y región estimada. Verificar Canadá
  con una conexión canadiense real y la configuración correcta del proxy.
- Crear una propiedad claramente identificada como PRUEBA, guardar, consultar y
  verificar persistencia tras reiniciar. Archivar al terminar.
- Comprobar que la landing original y sus cuentas siguen funcionando.

El JSON de servicio no permite que nosotros escribamos contraseñas de Google:
el titular de cada cuenta debe completar su acceso. La validación termina cuando
estos recorridos funcionen en el dominio temporal, no solo por haber subido el código.

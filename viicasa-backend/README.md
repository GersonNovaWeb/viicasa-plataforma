# VIICASA Backend - Fase 1

Backend propio para propiedades reservables, tienda, inventario, pedidos, consultas y pagos por API. Sin WordPress, Shopify ni Lodgify.
El frontend conectado está en `../viicasa-frontend-prototype`, con propiedades,
galerías, calendario, tienda, checkout y administración ES/EN. Todavía es una
demostración local; no sustituye la landing Coming Soon publicada.

Estado detallado y límites: [docs/ESTADO_FASE_1.md](docs/ESTADO_FASE_1.md).

## Tecnología y ejecución local

Node.js 24 recomendado, JavaScript ESM y Fastify. La base seleccionada es Firestore
nativo, con transacciones para fechas e inventario. Los adaptadores PostgreSQL/PGlite
se conservan como alternativas históricas, no son un requisito para Hostinger.

```sh
pnpm install --frozen-lockfile
pnpm emulator:start
# En otra terminal, para la API independiente:
pnpm dev
```

Sin `.env` la API escucha en `127.0.0.1:3001`, usa el emulador Firestore
`demo-viicasa` en el puerto 8080, pagos demo y correo en cola. Para la plataforma
integrada seguir el README del frontend: usa otro proyecto local en el puerto 8088.
Puede copiarse `.env.example` a `.env` para ajustar la configuración. No compartir `.env` ni subirlo al repositorio.

- Documentación interactiva local: http://127.0.0.1:3001/docs
- Contrato dinámico: http://127.0.0.1:3001/openapi.json
- Salud: `/health`; conexión a base de datos: `/ready`.
- El contrato estático de ejemplo está en `docs/openapi.demo.json`. El del servidor refleja el proveedor habilitado.

No hay usuarios ni contraseñas predeterminados. Para crear el primer administrador, establecer `ADMIN_CREATE_EMAIL`,
`ADMIN_CREATE_PASSWORD` (12-128 caracteres) y opcionalmente `ADMIN_CREATE_NAME`, y ejecutar:

```sh
pnpm admin:create
```

Estas variables son únicamente de alta. No se imprimen contraseñas. También puede usarse `ADMIN_CREATE_ROLE`
con admin, catalog, support o viewer. El cambio de contraseña vía API revoca todas las sesiones del usuario.

## Estructura

```text
src/
  app.js             API, validación, rutas y documentación
  auth.js            Sesiones de visitantes y personal
  catalog.js         Propiedades, productos, inventario, fotos y consultas
  commerce.js        Cotizaciones, pedidos, reservas y liberación de recursos
  payments.js        Contrato de pasarela, demo y conector Stripe opcional
  notifications.js   Cola transaccional y transporte SMTP
  db.js              Adaptadores PostgreSQL/PGlite y migraciones
  schemas.js         Contratos de entrada
  config.js          Configuración y comprobaciones de producción
  server.js          Arranque y mantenimiento
migrations/          Esquema SQL versionado
test/                Pruebas de API y reglas de negocio
scripts/             Alta de usuarios, datos demo, correo y verificaciones
docs/                Estado y contrato OpenAPI
```

## Reglas del contrato

- Prefijo `/v1`. JSON en snake_case. IDs UUID.
- Precios enteros en la unidad mínima: `250000` representa `2,500.00 MXN`.
- Monedas admitidas inicialmente: MXN y USD; nunca se mezclan en un pedido.
- Fechas de estancia `YYYY-MM-DD`; salida excluyente. La zona horaria de cada propiedad determina la fecha local.
- Una propiedad representa una unidad reservable completa. Cotizar no bloquea fechas; crear la reserva sí.
- `Authorization: Bearer <token>` identifica al visitante o administrador según el endpoint.
- `Idempotency-Key` es obligatorio al crear pedido o reserva. Reutilizar la misma clave y contenido devuelve la operación original.
- El visitante debe conservar su token para consultar la operación; no debe incluirlo en URLs.
- Los importes enviados por el cliente no se admiten. El servidor usa catálogo, tarifa, envío y anticipo vigentes.
- Las operaciones conservan una fotografía de los precios y términos; cambios posteriores al catálogo no las modifican.
- El consentimiento de compra/reserva es obligatorio. Textos definitivos de políticas deben proporcionarse antes de publicar.
- Errores habituales: 400 datos inválidos, 401 sesión, 403 permiso, 404 no encontrado, 409 conflicto, 429 límite de solicitudes.

## Flujo para reservar

1. `GET /v1/properties` y `GET /v1/properties/:slug`.
2. `POST /v1/guest-sessions`; conservar el token.
3. `POST /v1/bookings/quote` con property_id, check_in, check_out, guests.
4. `POST /v1/bookings` con esos campos, customer y pay (`full` o `deposit`), token e Idempotency-Key.
5. `POST /v1/checkouts/:id/payment`; redirigir a checkout_url si la pasarela entrega una URL.
6. `GET /v1/checkouts/:id` para consultar confirmación tras el webhook. La URL de retorno no acredita un pago.

```json
{
  "property_id": "UUID_DE_LA_PROPIEDAD",
  "check_in": "2026-10-10",
  "check_out": "2026-10-13",
  "guests": 2,
  "pay": "deposit",
  "customer": {
    "name": "Nombre del huésped",
    "email": "cliente@example.com",
    "phone": "5512345678",
    "consent": true
  }
}
```

## Flujo para comprar

1. `GET /v1/products` y `GET /v1/products/:slug` para obtener variantes.
2. Crear sesión de visitante.
3. `PUT /v1/cart/items/:variant_id` con quantity; consultar con `GET /v1/cart`; eliminar con DELETE.
4. `GET /v1/shop/settings` para consultar métodos y tarifa de entrega.
5. `POST /v1/orders` con customer y delivery, token e Idempotency-Key.
6. Crear pago y consultar operación igual que en reservaciones.

`delivery=pickup` usa las instrucciones configuradas. `delivery=shipping` requiere shipping_address y envío habilitado.
El envío se configura por moneda en `PUT /v1/admin/shop/settings/:currency`; es una tarifa fija, sin integración de transportista.

## Administración

- Login y perfil: `/v1/auth/login`, `/v1/auth/me`, `/v1/auth/logout`, `/v1/auth/password`.
- CRUD de catálogo: `/v1/admin/properties`, `/v1/admin/products`.
- Variantes: `/v1/admin/products/:id/variants`, `/v1/admin/variants/:id`.
- Stock mediante movimientos: `/v1/admin/variants/:id/stock`; historial en `/movements`.
- Calendario: `/v1/admin/properties/:id/calendar` y `/calendar-blocks`.
- Pedidos/reservas: `/v1/admin/checkouts?kind=order` o `kind=booking`.
- Consultas: `/v1/admin/inquiries`; público `POST /v1/inquiries`.
- Fotos: `POST /v1/admin/media` multipart con una imagen; usar la URL retornada en images.
- Resumen: `/v1/admin/summary`; correo: `/v1/admin/mail-status`; auditoría: `/v1/admin/audit`.

Archivar catálogo conserva el historial. Solo operaciones pendientes pueden cancelarse desde esta API.
Los permisos administrativos son independientes del futuro plan Básico/Pro; esta fase no implementa facturación de planes.

## Pagos

`PAYMENT_PROVIDER=disabled` mantiene el comercio pero rechaza crear cobros con 503.

`PAYMENT_PROVIDER=demo` permite verificar el flujo local: un administrador utiliza
`POST /v1/admin/payments/:payment_id/simulate` con `{ "event_id": "identificador-unico", "outcome": "paid" }`.
Outcomes: paid, failed, expired. No cobra dinero ni ofrece una pantalla de checkout real; está prohibido en producción.

Stripe Checkout es la pasarela seleccionada por el cliente. El conector está
implementado; las claves y pruebas externas se conectarán al final. No hubo cobros reales.
Para probarlo posteriormente: PAYMENT_PROVIDER=stripe, STRIPE_SECRET_KEY de prueba y STRIPE_WEBHOOK_SECRET.
Registrar el webhook `/v1/webhooks/stripe` para checkout.session.completed, checkout.session.expired y, si aplica,
checkout.session.async_payment_succeeded/failed. El checkout habilita tarjetas; no se habilitan métodos de confirmación diferida.

El identificador del pago se persiste antes de llamar a la API y se reutiliza al reintentar. Se verifica la firma sobre el cuerpo original,
la referencia, el importe y la moneda antes de confirmar. Los eventos repetidos no duplican la operación.
Los pagos recibidos después de liberar los recursos quedan en payment_review; no confirman una reserva ocupada o producto vendido.

El pago de anticipo confirma la reservación y registra el saldo pendiente. No incluye cobro automático del saldo ni devoluciones.
No se almacenan números de tarjeta. Las claves permanecen exclusivamente en el servidor.

## Correos y mantenimiento

MAIL_MODE=outbox almacena mensajes localmente sin enviarlos. MAIL_MODE=smtp activa Nodemailer usando SMTP_HOST, SMTP_PORT,
SMTP_SECURE, SMTP_USER, SMTP_PASSWORD y MAIL_FROM. ADMIN_EMAIL recibe avisos administrativos.

El servidor revisa la cola y retenciones cada 30 segundos. También existen `pnpm mail:work` y `pnpm maintenance`.
Los mensajes se encolan en la misma transacción de confirmación. SMTP utiliza reintentos y bloqueo temporal de trabajos.
Una interrupción después de enviar por SMTP pero antes de marcar el registro puede repetir el correo; Message-ID es estable,
pero SMTP no garantiza entrega exactamente una vez. Las operaciones financieras sí deduplican sus eventos.

## Pruebas

```sh
pnpm check
pnpm test
pnpm docs:export
```

Suite local con PostgreSQL embebido aislado. Para repetir en PostgreSQL nativo instalado:

```sh
pnpm test:postgres
```

PG_BIN permite indicar el directorio de initdb/pg_ctl. El script crea y elimina únicamente un clúster temporal propio,
escucha en loopback en un puerto libre y no toca servicios instalados. En esta sesión Windows bloqueó initdb por su sandbox;
la suite nativa queda pendiente. Alternativamente, TEST_DATABASE_URL debe apuntar a una base desechable vacía y exclusiva
antes de ejecutar `pnpm test`; la suite insertará datos de prueba en esa base.

## Hostinger

Hostinger es el destino solicitado y el usuario confirmó soporte Node.js. Se
necesitan Firestore accesible por la cuenta de servicio y almacenamiento persistente
para fotos. No se requiere PostgreSQL. El despliegue de la plataforma sigue pendiente.

Se incluyen Dockerfile y compose.yaml como opción para un VPS. No fueron ejecutados porque Docker no está iniciado en este entorno.
El compose levanta API y PostgreSQL en red privada; solo publica la API en loopback, para colocar un proxy HTTPS delante.
Configurar POSTGRES_PASSWORD con un valor aleatorio apto para URI, PUBLIC_SITE_URL, ALLOWED_ORIGINS y ADMIN_EMAIL en el entorno.
En ese despliegue usar PAYMENT_PROVIDER=disabled hasta configurar la pasarela elegida; nunca demo.

```sh
docker compose up -d --build
```

El volumen postgres_data conserva la base y media_data conserva fotos. Respaldar ambos y probar restauración antes de operación real.
Para la API independiente configurar `pnpm start` y las variables privadas.
Para la plataforma completa usar el servidor del frontend junto con esta carpeta;
ver su README. Confirmar HTTPS, Firestore, índices, permisos y persistencia de medios.
Si el sistema de archivos es efímero, sustituir el almacenamiento de imágenes por un adaptador de objetos antes de subir archivos reales.

TRUST_PROXY=true acepta un salto y debe utilizarse únicamente detrás del proxy controlado con acceso directo a la API restringido.
El limitador de solicitudes es por proceso; varias réplicas requieren un almacén compartido para el límite. PGlite no se admite en producción.

Fuentes técnicas consultadas:

- [Hostinger: opciones Node.js](https://www.hostinger.com/support/node-js-hosting-options-at-hostinger/)
- [Fastify: validación](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [PostgreSQL desde Node: transacciones](https://node-postgres.com/features/transactions)
- [PGlite: API](https://pglite.dev/docs/api)
- [Stripe: creación de Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create)

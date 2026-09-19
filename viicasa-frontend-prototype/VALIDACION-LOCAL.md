# Validación local — 18 de septiembre de 2026

## Cambio posterior: sin selector de moneda y zona de registro

El selector mencionado en las pruebas históricas de abajo fue eliminado por
solicitud del usuario. Se conserva la detección automática y las tarifas del admin.
Se agregaron 7 pruebas aprobadas de clasificación, persistencia, conservación de
la primera zona, cuentas antiguas, paginación y permisos. La lista está en
Administrador → Clientes registrados y la zona también se devuelve al perfil propio.
Las pruebas de Google usan identidades ficticias después del punto de verificación;
no sustituyen el inicio de sesión real pendiente. Las 18 pruebas de plataforma y
monedas siguen aprobadas tras el cambio.

Entorno: Node 24, Firestore Emulator 8088, servidor web 3015. Catálogo ficticio,
simulador de pagos y correos en outbox. No se utilizó Firebase de producción.

## Pruebas automatizadas

- Backend Firestore: **27/27 aprobadas** (`node scripts/test-firestore.js` con
  `TEST_FIRESTORE_HOST=127.0.0.1:8088`), proyecto aislado `demo-viicasa`.
- Plataforma HTTP + monedas: **18/18 aprobadas** (`node --test
  test/currency.test.mjs test/platform.test.mjs`), proyecto `demo-viicasa-platform`.
- Lint JavaScript sin errores de variables no definidas/código inalcanzable;
  CSS validado por parser. Comprobación de sintaxis del backend aprobada.
- El comando global `npm` de este equipo apunta a un `npm-cli.js` inexistente;
  se usó `node` directamente para arrancar, ejecutar pruebas y comprobar los
  ocho archivos de plataforma. No se modificó la instalación global de npm.

Cobertura: permisos, origen/CSRF, publicación de borradores, imágenes, calendario,
reservas concurrentes, idempotencia, inventario, expiración, cancelación,
aislamiento entre clientes, pagos simulados, firma Stripe y cola de correo.

Monedas: tarifas exactas en centavos, ausencia de conversión automática,
rechazo de una moneda sin precio, cálculo de anticipos, pedidos CAD, edición de
variantes, envío CAD, conservación del precio reservado y stock compartido.
IP: prioridad de proxies explícitos, IPv4/IPv6 y fallback seguro.
Se verificó la base local con direcciones públicas de referencia: US → USD,
CA → CAD, loopback → USD; no se enviaron esas IP a una API de geolocalización.

## Recorridos en navegador

- Catálogo: búsqueda “Brisa” devuelve una propiedad; abre su página individual.
- Galería: abre y avanza de foto 1 a foto 2.
- Reserva CAD: tres noches de Casa Brisa, total 1,690 CAD, anticipo 507 CAD;
  creación, preparación de pago simulado y cancelación verificadas. Las fechas
  de esta prueba quedaron liberadas.
- Cambio EN → ES: textos de reserva y estado cambian; CAD se conserva.
- Dashboard demo: acceso, alta de propiedad con slug automático, tarifa USD
  principal y CAD adicional; al reabrir se conserva el importe. La tarifa
  duplicada de la moneda principal está bloqueada. Borrador QA archivado.
- ViiShop: acceso desde el feed a catálogo y ficha; dos jarrones muestran 298 CAD
  o 218 USD, según los precios independientes guardados. Carrito QA vaciado.
- Selector Auto (IP): restablecido, sugiere USD en localhost.
- Vista móvil 390 y 320 px: sin desbordamiento horizontal; encabezado no tapa
  contenido. Se corrigió su altura dinámica. Escritorio revisado a 1089 px.
- Sin errores de consola observados en los recorridos revisados.

Las pruebas conservan historial y archivos QA en el emulador/medios locales;
las propiedades y productos de automatización se archivan al terminar. No
transferir esos datos al catálogo real.

## Pendientes que estas pruebas no sustituyen

- Acceso Google real y permisos de la cuenta del cliente en un origen autorizado.
- Stripe externo: credenciales de prueba completas, webhook y flujo real de
  Stripe Checkout. La prueba de firma local no demuestra que el destino reciba
  eventos en Hostinger.
- IP del visitante detrás del proxy real del hosting y persistencia de medios.
- Índices de Firestore real, SMTP, contenido/legal aprobado, videos y dispositivos físicos.
- Preflight de staging ejecutado: señala 11 requisitos de configuración pendientes
  en el `.env` local actual; es esperado, no se ha habilitado producción.

No se cambió DNS, no se publicó, no se envió correo ni se realizó un cobro real.

# VIICASA — plataforma de desarrollo, fase 1

> Para instalar, publicar y validar la versión empaquetada, usar
> [README.md](../README.md) y [HOSTINGER.md](../HOSTINGER.md) de la raíz.
> Las instrucciones de instalación de este documento corresponden a la
> estructura de desarrollo previa al repositorio unificado.

Actualizado: 18 de septiembre de 2026. Interfaz ES/EN conectada al backend
Firestore de la carpeta hermana `../viicasa-backend`. No modifica ni sustituye
la landing Coming Soon desplegada. Esta plataforma todavía no está publicada.

## Funcionalidad

- `/`: inicio; `/shop`, `/viiconcierge`, `/viilife`: feeds inmersivos existentes.
- `/propiedades`: catálogo con búsqueda, filtros y orden por tarifa.
- `/viiconcierge/:slug`: página individual, portada, galería, detalles con iconos,
  amenidades, políticas, fechas, cotización y solicitud de información.
- `/coleccion` y `/shop/:slug`: productos, variantes, existencias y carrito.
- `/checkout`: reserva con anticipo o pago completo; compra con envío o recolección.
- `/cuenta`: operaciones del visitante y acceso con Google en el entorno real.
- `/admin`: propiedades, fotos, calendario, productos, inventario, operaciones,
  interesados y opciones de envío. La primera foto de cada galería es la portada.
- `/pago/resultado` y `/pago/cancelado`: estado verificado en servidor.

Los importes, disponibilidad, permisos y confirmaciones se resuelven en servidor.
El navegador conserva el idioma; las sesiones usan cookies HttpOnly.
Una visita al resultado de pago nunca marca una operación como pagada.

## Desarrollo local

Conservar ambas carpetas hermanas. Instalar las dependencias del backend con
su versión declarada de pnpm y `pnpm install --frozen-lockfile`. Node.js 24
recomendado para las dependencias actuales. El frontend no instala dependencias propias.

Desde esta carpeta, iniciar Firestore con la CLI instalada en el backend:

```powershell
node ../viicasa-backend/node_modules/firebase-tools/lib/bin/firebase.js emulators:start --only firestore --project demo-viicasa-platform --config firebase.json
```

En otra terminal de esta carpeta: `npm run dev:local` (o `node dev-local.mjs`). Abrir
`http://127.0.0.1:3015/propiedades` o `/admin`. El modo predeterminado es demo,
sólo en loopback y en el proyecto separado `demo-viicasa-platform`, puerto 8088.
El administrador de demostración no existe en modo real. No se envían correos.
No usar datos personales o claves reales en esta demostración.

`dev:local` no carga `.env` y fuerza el simulador. Así puedes conservar la clave
Stripe de prueba pendiente en tu archivo privado sin bloquear el arranque ni
realizar llamadas de pago. `npm start` sí carga `.env`: reservarlo para probar
una configuración completa. No habilitar claves reales para pruebas locales.

Los datos sobreviven al reinicio del servidor web mientras siga el emulador;
para conservarlos al detener el emulador usar su exportación/importación.
Las fotos cargadas se guardan en el directorio de medios del backend.

## Google y Stripe

`.env.example` documenta las variables; copiar sus valores a un `.env` privado
o al gestor de secretos del hosting. Nunca subir JSON de servicio ni claves a Git.

Google en modo real intercambia el ID token por una sesión verificada en servidor.
Se requiere Google habilitado en Firebase, dominios autorizados, configuración web,
credenciales de servidor y `ADMIN_EMAILS=viicasa.database@gmail.com`.
Una operación anónima no se fusiona automáticamente al iniciar sesión con Google.
El código está integrado; el acceso Google real de esta plataforma aún no fue
validado de extremo a extremo. Referencia: [Firebase Google Auth](https://firebase.google.com/docs/auth/web/google-signin).

Stripe es la pasarela elegida. Por ahora se usa un simulador local: el cliente
prepara el pago y sólo el administrador demo puede simular su confirmación.
Para las pruebas posteriores configurar `PAYMENT_PROVIDER=stripe`,
`STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`. El modo local rechaza claves
que no comiencen con `sk_test_`. El webhook recibe los bytes originales en
`/v1/webhooks/stripe` y verifica la firma. No se han probado pagos externos.
El saldo de anticipos se registra; su cobro posterior y los reembolsos no están automatizados.

## Antes de publicar en Hostinger

1. Empaquetar backend y frontend juntos: esta carpeta no es un sitio estático ni
   una aplicación Next.js independiente. Mantener sus rutas relativas.
2. Configurar `NODE_ENV=production`, `PLATFORM_MODE=live`, `SITE_URL` con el origen
   HTTPS exacto sin barra final, `PORT` del hosting y variables privadas de Firebase.
3. Revisar/aplicar los índices y reglas Firestore del backend. No reemplazar reglas
   existentes de la landing sin evaluar el impacto. La API usa permisos de servidor.
4. Asegurar almacenamiento persistente para `MEDIA_DIR`, copias y restauración.
5. Configurar Stripe en pruebas y verificar webhook, Google, SMTP, correos,
   cancelaciones y vencimientos en el entorno final.
6. Cargar catálogo y medios reales, precios y condiciones. El aviso de privacidad
   es un borrador; `PRIVACY_APPROVED` y `COMMERCE_ENABLED` deben seguir en false
   hasta aprobarlo y habilitar la operación expresamente.
7. Revisar los recorridos en navegador de escritorio y móvil antes del lanzamiento.

Consultar [HOSTINGER-PREPARACION.md](HOSTINGER-PREPARACION.md). Existe un preflight
de staging de solo lectura: `node --env-file-if-exists=.env preflight.mjs`.
No imprime secretos, no despliega y no reemplaza validaciones externas.

## Monedas y detección de país

- Canadá sugiere CAD; Estados Unidos y los demás países sugieren USD.
- No hay selector de moneda para el visitante. La moneda se sugiere automáticamente
  por IP; se ignora/elimina la preferencia manual de versiones anteriores.
  Idioma y moneda son independientes. El administrador conserva ambas tarifas editables.
- El administrador introduce importes independientes para cada moneda. **No hay
  tipo de cambio ni conversión automática.** Esto aplica también a limpieza,
  variantes de productos y tarifas de envío.
- La tarifa principal se edita en sus campos principales; sus duplicados aparecen
  bloqueados para evitar dos precios contradictorios. Las otras tarifas son opcionales.
- Sin tarifa en la moneda seleccionada no se permite cotizar/comprar ese artículo;
  no se inventa ni se convierte un importe.
- La reserva/pedido conserva su moneda e importes aunque luego cambie el catálogo.
- Detección en servidor con base local `ip-location-api`, fuente `user-country`;
  ninguna IP del visitante se envía a un proveedor de geolocalización.
- Solo se aceptan direcciones reenviadas por proxies explícitos de
  `TRUSTED_PROXY_IPS`. Confirmar sus direcciones con el hosting; no confiar en
  cabeceras de país enviadas por el navegador ni configurar confianza universal.
- En localhost no existe una IP pública del visitante: se usa USD. VPN, redes
  móviles y datos de geolocalización pueden dar un país incorrecto. No se utiliza
  para impuestos, nacionalidad, residencia verificada ni control de acceso.
- Antes de publicar, ejecutar `node scripts/geoip.mjs` desde el backend para
  preparar la base. Para actualizarla, `node scripts/geoip.mjs --update` y reiniciar
  el servidor. No se programaron actualizaciones automáticas.
- Fuente y licencia de los datos: [user-country](https://github.com/sapics/ip-location-db/tree/main/user-country),
  [CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). Conservar esa licencia
  si se redistribuye la base. El código de la dependencia conserva sus avisos
  de licencia dentro del paquete instalado.

Los precios USD/CAD del catálogo demo son ejemplos ficticios, no equivalencias
de MXN. No se agregan en modo live. Esta funcionalidad usa el adaptador Firestore;
el adaptador SQL legado no fue ampliado para tarifas multimoneda.

## Clientes registrados y zona de origen

Al primer registro Google verificado en servidor se guarda `registration` en el
perfil: país estimado, grupo `canada` / `rest_of_world` / `unknown`, fuente y fecha.
No se conserva la IP completa. Esta estimación se mantiene en los siguientes
accesos; no se reemplaza por una conexión de otro país. Registros antiguos sin
evidencia histórica se muestran como “No detectado”, sin inventar su origen.

La zona se muestra en Mi cuenta y en Administrador → Clientes registrados. La lista
requiere permisos de administrador, soporte o consulta; no incluye visitantes
anónimos ni expone tokens o identificadores de Google. Se pagina por ID para incluir
también cuentas antiguas sin metadatos de creación y no requiere un índice compuesto nuevo.

Prueba aislada: desde backend, definir `TEST_FIRESTORE_HOST=127.0.0.1:8088` y ejecutar
`node --test test/customer-registration.test.js`. Usa identidades ficticias en
un proyecto demo separado; no inicia sesiones Google reales ni modifica usuarios reales.

No se han cambiado DNS, desplegado esta plataforma, escrito datos en Firebase
real, enviado correos ni realizado cobros durante estas pruebas.

## Comprobación

- `npm run check`: sintaxis JavaScript.
- `npm run test:platform`: recorridos HTTP sobre la demo activa; crea registros
  QA ficticios y archiva sus propiedades/productos al terminar.
- `npm run test:currency`: precios USD/CAD, pagos simulados, envío, prioridad de
  tarifas y tratamiento seguro de IP. También requiere la demo activa.
- Backend: `TEST_FIRESTORE_HOST=127.0.0.1:8088` con `node scripts/test-firestore.js`
  en su carpeta prueba un proyecto demo diferente.

Los controles HTTP no sustituyen pruebas visuales o Google/Stripe externos.
Los índices compuestos necesitan verificación en Firestore real, no en emulador.

## Medios y alcance

Las cuatro propiedades iniciales y los productos son demostraciones identificadas.
Las imágenes proceden de los diseños anteriores; no representan inventario real.
No se recibieron videos: las escenas mantienen `video: null` en `app.js` y usan
fotografías. Al agregar videos aprobados, probar autoplay silenciado, bucle,
pausa fuera de pantalla y respaldo de imagen en dispositivos reales.
Se preserva la estética Immersive Luxury. El editor por bloques, suscripciones
Básico/Pro y automatizaciones avanzadas quedan para fases posteriores.

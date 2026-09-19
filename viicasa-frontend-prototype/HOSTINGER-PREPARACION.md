# Preparación de VIICASA para staging en Hostinger

> Documento histórico anterior al empaquetado. Para este repositorio, seguir
> [HOSTINGER.md](../HOSTINGER.md) y [README.md](../README.md) de la raíz.
> La instalación y los comandos actuales se ejecutan desde la raíz con npm;
> la primera validación de Google/Firestore mantiene Stripe desactivado.

Estado: pruebas locales. No se publicó esta plataforma ni se modificó la landing.

## Estructura que hay que conservar

```text
viicasa-backend/              # dependencias, pnpm-lock.yaml, API y reglas
viicasa-frontend-prototype/   # servidor web, BFF y archivos públicos
```

Esta plataforma es Node.js, **no el proyecto Next.js de Coming Soon**. No basta
con importar únicamente la carpeta frontend. Antes de crear la aplicación en
Hostinger hay que preparar un repositorio/paquete que contenga ambas carpetas,
excluyendo `.env`, JSON privados, `node_modules`, datos del emulador y medios QA.
No se ha creado ni subido ese repositorio en esta etapa.

Instalar en `viicasa-backend` con la versión de pnpm declarada en `package.json`:

```powershell
pnpm install --frozen-lockfile
node scripts/geoip.mjs
```

Arranque desde `viicasa-frontend-prototype`: `node server.mjs`. No usar
`dev-local.mjs` en hosting. El proceso respeta `PORT`; en live escucha en
`0.0.0.0`. La instalación no necesita compilación de frontend. Confirmar que el
plan Node permite esta estructura, comando de inicio y persistencia de archivos
antes de sustituir el sitio existente. Node debe satisfacer los motores declarados
por las dependencias (se probó localmente con Node 24).

## Configuración privada

Usar `.env.example` como lista de nombres, no subir `.env` a Git. Configurar:

- `NODE_ENV=production`, `PLATFORM_MODE=live`.
- `SITE_URL`: origen HTTPS de staging exacto, sin ruta ni barra final.
- Variables web Firebase, cuenta de servicio del mismo proyecto y
  `ADMIN_EMAILS=viicasa.database@gmail.com`.
- `PAYMENT_PROVIDER=stripe`, clave **de prueba** y secreto del webhook de staging.
- `MEDIA_DIR`: directorio privado y persistente. Probar que las fotos sobrevivan
  a un redeploy; si el plan no lo garantiza, resolver almacenamiento externo antes
  de subir el catálogo real.
- `TRUSTED_PROXY_IPS`: solo proxies confirmados por el proveedor. La aplicación
  ignora `X-Forwarded-For` de orígenes no confiables. Sin esa configuración la IP
  podría ser la del proxy y la sugerencia de moneda no sería la del visitante.
- SMTP si se van a probar correos. `MAIL_MODE=outbox` no envía mensajes.
- Mantener `COMMERCE_ENABLED=false` y `PRIVACY_APPROVED=false` hasta revisar el
  aviso, condiciones y autorización de pruebas públicas.

Ejecutar `node preflight.mjs` con las variables del hosting cargadas; localmente
puede utilizarse `node --env-file-if-exists=.env preflight.mjs`. Comprueba formato
y presencia, no permisos de las credenciales ni disponibilidad de los servicios.
Está deliberadamente limitado a claves Stripe de prueba.

## Lista de aceptación antes de producción

1. Google: inicio/cierre de sesión, dominio autorizado y popup en móvil. Probar un
   usuario normal y el administrador; el primero debe recibir rechazo en `/api/admin/*`.
2. Firestore: revisar índices y permisos, separar datos demo/reales y respaldar.
   No aplicar reglas sobre la base usada por la landing sin revisar su impacto.
3. Moneda: desde una conexión pública canadiense comprobar CAD; desde EE. UU.
   comprobar USD; comprobar Canadá/resto del mundo en el registro y dashboard.
   No hay selector manual de moneda. Confirmar tarifas reales
   ingresadas por el administrador. No usar la IP para calcular impuestos.
4. Propiedades: guardar, publicar, galería, portada, calendario, solapamientos,
   anticipo y expiración. Revisar zonas horarias y condiciones reales.
5. Stripe: destino de eventos `https://ORIGEN/v1/webhooks/stripe`, firma verificada,
   pago exitoso/rechazado, evento repetido y retorno del checkout. Una redirección
   no acredita el pago. El CLI bloqueado no impide preparar estos flujos, pero la
   validación externa requiere permisos/configuración de Stripe.
6. Pedidos: existencias concurrentes, envío/recolección, cancelación y total en la
   misma moneda desde catálogo hasta Stripe. Confirmar impuestos y cobertura de
   entrega con el cliente antes de operar; no se infieren por geolocalización.
7. Correos, persistencia de fotos, copias/recuperación, errores y límites.
8. Videos y fotografías aprobados, contenido ES/EN, accesibilidad y dispositivos reales.

Los cobros de saldos pendientes, reembolsos automáticos, editor por bloques y
planes Básico/Pro siguen fuera de esta validación local. No activar pagos reales
ni cambiar DNS hasta cerrar los pendientes y recibir autorización.

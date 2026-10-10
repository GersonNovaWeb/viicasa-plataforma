# ViiLife: cierre de fase 1

## Flujo aprobado implementado

- Formulario sencillo después del scroll de ViiLife y en `/viilife/limpieza`.
- En modo live usa las tarifas de **Limpieza de hogar** del administrador, en CAD.
  No convierte importes USD ni migra pedidos demo. El admin debe confirmar CAD.
- Rutinaria: tarifa por hora × horas por visita × días seleccionados, un ciclo
  sin renovación automática. Ejemplo: 99.99 × 3 × 5 = **1,499.85 CAD**.
- Más de 3 horas **o** más de 3 días genera atención personalizada sin bloquear
  el pago. La solicitud se guarda al pulsar Continuar; no se capturan formularios
  abandonados antes de enviarlos.
- El cliente paga con tarjeta en Stripe, sin aprobación previa del administrador.
  Guardar la solicitud no envía correos. Al confirmar el webhook de pago llega
  el recibo empresarial en inglés y el aviso al equipo. El pago no confirma
  automáticamente un horario: ViiLife contacta después para coordinarlo.
- Se eliminan los avisos de abandono/pedidos grandes sin pagar. El administrador
  solo puede registrar seguimiento después del pago, para pedidos de cualquier
  tamaño. Un pago recibido en revisión permite contacto, sin prometer la visita.
- Las propiedades de prueba se mantienen sin cambios y no se vuelven reservables
  en producción por activar ViiLife. La landing no cambia.

## Configuración de prueba en Hostinger

Sobre la plataforma de pruebas, no la aplicación Coming Soon:

```dotenv
VIILIFE_MODE=live
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_REEMPLAZAR_EN_PRIVADO
STRIPE_WEBHOOK_SECRET=whsec_DEL_DESTINO_DE_HOSTINGER
MAIL_MODE=smtp
ADMIN_EMAIL=gerson@novaweb-agency.com
AUTH_EMAIL_ENABLED=true
```

Conservar Firebase, `SITE_URL` exacto HTTPS, SMTP y las demás variables vigentes.
No reutilizar el secreto de `stripe listen` para un destino webhook de Hostinger:
cada destino tiene el suyo. Nunca subir los secretos al repositorio.

`COMMERCE_ENABLED=true` y `PRIVACY_APPROVED=true` solo una vez aprobadas y publicadas
las condiciones. En admin → Limpieza de hogar, confirmar moneda CAD, precios,
cobertura y condiciones; marcar tarifas confirmadas y habilitar pagos.
No basta con cambiar `VIILIFE_MODE`: esas protecciones siguen activas.

En Stripe, usar el **mismo sandbox** para la clave y el destino webhook
`https://DOMINIO-DE-PLATAFORMA/v1/webhooks/stripe`. Configurar eventos de Checkout
completado, pago asíncrono exitoso/fallido y expirado que admite el backend.
Mantener `sk_test_` hasta completar aceptación. No activar claves `sk_live_`
solo para hacer esta prueba.

## Pruebas de aceptación

1. Entrar como cliente A, enviar una limpieza de 3 h × 5 días y verificar total.
2. Confirmar que aparece pendiente en Mi cuenta y en admin, sin aprobación previa.
3. Completar Stripe Checkout con datos de prueba del sandbox.
4. En Stripe verificar que el webhook recibió HTTP 2xx; en VIICASA que el pedido
   está confirmado y el importe/moneda son los mismos.
5. Revisar la recepción real del recibo en inglés con logo, referencia, conceptos,
   fechas/horas y total. `sent` en el outbox solo significa aceptación por SMTP.
6. Reenviar el mismo evento desde Stripe: no debe duplicar pedido ni correo.
7. Recargar, salir/entrar y reiniciar el despliegue: el pedido debe conservarse.
8. Con cliente B, intentar consultar el ID de A: debe denegarse. Revisar también
   pago y cancelación. Probar rechazo de pago y una solicitud grande sin completar:
   no deben generar avisos al equipo ni permitir marcar el cliente como contactado.
9. Probar Google, Apple y correo siguiendo `ACCESOS-CLIENTES.md`.

## Validación automática local

```powershell
npm run check
npm run test:social-auth
npm run test:stripe-local
npm run test:stripe-cad
npm run test:viilife-mail
$env:TEST_FIRESTORE_HOST="127.0.0.1:8088"
npm run test:viilife-live
npm run test:cleaning
```

El emulador debe estar iniciado. Los tests usan proyectos `demo-*`, una pasarela
simulada con verificación de firmas Stripe y transporte de correo simulado.
No hacen cobros, no escriben en el proyecto real y no prueban la entrega al buzón.
Para probar el sandbox externo: `npm run dev:stripe`, junto con `stripe listen`
y `.env.stripe.local` privado; en admin local habilitar las tarifas de limpieza.

Este documento no certifica que el despliegue remoto ya haya pasado las pruebas.
El lanzamiento definitivo requiere aprobación del cliente y completar el recorrido.

## Prueba externa de Stripe sandbox — 8 de octubre de 2026

- Checkout real de sandbox, con tarjeta ficticia de Stripe: **199.98 CAD**
  (99.99 CAD/h × 2 horas × 1 día). Sin cobros reales.
- Pedido local: `1bed8561-7ab4-4731-a245-7117d8340455`.
- Evento real: `evt_1UOPOjAk4dFcLdYTrJ0khbVT`, `checkout.session.completed`.
- El listener oficial entregó el webhook firmado; el servidor respondió HTTP 200.
- Firestore **emulado** terminó con pedido `confirmed`, pago `paid`, importe
  `19998` centavos y moneda `CAD`. No se escribió en Firestore de producción.
- Se generaron tres mensajes en la cola local. No se enviaron por SMTP.
  Las siete pruebas automatizadas de correo aprobaron; la recepción real sigue
  pendiente. El contador auxiliar de recibos de esta ejecución buscaba una cadena
  no aplicable al modo demo y no sirve como evidencia del contenido de los recibos.
- La prueba detectó conversión automática a MXN en Stripe. Se desactivó
  `adaptive_pricing` solo para ViiLife (`kind=cleaning`); el segundo Checkout mostró
  y cobró 199.98 CAD sin conversión. El Checkout anterior sin pagar se expiró.
  Una prueba de regresión verifica que tienda y propiedades no cambian.
- La página de retorno a localhost no pudo verificarse en el navegador
  (`ERR_CONNECTION_REFUSED`); el proceso de prueba se cerró al confirmar el pago.
  No se considera validado el recorrido visual completo de Mi cuenta.
- Apple permanece visible/desactivado hasta que el cliente complete su alta.

Pendiente antes de producción: repetir en Hostinger con su propio webhook de
sandbox, verificar el retorno/Mi cuenta, persistencia remota y recepción SMTP.
Esta prueba no activa pagos reales ni publica los cambios en GitHub/Hostinger.

## Botones del scroll ViiLife

- Tres acciones en cada panel, en ES/EN: contratar limpieza, avanzar a la siguiente
  sección y abrir información especial del servicio visible. El último avance
  llega a servicios/tarifas. La compra sigue el flujo existente de Stripe.
- La consulta especial usa el formulario de consultas existente; no se confunde
  con un pedido pagado ni modifica sus reglas de seguimiento.
- Botón principal blanco, secundario transparente y consulta discreta; estilos
  móviles, foco visible, desplazamiento con reducción de movimiento y enlace
  de contratación que conserva apertura en otra pestaña.
- `npm run test:viilife-actions`: dos pruebas aprobadas. Se observó en escritorio
  el diseño, el avance al segundo panel y la consulta contextual de lavandería.
  Pendiente: comprobación visual móvil y llegada al formulario cargado; el entorno
  local presentó conflictos de puertos y tiempos de espera. No se enviaron
  consultas, correos ni pagos reales para esta revisión.

### Ajuste posterior: contacto después del cobro

La regla más reciente sustituye los avisos previos al pago descritos en la prueba
histórica anterior. El flujo rápido ahora genera cero correos al guardar y dos
recibos/avisos al recibir el webhook pagado (cliente y equipo). No hay alertas de
abandono. Se comprobaron 28 pruebas con Firestore emulado, incluyendo bloqueo de
seguimiento antes del pago, habilitación posterior y webhooks duplicados; además
aprobaron las pruebas unitarias de tarjeta/CAD y correo. No se repitió un cobro en
Stripe externo ni se enviaron correos reales para este ajuste.

### Navegación y scroll — 9 de octubre de 2026

- Navegación normal y restauración de páginas comienzan arriba; se respetan los
  enlaces explícitos a la sección de contratación o al formulario.
- Los botones desplazan únicamente el feed y compensan el encabezado fijo.
- ViiLife utiliza snap de proximidad entre las escenas; el formulario largo no
  es un destino de snap. Las vistas de checkout eliminan los estilos del feed.
- `npm run check`: 77 archivos JavaScript sin errores de sintaxis.
- `npm run test:scroll`: cinco pruebas aprobadas de reinicio, destinos, CSS y CTA.
- Pendiente: validación visual en escritorio y móvil. El navegador no pudo
  conectar con la vista aislada local (timeout). Esta revisión no valida
  Firestore, correos ni pagos, ni se ha desplegado en Hostinger.

### Aprobación de pedidos grandes — 10 de octubre de 2026

Esta regla sustituye la instrucción anterior de pagar primero SOLO para pedidos
nuevos del flujo rápido de ViiLife que superen 3 horas por visita O 3 días por
ciclo. Los pedidos pequeños mantienen el pago directo. Los pedidos históricos
no se migran y ningún pedido pagado vuelve a solicitar un cobro.

- Pedido grande: `awaiting_approval`, sin plazo de pago mientras espera. Se
  encolan avisos en inglés al comprador y a `ADMIN_EMAIL`, con la marca VIICASA.
- Panel ViiLife: tarifas plegables, tarjetas, filtros y contadores de la página,
  notas y casilla Contactado independiente de la aprobación.
- Aprobar pago es una acción administrativa explícita: pasa a `pending` por
  24 horas para iniciar Stripe y encola una sola notificación al comprador con
  enlace a `SITE_URL/cuenta#viilife-orders`. Iniciar sesión conserva la propiedad
  del pedido; el enlace no concede acceso ni contiene tokens.
- Cancelar solicitud de pago notifica al comprador y bloquea pagar. No cancela
  pagos ya iniciados en Stripe ni emite reembolsos: esos intentos se deben revisar
  antes de proceder. Los pedidos pagados están protegidos también en el servidor.
- La API exige rol admin para contacto/aprobación/cancelación y no permite saltar
  la aprobación solicitando directamente una sesión Stripe.
- Pruebas locales con almacenamiento en memoria y SMTP simulado: límites,
  idempotencia, permisos HTTP, propiedad, recibos y renderizado de controles.
  No hubo envíos de correo, compras ni escrituras en Firestore real.
- Pendiente: prueba visual (el navegador no pudo acceder a localhost), prueba
  contra Firestore y entrega real de correo en Hostinger. Las pruebas que
  necesitan el emulador no se consideran validadas en esta revisión.

Para desplegar: mantener `VIILIFE_MODE=live`, `PAYMENT_PROVIDER=stripe` con claves
de PRUEBA para QA, `MAIL_MODE=smtp`, SMTP válido y `ADMIN_EMAIL` correcto. El índice
`mail_outbox` (`status` ascendente + `next_attempt` ascendente, alcance colección)
debe estar Habilitado. El panel muestra el estado de la cola y errores sanitizados;
no garantiza recepción en bandeja. El worker intenta procesar correo cada 30 s.

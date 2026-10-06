# ViiLife — limpieza de hogar, fase 1

Fuente: `VIICasa_Limpieza_de_Hogar_Pago_ES (1).pdf`, una página. Implementación en la plataforma, no en Coming Soon. Cobertura confirmada por el cliente: Canadá. Moneda elegida por el administrador: CAD o USD, sin conversión automática.

## Flujo

- `/viilife` → primer servicio → `/viilife/limpieza` (ES/EN).
- Rutinaria: tarifa por hora × horas por visita × días seleccionados. Un día marcado equivale a una visita por ciclo semanal o quincenal; quincenal NO duplica los días (3 días = 3 visitas, no 6). Un solo ciclo, sin renovación automática. Ejemplo: 99.99 CAD × 2 h × 3 días = 599.94 CAD. Las habitaciones 3–6, 5–8 y 7+ son orientativas, no multiplicadores.
- Profunda: mudanza o estacional; se elige una sola medida. Base 350 por los primeros 700 pies cuadrados más 0.25 por cada pie **adicional**, o 350 por las primeras 3 habitaciones más 75 por cada habitación **adicional**. No se aplican ambas fórmulas a la vez.
- Extra de limpieza completa, solo mudanza: 1,000 por los primeros 500 pies cuadrados más 1 por cada pie adicional. Se suma al servicio principal; se captura el área por separado aunque la limpieza principal se mida por habitaciones.
- Montaje, decoración y retiros: solo mudanza, sin importe asignado. El resumen y recibo dicen «Estimación pendiente». No se cobran ni se contrata una cotización en persona automáticamente.
- Rutinaria: días de visita cobrables; profunda: días posibles para una sola visita (no multiplica el precio). Se elige una franja horaria y habitaciones de enfoque. El equipo confirma las fechas; no hay calendario de disponibilidad, fecha de inicio ni asignación automática de personal.
- Datos, dirección y consentimiento. En producción se utiliza el acceso social verificado existente; escribir un email no crea una cuenta ni permite suplantarla. Iniciar sesión antes del formulario. En demo se permite la sesión de visitante local.
- Suscripción a novedades mediante casilla opcional sin premarcar; baja desde Mi cuenta. Preferencias aisladas de `cs_*`. No se implementan campañas masivas.
- Cobertura predeterminada: país CA. Puede restringirse por prefijos postales en admin; no usa IP para cobertura. Se comprueba la sintaxis del código postal canadiense, no se geocodifica ni certifica la existencia de la dirección.
- Dentro de cobertura: crea un checkout de tipo `cleaning` por el precio calculado en servidor. Stripe utiliza la infraestructura existente de pago y webhook. Pago completo por **un ciclo de visitas** en rutinaria y **una visita** en profunda, sin renovaciones automáticas. La frecuencia no crea una suscripción de Stripe.
- Fuera de cobertura: guarda una solicitud sin checkout/pago y encola dos correos: aviso al administrador y disculpa al cliente con enlace a ViiShop y hasta tres productos publicados disponibles. Sin cobertura configurada se encola un aviso de revisión, no una falsa confirmación de rechazo.
- Webhook verificado confirma pago y encola recibos. Redirigir a «éxito» no confirma nada. Seguimiento de extras en admin solo se habilita tras pago confirmado.

## Activación después de desplegar

1. Admin → **ViiLife · Limpieza**. Elegir CAD o USD; modificar importes si hace falta. Cambiar la moneda no calcula un tipo de cambio; el administrador debe revisar las cifras.
2. Confirmar cobertura: todo Canadá o códigos postales. Prefijos sin espacios, uno por línea (ejemplo: `V1Y`); no usar una lista de ciudades como si fueran códigos.
3. Revisar condiciones ES/EN y tratamiento de impuestos. No hay cálculo fiscal nuevo; los importes deben ser los finales aprobados antes de activar. El modelo comercial confirmado es un ciclo de visitas en rutinaria y una visita en profunda, no una suscripción. Revisar condiciones personalizadas del administrador: no se sobrescriben automáticamente.
4. Marcar la confirmación de tarifas/moneda/condiciones y habilitar el servicio. **Por defecto queda deshabilitado**, sin activar cobros reales desde el desarrollo.
5. Mantener `COMMERCE_ENABLED=true`, `PRIVACY_APPROVED=true` y las variables existentes de Stripe de prueba para validación. No publicar claves. Antes de producción validar el pago de prueba completo y el webhook.
6. Para envío de notificaciones, configurar SMTP, `MAIL_FROM` y `ADMIN_EMAIL` en el servidor. Sin SMTP los mensajes permanecen en `mail_outbox`; no se promete entrega. El trabajador existente se ejecuta cada 30 segundos y requiere los índices de correo ya incluidos en el proyecto.

## Seguridad y persistencia

`cleaning_settings`, `cleaning_requests`, `cleaning_idempotency`, `cleaning_preferences`; comparte `checkouts`, `payments`, `mail_outbox` y auditoría de la plataforma. No modifica `cs_*`, credenciales, reglas reales ni datos en producción.

Importes en centavos, validación estricta, extras incompatibles rechazados, idempotencia de solicitudes y pagos, propietario del checkout y permisos administrativos conservados. Cada operación guarda precio, moneda, número de visitas, horas, ciclo, condiciones y preferencias como snapshot. Las operaciones antiguas mantienen su importe y alcance de una visita; no se recalculan. El contrato `pricing_version: 2` exige que nuevas solicitudes usen el nuevo cálculo: formularios anteriores deben recargar y revisar el total. Un cambio de configuración entre cotización y solicitud exige cotizar de nuevo. Los cambios posteriores no reetiquetan operaciones existentes.

Admin ofrece moneda, tarifas, bases incluidas, cobertura, solicitudes paginadas y seguimiento interno. Mi cuenta muestra el checkout y preferencias de novedades. Las solicitudes sin pago están en el panel; no se crea una reserva de horario ni asignación de personal. Cancelar pagos confirmados o devolver dinero conserva el flujo de revisión existente, no hace reembolsos automáticos.

## Pruebas locales

```powershell
npm run check
$env:TEST_FIRESTORE_HOST='127.0.0.1:8088'
npm run test:cleaning
npm run test:platform
```

La suite de limpieza crea un proyecto `demo-clean-*` aislado y pagos ficticios. Sin `TEST_FIRESTORE_HOST` ejecuta pruebas unitarias y omite integración explícitamente. `npm run dev` usa emulador 8088 y puerto 3015; no carga `.env`, ni abre Stripe o SMTP reales.

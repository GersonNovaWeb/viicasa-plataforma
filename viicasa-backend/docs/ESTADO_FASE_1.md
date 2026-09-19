# Estado de implementación - Fase 1

Actualizado: 16 de septiembre de 2026.

## Actualización vigente: Firestore y plataforma conectada

La implementación elegida ya no requiere PostgreSQL: existe un backend Firestore
nativo y el frontend ES/EN conectado en `../viicasa-frontend-prototype`.
Stripe fue confirmado como pasarela; sus credenciales se conectarán al final.
La plataforma incorpora catálogo y página por propiedad, portada/galería, iconos,
cotización, calendario administrativo, tienda, carrito, checkout, consultas y panel.
Se conservan los feeds inmersivos; todavía faltan videos aprobados del cliente.

Validación actual: 27 pruebas del backend Firestore y 10 de recorridos HTTP de
la plataforma completadas sin fallos. Verifican permisos, imágenes, reservas
simultáneas, inventario, cancelaciones, calendario, solicitudes y pago simulado.
Se ejecutaron con dos proyectos de emulador separados, sin datos reales.
También se comprobó sintaxis JavaScript. No equivalen a pruebas en navegador,
pruebas de Google real, SMTP ni pagos Stripe externos.

Pendiente para producción: configuración final Hostinger/HTTPS, reglas e índices
Firestore revisados con la landing existente, almacenamiento persistente de medios,
pruebas Google y Stripe con webhook, SMTP, catálogo real, términos/privacidad,
revisión de escritorio/móvil y autorización de lanzamiento. La cuenta administradora
prevista es `viicasa.database@gmail.com`. No se han cambiado DNS ni publicado
esta plataforma. La landing Coming Soon existente sigue sin cambios.

El estado siguiente conserva el historial de la entrega SQL del 4 de septiembre;
sus referencias a PostgreSQL obligatorio, pasarela sin elegir y frontend pendiente
han sido sustituidas por esta actualización. Sus límites funcionales siguen vigentes.

## Implementado en código

- API HTTP independiente, preparada para conectarse a cualquier diseño de frontend.
- Migraciones SQL, PostgreSQL externo para despliegue y PGlite local para desarrollo.
- Usuarios administrativos, contraseñas con scrypt, sesiones revocables y roles admin/catalog/support/viewer.
- Sesiones de visitante para comprar y reservar sin obligar a crear una cuenta.
- Propiedades, fotografías, amenidades, capacidad, precios, limpieza, noches mínimas, anticipo y políticas.
- Disponibilidad por propiedad, bloqueos manuales de calendario y reservas con retención temporal.
- Productos, categorías, variantes, SKU, movimientos de inventario y archivo de publicaciones.
- Carrito, pedidos, recolección o envío con tarifa fija por moneda y captura de dirección.
- Importes calculados en servidor y conservados en cada operación.
- Aislamiento del acceso a las compras/reservas por token de visitante.
- Idempotencia al crear operaciones, bloqueo de filas e inventario transaccional.
- Cancelación de operaciones pendientes, vencimiento y liberación de existencias.
- Módulo de pagos intercambiable: deshabilitado, simulador local y conector opcional Stripe Checkout.
- Verificación de firma del webhook Stripe; una redirección del navegador nunca confirma un pago.
- Confirmaciones y rechazos en cola de correo, transporte SMTP y reintentos.
- Consultas, resumen administrativo, registro de cambios y documentación OpenAPI.

## Validado

26 pruebas automatizadas con PostgreSQL embebido PGlite: autorización, exposición pública, cálculo de importes, fechas,
capacidad, reservas solapadas, entradas consecutivas, idempotencia, bloqueos, carrito, inventario, moneda, envío,
cancelación, vencimiento, acceso entre visitantes, pagos aprobados/rechazados/repetidos/tardíos, firma de Stripe,
cola de correo, subida de imágenes, configuración de producción, HTTP real y persistencia después de reiniciar.

Se verificó la sintaxis de los módulos JavaScript. La suite usa solicitudes HTTP inyectadas sobre Fastify y base de datos real embebida,
sin conectarse a proveedores externos; una prueba adicional abre un puerto HTTP local. PGlite serializa las transacciones: las solicitudes simultáneas de esta suite no sustituyen
una prueba de concurrencia con varias conexiones PostgreSQL nativas.

Se preparó scripts/test-postgres.js para repetir la suite en un clúster PostgreSQL temporal. El intento en esta sesión
no pudo inicializar el clúster: el entorno aislado de Windows impidió a initdb crear su token restringido/directorio.
No se cambiaron servicios ni bases existentes. Esta verificación queda pendiente en un equipo o entorno de integración compatible.

## Pendiente antes de considerar la Fase 1 operativa

1. Confirmar el plan Hostinger, preparar PostgreSQL externo y almacenamiento persistente para imágenes.
2. Elegir pasarela. Stripe es un conector opcional de referencia, no una elección comercial confirmada.
3. Si se elige Stripe: configurar claves de prueba y webhook; si se elige otra pasarela: implementar su adaptador y verificación.
4. Configurar SMTP y verificar recepción real de mensajes del cliente y administrador.
5. Cargar catálogo, precios finales, moneda, términos, reglas de cancelación, política de anticipo y envíos acordados.
6. Implementar el diseño elegido, conectar formularios y realizar compras/reservas de extremo a extremo en computadora y móvil.
7. Ejecutar pruebas PostgreSQL nativas, contenedores, HTTPS, copias de seguridad y restauración en el entorno de despliegue.
8. Ejecutar el pago real de bajo importe cuando se autorice expresamente.

No se han hecho cobros, enviado correos a terceros, conectado cuentas, desplegado en Hostinger ni construido el frontend.
Los correos locales permanecen en la cola y los pagos demo son simulaciones. La Fase 1 completa aún no se declara finalizada.

## Límites de esta entrega

- Un sitio y una organización VIICASA; no incluye multitenencia ni cobro de suscripciones Básico/Pro.
- Una unidad reservable por propiedad. Varios departamentos/habitaciones requieren unidades separadas en el modelo futuro.
- Precios finales configurados; no calcula automáticamente impuestos, temporadas ni fiscalidad.
- El anticipo registra el saldo restante, pero su cobro posterior automático y las devoluciones quedan pendientes de la pasarela/políticas.
- El envío básico guarda dirección y cobra tarifa fija; no crea guías ni cotiza transportistas.
- Las confirmadas no se cancelan automáticamente desde el endpoint de pendientes: requieren revisión del pago y política de devolución.
- Fotos PNG/JPEG/WebP/GIF públicas, hasta 8 MiB por carga; sin optimización o procesamiento de video en esta fase.
- Edición visual por bloques, menús Básico/Pro completos, CRM, temporadas, sincronización de canales y automatizaciones avanzadas son etapas posteriores.

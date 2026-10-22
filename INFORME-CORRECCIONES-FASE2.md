# VII · Integración del informe del cliente

Trabajo en el proyecto de la plataforma real, en una rama independiente. No se ha desplegado, conectado PostgreSQL, enviado correo real ni hecho un cobro durante esta revisión.

## Alcance y base de datos

`server.js` conserva el servidor de Firebase/Firestore y el acceso existente de clientes y administradores. No se ha sustituido por el servidor de demostración de fase 2, ni se han copiado archivos `.env`, bases locales, credenciales o cuentas de ejemplo.

El código comercial de fase 2 está en `phase2/`. Sus contratos, CRM, facturación programada y agenda comercial siguen **preparados, no conectados al runtime real**. Los portales muestran esa limitación de forma explícita. Integrar su identidad, permisos y datos con el runtime real y validar PostgreSQL será parte de la activación posterior; copiar los módulos no acredita esa integración.

## Correcciones del informe

| Punto | Implementación / límite |
| --- | --- |
| 1. Ficha y compra diferenciadas | Imagen/título abren ficha; Comprar/Reservar abren checkout directo. Fechas y huéspedes se conservan. |
| 2. Checkout invitado | Nombre, email y teléfono; entrega y dirección para ViiShop; fechas/huéspedes para propiedades. La tarjeta se introduce en Stripe Checkout, no en nuestro servidor. Crear cuenta sigue siendo opcional. |
| 3. Entregas | Recolección y envío a tarifa CAD configurada por admin. No se inventan tarifas ni se ofrece envío si está deshabilitado. Cotización automática de transportista pendiente de proveedor/datos. |
| 4. Socios | Accesos públicos separados Anfitrión/Vendedor, con sesión privada y listado de recursos propios. Admin global separado. Panel comercial avanzado pendiente de PostgreSQL. |
| 5. Solicitud de socios | Solicitud → revisión admin → invitación segura por correo → establecer contraseña. No se envían contraseñas en texto claro ni se concede acceso al solicitarlo. |
| 6. Acceso de clientes | Se conserva Firebase real, no el código de confirmación de la demo. Alta opcional puede asociar compras del navegador actual solo cuando coinciden sesión anónima y email recién verificado; nunca fusiona cuentas por email. |
| 7. Confirmación de pagos | Se conserva webhook/reconciliación verificada e idempotente. Probado con pasarela controlada; falta repetir transacción real de sandbox en dominio desplegado. |
| 8. Lista de espera | Formularios reutilizables en secciones sin catálogo publicado, guardados en Firestore, correo en outbox real y consulta admin. No se usa para errores de carga ni filtros sin resultados. |
| 9. Marca VII | Marca visible en texto, encabezados, correos y recibos. Se mantienen dominios, correos, IDs técnicos y razón social existentes. |
| 10. Idiomas | ES/EN visible en móvil, preferencia compartida; sin elección previa usa idioma del navegador, inglés como alternativa. |
| 11. Cancelación | Acción de cancelar separada al final, lejos del pago; conserva confirmación. |
| 12. Privacidad | Control discreto se oculta al responder; acceso permanente desde pie de página y menú. No activa seguimiento opcional. |
| 13. Barra inferior | Iconos con etiquetas accesibles, indicadores dorados de novedades propias y marcas de lectura. |
| 14. Mensajes | Se elimina la explicación técnica de webhooks de la confirmación pública. Se mantienen avisos honestos de prueba y condiciones pendientes de aprobar. |
| 15. Villa Oliva | Sustitución de la imagen de muestra con cabecera incrustada por una imagen ilustrativa limpia. No modifica medios subidos por admin. |
| 16. Fechas móviles | Campos contenidos, fecha elegida visible y resaltada; fecha de salida validada. El calendario nativo depende del navegador/sistema. |

## Conectar PostgreSQL después

1. Crear dos bases PostgreSQL vacías e independientes, con copias de seguridad, usuario de mínimo privilegio y TLS verificado.
2. Completar privadamente `phase2.integration.env.example`; no subir valores reales al repositorio. Mantener las variables actuales de Firebase/Stripe/SMTP.
3. En un staging independiente y con respaldo, ejecutar `npm run phase2:migrate` con esas variables. El comando crea esquemas/perfil; no crea usuarios de demo ni envía correos/cobros.
4. Implementar/verificar el enlace de identidad y autorización entre Firebase y los módulos comerciales, migración controlada de datos aprobados y operación del worker. No cambiar el archivo de entrada de Hostinger a `phase2/server.mjs` para saltarse este paso: es un runtime separado.
5. Probar aislamiento por rol, contratos, agenda, facturas, devoluciones, correo, reintentos y recuperación. Activación comercial solo mediante una nueva publicación autorizada.

## Datos para entrega automática y conexiones

- Transportista o agregador elegido, cuenta comercial, credenciales sandbox y productivas, origen de los envíos, cobertura, pesos/dimensiones, tarifas, impuestos, devoluciones y reglas de embalaje.
- Airbnb/PMS/gestor de canales: proveedor y acceso autorizado, IDs de propiedades, zonas horarias y política de sincronización. No basta un calendario público para sincronizar pagos o mensajes.
- Shopify: tienda y permisos, catálogo/variantes/inventario, reglas de precios CAD y definición de cuál sistema es la fuente de verdad.
- PostgreSQL, política de respaldos y recuperación; acceso Apple cuando el cliente active su membresía.

## Validación y publicación

Pruebas locales usan memoria/PGlite aislados, pasarela controlada y outbox sin SMTP; no constituyen prueba de OAuth/Stripe/entrega de correo real. La vista de QA se puede abrir con `npm run preview:integrated` (solo loopback; datos descartables). Es distinta del arranque normal de producción.

Resultado de esta revisión: 141 pruebas locales aprobadas y 4 omitidas por no disponer del emulador Firestore; adicionalmente, 4 pruebas de paquetes semanales/PGlite aprobadas. Revisión sintáctica: 261 archivos JavaScript, sin llamadas a Firebase ni pagos. Vista móvil comprobada a 390 px: idioma EN, entrega con dirección, totales CAD, fechas visibles y sin desbordamiento. Las pruebas de SMTP usan transporte controlado, no entrega real a un buzón.

Antes de publicar: revisar diff, ejecutar pruebas y comprobar variables sin compartir secretos; después probar Google/email en HTTPS, completar pago sandbox, webhook, pedido confirmado, PDF al comprador y aviso al administrador, y aprobación/invitación del socio. Nada de ello se activa solo por añadir variables PostgreSQL.

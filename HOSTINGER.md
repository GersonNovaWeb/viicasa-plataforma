# Importar VIICASA en Hostinger — Google y Firestore primero

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

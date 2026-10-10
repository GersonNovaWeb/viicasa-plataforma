# Accesos de clientes: Google, Apple y correo con contraseña

Facebook queda descartado, incluso si una configuración antigua conserva
`AUTH_FACEBOOK_ENABLED=true`. El administrador sigue entrando exclusivamente con
Google, correo verificado, allowlist y rol del servidor. No se cambia la landing.

## Activación

1. En Firebase `viicasa` → Authentication → Sign-in method, mantener Google y
   habilitar **Correo electrónico/contraseña** (no enlace sin contraseña).
2. Authentication → Settings → Authorized domains: agregar el hostname HTTPS de
   la plataforma, sin protocolo ni ruta. Conservar los dominios de Coming Soon.
3. Configurar la política de contraseñas de Firebase (mínimo 12 caracteres para
   nuevas cuentas) y protección contra enumeración de correos. El mínimo del
   formulario no sustituye una política aplicada en Firebase.
4. Revisar las plantillas de **verificación de correo** y **restablecimiento de
   contraseña** de Firebase. Estos mensajes los envía Firebase, no el SMTP de pedidos.
5. En Hostinger, activar `AUTH_EMAIL_ENABLED=true` y volver a desplegar.

El formulario permite crear cuenta, iniciar sesión y recuperar contraseña. Una
cuenta nueva recibe un enlace de verificación; debe abrirlo y luego iniciar sesión.
El backend no admite un email sin verificar ni guarda la contraseña en Firestore.
Firebase gestiona la contraseña; VIICASA usa una cookie HttpOnly y valida la sesión.

## Apple

El cliente debe configurar Sign in with Apple para web en su Apple Developer:
Service ID, Team ID, Key ID y clave privada `.p8`. Esos datos van en el proveedor
Apple de Firebase, **nunca en Git ni en el JavaScript del sitio**.

Registrar los dominios y la Return URL que muestre Firebase. Con el authDomain
actual, la URL es `https://viicasa.firebaseapp.com/__/auth/handler`.

Configurar Apple Private Email Relay para los remitentes de Firebase y del SMTP
de pedidos. El correo privado de Apple es válido y debe conservarse. Después de
configurarlo, activar `AUTH_APPLE_ENABLED=true` en Hostinger y volver a desplegar.
Si todavía falta configuración, mantenerlo en `false`.

Guías oficiales:

- https://firebase.google.com/docs/auth/web/password-auth
- https://firebase.google.com/docs/auth/web/apple

## Identidad y permisos

- Una cuenta se identifica por UID de Firebase; nunca se fusionan dos clientes
  solo porque sus emails coinciden. Se conserva el historial de cuentas Google.
- Esta versión no ofrece vinculación manual de proveedores. Ante un conflicto,
  entrar con el método usado originalmente.
- Verificar el correo demuestra control del buzón, no identidad legal ni domicilio.
- No abrir las reglas de Firestore. El servidor comprueba propietario y sesión;
  las colecciones `cs_*` de Coming Soon no cambian.

## Prueba real pendiente de completar en el dominio desplegado

1. Con un cliente distinto al admin, probar Google y comprobar su historial tras
   salir y volver a entrar.
2. Crear una cuenta por correo. Antes de verificar debe rechazar el acceso; tras
   abrir el enlace debe permitirlo. Probar también recuperación de contraseña.
3. Con el titular de una cuenta Apple, probar acceso normal y “Ocultar mi correo”;
   comprobar que recibe los correos de pedidos.
4. Comprobar en `/admin` → Clientes registrados el proveedor y email verificado.
5. Con dos clientes A/B, comprobar que B no puede consultar/pagar/cancelar el pedido
   de A, y que ninguno obtiene acceso de administrador.

`npm run test:social-auth` valida la política local. Con `TEST_FIRESTORE_HOST`
incluye persistencia en el emulador. No sustituye la prueba OAuth real. Los comandos
locales `npm run dev` y `npm run dev:stripe` no habilitan identidades reales.

Nunca publicar `.env`, `.env.stripe.local`, JSON privados o claves `.p8`.

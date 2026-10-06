# Accesos de clientes: Google, Apple y Facebook

## Qué está implementado

- Botones ES/EN en `/cuenta`. Google conserva su configuración anterior.
- Apple/Facebook quedan desactivados hasta completar su configuración externa y
  activar las variables indicadas abajo; no basta con subir el código.
- Firebase realiza OAuth. El servidor verifica el ID token (incluida revocación),
  proveedor permitido, email verificado y autenticación reciente antes de crear
  una cookie HttpOnly. Comprueba también la sesión y el UID en cada acceso.
- Si el proveedor no acredita el email, la interfaz solicita a Firebase un email
  de verificación. El cliente debe abrir el enlace y volver a iniciar sesión.
  Si el proveedor no comparte email, debe autorizarlo o elegir otro método.
- Las cuentas se identifican por UID Firebase, nunca por coincidencia de email.
  Se conserva la clave histórica de Google para no perder reservas existentes.
  Un conflicto de proveedores muestra una indicación para utilizar el original;
  esta versión no ofrece vinculación manual de proveedores.
- El administrador sigue requiriendo Google, email verificado, allowlist y rol
  del servidor. Apple/Facebook no conceden administración por compartir email.
- No cambia las reglas, índices o colecciones `cs_*` de Coming Soon.

## Firebase común

1. Proyecto `viicasa` → Authentication → Sign-in method / Método de acceso.
2. Mantener Google habilitado. Configurar Apple y Facebook por separado.
3. Authentication → Settings → Authorized domains: conservar los dominios actuales
   y agregar el hostname HTTPS donde se probará la plataforma, sin esquema/ruta.
4. Revisar la plantilla de verificación de correo de Firebase y el remitente.
5. Mantener una cuenta por email. No relajar reglas de Firestore para estos accesos.

Los comandos locales `npm run dev` y `npm run dev:stripe` mantienen el emulador de
Firestore y no habilitan identidades sociales reales. Probar los proveedores en
el dominio HTTPS de Hostinger con pagos desactivados, no contra el emulador.

## Apple

Requiere acceso del cliente a Apple Developer y configuración de Sign in with
Apple para web: Service ID, Team ID, Key ID y clave privada. Configurar estos
valores en el proveedor Apple de Firebase, no en el JavaScript del sitio ni Git.

Registrar el dominio y la Return URL que indica Firebase. Con el authDomain actual:

```text
https://viicasa.firebaseapp.com/__/auth/handler
```

Configurar Apple Private Email Relay para los correos de Firebase y cualquier
remitente de confirmaciones que se utilice después. El email oculto de Apple es
válido; no hay que sustituirlo ni vincularlo por fuerza a Google/Facebook.

Guía oficial: https://firebase.google.com/docs/auth/web/apple

## Facebook

Crear/configurar una app en Meta for Developers con Facebook Login. Copiar su
App ID y App Secret al proveedor Facebook de Firebase. Registrar exactamente la
URI de redirección que muestra Firebase, actualmente la misma URL anterior.

Comprobar en Meta los dominios, URLs de privacidad y eliminación de datos, permisos
de email y requisitos de publicación/revisión vigentes de la app. Mientras esté
restringida a desarrollo, las pruebas pueden estar limitadas a usuarios con rol
en esa app. No afirmar que está disponible para todos hasta probar una cuenta
externa sin rol. Publicar políticas y el mecanismo de eliminación aplicables
antes de habilitarlo para clientes reales.

Guía oficial: https://firebase.google.com/docs/auth/web/facebook-login

## Activación en Hostinger

Solo después de configurar y habilitar cada proveedor en Firebase:

```dotenv
AUTH_APPLE_ENABLED=true
AUTH_FACEBOOK_ENABLED=true
```

Se pueden activar independientemente. Si falta configuración, dejarlos en `false`.
No hacen falta claves Apple/Meta en el repositorio ni claves publicables de Stripe.
Redeploy/reiniciar para que el servidor lea las variables.

## Cómo verificar clientes y permisos

1. Firebase → Authentication → Users muestra las identidades creadas, UID,
   proveedores y datos de acceso. Una identidad allí no garantiza que ya haya
   terminado el registro de VIICASA: un correo pendiente puede detener el proceso.
2. VIICASA `/admin` → Clientes registrados muestra el proveedor usado más
   recientemente y el estado del email, además de la región estimada por IP.
   Las cuentas antiguas actualizan ese estado cuando vuelven a iniciar sesión.
3. Con cuentas de prueba distintas del administrador, probar Google, Apple y
   Facebook en perfiles de navegador separados o incógnito. Verificar aparición
   del cliente, cierre de sesión y recuperación de su historial al volver.
4. Comprobar que cliente A no pueda abrir un checkout de cliente B, que los clientes
   no puedan abrir administración y que el administrador autorizado sí pueda.
5. Probar popup cancelado/bloqueado, email no compartido/no verificado, correo
   privado Apple, conflicto entre proveedores y cuenta deshabilitada/revocada.
6. El email verificado demuestra control del correo; no es verificación legal de
   identidad, nacionalidad ni domicilio. La clasificación Canadá/resto proviene
   de IP y puede ser desconocida. Esta versión no incluye KYC ni aprobación manual.

Pruebas automatizadas: `npm run test:social-auth`. Comprueban política, aislamiento
de cuentas y compatibilidad con Google; no sustituyen OAuth real con Apple/Meta.

## Publicación con Git

El usuario realizará commit y push de los cambios revisados. `git pull` descarga
cambios remotos; `git push` los envía. Antes de publicar, revisar `git diff` y
`git status`; nunca agregar `.env`, `.env.stripe.local`, claves `.p8` ni JSON privados.
Los `.env.*` ya se ignoran. Apple/Meta se configuran en Firebase, no en archivos.

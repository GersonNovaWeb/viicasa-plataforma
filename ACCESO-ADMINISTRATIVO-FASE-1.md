# Administradores con correo y contraseña · fase 1

La cuenta principal sigue utilizando Google y `ADMIN_EMAILS`. Las cuentas
administrativas adicionales entran directamente por `/admin`, sin Google ni
registro público. Este acceso no crea ni concede acceso a un buzón corporativo.
`AUTH_EMAIL_ENABLED` es para clientes Firebase, no para estos administradores.

## Crear desde el administrador principal

Después de desplegar estos cambios, entrar con la cuenta Google principal,
abrir `/admin` y pulsar **Crear acceso administrativo**. Introducir nombre,
correo y una contraseña de 12 a 128 caracteres y confirmar los permisos completos.
El formulario trae `concierge@viicasa.com` como sugerencia, no como cuenta precreada.
El servidor rechaza correos duplicados: no cambia contraseñas ni promueve cuentas
existentes. Solo el rol `admin` puede dar este acceso; se registra una auditoría.

## Alta inicial privada en Hostinger

Alternativamente, importar el archivo privado `.env.concierge.local` en las variables
de entorno de **la plataforma de fase 1** y redesplegar el código actualizado.
No sustituir las variables Firebase/Stripe/SMTP actuales: añadir solo las de alta.
El archivo está ignorado por Git y contiene una huella scrypt, nunca la contraseña
en texto. Tratarlo como secreto de servidor y no compartirlo con el cliente.

Variables de alta: `ADMIN_BOOTSTRAP_ENABLED`, `ADMIN_BOOTSTRAP_EMAIL`,
`ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_PASSWORD_HASH`. No ponerlas en el navegador,
en código fuente ni en Firebase Web Config. El proyecto debe ser `viicasa` en modo
live; se rechaza el alta en el emulador. La operación crea únicamente el usuario,
su índice único, un marcador de alta y la auditoría; no hace pagos ni envía correos.

El marcador impide recrear la cuenta o restablecer su contraseña al redesplegar.
Si el correo ya existe por otro método, no se sobrescribe: resolverlo desde la
administración. Elegir uno de los dos métodos de alta, no ambos.

Al verificar el acceso, poner `ADMIN_BOOTSTRAP_ENABLED=false` y eliminar las
otras tres variables de alta de Hostinger. Conservar `ADMIN_PASSWORD_ENABLED=true`
(o sin definir, que habilita esta función en live). `false` deshabilita tanto el
formulario como las sesiones por contraseña, sin quitar el acceso con Google.

## Sesiones y contraseña

Cookies HttpOnly, Secure en HTTPS y SameSite=Lax; origen exacto para operaciones.
Se comprueba en cada acceso el rol, estado activo, expiración y versión de sesión.
La contraseña no aparece en respuestas, registros ni configuración pública. El
backend limita los intentos y no existe registro administrativo anónimo.

En la cuenta por contraseña aparece **Cambiar contraseña**. Una actualización
revoca todas sus sesiones anteriores; después se debe volver a entrar. Usar una
contraseña distinta de la del buzón y cambiar la contraseña inicial al recibirla.

# Stripe: pruebas locales

Ejecutar los comandos desde la raíz de `viicasa-plataforma`.
No cambiar variables de Hostinger ni usar claves de producción.

1. Confirmar con `stripe whoami` que el contexto activo sea el sandbox correcto.
2. Mantener abierta una terminal con:

   ```powershell
   stripe listen --forward-to http://127.0.0.1:3015/v1/webhooks/stripe
   ```

3. Guardar en `.env.stripe.local` únicamente `STRIPE_SECRET_KEY` (clave `sk_test_`
   del mismo sandbox) y `STRIPE_WEBHOOK_SECRET` (secreto `whsec_` de la CLI).
   Este archivo está excluido de Git. No compartir sus valores en capturas o chats.
4. Ejecutar `npm run check:stripe-local`. Verifica formato, no vigencia ni cuenta;
   no muestra claves ni hace llamadas externas.
5. Mantener el emulador de Firestore en `127.0.0.1:8088`. Detener con Ctrl+C
   únicamente la terminal del servidor local anterior para liberar el puerto 3015.
   No detener la terminal de `stripe listen` ni el emulador.
6. Ejecutar `npm run dev:stripe` y abrir `http://127.0.0.1:3015`.

El arranque de pruebas no carga `.env`, rechaza claves live y fuerza Firestore
local (`demo-viicasa-platform`) y correos sin envío. Solo Stripe utiliza red externa
al iniciar un checkout. Usar exclusivamente datos ficticios y tarjetas de prueba.
Crear una operación nueva: no reutilizar un pago previo de la pasarela simulada.

`npm run dev` conserva la simulación sin Stripe. La autorización de la CLI no
demuestra que el checkout funcione: falta completar un pago sandbox desde el sitio
y comprobar la recepción del webhook y el estado confirmado de la operación.

Pruebas del arranque sin secretos ni red: `npm run test:stripe-local`.

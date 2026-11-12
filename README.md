# Nuestro Día

App web instalable para registrar en pareja el agua, las pastillas y otros hábitos del día. Cada uno tiene su clicker, ve el progreso del otro en vivo, puede mandarle un recordatorio y recibe notificaciones a la hora que elijan. Funciona en iPhone (iOS 16.4+) y Android.

- **Frontend:** HTML, CSS y JS sin compilación, publicado con GitHub Pages.
- **Backend:** Supabase (cuentas, base de datos con reglas RLS, tiempo real, una Edge Function para las notificaciones y `pg_cron` para los recordatorios).

## Instalar en el celular

- **iPhone:** abre el enlace en Safari → Compartir → **Agregar a pantalla de inicio**. Abre la app desde el ícono y, en Ajustes, toca **Activar** notificaciones.
- **Android:** abre el enlace en Chrome → **Instalar app** (o el botón Instalar dentro de la app).

La primera persona crea su cuenta y toca **Crear nuestro espacio**. La app le muestra un código de 6 letras. La segunda persona crea su cuenta y se une con ese código.

## Configurar Supabase (una sola vez)

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor:** ejecuta `supabase/schema.sql`.
3. **Authentication → Sign In / Providers → Email:** desactiva *Confirm email* para entrar sin tener que confirmar el correo (opcional).
4. **Edge Functions:** crea la función `push` con el código de `supabase/functions/push/index.ts` y desactiva *Verify JWT* (la función hace su propia verificación).
5. **Edge Functions → Secrets:** agrega `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (por ejemplo `mailto:tu@correo.com`) y `CRON_SECRET`. Puedes generar un par VAPID con `npx web-push generate-vapid-keys`.
6. **SQL Editor:** ejecuta `supabase/cron.sql` después de reemplazar `PROJECT_REF` y `CRON_SECRET`.
7. Copia en `config.js` la URL del proyecto, la *anon / publishable key* y la clave pública VAPID.

La *anon key* y la clave pública VAPID están pensadas para ir en el navegador. La clave privada VAPID, el `CRON_SECRET` y la *service role key* nunca van en este repositorio.

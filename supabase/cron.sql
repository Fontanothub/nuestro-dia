-- Recordatorios programados: cada 5 minutos llama a la función "push".
-- Reemplaza PROJECT_REF y CRON_SECRET antes de ejecutarlo.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('nuestro-dia-reminders')
where exists (select 1 from cron.job where jobname = 'nuestro-dia-reminders');

select cron.schedule(
  'nuestro-dia-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'CRON_SECRET'),
    body := '{"type":"reminders"}'::jsonb
  );
  $$
);

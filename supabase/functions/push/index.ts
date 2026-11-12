// Nuestro Día · función de notificaciones (Supabase Edge Function, Deno)
// type "nudge":     un miembro le recuerda algo a su pareja (requiere sesión).
// type "test":      notificación de prueba a uno mismo (requiere sesión).
// type "reminders": la llama pg_cron cada 5 minutos (requiere x-cron-secret).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:nuestro-dia@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Msg = { title: string; body: string; tag?: string; url?: string };

async function sendTo(userId: string, msg: Msg) {
  const { data: subs } = await db.from("push_subs").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg),
        { TTL: 60 * 60 * 6 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push error", code, String(e));
    }
  }
  return sent;
}

async function userFrom(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data.user ?? null;
}

function localParts(tz: string, now: Date) {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    return localParts("UTC", now);
  }
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

async function reminders() {
  const now = new Date();
  const { data: habits } = await db.from("habits").select("*").neq("remind_at", "{}");
  if (!habits?.length) return { sent: 0 };
  const coupleIds = [...new Set(habits.map((h) => h.couple_id))];
  const { data: people } = await db.from("profiles").select("user_id,couple_id,tz").in("couple_id", coupleIds);
  let sent = 0;
  for (const h of habits) {
    const users = (people ?? []).filter((p) => p.couple_id === h.couple_id && (!h.for_user || h.for_user === p.user_id));
    for (const u of users) {
      const { day, minutes } = localParts(u.tz || "UTC", now);
      for (const slot of h.remind_at as string[]) {
        const m = /^(\d{2}):(\d{2})$/.exec(slot);
        if (!m) continue;
        const slotMin = Number(m[1]) * 60 + Number(m[2]);
        const diff = minutes - slotMin;
        if (diff < 0 || diff >= 15) continue;
        const { data: claimed } = await db.from("reminder_log")
          .upsert({ user_id: u.user_id, habit_id: h.id, day, slot }, { onConflict: "user_id,habit_id,day,slot", ignoreDuplicates: true })
          .select();
        if (!claimed?.length) continue;
        const { count } = await db.from("taps").select("id", { count: "exact", head: true })
          .eq("user_id", u.user_id).eq("habit_id", h.id).eq("day", day);
        const n = count ?? 0;
        if (n >= h.goal) continue;
        const body = h.kind === "water"
          ? `Llevas ${n} de ${h.goal} vasos hoy.`
          : h.goal > 1 ? `Llevas ${n} de ${h.goal} hoy.` : "Todavía no lo registras hoy.";
        sent += await sendTo(u.user_id, { title: `Hora de: ${h.name}`, body, tag: `rem-${h.id}` });
      }
    }
  }
  // limpieza de registros viejos
  const old = new Date(now.getTime() - 3 * 864e5).toISOString().slice(0, 10);
  await db.from("reminder_log").delete().lt("day", old);
  return { sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { type?: string; id?: number } = {};
  try { body = await req.json(); } catch { /* vacío */ }

  if (body.type === "reminders") {
    if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "forbidden" }, 403);
    return json(await reminders());
  }

  const user = await userFrom(req);
  if (!user) return json({ error: "not_signed_in" }, 401);

  if (body.type === "test") {
    const sent = await sendTo(user.id, { title: "Nuestro Día", body: "¡Las notificaciones funcionan!", tag: "test" });
    return json({ sent });
  }

  if (body.type === "nudge" && body.id) {
    const { data: n } = await db.from("nudges").select("*").eq("id", body.id).maybeSingle();
    if (!n || n.from_user !== user.id) return json({ error: "not_found" }, 404);
    if (Date.now() - new Date(n.at).getTime() > 5 * 60e3) return json({ error: "too_old" }, 400);
    const [{ data: from }, { data: habit }] = await Promise.all([
      db.from("profiles").select("nick").eq("user_id", n.from_user).maybeSingle(),
      n.habit_id ? db.from("habits").select("name").eq("id", n.habit_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const who = from?.nick || "Tu pareja";
    const sent = await sendTo(n.to_user, {
      title: `${who} te recuerda`,
      body: habit?.name ? `${habit.name} 💕` : "Tienes algo pendiente 💕",
      tag: `nudge-${n.habit_id ?? "x"}`,
    });
    return json({ sent });
  }

  return json({ error: "bad_request" }, 400);
});

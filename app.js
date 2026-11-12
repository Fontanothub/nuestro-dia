import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "./config.js";

/* ---------- utilidades ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayKey(new Date());
const daysAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const hhmm = (iso) => new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
const LS = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const UNITS = { water: ["vaso", "vasos"], pill: ["toma", "tomas"], other: ["vez", "veces"] };
const unit = (h, n) => (UNITS[h.kind] || UNITS.other)[n === 1 ? 0 : 1];
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const show = (id) => ["#vSetup", "#vAuth", "#vJoin", "#vMain"].forEach((v) => ($(v).hidden = v !== id));

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}
const buzz = (p) => { try { navigator.vibrate?.(p); } catch {} };
const setDate = () => ($("#date").textContent = new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" }));
setDate();

/* ---------- estado ---------- */
const S = {
  sb: null, me: null, profile: null, couple: null, members: {}, habits: [], taps: [], pending: new Map(),
  nudge: null, day: today(), partnerBase: null, lastNudge: 0, delArm: null, loaded: false, channel: null,
};

const partner = () => Object.keys(S.members).find((id) => id !== S.me) || null;
const applies = (h, uid) => !h.for_user || h.for_user === uid;
const nameOf = (uid) => (uid && S.members[uid]?.nick) || (uid === S.me ? "Tú" : "Tu pareja");
function tapsOf(uid, day, hid) { return S.taps.filter((t) => t.user_id === uid && t.day === day && t.habit_id === hid); }
function countMap(uid, day) {
  const m = {}; for (const t of S.taps) if (t.user_id === uid && t.day === day) m[t.habit_id] = (m[t.habit_id] || 0) + 1;
  return m;
}
function progress(uid, day) {
  const m = countMap(uid, day); let got = 0, need = 0;
  for (const h of S.habits) if (applies(h, uid)) { need += h.goal; got += Math.min(m[h.id] || 0, h.goal); }
  return need ? got / need : 0;
}
function streak() {
  if (!S.habits.length) return 0;
  const p = partner(); const ok = (d) => progress(S.me, d) >= 1 && (!p || progress(p, d) >= 1);
  let n = 0, i = ok(today()) ? 0 : 1;
  for (; i < 31; i++) { if (ok(dayKey(daysAgo(i)))) n++; else break; }
  return n;
}

/* ---------- dibujos ---------- */
function glass(frac, key) {
  const f = Math.max(0, Math.min(1, frac)), bot = 74, h = 66 * f;
  return `<svg class="glass" viewBox="0 0 60 80" aria-hidden="true">
    <defs><clipPath id="c${key}"><path d="M8 6 L52 6 L46 76 L14 76 Z"/></clipPath></defs>
    <path class="back" d="M8 6 L52 6 L46 76 L14 76 Z"/>
    <rect class="water" clip-path="url(#c${key})" x="0" y="${bot - h + 2}" width="60" height="${h + 2}"/>
    <rect class="shine" clip-path="url(#c${key})" x="16" y="12" width="4" height="54" rx="2"/>
    <path class="wall" d="M8 6 L52 6 L46 76 L14 76 Z" stroke-linejoin="round"/></svg>`;
}
function ring(frac) {
  const C = 2 * Math.PI * 30, f = Math.max(0, Math.min(1, frac));
  return `<svg class="ringviz" viewBox="0 0 76 76" aria-hidden="true"><circle class="trk" cx="38" cy="38" r="30"/>
    <circle class="bar" cx="38" cy="38" r="30" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - f)}" transform="rotate(-90 38 38)"/></svg>`;
}
function caps(n, goal) {
  if (goal > 6) return ring(n / goal);
  let s = ""; for (let i = 0; i < goal; i++) s += `<span class="cap${i < n ? " on" : ""}"></span>`;
  return `<div class="caps" aria-hidden="true">${s}</div>`;
}
const viz = (h, n, key) => h.kind === "water" ? glass(n / h.goal, key) : h.kind === "pill" ? caps(n, h.goal) : ring(n / h.goal);
function ringSmall(frac, color, initial) {
  const C = 2 * Math.PI * 20, f = Math.max(0, Math.min(1, frac));
  return `<svg viewBox="0 0 46 46" width="46" height="46"><circle cx="23" cy="23" r="20" fill="none" stroke="var(--line)" stroke-width="4"/>
    <circle cx="23" cy="23" r="20" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - f)}" transform="rotate(-90 23 23)" style="transition:stroke-dashoffset .4s"/></svg>
    <span class="ini" style="background:${color}">${esc(initial)}</span>`;
}

/* ---------- pantalla principal ---------- */
function render() {
  if (!S.loaded) return;
  const me = S.me, p = partner(), day = S.day;

  const who = (uid, cls, color) => {
    const pr = progress(uid, day), nm = nameOf(uid);
    return `<div class="who ${cls}"><div class="ring">${ringSmall(pr, color, (nm[0] || "?").toUpperCase())}</div>
      <div class="meta"><div class="nm">${esc(nm)}</div>
      <div class="pc">${S.habits.some((h) => applies(h, uid)) ? Math.round(pr * 100) + "% de hoy" : "Sin hábitos"}</div></div></div>`;
  };
  $("#duo").innerHTML = who(me, "mine", "var(--me)") +
    (p ? who(p, "theirs", "var(--partner)") : `<div class="who ghost">Tu pareja aparecerá aquí cuando se una</div>`);

  $("#invite").hidden = !!p;
  $("#inviteCode").textContent = S.couple?.code || "——";
  $("#codeShow").textContent = S.couple?.code || "—";
  $("#lgMe").textContent = nameOf(me); $("#lgP").textContent = nameOf(p); $("#lgP").hidden = !p;

  const st = streak();
  $("#streak").hidden = st < 1;
  $("#streakN").textContent = st; $("#streakU").textContent = st === 1 ? "día" : "días";

  const H = $("#habits");
  if (!S.habits.length) {
    H.innerHTML = `<div class="empty"><strong>Aún no hay hábitos</strong>Agrega el primero en “Editar hábitos”, por ejemplo Agua con meta de 8 vasos.</div>`;
  } else {
    H.innerHTML = S.habits.map((h) => {
      const people = [me, p].filter(Boolean).filter((u) => applies(h, u));
      if (!people.length) return "";
      const cols = people.map((u) => {
        const mine = u === me, list = tapsOf(u, day, h.id), n = list.length, done = n >= h.goal;
        const last = n ? `última a las ${hhmm(list[n - 1].at)}` : mine ? "" : "sin registros hoy";
        let actions;
        if (mine) {
          const label = done ? "¡Listo! +1" : h.kind === "water" ? "+1 vaso" : h.kind === "pill" ? "Me la tomé" : "+1";
          actions = `<button class="tapbtn${done ? " complete" : ""}" data-act="tap" data-h="${h.id}">${label}</button>
            ${n ? `<button class="link" data-act="undo" data-h="${h.id}">Deshacer</button>` : ""}`;
        } else {
          actions = done ? `<span class="done-tag">Cumplido</span>` : `<button class="nudgebtn" data-act="nudge" data-h="${h.id}">Recordarle</button>`;
        }
        return `<div class="person ${mine ? "mine" : "theirs"}" data-p="${mine ? "me" : "p"}" data-h="${h.id}">
          <div class="plabel">${esc(mine ? "Tú" : nameOf(u))}</div>
          <div class="viz">${viz(h, n, h.id.slice(0, 8) + (mine ? "a" : "b"))}</div>
          <div class="count">${n}<small> / ${h.goal} ${unit(h, h.goal)}</small></div>
          <div class="last">${done && mine ? `<span class="done-tag">Cumplido</span>${last ? " · " : ""}` : ""}${last}</div>
          ${actions}</div>`;
      }).join("");
      const meta = [`${h.goal} ${unit(h, h.goal)} al día`];
      if (h.for_user) meta.push(`solo ${esc(nameOf(h.for_user))}`);
      if (h.remind_at?.length) meta.push(`aviso ${h.remind_at.join(", ")}`);
      return `<article class="habit"><header><h3>${esc(h.name)}</h3><span class="goal">${meta.join(" · ")}</span></header>
        <div class="cols n${people.length}">${cols}</div></article>`;
    }).join("");
  }

  $("#weekSec").hidden = !S.habits.length;
  let w = "";
  for (let i = 6; i >= 0; i--) {
    const d = daysAgo(i), k = dayKey(d);
    const dot = (uid, c) => { const f = progress(uid, k); return `<span class="dot ${c}${f >= 1 ? " full" : ""}" style="--f:${f.toFixed(3)}" title="${esc(nameOf(uid))}: ${Math.round(f * 100)}%"></span>`; };
    w += `<div class="wd${i === 0 ? " today" : ""}">${d.toLocaleDateString("es", { weekday: "narrow" })}${dot(me, "m")}${p ? dot(p, "p") : ""}</div>`;
  }
  $("#week").innerHTML = w;

  $("#hlist").innerHTML = S.habits.map((h) => `<div class="hitem">
      <div class="head"><span><b>${esc(h.name)}</b> <small>${h.goal} ${unit(h, h.goal)} · ${h.for_user ? "solo " + esc(nameOf(h.for_user)) : "los dos"}</small></span>
      <button class="del${S.delArm === h.id ? " arm" : ""}" data-act="del" data-h="${h.id}" type="button">${S.delArm === h.id ? "Toca para borrar" : "Quitar"}</button></div>
      <div class="times"><small>Recordar:</small>
        ${(h.remind_at || []).map((t) => `<span class="chip">${esc(t)}<button type="button" aria-label="Quitar ${esc(t)}" data-act="rmTime" data-h="${h.id}" data-t="${esc(t)}">×</button></span>`).join("")}
        <input type="time" id="t-${h.id}" aria-label="Nueva hora para ${esc(h.name)}">
        <button class="btn soft" type="button" data-act="addTime" data-h="${h.id}">Añadir</button>
      </div></div>`).join("") || `<p>Todavía no hay hábitos.</p>`;
  $("#hFor").querySelector('[value="partner"]').disabled = !p;
}

/* ---------- datos ---------- */
async function fetchAll() {
  const since = dayKey(daysAgo(31));
  const [m, h, t, c, n] = await Promise.all([
    S.sb.from("profiles").select("user_id,nick,couple_id").eq("couple_id", S.profile.couple_id),
    S.sb.from("habits").select("*").order("sort"),
    S.sb.from("taps").select("id,user_id,habit_id,day,at").gte("day", since).order("at"),
    S.sb.from("couples").select("id,code").maybeSingle(),
    S.sb.from("nudges").select("*").eq("to_user", S.me).order("at", { ascending: false }).limit(1),
  ]);
  const err = [m, h, t, c, n].find((r) => r.error);
  if (err) throw err.error;
  S.members = Object.fromEntries(m.data.map((x) => [x.user_id, x]));
  S.habits = h.data;
  S.taps = t.data.concat([...S.pending.values()]);
  S.couple = c.data;
  S.nudge = n.data[0] || null;
}

let refetchT;
function refetchSoon() { clearTimeout(refetchT); refetchT = setTimeout(refresh, 250); }
async function refresh() {
  try {
    const p0 = partner(), before = p0 ? countMap(p0, S.day) : null;
    await fetchAll();
    const p = partner();
    if (p && before && p === p0) {
      const now = countMap(p, S.day);
      for (const h of S.habits) if ((now[h.id] || 0) > (before[h.id] || 0)) {
        toast(`${nameOf(p)} registró ${h.name} (${now[h.id]}/${h.goal})`);
        requestAnimationFrame(() => document.querySelector(`.person[data-p="p"][data-h="${h.id}"]`)?.classList.add("bump"));
      }
    }
    render(); showNudge();
  } catch (e) { console.error(e); }
}

function subscribe() {
  const cid = S.profile.couple_id;
  S.channel?.unsubscribe();
  S.channel = S.sb.channel("couple-" + cid)
    .on("postgres_changes", { event: "*", schema: "public", table: "taps", filter: `couple_id=eq.${cid}` }, refetchSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "habits", filter: `couple_id=eq.${cid}` }, refetchSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `couple_id=eq.${cid}` }, refetchSoon)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "nudges", filter: `to_user=eq.${S.me}` }, refetchSoon)
    .subscribe();
}

/* ---------- acciones ---------- */
let tmpN = 0;
async function tap(hid) {
  const h = S.habits.find((x) => x.id === hid); if (!h) return;
  const tmp = { id: "tmp" + ++tmpN, user_id: S.me, habit_id: hid, day: S.day, at: new Date().toISOString() };
  S.pending.set(tmp.id, tmp); S.taps.push(tmp);
  buzz(15); render();
  const n = tapsOf(S.me, S.day, hid).length;
  const card = document.querySelector(`.person[data-p="me"][data-h="${hid}"]`);
  if (card) { card.classList.add("bump"); if (n === h.goal) { burst(card); buzz([30, 40, 30]); toast(`¡Meta de ${h.name} cumplida!`); } }
  if (n === h.goal && progress(S.me, S.day) >= 1) setTimeout(() => toast("¡Completaste todo lo de hoy!"), 1300);

  const { data, error } = await S.sb.from("taps").insert({ couple_id: S.profile.couple_id, habit_id: hid, day: tmp.day }).select("id,user_id,habit_id,day,at").single();
  S.pending.delete(tmp.id);
  const i = S.taps.indexOf(tmp);
  if (error) { if (i >= 0) S.taps.splice(i, 1); toast("No se pudo guardar. Revisa tu conexión."); }
  else if (i >= 0 && !S.taps.some((t) => t.id === data.id)) S.taps[i] = data;
  else if (i >= 0) S.taps.splice(i, 1);
  render();
}
async function undo(hid) {
  const list = tapsOf(S.me, S.day, hid).filter((t) => !String(t.id).startsWith("tmp"));
  const last = list[list.length - 1]; if (!last) return;
  S.taps = S.taps.filter((t) => t !== last); render();
  const { error } = await S.sb.from("taps").delete().eq("id", last.id);
  if (error) { toast("No se pudo deshacer."); refresh(); }
}
async function nudge(hid) {
  const p = partner(), h = S.habits.find((x) => x.id === hid); if (!p || !h) return;
  if (Date.now() - S.lastNudge < 30000) { toast("Ya le avisaste hace un momento."); return; }
  S.lastNudge = Date.now();
  const { data, error } = await S.sb.from("nudges").insert({ couple_id: S.profile.couple_id, to_user: p, habit_id: hid }).select("id").single();
  if (error) { toast("No se pudo enviar el recordatorio."); S.lastNudge = 0; return; }
  buzz(20); toast(`Le recordaste a ${nameOf(p)}: ${h.name}`);
  S.sb.functions.invoke("push", { body: { type: "nudge", id: data.id } }).catch(() => {});
}
function burst(el) {
  for (let i = 0; i < 12; i++) {
    const b = document.createElement("span"); b.className = "burst";
    const a = (i / 12) * Math.PI * 2, r = 50 + Math.random() * 30;
    b.style.setProperty("--dx", Math.cos(a) * r + "px"); b.style.setProperty("--dy", Math.sin(a) * r + "px");
    el.appendChild(b); setTimeout(() => b.remove(), 750);
  }
}
function showNudge() {
  const n = S.nudge, B = $("#nudgeBanner");
  const seen = Number(LS.get("seenNudge") || 0), at = n ? new Date(n.at).getTime() : 0;
  if (!n || n.from_user === S.me || at <= seen || Date.now() - at > 36 * 3600e3) { B.hidden = true; return; }
  if (!B.hidden && B.dataset.at === String(at)) return;
  const h = S.habits.find((x) => x.id === n.habit_id);
  B.dataset.at = String(at);
  B.innerHTML = `<span>${esc(nameOf(n.from_user))} te recuerda: ${esc(h?.name || "tu hábito")} · ${hhmm(n.at)}</span>
    <span class="row"><button class="btn" data-act="nudgeDone" data-h="${h ? h.id : ""}">${h ? "Registrar ahora" : "Entendido"}</button>
    <button class="btn soft" data-act="nudgeClose">Cerrar</button></span>`;
  B.hidden = false; B.classList.add("shake"); buzz([60, 40, 60]);
}
async function updateHabit(id, patch) {
  const { error } = await S.sb.from("habits").update(patch).eq("id", id);
  if (error) toast("No se pudo guardar el cambio."); else refresh();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const hid = b.dataset.h, act = b.dataset.act, h = S.habits.find((x) => x.id === hid);
  if (act === "tap") tap(hid);
  else if (act === "undo") undo(hid);
  else if (act === "nudge") nudge(hid);
  else if (act === "del") {
    if (S.delArm === hid) {
      S.delArm = null;
      const { error } = await S.sb.from("habits").delete().eq("id", hid);
      if (error) toast("No se pudo quitar."); else refresh();
    } else { S.delArm = hid; render(); setTimeout(() => { if (S.delArm === hid) { S.delArm = null; render(); } }, 4000); }
  } else if (act === "addTime" && h) {
    const v = $(`#t-${hid}`).value; if (!/^\d{2}:\d{2}$/.test(v)) { toast("Elige una hora primero."); return; }
    const times = [...new Set([...(h.remind_at || []), v])].sort();
    updateHabit(hid, { remind_at: times });
    if (window.Notification?.permission !== "granted") toast("Activa las notificaciones en Ajustes para recibir el aviso.");
  } else if (act === "rmTime" && h) {
    updateHabit(hid, { remind_at: (h.remind_at || []).filter((t) => t !== b.dataset.t) });
  } else if (act === "nudgeDone" || act === "nudgeClose") {
    LS.set("seenNudge", String(new Date(S.nudge?.at || Date.now()).getTime()));
    $("#nudgeBanner").hidden = true;
    if (act === "nudgeDone" && hid) tap(hid);
  } else if (act === "copyCode") {
    const txt = `Únete a Nuestro Día: ${location.href.split("#")[0]} · Código: ${S.couple?.code}`;
    try { await navigator.clipboard.writeText(txt); toast("Copiado"); }
    catch { toast(`Código: ${S.couple?.code}`); }
  }
});
document.addEventListener("animationend", (e) => e.target.classList?.remove("bump", "shake"));

$("#hType").addEventListener("change", (e) => ($("#hGoal").value = e.target.value === "water" ? 8 : 1));
$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#hName").value.trim(); if (!name) return;
  const goal = Math.max(1, Math.min(30, parseInt($("#hGoal").value, 10) || 1));
  const f = $("#hFor").value, time = $("#hTime").value;
  const { error } = await S.sb.from("habits").insert({
    couple_id: S.profile.couple_id, name, kind: $("#hType").value, goal,
    for_user: f === "me" ? S.me : f === "partner" ? partner() : null,
    remind_at: /^\d{2}:\d{2}$/.test(time) ? [time] : [], sort: Date.now(),
  });
  if (error) { toast("No se pudo agregar el hábito."); return; }
  $("#hName").value = ""; $("#hTime").value = ""; toast(`Agregado: ${name}`); refresh();
});
$("#nickForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nick = $("#nickEdit").value.trim().slice(0, 24); if (!nick) return;
  const { error } = await S.sb.from("profiles").update({ nick }).eq("user_id", S.me);
  if (error) toast("No se pudo guardar."); else { toast("Guardado"); refresh(); }
});
$("#logout").addEventListener("click", async () => { await S.sb.auth.signOut(); location.reload(); });

/* ---------- notificaciones ---------- */
const b64ToBytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function pushStatus() {
  const st = $("#pushState"), btn = $("#pushBtn"), test = $("#pushTest");
  test.hidden = true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    st.textContent = isIOS && !standalone ? "En iPhone primero instala la app: Compartir → Agregar a pantalla de inicio, y ábrela desde el ícono." : "Este navegador no permite notificaciones.";
    btn.hidden = true; return;
  }
  if (!CONFIG.VAPID_PUBLIC_KEY) { st.textContent = "Las notificaciones aún no están configuradas en el servidor."; btn.hidden = true; return; }
  btn.hidden = false;
  if (Notification.permission === "denied") { st.textContent = "Las bloqueaste. Actívalas en los ajustes del teléfono para esta app."; btn.hidden = true; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    st.textContent = "Activadas en este dispositivo."; btn.textContent = "Reactivar"; test.hidden = false;
    saveSub(sub);
  } else { st.textContent = "Recibe los recordatorios y los avisos de tu pareja."; btn.textContent = "Activar"; }
}
async function saveSub(sub) {
  const j = sub.toJSON();
  await S.sb.from("push_subs").upsert({ endpoint: j.endpoint, user_id: S.me, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
}
$("#pushBtn").addEventListener("click", async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { pushStatus(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CONFIG.VAPID_PUBLIC_KEY) });
    await saveSub(sub);
    toast("Notificaciones activadas"); pushStatus();
  } catch (e) { console.error(e); toast("No se pudieron activar las notificaciones."); }
});
$("#pushTest").addEventListener("click", async () => {
  const { data, error } = await S.sb.functions.invoke("push", { body: { type: "test" } });
  toast(error ? "El servidor no respondió." : data?.sent ? "Enviada. Debería llegar en unos segundos." : "No hay dispositivos registrados.");
});

/* ---------- instalación ---------- */
let deferredPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  const hint = $("#installHint");
  hint.innerHTML = `<b>Instala Nuestro Día</b><p>Tenla en tu pantalla de inicio como una app.</p><button class="btn" type="button" id="installBtn">Instalar</button>`;
  hint.hidden = false;
  $("#installBtn").onclick = async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; hint.hidden = true; };
});
function iosHint() {
  if (!isIOS || standalone || LS.get("iosHintClosed")) return;
  const hint = $("#installHint");
  hint.innerHTML = `<b>Instálala en tu iPhone</b><p>En Safari toca <b>Compartir</b> y luego <b>Agregar a pantalla de inicio</b>. Ábrela desde el ícono para recibir notificaciones.</p><button class="link" type="button" id="iosClose">Entendido</button>`;
  hint.hidden = false;
  $("#iosClose").onclick = () => { hint.hidden = true; LS.set("iosHintClosed", "1"); };
}

/* ---------- inicio ---------- */
let signup = false;
function setAuthMode() {
  $("#authTitle").textContent = signup ? "Crear cuenta" : "Entrar";
  $("#authBtn").textContent = signup ? "Crear cuenta" : "Entrar";
  $("#authToggle").textContent = signup ? "Ya tengo cuenta" : "¿Primera vez? Crear cuenta";
  $("#password").autocomplete = signup ? "new-password" : "current-password";
}
$("#authToggle").addEventListener("click", () => { signup = !signup; setAuthMode(); });
$("#vAuth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim(), password = $("#password").value, err = $("#authErr");
  err.hidden = true; $("#authBtn").disabled = true;
  const r = signup ? await S.sb.auth.signUp({ email, password }) : await S.sb.auth.signInWithPassword({ email, password });
  $("#authBtn").disabled = false;
  if (r.error) {
    err.textContent = /invalid login/i.test(r.error.message) ? "Correo o contraseña incorrectos." :
      /already registered/i.test(r.error.message) ? "Ese correo ya tiene cuenta. Toca “Ya tengo cuenta”." :
      /password/i.test(r.error.message) ? "La contraseña debe tener al menos 6 caracteres." : r.error.message;
    err.hidden = false; return;
  }
  if (!r.data.session) { err.textContent = "Te enviamos un correo para confirmar tu cuenta. Confírmala y vuelve a entrar."; err.hidden = false; signup = false; setAuthMode(); return; }
  afterLogin(r.data.session);
});

async function joinFlow(kind) {
  const nick = $("#nickJoin").value.trim(), err = $("#joinErr");
  err.hidden = true;
  if (!nick) { err.textContent = "Escribe tu nombre o apodo primero."; err.hidden = false; return; }
  const r = kind === "create"
    ? await S.sb.rpc("create_couple", { p_nick: nick })
    : await S.sb.rpc("join_couple", { p_code: $("#codeJoin").value, p_nick: nick });
  if (r.error) {
    err.textContent = /code_not_found/.test(r.error.message) ? "Ese código no existe. Revísalo con tu pareja." :
      /couple_full/.test(r.error.message) ? "Ese espacio ya tiene dos personas." : "Algo falló. Inténtalo de nuevo.";
    err.hidden = false; return;
  }
  await loadProfile();
}
$("#createBtn").addEventListener("click", () => joinFlow("create"));
$("#joinBtn").addEventListener("click", () => joinFlow("join"));

async function loadProfile() {
  const { data, error } = await S.sb.from("profiles").select("*").eq("user_id", S.me).maybeSingle();
  if (error) { $("#status").hidden = false; $("#status").textContent = "No se pudo conectar. Revisa tu conexión."; return; }
  S.profile = data;
  if (!data?.couple_id) { $("#status").hidden = true; show("#vJoin"); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && data.tz !== tz) S.sb.from("profiles").update({ tz }).eq("user_id", S.me).then(() => {});
  $("#nickEdit").value = data.nick || "";
  try { await fetchAll(); }
  catch { $("#status").textContent = "No se pudieron cargar los datos. Revisa tu conexión."; return; }
  S.loaded = true;
  $("#status").hidden = true; show("#vMain");
  render(); showNudge(); subscribe(); pushStatus(); iosHint();
}
async function afterLogin(session) { S.me = session.user.id; await loadProfile(); }

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.loaded) return;
  if (today() !== S.day) { S.day = today(); setDate(); }
  refresh();
  if (S.channel?.state !== "joined") subscribe();
});
setInterval(() => { if (S.loaded && today() !== S.day) { S.day = today(); setDate(); render(); } }, 30000);

async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) { $("#status").hidden = true; show("#vSetup"); return; }
  S.sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: { session } } = await S.sb.auth.getSession();
  if (!session) { $("#status").hidden = true; show("#vAuth"); return; }
  afterLogin(session);
}
start().catch((e) => { console.error(e); $("#status").textContent = "Algo falló al cargar. Cierra y vuelve a abrir la app."; });

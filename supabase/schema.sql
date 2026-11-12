-- Nuestro Día · esquema de base de datos (Supabase / Postgres)
-- Se puede ejecutar varias veces sin romper nada.

create extension if not exists pgcrypto;

-- ---------- Tablas ----------
create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  couple_id uuid references public.couples on delete set null,
  nick text not null default '' check (char_length(nick) <= 24),
  tz text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  kind text not null default 'other' check (kind in ('water', 'pill', 'other')),
  goal int not null default 1 check (goal between 1 and 30),
  for_user uuid references auth.users on delete cascade,
  remind_at text[] not null default '{}',
  sort bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.taps (
  id bigint generated always as identity primary key,
  couple_id uuid not null references public.couples on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  habit_id uuid not null references public.habits on delete cascade,
  day date not null,
  at timestamptz not null default now()
);
create index if not exists taps_couple_day on public.taps (couple_id, day);

create table if not exists public.nudges (
  id bigint generated always as identity primary key,
  couple_id uuid not null references public.couples on delete cascade,
  from_user uuid not null default auth.uid() references auth.users on delete cascade,
  to_user uuid not null references auth.users on delete cascade,
  habit_id uuid references public.habits on delete cascade,
  at timestamptz not null default now()
);

create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reminder_log (
  user_id uuid not null,
  habit_id uuid not null,
  day date not null,
  slot text not null,
  primary key (user_id, habit_id, day, slot)
);

-- ---------- Helper ----------
create or replace function public.my_couple() returns uuid
language sql stable security definer set search_path = public as $$
  select couple_id from public.profiles where user_id = auth.uid()
$$;

-- ---------- Seguridad (RLS) ----------
alter table public.couples      enable row level security;
alter table public.profiles     enable row level security;
alter table public.habits       enable row level security;
alter table public.taps         enable row level security;
alter table public.nudges       enable row level security;
alter table public.push_subs    enable row level security;
alter table public.reminder_log enable row level security;

drop policy if exists couples_read on public.couples;
create policy couples_read on public.couples for select to authenticated using (id = public.my_couple());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid() or couple_id = public.my_couple());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Solo se puede cambiar el apodo y la zona horaria; la pareja se asigna con las funciones de abajo.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (nick, tz) on public.profiles to authenticated;

drop policy if exists habits_all on public.habits;
create policy habits_all on public.habits for all to authenticated
  using (couple_id = public.my_couple()) with check (couple_id = public.my_couple());

drop policy if exists taps_read on public.taps;
create policy taps_read on public.taps for select to authenticated using (couple_id = public.my_couple());
drop policy if exists taps_insert on public.taps;
create policy taps_insert on public.taps for insert to authenticated
  with check (couple_id = public.my_couple() and user_id = auth.uid());
drop policy if exists taps_delete on public.taps;
create policy taps_delete on public.taps for delete to authenticated using (user_id = auth.uid());

drop policy if exists nudges_read on public.nudges;
create policy nudges_read on public.nudges for select to authenticated using (couple_id = public.my_couple());
drop policy if exists nudges_insert on public.nudges;
create policy nudges_insert on public.nudges for insert to authenticated
  with check (couple_id = public.my_couple() and from_user = auth.uid());

drop policy if exists push_subs_own on public.push_subs;
create policy push_subs_own on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- reminder_log: sin políticas, solo lo usa el servidor.

-- ---------- Crear / unirse a la pareja ----------
create or replace function public.create_couple(p_nick text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_couple uuid; v_code text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select c.id, c.code into v_couple, v_code
    from profiles p join couples c on c.id = p.couple_id where p.user_id = auth.uid();
  if v_couple is not null then return v_code; end if;

  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(8), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when char_length(v_code) = 6 and not exists (select 1 from couples where code = v_code);
  end loop;

  insert into couples (code) values (v_code) returning id into v_couple;
  insert into profiles (user_id, couple_id, nick) values (auth.uid(), v_couple, left(coalesce(p_nick, ''), 24))
    on conflict (user_id) do update set couple_id = excluded.couple_id, nick = excluded.nick;

  insert into habits (couple_id, name, kind, goal, sort) values
    (v_couple, 'Agua', 'water', 8, 1),
    (v_couple, 'Pastilla', 'pill', 1, 2);
  return v_code;
end $$;

create or replace function public.join_couple(p_code text, p_nick text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_couple uuid; v_count int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select id into v_couple from couples where code = upper(trim(p_code));
  if v_couple is null then raise exception 'code_not_found'; end if;
  select count(*) into v_count from profiles where couple_id = v_couple and user_id <> auth.uid();
  if v_count >= 2 then raise exception 'couple_full'; end if;
  insert into profiles (user_id, couple_id, nick) values (auth.uid(), v_couple, left(coalesce(p_nick, ''), 24))
    on conflict (user_id) do update set couple_id = excluded.couple_id, nick = excluded.nick;
  return v_couple;
end $$;

revoke execute on function public.create_couple(text) from anon;
revoke execute on function public.join_couple(text, text) from anon;
grant execute on function public.create_couple(text) to authenticated;
grant execute on function public.join_couple(text, text) to authenticated;

-- ---------- Tiempo real ----------
do $$
declare t text;
begin
  foreach t in array array['taps', 'habits', 'profiles', 'nudges'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

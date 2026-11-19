-- =====================================================================
--  Nube de palabras · Ciclo de Masterclasses ISI Conecta (UTN FRT)
--  Ejecutar COMPLETO en Supabase → SQL Editor → Run.
--  Es re-ejecutable: no borra datos existentes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.questions (
  id          uuid primary key default gen_random_uuid(),
  text        text not null check (char_length(btrim(text)) between 1 and 200),
  position    int  not null default 0,
  is_open     boolean not null default true,   -- recibe respuestas
  created_at  timestamptz not null default now()
);

-- Estado global (una sola fila): qué pregunta se proyecta
create table if not exists public.app_state (
  id                  int primary key default 1 check (id = 1),
  active_question_id  uuid references public.questions(id) on delete set null,
  show_qr             boolean not null default false,  -- QR a pantalla completa
  updated_at          timestamptz not null default now()
);
insert into public.app_state (id) values (1) on conflict do nothing;

create table if not exists public.answers (
  id           bigint generated always as identity primary key,
  question_id  uuid not null references public.questions(id) on delete cascade,
  text         text not null,          -- como lo escribió la persona
  norm         text not null,          -- normalizado (agrupa "Innovación" = "innovacion")
  device_id    text not null,          -- id anónimo del celular
  flagged      boolean not null default false,  -- marcado por el filtro automático
  created_at   timestamptz not null default now(),
  unique (question_id, device_id, norm) -- una misma palabra cuenta 1 vez por persona
);
create index if not exists answers_question_norm_idx on public.answers (question_id, norm);
create index if not exists answers_device_time_idx  on public.answers (device_id, created_at desc);

-- Palabras ocultadas a mano desde el panel (por pregunta)
create table if not exists public.hidden_terms (
  question_id  uuid not null references public.questions(id) on delete cascade,
  norm         text not null,
  created_at   timestamptz not null default now(),
  primary key (question_id, norm)
);

-- Lista de malas palabras para el filtro automático
create table if not exists public.blocked_words (
  word  text primary key
);

-- Emails habilitados para usar el panel /admin
create table if not exists public.admins (
  email  text primary key
);

-- ---------------------------------------------------------------------
-- Normalización y filtro
-- ---------------------------------------------------------------------
create or replace function public.norm_text(t text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(
    translate(lower(coalesce(t, '')), 'áàäâãéèëêíìïîóòöôõúùüûç', 'aaaaaeeeeiiiiooooouuuuc'),
    '[^a-z0-9ñ ]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- Versión "aplastada" para comparar contra la lista negra:
-- leetspeak (p0t0 → poto) y letras repetidas (putooo → puto)
create or replace function public.squash_text(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    public.norm_text(translate(lower(coalesce(t, '')), '013457@$', 'oieastas')),
    '(.)\1+', '\1', 'g')
$$;

create or replace function public.is_blocked(t text) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  s      text := public.squash_text(t);
  joined text := replace(s, ' ', '');
  w      text;
begin
  -- links, mails y números de teléfono
  if t ~* '(https?://|www\.|\.(com|net|org|ar|io)(\W|$)|\w@\w)' then return true; end if;
  if char_length(regexp_replace(t, '[^0-9]', '', 'g')) >= 7 then return true; end if;

  for w in select public.squash_text(b.word) from public.blocked_words b loop
    continue when w = '';
    if position(' ' in w) > 0 then
      -- frase: "hijo de puta", también pegada "hijodeputa"
      if position(' ' || w || ' ' in ' ' || s || ' ') > 0
         or position(replace(w, ' ', '') in joined) > 0 then
        return true;
      end if;
    else
      -- palabra suelta (+ plural), o la respuesta entera con espacios intercalados ("p u t o")
      if (' ' || s || ' ') ~ ('\s' || w || '(s|es)?\s')
         or joined ~ ('^' || w || '(s|es)?$') then
        return true;
      end if;
    end if;
  end loop;
  return false;
end $$;

-- ---------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from auth.users u
    join public.admins a on lower(a.email) = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  )
$$;

-- ---------------------------------------------------------------------
-- API pública (celulares y proyector)
-- ---------------------------------------------------------------------

-- Pregunta activa + estado de pantalla
create or replace function public.get_current() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'question', (select json_build_object('id', q.id, 'text', q.text, 'is_open', q.is_open)
                 from public.questions q where q.id = s.active_question_id),
    'show_qr', s.show_qr,
    'updated_at', s.updated_at)
  from public.app_state s where s.id = 1
$$;

-- Enviar una respuesta. Devuelve un código:
-- ok | flagged | duplicate | too_fast | empty | too_long | closed | not_active | bad_device
create or replace function public.submit_answer(p_question uuid, p_text text, p_device text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_text   text;
  v_norm   text;
  v_open   boolean;
  v_flag   boolean;
  v_id     bigint;
begin
  if p_device is null or p_device !~ '^[A-Za-z0-9-]{8,64}$' then return 'bad_device'; end if;

  v_text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  if char_length(v_text) = 0 then return 'empty'; end if;
  if char_length(v_text) > 25 then return 'too_long'; end if;

  v_norm := public.norm_text(v_text);
  if v_norm = '' then return 'empty'; end if;

  if (select s.active_question_id from public.app_state s where s.id = 1) is distinct from p_question then
    return 'not_active';
  end if;
  select q.is_open into v_open from public.questions q where q.id = p_question;
  if not coalesce(v_open, false) then return 'closed'; end if;

  -- anti-spam suave: 1 envío cada ~0,8 s por celular
  if exists (select 1 from public.answers a
             where a.device_id = p_device and a.created_at > now() - interval '800 milliseconds') then
    return 'too_fast';
  end if;

  -- si el admin ya "permitió" esta palabra en esta pregunta, no se vuelve a marcar
  v_flag := public.is_blocked(v_text)
            and not exists (select 1 from public.answers a
                            where a.question_id = p_question and a.norm = v_norm and not a.flagged);

  insert into public.answers (question_id, text, norm, device_id, flagged)
  values (p_question, v_text, v_norm, p_device, v_flag)
  on conflict (question_id, device_id, norm) do nothing
  returning id into v_id;

  if v_id is null then return 'duplicate'; end if;
  return case when v_flag then 'flagged' else 'ok' end;
end $$;

-- Datos de la nube (solo lo visible: sin marcadas ni ocultas)
create or replace function public.get_cloud(p_question uuid) returns json
language sql stable security definer set search_path = '' as $$
  with visible as (
    select a.norm, a.text, a.created_at
    from public.answers a
    where a.question_id = p_question and not a.flagged
      and not exists (select 1 from public.hidden_terms h
                      where h.question_id = a.question_id and h.norm = a.norm)
  ), forms as (   -- cómo se escribió cada variante
    select v.norm, v.text, count(*) as c, min(v.created_at) as f
    from visible v group by v.norm, v.text
  ), best as (    -- se muestra la forma más usada (empate: la primera que llegó)
    select distinct on (fo.norm) fo.norm, fo.text
    from forms fo order by fo.norm, fo.c desc, fo.f
  ), terms as (
    select v.norm, b.text, count(*)::int as count, min(v.created_at) as first_at
    from visible v join best b on b.norm = v.norm
    group by v.norm, b.text
    order by count(*) desc, min(v.created_at)
    limit 150
  )
  select json_build_object(
    'question_id',  p_question,
    'total',        (select count(*) from visible),
    'participants', (select count(distinct a.device_id) from public.answers a where a.question_id = p_question),
    'terms',        coalesce((select json_agg(json_build_object('norm', t.norm, 'text', t.text, 'count', t.count)
                                              order by t.count desc, t.first_at)
                              from terms t), '[]'::json))
$$;

-- ---------------------------------------------------------------------
-- API del panel (requiere admin)
-- ---------------------------------------------------------------------
create or replace function public.admin_terms(p_question uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((
    select json_agg(x order by x.count desc, x.text)
    from (
      select a.norm,
             (select a2.text from public.answers a2
              where a2.question_id = p_question and a2.norm = a.norm
              group by a2.text order by count(*) desc, min(a2.created_at) limit 1) as text,
             count(*)::int as count,
             (count(*) filter (where a.flagged))::int as flagged,
             exists (select 1 from public.hidden_terms h
                     where h.question_id = p_question and h.norm = a.norm) as hidden,
             max(a.created_at) as last_at
      from public.answers a
      where a.question_id = p_question
      group by a.norm
    ) x), '[]'::json);
end $$;

create or replace function public.admin_stats() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((
    select json_object_agg(t.question_id, json_build_object('answers', t.n, 'people', t.p))
    from (select a.question_id, count(*)::int as n, count(distinct a.device_id)::int as p
          from public.answers a group by a.question_id) t), '{}'::json);
end $$;

-- ---------------------------------------------------------------------
-- Triggers: cualquier cambio en la pregunta activa "toca" app_state
-- para que celulares y proyector se enteren por Realtime
-- ---------------------------------------------------------------------
create or replace function public.state_set_updated() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_state_updated on public.app_state;
create trigger app_state_updated before update on public.app_state
  for each row execute function public.state_set_updated();

create or replace function public.touch_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.app_state set updated_at = now()
  where id = 1 and active_question_id = new.id;
  return null;
end $$;

drop trigger if exists questions_touch_state on public.questions;
create trigger questions_touch_state after update on public.questions
  for each row execute function public.touch_state();

-- ---------------------------------------------------------------------
-- Seguridad (RLS)
-- ---------------------------------------------------------------------
alter table public.questions     enable row level security;
alter table public.app_state     enable row level security;
alter table public.answers       enable row level security;
alter table public.hidden_terms  enable row level security;
alter table public.blocked_words enable row level security;
alter table public.admins        enable row level security;  -- sin políticas: nadie la lee por API

drop policy if exists "admin gestiona preguntas" on public.questions;
create policy "admin gestiona preguntas" on public.questions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "todos leen el estado" on public.app_state;
create policy "todos leen el estado" on public.app_state
  for select to anon, authenticated using (true);

drop policy if exists "admin cambia el estado" on public.app_state;
create policy "admin cambia el estado" on public.app_state
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- respuestas: nadie inserta directo (solo vía submit_answer); admin lee/modera/borra
drop policy if exists "admin lee respuestas" on public.answers;
create policy "admin lee respuestas" on public.answers
  for select to authenticated using (public.is_admin());
drop policy if exists "admin modera respuestas" on public.answers;
create policy "admin modera respuestas" on public.answers
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin borra respuestas" on public.answers;
create policy "admin borra respuestas" on public.answers
  for delete to authenticated using (public.is_admin());

drop policy if exists "admin gestiona ocultas" on public.hidden_terms;
create policy "admin gestiona ocultas" on public.hidden_terms
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin gestiona lista negra" on public.blocked_words;
create policy "admin gestiona lista negra" on public.blocked_words
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Permisos explícitos (por si el proyecto no expone tablas nuevas automáticamente).
-- RLS sigue decidiendo qué filas ve/modifica cada uno.
grant usage on schema public to anon, authenticated;
grant select on public.app_state to anon, authenticated;
grant update on public.app_state to authenticated;
grant select, insert, update, delete on public.questions, public.answers, public.hidden_terms, public.blocked_words to authenticated;
revoke all on public.admins from anon, authenticated;
revoke insert, update, delete on public.answers from anon;

-- Funciones: solo las públicas quedan abiertas a anon
revoke execute on function public.is_blocked(text)   from public, anon, authenticated;
revoke execute on function public.admin_terms(uuid)  from public, anon;
revoke execute on function public.admin_stats()      from public, anon;
grant  execute on function public.admin_terms(uuid)  to authenticated;
grant  execute on function public.admin_stats()      to authenticated;
grant  execute on function public.get_current()                 to anon, authenticated;
grant  execute on function public.get_cloud(uuid)               to anon, authenticated;
grant  execute on function public.submit_answer(uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: el estado se empuja a celulares y proyector
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_state') then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Lista negra inicial (se puede ampliar desde el panel)
-- ---------------------------------------------------------------------
insert into public.blocked_words (word) values
  ('puto'),('puta'),('putazo'),('putita'),('puton'),('hdp'),('hijo de puta'),('hija de puta'),
  ('puta madre'),('la concha de tu madre'),('concha'),('conchudo'),('conchuda'),('lpm'),('lpqtp'),
  ('ctm'),('ptm'),('ql'),('mierda'),('cagada'),('cagar'),('cagon'),('culo'),('culiado'),('culeado'),
  ('culiao'),('orto'),('ojete'),('pelotudo'),('pelotuda'),('pelotudez'),('boludo'),('boluda'),
  ('boludez'),('forro'),('forra'),('idiota'),('imbecil'),('estupido'),('estupida'),('tarado'),
  ('tarada'),('mogolico'),('mogolica'),('retrasado'),('retrasada'),('subnormal'),('pija'),
  ('poronga'),('verga'),('chota'),('choto'),('garcha'),('pene'),('teta'),('tetona'),('coger'),
  ('cojer'),('cogida'),('cogido'),('follar'),('chupala'),('chupame'),('chupapija'),('pajero'),
  ('pajera'),('paja'),('marica'),('maricon'),('trolo'),('trola'),('sorete'),('garca'),('malparido'),
  ('malparida'),('cornudo'),('cornuda'),('zorra'),('perra'),('chinga'),('chingada'),('pendejo'),
  ('pendeja'),('cabron'),('cabrona'),('gonorrea'),('malcogido'),('malcogida'),('huevon'),('weon'),
  ('nazi'),('hitler'),('porno'),('sexo'),('falopa')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- ⚠️  ÚLTIMO PASO: habilitá tu email como admin.
--     1) Authentication → Users → Add user (email + contraseña, "Auto Confirm User")
--     2) Reemplazá el email de abajo y ejecutá esta línea:
-- insert into public.admins (email) values ('tu-email@ejemplo.com') on conflict do nothing;
-- ---------------------------------------------------------------------

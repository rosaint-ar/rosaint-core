-- Google Shopping (Merchant Center 130292706): archivo complementario que arma el Core.
-- Precio, oferta y stock NO van acá: los manda Tienda Nube al instante por Content API.
-- Este archivo suma lo que Tienda Nube no tiene (fichas técnicas, costos, combos, línea,
-- códigos de barras de Odoo, link a rosaint.online) y lo que se escriba a mano.

create table if not exists public.google_feed_config (
  id                   int primary key default 1 check (id = 1),
  tienda               bigint not null default 385079,
  clave                text not null default md5(random()::text || clock_timestamp()::text) || md5(clock_timestamp()::text || random()::text),
  web_origen           text not null default 'https://rosaint.online',
  incluir_costo        boolean not null default true,
  max_destacados       int not null default 6 check (max_destacados between 0 and 10),
  envio_gratis_desde   numeric,            -- null = no se anuncia envío gratis
  margen_alto          numeric not null default 0.60,
  margen_medio         numeric not null default 0.40,
  top_ventas_pct       numeric not null default 0.20,
  actualizado_en       timestamptz not null default now()
);
insert into public.google_feed_config (id) values (1) on conflict (id) do nothing;

-- Lo escrito a mano por producto (variante de Tienda Nube). Lo que esté cargado gana sobre lo automático.
create table if not exists public.google_feed_ajustes (
  offer_id        text primary key,          -- id de variante de Tienda Nube (= id en Merchant)
  sku             text,
  titulo          text,
  descripcion     text,
  destacados      text[],
  categoria       text,                      -- id o ruta de la taxonomía de Google
  envio_gratis    boolean,                   -- null = según la regla general
  excluir         boolean not null default false,
  notas           text,
  actualizado_en  timestamptz not null default now(),
  actualizado_por text
);

-- Cada vez que Google (u otro) baja el archivo.
create table if not exists public.google_feed_lecturas (
  id         bigserial primary key,
  en         timestamptz not null default now(),
  agente     text,
  items      int,
  ms         int
);

alter table public.google_feed_config   enable row level security;
alter table public.google_feed_ajustes  enable row level security;
alter table public.google_feed_lecturas enable row level security;

drop policy if exists "core lee config google"   on public.google_feed_config;
drop policy if exists "core edita config google" on public.google_feed_config;
create policy "core lee config google"   on public.google_feed_config for select to authenticated using (true);
create policy "core edita config google" on public.google_feed_config for update to authenticated using (true) with check (true);

drop policy if exists "core ajustes google" on public.google_feed_ajustes;
create policy "core ajustes google" on public.google_feed_ajustes for all to authenticated using (true) with check (true);

drop policy if exists "core lee lecturas google" on public.google_feed_lecturas;
create policy "core lee lecturas google" on public.google_feed_lecturas for select to authenticated using (true);

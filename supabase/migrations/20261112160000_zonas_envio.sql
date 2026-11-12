-- Zonas en las reglas de envío (Core → Tienda Nube → Envíos y descuentos), pedido de Diego 12/11/2026:
-- elegir por provincia, incluir o excluir, y códigos postales puntuales.
-- Tienda Nube manda solo el código postal (shipping.postalcode), no la provincia: la tabla cp_provincias
-- traduce el CP de 4 dígitos a la letra ISO 3166-2:AR de la provincia (la misma letra del CPA).
-- Fuentes: GeoNames AR (CC BY 4.0) + pedidos reales de Tienda Nube (desempatan los CP de dos provincias)
-- + Ciudad de Buenos Aires 1000–1499.

create table if not exists public.cp_provincias (
  cp text primary key check (cp ~ '^\d{4}$'),
  provincia text not null check (provincia ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ]$'),
  fuente text not null default 'manual',          -- geonames | geonames-mayoria (dudoso) | pedidos | caba | manual
  alternativas text[] not null default '{}',      -- otras provincias posibles (CP compartido)
  actualizado_en timestamptz not null default now(),
  actualizado_por text
);
alter table public.cp_provincias enable row level security;
drop policy if exists cp_provincias_leer on public.cp_provincias;
create policy cp_provincias_leer on public.cp_provincias for select to authenticated using (true);
drop policy if exists cp_provincias_cargar on public.cp_provincias;
create policy cp_provincias_cargar on public.cp_provincias for insert to authenticated with check (true);
drop policy if exists cp_provincias_corregir on public.cp_provincias;
create policy cp_provincias_corregir on public.cp_provincias for update to authenticated using (true) with check (true);

-- Zona de cada regla. todas = sin filtro; incluir = solo esas provincias / CP; excluir = todo menos esas.
-- zona_cps: lista libre de CP y rangos, ej. «2000-2009, 1414».
alter table public.tn_envio_reglas
  add column if not exists zona_modo text not null default 'todas',
  add column if not exists zona_provincias text[] not null default '{}',
  add column if not exists zona_cps text;
alter table public.tn_envio_reglas drop constraint if exists tn_envio_reglas_zona_modo_check;
alter table public.tn_envio_reglas add constraint tn_envio_reglas_zona_modo_check check (zona_modo in ('todas', 'incluir', 'excluir'));

-- El archivo público (tn-descuentos-v2.json) lleva la tabla comprimida en rangos [desde, hasta, letra]:
-- la usan el callback, la bolsa de rosaint.online y el simulador. Los huecos (CP desconocido) quedan afuera.
create or replace function public.tn_descuentos_datos()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'tiendas', coalesce((select jsonb_agg(t) from tn_descuentos_tiendas t), '[]'),
    'reglas',  coalesce((select jsonb_agg(r) from tn_envio_reglas r), '[]'),
    'prueba',  coalesce((select jsonb_agg(p.store_id || '|' || p.cart_id) from tn_carritos_prueba p where p.creado_en > now() - interval '3 days'), '[]'),
    'cp',      coalesce((select jsonb_agg(jsonb_build_array(d, h, provincia) order by d) from (
                 select min(n) d, max(n) h, provincia from (
                   select cp::int n, provincia, cp::int - row_number() over (partition by provincia order by cp::int) g from cp_provincias) x
                 group by provincia, g) y), '[]'));
$function$;

-- Corregir un CP desde el Core republica el archivo (una vez por operación, no por fila).
drop trigger if exists cp_provincias_publicar on public.cp_provincias;
create trigger cp_provincias_publicar after insert or update or delete on public.cp_provincias
  for each statement execute function public.tn_descuentos_publicar();

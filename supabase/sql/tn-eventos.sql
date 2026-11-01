-- Eventos de Tienda Nube (CyberMonday, Black Friday, Hot Sale…): armador del Core → grupo «Tienda Nube» → Eventos.
-- 1/11/2026. El descuento de cada producto se aplica como precio promocional nativo de Tienda Nube
-- (se ve tachado en la web, el checkout y Google) y la función tn-eventos lo vuelve atrás sola al terminar.

create table if not exists public.tn_eventos (
  id bigserial primary key,
  store_id bigint not null default 385079,
  nombre text not null,                       -- «CyberMonday 2026»
  desde timestamptz not null,
  hasta timestamptz not null,
  estado text not null default 'borrador' check (estado in ('borrador','programado','activo','terminado','cancelado')),
  -- Qué pasa con una promo que el producto ya tiene (p. ej. 4/10 Kg al 20%):
  --   reemplaza = el % del evento se calcula sobre el precio de lista y reemplaza la promo (nunca sube el precio)
  --   suma      = el % del evento se aplica sobre el precio que ya tiene promo
  --   mejor     = queda el más barato de los dos
  modo_promo text not null default 'reemplaza' check (modo_promo in ('reemplaza','suma','mejor')),
  -- Tienda Nube aplica el descuento por transferencia sobre toda la compra: solo se puede sumar o apagar (a mano en TN).
  transferencia text not null default 'suma' check (transferencia in ('suma','apagar')),
  margen_min numeric not null default 45,     -- % sobre neto en el peor caso (3 cuotas con Mercado Pago)
  tope_pct int not null default 30,
  min_pct int not null default 15,
  titulo text,                                -- «CyberMonday en Rosaint»
  bajada text,                                -- «Hasta 30% OFF en productos profesionales»
  texto_barra text,                           -- barra superior de la web
  texto_popup text,                           -- ventana emergente
  linea_odoo text,                            -- renglón aparte en Odoo: «Descuento CyberMonday 2026»
  notas text,
  aplicado_en timestamptz,
  revertido_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  check (hasta > desde)
);

create table if not exists public.tn_evento_items (
  id bigserial primary key,
  evento_id bigint not null references public.tn_eventos(id) on delete cascade,
  sku text not null,
  nombre text,
  descuento_pct int not null check (descuento_pct between 5 and 90 and descuento_pct % 5 = 0),
  product_id bigint,
  variant_id bigint,
  price_antes numeric,          -- precio de lista en TN al aplicar
  promo_antes numeric,          -- precio promocional que tenía (null = sin promo)
  promo_evento numeric,         -- precio promocional del evento
  estado text not null default 'pendiente' check (estado in ('pendiente','aplicado','revertido','omitido','error','conflicto')),
  detalle text,
  aplicado_en timestamptz,
  revertido_en timestamptz,
  unique (evento_id, sku)
);
create index if not exists tn_evento_items_sku on public.tn_evento_items (sku);

alter table public.tn_eventos enable row level security;
alter table public.tn_evento_items enable row level security;
drop policy if exists tn_eventos_core on public.tn_eventos;
create policy tn_eventos_core on public.tn_eventos for all to authenticated using (true) with check (true);
drop policy if exists tn_evento_items_core on public.tn_evento_items;
create policy tn_evento_items_core on public.tn_evento_items for all to authenticated using (true) with check (true);

-- Lo que lee la web (rosaint.online): el evento vigente o el próximo (hasta 7 días antes), con sus productos.
-- Solo datos públicos; nada de costos ni márgenes.
create or replace view public.v_tn_evento_web with (security_invoker = false) as
select e.id, e.store_id, e.nombre, e.desde, e.hasta, e.estado, e.titulo, e.bajada, e.texto_barra, e.texto_popup, e.transferencia,
       (select max(i.descuento_pct) from public.tn_evento_items i where i.evento_id = e.id and i.estado <> 'omitido') as max_pct,
       (select coalesce(jsonb_agg(jsonb_build_object('sku', i.sku, 'pct', i.descuento_pct, 'product_id', i.product_id, 'variant_id', i.variant_id) order by i.descuento_pct desc, i.sku), '[]'::jsonb)
          from public.tn_evento_items i where i.evento_id = e.id and i.estado in ('pendiente','aplicado')) as items
from public.tn_eventos e
where e.estado in ('programado','activo') and e.hasta > now() and e.desde < now() + interval '7 days';
revoke all on public.v_tn_evento_web from public;
grant select on public.v_tn_evento_web to anon, authenticated;

-- Sugerencia de descuentos: el mayor % redondo (múltiplo de 5) que deja al menos `p_margen` % sobre neto
-- en el peor caso (Tienda Nube, Mercado Pago, 3 cuotas), con tope y mínimo. Respeta el modo frente a la promo vigente
-- y deja afuera lo que no mejora el precio actual.
create or replace function public.tn_evento_sugerir(p_margen numeric default 45, p_tope int default 30, p_min int default 15, p_modo text default 'reemplaza')
returns table (codigo text, producto text, linea text, lista numeric, promo_actual numeric, pct int,
               margen_3c_hoy numeric, margen_3c_evento numeric, margen_1p_evento numeric, margen_transf_evento numeric)
language sql stable security invoker as $$
  with b as (
    select r.codigo, r.producto, r.linea, r.lista, coalesce(r.descuento_promoc_pct,0)/100.0 as p,
           1 - r.rent_3cuotas/100.0 as c3, 1 - r.rent_1pago/100.0 as c1, 1 - r.rent_transf/100.0 as ct
    from public.v_rentabilidad_canal r where r.canal_id = 1 and r.medio_pago = 'Mercado Pago'),
  -- k = costo+cargos como fracción del precio de lista sin promo; f = factor de precio del evento sobre la lista
  g as (
    select b.*, d.d,
      case p_modo when 'suma' then (1-b.p)*(1-d.d/100.0)
                  when 'mejor' then least(1-b.p, 1-d.d/100.0)
                  else 1-d.d/100.0 end as f
    from b cross join generate_series(5, greatest(p_tope,5), 5) d(d)),
  ok as (
    select g.*, 1 - g.c3*(1-g.p)/g.f as m3 from g
    where g.f < (1-g.p) - 0.0001 and g.d >= p_min and 1 - g.c3*(1-g.p)/g.f >= p_margen/100.0),
  mejor as (select distinct on (ok.codigo) ok.* from ok order by ok.codigo, ok.d desc)
  select m.codigo, m.producto, m.linea, m.lista, case when m.p > 0 then round(m.lista*(1-m.p),2) end, m.d::int,
         round(100*(1-m.c3),1), round(100*m.m3,1), round(100*(1 - m.c1*(1-m.p)/m.f),1), round(100*(1 - m.ct*(1-m.p)/m.f),1)
  from mejor m order by m.d desc, m.linea, m.codigo;
$$;
grant execute on function public.tn_evento_sugerir(numeric,int,int,text) to authenticated;

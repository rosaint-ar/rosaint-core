-- Compras de Rosaint EN Mercado Libre ⇄ ARCA ⇄ Odoo (contabilidad/compras-ml.html + función compras-ml).
-- Tablas cerradas: RLS activo y sin políticas → solo las toca la función con el service role.

-- Lo aprendido: qué CUIT (razón social de ARCA) es cada vendedor de ML. Un CUIT puede tener varias
-- tiendas (ej. First Label = MERCADOLIBRE SUPERMERCADO_AR y MERCADOLIBRE ELECTRONICA_AR).
create table if not exists public.compras_ml_vendedores (
  cuit text not null,
  seller_id bigint not null,
  nickname text,
  razon_social text,
  actualizado_en timestamptz not null default now(),
  primary key (cuit, seller_id)
);

-- Decisión por comprobante de ARCA (clave = CUIT|FA-A 00010-00093941): categoría elegida y, si se cargó, en qué asiento.
create table if not exists public.compras_ml_decisiones (
  clave text primary key,
  categoria text,
  nota text,
  odoo_move_id integer,
  odoo_move_name text,
  actualizado_en timestamptz not null default now()
);

alter table public.compras_ml_vendedores enable row level security;
alter table public.compras_ml_decisiones enable row level security;
revoke all on public.compras_ml_vendedores from anon, authenticated;
revoke all on public.compras_ml_decisiones from anon, authenticated;

-- Semilla: los vendedores ya identificados (historial nov-2025 → oct-2026).
insert into public.compras_ml_vendedores (cuit, seller_id, nickname, razon_social) values
  ('30707897968', 201486774,  'MARKET PAPER',                'Mavima S.A.'),
  ('30716620634', 608885756,  'MERCADOLIBRE SUPERMERCADO_AR','First Label S.R.L.'),
  ('30716620634', 608846165,  'MERCADOLIBRE ELECTRONICA_AR', 'First Label S.R.L.'),
  ('30709382019', 122659554,  'G-COMMERCE SA',               'G-Commerce S.A.'),
  ('27349403183', 3356646332, 'SHOPONLINA',                  'Niceforo Rodriguez Maria Florencia'),
  ('20416533815', 719644370,  'SOFR7506370',                 'Soto Franco Fabricio'),
  ('30528214483', 44034149,   'DWEINSTOCK',                  'D Weinstock S.R.L.'),
  ('30710790074', 1944397020, 'DIGITALSELLER',               'Elja Nun S.R.L.'),
  ('30715435388', 1189556777, 'VIRAHOY',                     'Green & Co S.R.L.'),
  ('30715464086', 314922091,  'PLANTMARKET',                 'Vivet S.R.L.'),
  ('27133810329', 2129143277, 'KITSUNESUPERMERCADO',         'Chilli Silvia Cristina'),
  ('30676374651', 610743463,  'FARMACITY_OFICIAL',           'Farmacias del Aguila S.A.'),
  ('30525346389', 415143126,  'MORIXEHERMANOSSOCIEDADANONI', 'Morixe Hermanos S.A.'),
  ('30715499203', 284297079,  'EASYWAYSEASYWAYSARGENTINASA', 'Easyways Argentina S.A.')
on conflict (cuit, seller_id) do nothing;

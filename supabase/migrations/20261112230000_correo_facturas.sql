-- Facturas que llegan a contacto@rosaint.com.ar (tarjeta «Facturas» en Ventas → Correo).
-- La función `correo` las detecta al llegar (Bandeja y Spam, antes de que las reglas las muevan),
-- deja una COPIA en la carpeta «Facturas» de la casilla y las cruza con las facturas de proveedor de Odoo.
create table if not exists public.correo_facturas (
  id bigserial primary key,
  clave text not null unique,            -- Message-ID (o remitente|fecha|asunto si no trae)
  recibido timestamptz,
  de_email text,
  de_nombre text,
  asunto text,
  origen_carpeta text,                   -- dónde estaba cuando se detectó (Bandeja, Spam o carpeta del proveedor)
  origen_uid integer,
  carpeta text,                          -- la copia: INBOX.Facturas
  uid integer,
  tipo text,                             -- Factura · Nota de crédito · Nota de débito
  letra text,                            -- A · B · C · M
  numero text,                           -- punto de venta y número: 00003-00022035
  pdfs jsonb not null default '[]',      -- [{parte, nombre, tamano}]
  partner_id integer,                    -- proveedor en Odoo (empresa)
  proveedor text,
  odoo_move_id integer,                  -- la factura de proveedor en Odoo
  odoo_nombre text,
  odoo_estado text,                      -- draft · posted · cancel
  odoo_total numeric,
  odoo_coincide text,                    -- numero (mismo número) · fecha (mismo proveedor y fecha cercana: revisar)
  odoo_revisado timestamptz,
  descartada boolean not null default false,   -- «No es una factura»
  creado timestamptz not null default now()
);
create index if not exists correo_facturas_recibido on public.correo_facturas (recibido desc);
alter table public.correo_facturas enable row level security;
comment on table public.correo_facturas is 'Facturas recibidas por correo (contacto@) y su cruce con Odoo. Solo service role: la pantalla las lee por la función correo.';

-- Hasta qué correo se revisó cada carpeta (para ver solo lo nuevo en cada pasada)
create table if not exists public.correo_estado (
  clave text primary key,
  valor jsonb not null,
  actualizado timestamptz not null default now()
);
alter table public.correo_estado enable row level security;
comment on table public.correo_estado is 'Marcas internas de la función correo (último uid revisado por carpeta). Solo service role.';

-- 12/11: facturas a nombre de otra empresa (RST Cosmetics) no van al Odoo de Velázquez
alter table public.correo_facturas add column if not exists a_nombre_de text;

-- 12/11: vencimientos (tarjeta «Vencimientos»). Fecha de Odoo si está cargada; si no, del PDF o del correo.
alter table public.correo_facturas
  add column if not exists cuit_emisor text,
  add column if not exists emitida date,
  add column if not exists total numeric,
  add column if not exists vence date,
  add column if not exists vence_origen text,
  add column if not exists pagada boolean,          -- true pagada · false sin pagar · null no se sabe
  add column if not exists pago_origen text,        -- odoo · correo · manual
  add column if not exists odoo_saldo numeric;
create index if not exists correo_facturas_vence on public.correo_facturas (vence) where pagada is not true and descartada = false;

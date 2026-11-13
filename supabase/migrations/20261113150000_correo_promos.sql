-- Publicidad nueva que el filtro automático manda a la carpeta Promociones (tarjeta «Promociones nuevas» en Correo).
-- Solo remitentes sin regla, fuera de la lista blanca y que no son clientes ni proveedores de Odoo, cuyo correo trae
-- el link de «darse de baja». estado: nueva · papelera (siempre a la Papelera) · bandeja (no es publicidad).
create table if not exists public.correo_promos (
  id bigserial primary key,
  clave text not null unique,            -- Message-ID
  recibido timestamptz,
  de_email text,
  de_nombre text,
  asunto text,
  uid integer,                           -- en INBOX.Promociones
  motivo text,
  estado text not null default 'nueva',
  creado timestamptz not null default now()
);
create index if not exists correo_promos_de on public.correo_promos (de_email);
alter table public.correo_promos enable row level security;

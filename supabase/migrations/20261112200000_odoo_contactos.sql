-- Personas de cada empresa en Odoo (contactos hijos: res.partner con parent_id), copiadas acá para que el Core
-- las reconozca: WhatsApp por teléfono (ej. Anahí escribe por Cadena de Hoteles) y Correo por email
-- (ej. Jose Ragusa, ventas de Invalcos). Las llena la función odoo-contactos (cron cada hora + al crear una).
create table if not exists public.odoo_contactos (
  partner_id integer primary key,
  nombre text not null,
  empresa_id integer not null,
  empresa_nombre text,
  funcion text,
  email text,
  telefono text,
  movil text,
  telefono_wa text,
  movil_wa text,
  actualizado timestamptz not null default now()
);
create index if not exists odoo_contactos_tel on public.odoo_contactos (telefono_wa);
create index if not exists odoo_contactos_mov on public.odoo_contactos (movil_wa);
create index if not exists odoo_contactos_email on public.odoo_contactos (lower(email));
alter table public.odoo_contactos enable row level security;
-- lectura para las pantallas del Core (mismo criterio que cliente_metricas); escribe solo la función
drop policy if exists odoo_contactos_leer on public.odoo_contactos;
create policy odoo_contactos_leer on public.odoo_contactos for select to authenticated using (true);
comment on table public.odoo_contactos is 'Contactos hijos de Odoo (persona de una empresa, con su sector). Copia de solo lectura; la llena odoo-contactos.';

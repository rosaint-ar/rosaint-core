-- Reglas para ordenar la casilla contacto@: "lo que llegue de <patron> va a <carpeta>".
-- Las crea la persona desde Correo → Ordenar (elige ella; nada se arma solo).
-- patron: "persona@dominio.com" (ese remitente) o "@dominio.com" (todo el dominio).
-- Las aplica la función `correo` (acción aplicar_reglas): a mano o con el cron cada 10 minutos.
create table if not exists public.correo_reglas (
  id bigint generated always as identity primary key,
  patron text not null unique check (patron ~ '^([^@\s]+)?@[a-z0-9.-]+\.[a-z]{2,}$'),
  carpeta text not null,
  activa boolean not null default true,
  creado_por text,
  creado_en timestamptz not null default now(),
  ultima_vez timestamptz,
  movidos integer not null default 0
);
alter table public.correo_reglas enable row level security;
-- sin políticas: se lee y escribe solo por la función (service role)
comment on table public.correo_reglas is 'Reglas elegidas para ordenar contacto@ (remitente o dominio → carpeta). Solo service role.';

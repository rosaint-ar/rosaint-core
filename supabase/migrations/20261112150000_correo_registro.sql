-- Registro de todo lo que el conector de correo (función `correo`) cambia en la casilla:
-- mover, borrar, marcar, carpetas, envíos. Lo escribe solo la función (service role).
create table if not exists public.correo_registro (
  id bigint generated always as identity primary key,
  creado_en timestamptz not null default now(),
  usuario text not null,
  accion text not null,
  ok boolean not null,
  error text,
  carpeta text,
  uids jsonb,
  destino text,
  para text,
  asunto text,
  detalle jsonb
);
create index if not exists correo_registro_creado_en on public.correo_registro (creado_en desc);
alter table public.correo_registro enable row level security;
-- sin políticas: desde las pantallas no se lee ni se escribe directo
comment on table public.correo_registro is 'Acciones que cambiaron algo en la casilla de correo (función correo). Solo service role.';

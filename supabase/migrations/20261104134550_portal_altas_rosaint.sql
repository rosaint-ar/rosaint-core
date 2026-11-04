-- Alta Rosaint: revisión humana. Sólo el backend de servicio accede a los datos.
create table public.portal_altas (
 id uuid primary key default gen_random_uuid(),
 creada timestamptz not null default now(), actualizada timestamptz not null default now(),
 estado text not null default 'recibida' check (estado in ('recibida','revisar','aprobando','aprobada','rechazada','error_aprobacion')),
 cuit text not null check (cuit ~ '^[0-9]{11}$'), email text not null,
 datos jsonb not null, analisis jsonb, resultado jsonb not null default '{}',
 aprobacion jsonb, resuelta_por text, motivo text, version integer not null default 0,
 archivos jsonb not null default '[]'
);
create unique index portal_altas_cuit_abierto on public.portal_altas(cuit)
 where estado in ('recibida','revisar','aprobando','error_aprobacion');
create index portal_altas_creada on public.portal_altas(creada desc);
create table public.portal_altas_eventos (
 id bigint generated always as identity primary key, alta_id uuid not null references public.portal_altas(id),
 creada timestamptz not null default now(), actor text not null, accion text not null, detalle jsonb not null default '{}'
);
create index portal_altas_eventos_alta on public.portal_altas_eventos(alta_id,creada);
create table public.portal_altas_limites (
 clave text not null, dia date not null default current_date, cantidad integer not null default 1,
 primary key (clave,dia)
);
alter table public.portal_altas enable row level security;
alter table public.portal_altas_eventos enable row level security;
alter table public.portal_altas_limites enable row level security;
revoke all on public.portal_altas,public.portal_altas_eventos,public.portal_altas_limites from anon,authenticated;
grant all on public.portal_altas,public.portal_altas_eventos,public.portal_altas_limites to service_role;
grant usage,select on sequence public.portal_altas_eventos_id_seq to service_role;
create function public.portal_alta_recibir(p_datos jsonb,p_ip_hash text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_n integer; v_cuit text := p_datos->>'cuit';
begin
 -- Serializa la recepción por IP y CUIT, incluso entre varias instancias Edge.
 perform pg_advisory_xact_lock(hashtextextended('portal-ip:'||p_ip_hash,0));
 perform pg_advisory_xact_lock(hashtextextended('portal-cuit:'||v_cuit,0));
 insert into public.portal_altas_limites(clave,cantidad) values ('ip:'||p_ip_hash,1)
 on conflict (clave,dia) do update set cantidad=public.portal_altas_limites.cantidad+1 returning cantidad into v_n;
 if v_n>6 then return null; end if;
 insert into public.portal_altas_limites(clave,cantidad) values ('cuit:'||v_cuit,1)
 on conflict (clave,dia) do update set cantidad=public.portal_altas_limites.cantidad+1 returning cantidad into v_n;
 if v_n>3 then return null; end if;
 select id into v_id from public.portal_altas where cuit=v_cuit and estado in ('recibida','revisar','aprobando','error_aprobacion') limit 1;
 if v_id is not null then return v_id; end if;
 insert into public.portal_altas(cuit,email,datos) values(v_cuit,p_datos->>'email',p_datos) returning id into v_id;
 insert into public.portal_altas_eventos(alta_id,actor,accion) values(v_id,'solicitante','recibida');
 return v_id;
end $$;
revoke all on function public.portal_alta_recibir(jsonb,text) from public,anon,authenticated;
grant execute on function public.portal_alta_recibir(jsonb,text) to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('portal-altas','portal-altas',false,5242880,array['application/pdf','image/jpeg','image/png']);

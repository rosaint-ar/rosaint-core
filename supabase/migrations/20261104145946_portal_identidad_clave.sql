-- Documentos básicos de Odoo y contraseña elegida antes de aprobar.
alter table public.portal_altas add column documento_tipo text not null default 'CUIT';
alter table public.portal_altas drop constraint portal_altas_cuit_check;
alter table public.portal_altas add constraint portal_altas_documento_check check (
 (documento_tipo='DNI' and cuit ~ '^[0-9]{7,8}$') or
 (documento_tipo in ('CUIT','CUIL') and cuit ~ '^[0-9]{11}$')
);
drop index public.portal_altas_cuit_abierto;
-- CUIT y CUIL comparten identificador; el DNI pertenece a otro espacio de números.
create unique index portal_altas_documento_abierto on public.portal_altas
 ((case when documento_tipo='DNI' then 'DNI' else 'CUIT' end),cuit)
 where estado in ('recibida','revisar','aprobando','error_aprobacion');
create table public.portal_altas_clave (
 alta_id uuid primary key references public.portal_altas(id),
 cifrada text not null check (cifrada like 'v1.%'),
 creada timestamptz not null default now(), vence timestamptz not null default now()+interval '30 days'
);
alter table public.portal_altas_clave enable row level security;
revoke all on public.portal_altas_clave from public,anon,authenticated;
grant all on public.portal_altas_clave to service_role;
create function public.portal_alta_recibir_v2(p_datos jsonb,p_ip_hash text,p_cifrada text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid; v_n integer; v_doc text:=p_datos->>'documento';
 v_tipo text:=p_datos->>'documento_tipo'; v_grupo text;
begin
 if v_tipo not in ('CUIT','CUIL','DNI') or p_cifrada is null or p_cifrada not like 'v1.%' then raise exception 'Solicitud inválida'; end if;
 v_grupo:=case when v_tipo='DNI' then 'DNI' else 'CUIT' end;
 perform pg_advisory_xact_lock(hashtextextended('portal-ip:'||p_ip_hash,0));
 perform pg_advisory_xact_lock(hashtextextended('portal-documento:'||v_grupo||':'||v_doc,0));
 insert into public.portal_altas_limites(clave,cantidad) values('ip:'||p_ip_hash,1)
 on conflict(clave,dia) do update set cantidad=public.portal_altas_limites.cantidad+1 returning cantidad into v_n;
 if v_n>6 then return null; end if;
 insert into public.portal_altas_limites(clave,cantidad) values('documento:'||v_grupo||':'||v_doc,1)
 on conflict(clave,dia) do update set cantidad=public.portal_altas_limites.cantidad+1 returning cantidad into v_n;
 if v_n>3 then return null; end if;
 select id into v_id from public.portal_altas where cuit=v_doc
 and (case when documento_tipo='DNI' then 'DNI' else 'CUIT' end)=v_grupo
 and estado in ('recibida','revisar','aprobando','error_aprobacion') limit 1;
 -- Un reenvío no reemplaza la contraseña ni el correo de una solicitud en revisión.
 if v_id is not null then return v_id; end if;
 insert into public.portal_altas(cuit,documento_tipo,email,datos)
 values(v_doc,v_tipo,p_datos->>'email',p_datos||jsonb_build_object('clave_elegida',true)) returning id into v_id;
 insert into public.portal_altas_clave(alta_id,cifrada) values(v_id,p_cifrada);
 insert into public.portal_altas_eventos(alta_id,actor,accion) values(v_id,'solicitante','recibida');
 return v_id;
end $$;
revoke all on function public.portal_alta_recibir_v2(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.portal_alta_recibir_v2(jsonb,text,text) to service_role;
create function public.portal_alta_limpiar_clave() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.estado in ('aprobada','rechazada') then delete from public.portal_altas_clave where alta_id=new.id; end if;
 return new;
end $$;
revoke all on function public.portal_alta_limpiar_clave() from public,anon,authenticated;
grant execute on function public.portal_alta_limpiar_clave() to service_role;
create trigger portal_alta_resuelta_clave after update of estado on public.portal_altas
 for each row execute function public.portal_alta_limpiar_clave();
select cron.schedule('portal-claves-vencidas','17 * * * *',
 $$delete from public.portal_altas_clave where vence<=now()$$);
-- Ticket de sólo consulta de constancia, cifrado y con renovación serializada.
create table public.portal_arca_cache(id text primary key,cifrada text,vence timestamptz,bloqueado_hasta timestamptz);
insert into public.portal_arca_cache(id) values('rosaint-2-constancia-production');
alter table public.portal_arca_cache enable row level security;
revoke all on public.portal_arca_cache from public,anon,authenticated;
grant all on public.portal_arca_cache to service_role;
create function public.portal_arca_tomar() returns boolean language plpgsql security invoker set search_path='' as $$
declare v_n integer;
begin
 update public.portal_arca_cache set bloqueado_hasta=now()+interval '90 seconds'
 where id='rosaint-2-constancia-production' and (bloqueado_hasta is null or bloqueado_hasta<now());
 get diagnostics v_n=row_count; return v_n=1;
end $$;
revoke all on function public.portal_arca_tomar() from public,anon,authenticated;
grant execute on function public.portal_arca_tomar() to service_role;

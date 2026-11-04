-- La reserva debe cubrir autenticación, firma y consulta WSAA con sus límites de tiempo.
create or replace function public.portal_arca_tomar() returns boolean language plpgsql security invoker set search_path='' as $$
declare v_n integer;
begin
 update public.portal_arca_cache set bloqueado_hasta=now()+interval '180 seconds'
 where id='rosaint-2-constancia-production' and (bloqueado_hasta is null or bloqueado_hasta<now());
 get diagnostics v_n=row_count; return v_n=1;
end $$;

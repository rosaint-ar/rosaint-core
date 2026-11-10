-- Actualiza la contraseña de Odoo guardada en la bóveda (Vault, secreto 'odoo_password') que usa odoo-libros-iva
-- para la sesión web. Solo la llama la función (service role), y solo DESPUÉS de comprobar que Odoo la acepta.
-- Así, cuando se cambia la contraseña del usuario en Odoo, se actualiza desde la pantalla de Libros de IVA.
create or replace function public.set_odoo_password(p text)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare sid uuid;
begin
  if p is null or length(p) < 4 then raise exception 'contraseña vacía'; end if;
  select id into sid from vault.secrets where name = 'odoo_password';
  if sid is null then
    perform vault.create_secret(p, 'odoo_password', 'Contraseña web de Odoo para descargar los libros de IVA');
  else
    perform vault.update_secret(sid, p);
  end if;
  return true;
end;
$$;
revoke all on function public.set_odoo_password(text) from public, anon, authenticated;
grant execute on function public.set_odoo_password(text) to service_role;

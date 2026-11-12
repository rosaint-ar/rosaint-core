-- Lista blanca de contacto@ (lo que NUNCA es spam), editable desde Correo → Ordenar.
-- patron: "persona@dom" o "*@dom" (ese dominio), igual que el antispam de Ferozo.
-- Efecto propio: el cron correo-reglas devuelve a la Bandeja lo que caiga en Spam de estos remitentes
-- (si además tienen regla, va a su carpeta). en_ferozo: si también está cargada en el antispam del panel
-- de Ferozo (Email → Filtro de Spam → contacto@ → Lista Negra/Blanca); esa lista solo se toca desde el panel.
create table if not exists public.correo_lista_blanca (
  id bigint generated always as identity primary key,
  patron text not null unique check (patron ~ '^(\*|[^@\s*]+)@[a-z0-9.-]+\.[a-z]{2,}$'),
  nota text,
  en_ferozo boolean not null default false,
  creado_por text,
  creado_en timestamptz not null default now()
);
alter table public.correo_lista_blanca enable row level security;
comment on table public.correo_lista_blanca is 'Remitentes que nunca son spam en contacto@ (rescate propio + espejo de la lista blanca de Ferozo). Solo service role.';
-- carga inicial (12/11/2026): las 54 entradas que se cargaron también en el panel de Ferozo
insert into public.correo_lista_blanca (patron, nota, en_ferozo, creado_por)
select p, 'Proveedor (carga inicial 12/11)', true, 'Claude (pedido de Diego)' from unnest(array['*@basf.com','*@dhacam.com.ar','*@quetzalquimica.com','*@puraquimica.com.ar','*@proyar.com.ar','*@kromberg.com','*@distvr.com.ar','*@organizacionstengel.com.ar','*@stengelsa.com','*@lovric.com.ar','corechem@fibertel.com.ar','*@fabriquimica.com','*@quimicasanahi.com','*@ladco.com.ar','*@serviciosquimicos.com.ar','*@clyckmedia.com','*@lipomize.com','*@etilfarma.com','*@etilcompany.com','*@envaseplastico.com.ar','*@3lindustria.com.ar','*@invalcos.com','*@invalcos.com.ar','*@andreani.com','*@donweb.com','*@ipred.net.ar','*@perfit.com.ar','*@myperfit.com','info@aguasparkling.sistemaws.com','*@sparklingrosario.com.ar','*@sparklingcba.com.ar','*@sparkling.com.ar','*@aguassantafesinas.com','*@adt-worldwide.com','*@tycoint.com','*@odoo.com','cplucianoruani@gmail.com','adm-marplast@hotmail.com','recepcionmarplast@hotmail.com','facturacionmarplast@gmail.com','*@marplast.com.ar','*@borsellino.com.ar','*@perfectprint.com.ar','*@nehuenburiasco.com','*@resikem.com.ar','*@bolsalogo.com.ar','novalquim@gmail.com','*@vantagegrp.com','*@quakmedia.com','fer.repetto@hotmail.com','*@bmestudio.com.ar','pablotarres@gmail.com','*@estudiobonetto.com','*@cis-sa.com.ar']) p
on conflict (patron) do nothing;
update public.correo_lista_blanca set nota = 'Soporte de Odoo (solo @odoo.com, sin los x.odoo.com)' where patron = '*@odoo.com';

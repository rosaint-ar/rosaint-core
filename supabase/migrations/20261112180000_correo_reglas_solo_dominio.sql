-- correo_reglas: además de "persona@dom" y "@dom" (dominio + subdominios), acepta "*@dom" = SOLO ese dominio.
-- Caso: *@odoo.com = la gente de Odoo (soporte, ventas), sin los Odoo de cada empresa (x.odoo.com).
alter table public.correo_reglas drop constraint if exists correo_reglas_patron_check;
alter table public.correo_reglas add constraint correo_reglas_patron_check check (patron ~ '^(\*|[^@\s*]+)?@[a-z0-9.-]+\.[a-z]{2,}$');

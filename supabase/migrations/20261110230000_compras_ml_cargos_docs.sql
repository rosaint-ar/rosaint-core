-- Comprobantes de CARGOS de Mercado Libre (facturación ML / Mercado Pago) ya leídos por compras-ml.
-- La API de facturación de ML permite 5 consultas por minuto: lo leído se guarda acá (un PDF fiscal no cambia)
-- y cada pasada sigue desde donde quedó. Solo la usa la función (service role): RLS sin políticas.
create table if not exists public.compras_ml_cargos_docs (
  ref        text primary key,          -- "0011A05421897" (punto de venta 4 dígitos + letra + número)
  grupo      text,                       -- ML | MP
  tipo       text,                       -- BILL | CREDIT_NOTE
  periodo    text,                       -- clave del período de ML: "2026-10-01"
  file_id    text,
  monto      numeric,
  texto      jsonb,                      -- renglones de texto del PDF (se vuelven a interpretar en cada uso)
  leido_en   timestamptz,
  creado_en  timestamptz not null default now()
);
alter table public.compras_ml_cargos_docs enable row level security;

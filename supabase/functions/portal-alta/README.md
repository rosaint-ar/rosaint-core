# Alta profesional de Rosaint

El solicitante elige perfil, condición IVA, documento y contraseña. El acceso a Odoo se habilita sólo después de una revisión humana en Core. Consumidor final admite DNI, CUIT o CUIL; responsable inscripto, monotributista y exento requieren CUIT.

La contraseña pendiente se cifra con AES-GCM y contexto vinculado al documento y correo. Se guarda en una tabla privada separada, durante un máximo de 30 días, y se elimina al aprobar o rechazar. Un reenvío no reemplaza el correo ni la contraseña originales. Las cuentas activas conservan su contraseña; los registros anteriores o con contraseña vencida usan la invitación nativa de Odoo. Los errores de operaciones con contraseña no devuelven detalles remotos.

La consulta ARCA reutiliza el certificado de Rosaint en Odoo. Una acción de servidor restringida al usuario de integración firma únicamente tickets para `ws_sr_constancia_inscripcion`, empresa 2. La clave privada permanece en Odoo. El backend construye CMS, obtiene el ticket de WSAA y lo conserva cifrado en una caché privada. No modifica la conexión de facturación.

## Estado del 4 de noviembre de 2026

- Formulario y backend desplegados en `https://rosaint.odoo.com/alta`.
- Firma ARCA instalada; WSAA responde «Computador no autorizado a acceder al servicio». Falta autorizar el servicio de constancia para el certificado de Rosaint. La consulta automática todavía no está operativa. Core permite la revisión con constancia adjunta; consumidor final con DNI no requiere consulta ARCA.
- `pro.rosaint.online` pendiente de cambio del CNAME en Donweb/Ferozo, asociación en Odoo y verificación HTTPS. La URL operativa sigue siendo la de Odoo.
- Fuentes originales del manual: Sora 400/500, Source Sans 3 400/600 y Bitter Italic 400.

## Verificación

`node --experimental-transform-types supabase/tests/portal-alta.mjs`

36 casos aislados sin red real: permisos, documentos, contraseñas, revisión fiscal, cuentas existentes, duplicados, concurrencia y recuperación de aprobaciones parciales. También se comprobó en una transacción revertida el guardado atómico, la conservación de la primera credencial y su eliminación al resolver, sin eliminar el historial. La primera aprobación de un cliente real deberá verificar la entrega del aviso y el acceso con su contraseña; no se crearon clientes ficticios ni se enviaron correos durante las pruebas.

Las tablas de solicitudes, credenciales y caché tienen RLS y acceso reservado al backend. El aviso de asesoría «RLS sin políticas» es deliberado: no se admite acceso directo de `anon` ni `authenticated`.

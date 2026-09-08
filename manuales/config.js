/* =========================================================================
   Rosaint · CORE — Manuales: configuración compartida
   Las tres pantallas (biblioteca, ficha, editor) leen de acá.
   Para sumar un área nueva: agregá una entrada a AREAS y listo.
   ========================================================================= */

const AREAS = [
  { key: 'produccion',     nom: 'Producción',            ico: '🏭', desc: 'Fabricación, fraccionado, envasado y control de la hoja diaria' },
  { key: 'laboratorio',    nom: 'Laboratorio',           ico: '⚗️', desc: 'Fórmulas, materias primas, desarrollos y semielaborados' },
  { key: 'deposito',       nom: 'Depósito y despacho',   ico: '📦', desc: 'Recepción, stock, armado de pedidos y envíos' },
  { key: 'administracion', nom: 'Administración',        ico: '🗂️', desc: 'Facturación, cobranzas, pagos e impuestos' },
  { key: 'comercial',      nom: 'Comercial y atención',  ico: '💬', desc: 'Clientes, cotizaciones, seguimiento y posventa' },
  { key: 'ventas-online',  nom: 'Ventas online',         ico: '🛒', desc: 'Tienda Nube, Mercado Libre y publicaciones' },
  { key: 'compras',        nom: 'Compras',               ico: '🚚', desc: 'Proveedores, pedidos de insumos y recepción de mercadería' },
  { key: 'calidad',        nom: 'Calidad',               ico: '🔬', desc: 'Controles, registros y buenas prácticas' },
  { key: 'sistemas',       nom: 'Sistemas y accesos',    ico: '🔑', desc: 'Odoo, el Core, usuarios, contraseñas y equipos' },
  { key: 'general',        nom: 'General',               ico: '🏢', desc: 'Reglas de la casa que aplican a todos' },
];

const TIPOS = [
  { key: 'instructivo',  nom: 'Instructivo',  desc: 'Cómo se hace una tarea concreta, paso a paso' },
  { key: 'procedimiento', nom: 'Procedimiento', desc: 'Un proceso completo, casi siempre entre varias personas o áreas' },
  { key: 'politica',     nom: 'Regla de la casa', desc: 'Qué se puede y qué no. Sin pasos: es una definición' },
  { key: 'ficha',        nom: 'Ficha rápida', desc: 'Datos de consulta: listas, códigos, teléfonos, valores' },
];

const ESTADOS = {
  vigente:   { nom: 'Vigente',   clase: 'ok'   },
  borrador:  { nom: 'Borrador',  clase: 'warn' },
  archivado: { nom: 'Archivado', clase: 'off'  },
};

const areaDe = (k) => AREAS.find((a) => a.key === k) || { key: k, nom: k || '—', ico: '📄', desc: '' };
const tipoDe = (k) => TIPOS.find((t) => t.key === k) || { key: k, nom: k || '—', desc: '' };

window.MANUALES_CFG = { AREAS, TIPOS, ESTADOS, areaDe, tipoDe };

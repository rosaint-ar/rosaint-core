/* =========================================================================
   Rosaint · CORE — shell.js
   Genera sidebar + topbar en cualquier página que tenga <div id="app-shell">.
   Cada página HTML solo declara su identidad en <body data-page="..." data-title="...">.
   ========================================================================= */

// ---- Menú de la plataforma ---------------------------------------------
// Editá este array para agregar/quitar módulos. `href` es relativo a la raíz.
// `status: 'soon'` deja el item visible pero deshabilitado (con etiqueta "pronto").
const MENU = [
  { type: 'item', id: 'dashboard', label: 'Dashboard', href: 'index.html', status: 'ready' },

  { type: 'group', label: 'Producto' },
  { type: 'item', id: 'laboratorio',   label: 'Laboratorio',   href: 'laboratorio/index.html', status: 'ready' },
  { type: 'item', id: 'catalogo',      label: 'Catálogo',      href: 'catalogo/index.html',      status: 'ready' },

  { type: 'group', label: 'Precios' },
  { type: 'item', id: 'precios',       label: 'Precios',       href: 'precios/index.html',       status: 'ready' },

  { type: 'group', label: 'Comercial' },
  { type: 'item', id: 'cotizador',     label: 'Cotizador',     href: 'comercial/cotizador.html', status: 'ready' },
  { type: 'item', id: 'crm',           label: 'CRM',           href: 'comercial/crm.html',       status: 'ready' },
  { type: 'item', id: 'canales',       label: 'Canales',       href: 'comercial/canales.html',   status: 'ready' },

  { type: 'group', label: 'Producción' },
  { type: 'item', id: 'produccion',    label: 'Producción',    href: 'produccion/index.html',    status: 'ready' },

  { type: 'group', label: 'Backoffice' },
  { type: 'item', id: 'conciliador',    label: 'Conciliador IVA', href: 'fiscal/conciliador.html', status: 'ready' },
  { type: 'item', id: 'percepciones',   label: 'Percepciones',    href: 'fiscal/percepciones.html', status: 'ready' },
  { type: 'item', id: 'calidad',        label: 'Calidad',         href: '#',                        status: 'soon' },
  { type: 'item', id: 'administracion', label: 'Administración',  href: '#',                        status: 'soon' },

  { type: 'group', label: 'Contabilidad' },
  { type: 'item', id: 'iibb',        label: 'IIBB por jurisdicción', href: 'contabilidad/iibb.html',       status: 'ready' },
  { type: 'item', id: 'librosiva',   label: 'Libros de IVA (ZIP)',   href: 'contabilidad/libros-iva.html', status: 'soon' },

  { type: 'group', label: 'Sistema' },
  { type: 'item', id: 'sistema',       label: 'Sistema',       href: 'sistema/index.html', status: 'ready' },
];

// ---- Utilidades --------------------------------------------------------
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

// Resuelve la ruta a la raíz del sitio según en qué subcarpeta esté la página.
// Cada HTML DEBE declarar su ubicación con un <meta name="app-root" content="...">:
//   - Página en la raíz (rosaint-core/index.html):        content="./"
//   - Página en subcarpeta (rosaint-core/comercial/x.html): content="../"
//   - Página anidada dos niveles:                          content="../../"
// Sin esto, la navegación de la sidebar rompe al abrir archivos localmente (file://).
function rootPath() {
  const meta = document.querySelector('meta[name="app-root"]');
  if (meta) return meta.getAttribute('content');
  console.warn('[shell] Falta <meta name="app-root" content="./"> en el <head>. Asumiendo raíz.');
  return './';
}

// ---- Tema (claro/oscuro) -----------------------------------------------
const THEME_KEY = 'rosaint-core-theme';
function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.querySelector('.theme-label').textContent = t === 'dark' ? 'Tema claro' : 'Tema oscuro';
  const icon = btn && btn.querySelector('.icon');
  if (icon) icon.innerHTML = t === 'dark' ? SUN_ICON : MOON_ICON;
}
function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

// Iconos SVG inline (evita depender de fuentes de iconos)
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SUN_ICON  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const HAMBURGER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>';

// ---- Iconos por módulo (línea fina, estilo Feather) -------------------
// La CSS (.nav-item .nav-icon svg) fija fill/stroke/grosor; acá solo el trazado.
const MODULE_ICONS = {
  dashboard:      '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  laboratorio:    '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3"/></svg>',
  catalogo:       '<svg viewBox="0 0 24 24"><path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  precios:        '<svg viewBox="0 0 24 24"><path d="M20.6 13.4L13.4 20.6a2 2 0 0 1-2.8 0l-7-7V4a1 1 0 0 1 1-1h6.6l9.4 9.4a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4"/></svg>',
  cotizador:      '<svg viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5z"/><path d="M8 13h8M8 17h5"/></svg>',
  crm:            '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.2 3.2 0 0 1 0 6.5M21 20a5.6 5.6 0 0 0-4-5.4"/></svg>',
  canales:        '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6"/></svg>',
  produccion:     '<svg viewBox="0 0 24 24"><path d="M4 20h16M4 20V10l4-3 4 3 4-3 4 3v10"/><path d="M9 20v-5h6v5"/></svg>',
  conciliador:    '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2.4"/></svg>',
  percepciones:   '<svg viewBox="0 0 24 24"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>',
  iibb:           '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/></svg>',
  librosiva:      '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  calidad:        '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  administracion: '<svg viewBox="0 0 24 24"><path d="M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/><circle cx="16" cy="13" r="1.3"/></svg>',
  sistema:        '<svg viewBox="0 0 24 24"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/></svg>',
};
const DEFAULT_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';

// ---- Módulos que tienen landing (index.html en su carpeta) ----------
// Cuando estás en una herramienta interna, el topbar muestra "← Módulo".
// Sumar acá cuando se agregue una landing nueva a un módulo.
const MODULE_LANDINGS = {
  laboratorio: 'Laboratorio',
  catalogo: 'Catálogo',
  precios: 'Precios',
  produccion: 'Producción',
  sistema: 'Sistema',
};

function detectBackLink() {
  const path = window.location.pathname.replace(/\\/g, '/');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const filename = parts[parts.length - 1] || 'index.html';
  const folder = parts[parts.length - 2];
  if (filename === 'index.html' || filename === '') return null;
  const label = MODULE_LANDINGS[folder];
  if (!label) return null;
  return { href: 'index.html', label };
}

// ---- Render de la sidebar ---------------------------------------------
function renderSidebar(activeId, root) {
  const brand = el('div', { class: 'brand' }, [
    el('img', { class: 'brand-iso light', src: root + 'shell/isotipo-ink.png', alt: 'Rosaint', width: '24', height: '24' }),
    el('img', { class: 'brand-iso dark', src: root + 'shell/isotipo-white.png', alt: '', width: '24', height: '24', 'aria-hidden': 'true' }),
    el('span', { class: 'brand-name' }, 'Rosaint'),
    el('span', { class: 'brand-tag' }, 'CORE'),
  ]);

  const nav = el('nav', { class: 'nav' });
  for (const entry of MENU) {
    if (entry.type === 'group') {
      nav.appendChild(el('div', { class: 'nav-group-label' }, entry.label));
      continue;
    }
    const isActive = entry.id === activeId;
    const isSoon = entry.status === 'soon';
    const item = el('a', {
      class: 'nav-item' + (isActive ? ' active' : '') + (isSoon ? ' soon' : ''),
      href: isSoon ? 'javascript:void(0)' : (root + entry.href),
      title: isSoon ? 'Próximamente' : entry.label,
    }, [
      el('span', { class: 'nav-icon', html: MODULE_ICONS[entry.id] || DEFAULT_ICON }),
      el('span', { class: 'nav-item-label' }, entry.label),
      isSoon ? el('span', { class: 'soon-tag' }, 'pronto') : null,
    ]);
    nav.appendChild(item);
  }

  const themeBtn = el('button', {
    id: 'theme-toggle-btn',
    class: 'theme-toggle',
    onclick: toggleTheme,
    'aria-label': 'Cambiar tema',
  }, [
    el('span', { class: 'icon', html: MOON_ICON }),
    el('span', { class: 'theme-label' }, 'Tema oscuro'),
  ]);

  const user = el('div', { class: 'sidebar-user', id: 'sidebar-user-block' }, [
    el('b', { id: 'sidebar-user-email' }, '—'),
    el('span', { id: 'sidebar-user-cuit', style: 'display:block; margin-top:2px;' }, 'CUIT 20-31092413-0'),
  ]);

  const logoutBtn = el('button', {
    id: 'logout-btn',
    class: 'theme-toggle',
    onclick: cerrarSesion,
    style: 'margin-top: 6px;',
    'aria-label': 'Cerrar sesión',
  }, [
    el('span', { class: 'icon' }, '⎋'),
    el('span', {}, 'Cerrar sesión'),
  ]);

  const footer = el('div', { class: 'sidebar-footer' }, [themeBtn, user, logoutBtn]);

  const sidebar = el('aside', { id: 'app-sidebar' }, [brand, nav, footer]);
  return sidebar;
}

// ---- Render del topbar ------------------------------------------------
function renderTopbar(pageTitle, pageSub) {
  const hamburger = el('button', {
    class: 'topbar-hamburger',
    onclick: () => document.getElementById('app-sidebar').classList.toggle('open'),
    'aria-label': 'Abrir menú',
    html: HAMBURGER_ICON,
  });
  const back = detectBackLink();
  const backLink = back ? el('a', {
    class: 'topbar-back',
    href: back.href,
    title: 'Volver a ' + back.label,
  }, [
    el('span', { class: 'icon', html: BACK_ICON }),
    el('span', {}, back.label),
  ]) : null;
  const title = el('div', { class: 'topbar-title' }, [
    hamburger,
    backLink,
    el('span', {}, pageTitle),
    pageSub ? el('span', { class: 'sub' }, pageSub) : null,
  ]);
  const actions = el('div', { class: 'topbar-actions' }, [
    el('div', { class: 'topbar-search' }, [
      el('span', { class: 'icon', html: SEARCH_ICON }),
      el('input', { type: 'text', placeholder: 'Buscar…', 'aria-label': 'Buscar' }),
    ]),
    el('div', { class: 'topbar-user', title: 'rosaint.ar@gmail.com' }, 'R'),
  ]);
  const topbar = el('header', { id: 'app-topbar' }, [title, actions]);
  return topbar;
}

// ---- Auth guard ------------------------------------------------------
async function requireSession() {
  // Nota: `sb` viene de shared/supabase.js, que debe cargarse ANTES de shell.js.
  if (typeof window.sb === 'undefined') {
    console.warn('[shell] sb no está definido — se salta el auth guard');
    return null;
  }
  try {
    const { data } = await window.sb.auth.getSession();
    if (!data.session) {
      const root = rootPath();
      window.location.replace(root + 'login.html');
      return null;
    }
    return data.session;
  } catch (e) {
    console.error('[shell] Error al leer sesión:', e);
    return null;
  }
}

async function cerrarSesion() {
  if (typeof window.sb !== 'undefined') {
    await window.sb.auth.signOut();
  }
  const root = rootPath();
  window.location.replace(root + 'login.html');
}

// ---- Montaje ----------------------------------------------------------
async function mount() {
  applyTheme(getTheme());

  // Guard: si no hay sesión, redirige a login antes de renderizar
  const session = await requireSession();
  if (!session) return;

  const shellRoot = document.getElementById('app-shell');
  const content = document.getElementById('app-content');
  if (!shellRoot || !content) {
    console.warn('[shell] Falta <div id="app-shell"> o <main id="app-content"> en el HTML.');
    return;
  }

  const activeId = document.body.dataset.page || 'dashboard';
  const pageTitle = document.body.dataset.title || 'Rosaint · CORE';
  const pageSub   = document.body.dataset.subtitle || '';

  const root = rootPath();

  // Favicon unificado para todas las páginas (sobrescribe lo hardcodeado por página).
  let fav = document.querySelector('link[rel="icon"]');
  if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
  fav.type = 'image/png';
  fav.href = root + 'shell/favicon.png';

  const sidebar = renderSidebar(activeId, root);
  const topbar  = renderTopbar(pageTitle, pageSub);

  const mainCol = el('div', { class: 'app-main-column' });
  mainCol.appendChild(topbar);
  // Mover el <main id="app-content"> dentro de la columna principal
  content.parentNode.insertBefore(mainCol, content);
  mainCol.appendChild(content);

  // Reemplazar el placeholder por el sidebar
  shellRoot.replaceWith(sidebar);

  // Pintar email del usuario logueado
  const emailEl = document.getElementById('sidebar-user-email');
  if (emailEl && session.user && session.user.email) emailEl.textContent = session.user.email;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

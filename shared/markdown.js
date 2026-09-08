/* =========================================================================
   Rosaint · CORE — markdown.js
   Convierte el texto de un manual en HTML. Formato pensado para instructivos:

     # Título grande            -> título de bloque
     ## Sección                 -> sección (entra en el índice lateral)
     ### Subsección             -> subtítulo
     1. paso                    -> lista numerada (los pasos de la tarea)
        detalle indentado       -> aclaración debajo de ese paso
     - item                     -> viñeta
     - [ ] tarea                -> checklist tildable
     > nota                     -> recuadro neutro
     >! cuidado                 -> recuadro de advertencia
     >+ dato útil               -> recuadro verde
     | a | b |                  -> tabla
     ---                        -> separador
     **negrita**  *cursiva*  `código`  [texto](url)

   Expone: window.mdRender(texto) y window.mdIndice(texto).
   ========================================================================= */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Slug estable para las anclas del índice.
  function slug(t) {
    return String(t).toLowerCase()
      .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
      .replace(/[óòôö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/ñ/g, 'n')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'seccion';
  }

  // Formato dentro de una línea (se escapa primero: el texto viene del editor).
  function inline(t) {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function mdIndice(texto) {
    const usados = {};
    return String(texto || '').split(/\r?\n/)
      .filter((l) => /^##\s+\S/.test(l.trim()) && !/^###/.test(l.trim()))
      .map((l) => {
        const titulo = l.trim().replace(/^##\s+/, '').trim();
        let id = slug(titulo);
        if (usados[id]) { usados[id]++; id = id + '-' + usados[id]; } else { usados[id] = 1; }
        return { id, titulo };
      });
  }

  function mdRender(texto) {
    const lineas = String(texto || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const usados = {};
    let i = 0;

    while (i < lineas.length) {
      const t = lineas[i].trim();

      if (!t) { i++; continue; }

      // separador
      if (/^(---|___|\*\*\*)$/.test(t)) { out.push('<hr>'); i++; continue; }

      // títulos
      let m = t.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        const nivel = m[1].length;
        const txt = m[2].trim();
        if (nivel === 2) {
          let id = slug(txt);
          if (usados[id]) { usados[id]++; id = id + '-' + usados[id]; } else { usados[id] = 1; }
          out.push('<h3 id="' + id + '" class="md-h2">' + inline(txt) + '</h3>');
        } else if (nivel === 1) {
          out.push('<h2 class="md-h1">' + inline(txt) + '</h2>');
        } else {
          out.push('<h4 class="md-h3">' + inline(txt) + '</h4>');
        }
        i++; continue;
      }

      // recuadros:  >  |  >!  |  >+
      m = t.match(/^>([!+]?)\s?(.*)$/);
      if (m) {
        const marca = m[1];
        const tipo = marca === '!' ? 'warn' : marca === '+' ? 'ok' : 'nota';
        const buf = [m[2]];
        i++;
        // Sigue el mismo recuadro sólo mientras la marca no cambie:
        // ">! a" + ">+ b" son dos recuadros distintos, no uno.
        while (i < lineas.length) {
          const sig = lineas[i].trim().match(/^>([!+]?)\s?(.*)$/);
          if (!sig || sig[1] !== marca) break;
          buf.push(sig[2]);
          i++;
        }
        const ico = tipo === 'warn' ? '&#9888;&#65039;' : tipo === 'ok' ? '&#10003;' : '&#9432;';
        out.push('<div class="md-callout md-' + tipo + '"><span class="md-callout-ico">' + ico +
          '</span><div>' + buf.map(inline).join('<br>') + '</div></div>');
        continue;
      }

      // checklist
      if (/^[-*]\s+\[[ xX]\]\s+/.test(t)) {
        const items = [];
        while (i < lineas.length && /^[-*]\s+\[[ xX]\]\s+/.test(lineas[i].trim())) {
          const it = lineas[i].trim();
          const marcado = /\[[xX]\]/.test(it);
          items.push('<li><label><input type="checkbox" class="md-check"' +
            (marcado ? ' checked' : '') + '><span>' +
            inline(it.replace(/^[-*]\s+\[[ xX]\]\s+/, '')) + '</span></label></li>');
          i++;
        }
        out.push('<ul class="md-checklist">' + items.join('') + '</ul>');
        continue;
      }

      // lista numerada = los pasos de la tarea
      if (/^\d+[.)]\s+/.test(t)) {
        const items = [];
        while (i < lineas.length && /^\d+[.)]\s+/.test(lineas[i].trim())) {
          let cuerpo = inline(lineas[i].trim().replace(/^\d+[.)]\s+/, ''));
          i++;
          // líneas indentadas debajo de un paso = detalle de ese paso
          while (i < lineas.length && /^\s{2,}\S/.test(lineas[i]) && !/^\s*\d+[.)]\s/.test(lineas[i])) {
            cuerpo += '<div class="md-detalle">' + inline(lineas[i].trim()) + '</div>';
            i++;
          }
          items.push('<li>' + cuerpo + '</li>');
        }
        out.push('<ol class="md-pasos">' + items.join('') + '</ol>');
        continue;
      }

      // viñetas
      if (/^[-*]\s+/.test(t)) {
        const items = [];
        while (i < lineas.length && /^[-*]\s+/.test(lineas[i].trim()) &&
               !/^[-*]\s+\[[ xX]\]/.test(lineas[i].trim())) {
          items.push('<li>' + inline(lineas[i].trim().replace(/^[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul class="md-lista">' + items.join('') + '</ul>');
        continue;
      }

      // tabla
      if (/^\|.*\|$/.test(t)) {
        const filas = [];
        while (i < lineas.length && /^\|.*\|$/.test(lineas[i].trim())) {
          filas.push(lineas[i].trim());
          i++;
        }
        const celdas = (f) => f.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const cab = celdas(filas[0]);
        const cuerpo = filas.slice(/^\|[\s:|-]+\|$/.test(filas[1] || '') ? 2 : 1);
        out.push('<div class="md-tabla-wrap"><table class="md-tabla"><thead><tr>' +
          cab.map((c) => '<th>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          cuerpo.map((f) => '<tr>' + celdas(f).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }

      // párrafo: junta líneas seguidas
      const buf = [];
      while (i < lineas.length && lineas[i].trim() &&
             !/^(#{1,4}\s|>|[-*]\s|\d+[.)]\s|\|)/.test(lineas[i].trim()) &&
             !/^(---|___|\*\*\*)$/.test(lineas[i].trim())) {
        buf.push(lineas[i].trim());
        i++;
      }
      if (buf.length) out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    }

    return out.join('\n');
  }

  window.mdRender = mdRender;
  window.mdIndice = mdIndice;
})();

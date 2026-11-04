(() => {
  "use strict";
  const $ = (s) => document.querySelector(s),
    e = (v) =>
      String(v ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  let items = [],
    opts = {},
    selected = null,
    pending = null,
    busy = false;
  const states = {
    recibida: "Recibida",
    revisar: "En revisión",
    aprobando: "Aprobando",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
    error_aprobacion: "Aprobación incompleta",
  };
  const notice = (s, err = false) => {
    const n = $("#aviso");
    n.textContent = s;
    n.style.background = err ? "#fde9ec" : "#edf1f4";
  };
  async function api(accion, data = {}) {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session) throw Error("Iniciá sesión en Core.");
    const r = await fetch(SUPABASE_URL + "/functions/v1/portal-alta", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + session.access_token,
      },
      body: JSON.stringify({ accion, ...data }),
    });
    let j;
    try {
      j = await r.json();
    } catch {
      throw Error(
        "No se pudo leer la respuesta. Actualizá la bandeja antes de reintentar.",
      );
    }
    if (!r.ok || !j.ok)
      throw Error(j.error || "No se pudo completar la operación.");
    return j;
  }
  async function task(fn) {
    if (busy) return;
    busy = true;
    document.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (err) {
      notice(err.message, true);
    } finally {
      busy = false;
      document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
  function list() {
    const term = $("#busqueda").value.toLowerCase(),
      filter = $("#estado").value;
    const shown = items.filter(
      (a) =>
        (filter === "todos" || filter === "pendientes"
          ? !["aprobada", "rechazada"].includes(a.estado) || filter === "todos"
          : a.estado === filter) &&
        [a.datos.razon, a.email, a.cuit].some((v) =>
          v.toLowerCase().includes(term),
        ),
    );
    $("#bandeja").innerHTML =
      shown
        .map(
          (a) =>
            `<button class="alta-card ${a.id === selected ? "selected" : ""}" data-alta="${e(a.id)}"><strong>${e(a.datos.razon)}</strong><span>${e(opts.tipos?.[a.datos.tipo] || a.datos.tipo)} · ${e(a.cuit)}</span><span>${e(a.email)}</span><span class="alta-state">${e(states[a.estado])} · ${new Date(a.creada).toLocaleDateString("es-AR")}</span></button>`,
        )
        .join("") ||
      '<div class="altas-empty">No hay solicitudes en esta vista.</div>';
    $("#contadores").innerHTML =
      `<span class="altas-stat"><b>${items.filter((a) => !["aprobada", "rechazada"].includes(a.estado)).length}</b> pendientes</span><span class="altas-stat"><b>${items.filter((a) => a.estado === "aprobada").length}</b> aprobadas</span>`;
  }
  async function load() {
    const r = await api("listar");
    items = r.solicitudes;
    opts = r.opciones;
    list();
    notice("Bandeja actualizada. Aprobación autorizada para " + r.actor + ".");
    if (selected && items.some((a) => a.id === selected))
      await detail(selected);
  }
  async function detail(id) {
    const r = await api("detalle", { id });
    selected = id;
    const a = r.solicitud,
      an = a.analisis || {},
      ar = an.arca || {},
      closed = ["aprobada", "rechazada", "aprobando"].includes(a.estado),
      saved = a.aprobacion || {};
    list();
    const pairs = [
      ["CUIT", a.cuit],
      ["Actividad", opts.tipos[a.datos.tipo]],
      ["Nombre comercial", a.datos.cartel || "—"],
      ["Correo", a.email],
      ["Teléfono", a.datos.telefono],
      [
        "Domicilio",
        [a.datos.calle, a.datos.localidad, a.datos.provincia].join(", "),
      ],
    ];
    $("#detalle").innerHTML =
      `<article class="alta-panel"><p class="eyebrow">${e(states[a.estado])}</p><h2>${e(a.datos.razon)}</h2><dl>${pairs.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl><h3>Identidad fiscal y coincidencias</h3>${an.consultada ? `<p>Consulta: ${new Date(an.consultada).toLocaleString("es-AR")}</p><div class="altas-note ${an.alertas?.length ? "warn" : ""}">${e(ar.nombre_completo || ar.error || "Sin datos fiscales")}<br>${e(ar.estado || "")} · ${e(ar.iva || "Sin condición fiscal confirmada")}</div><ul>${(an.alertas || []).map((s) => `<li>${e(s)}</li>`).join("")}</ul><ul>${(an.odoo?.fichas || []).map((p) => `<li>Ficha ${p.id}: ${e(p.name)} · correo ${e(p.email || "sin correo")} · lista ${e(p.property_product_pricelist?.[1] || "—")}</li>`).join("")}${(an.odoo?.usuarios || []).map((u) => `<li>Acceso ${e(u.login)} · ${u.share ? "portal" : "interno"} · ${u.active ? "activo" : "archivado"}</li>`).join("")}</ul>` : "<p>Consultá ARCA y Odoo antes de decidir.</p>"}${["recibida", "revisar"].includes(a.estado) ? '<button class="btn" data-action="analizar">Consultar ARCA y Odoo</button>' : ""}
<h3>Documentación</h3><ul>${a.archivos.map((f, i) => `<li><button class="btn" data-file="${i}">${e(f.nombre)} ↗</button></li>`).join("") || "<li>Sin documentos adjuntos.</li>"}</ul>${["recibida", "revisar"].includes(a.estado) ? '<label>Agregar constancia o documentación<input id="documento" type="file" accept="application/pdf,image/jpeg,image/png"></label><button class="btn" data-action="subir">Guardar documento</button><p>PDF, JPG o PNG · hasta 5 MB. Acceso privado.</p>' : ""}
${
  !closed
    ? `<h3>Condiciones del acceso</h3><div class="alta-controls"><label>Lista de precios<select id="lista">${opts.listas.map((x) => `<option value="${x.id}" ${x.id === (saved.lista_id || 32) ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label><label>Responsable comercial<select id="comercial">${opts.comerciales.map((x) => `<option value="${x.id}" ${x.id === saved.comercial_id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label><label>Condición IVA (constancia revisada)<select id="responsabilidad"><option value="0">Usar consulta ARCA</option>${[
        { id: 1, name: "Responsable inscripto" },
        { id: 6, name: "Monotributo" },
        { id: 4, name: "Exento" },
      ]
        .map(
          (x) =>
            `<option value="${x.id}" ${x.id === saved.responsabilidad_id ? "selected" : ""}>${e(x.name)}</option>`,
        )
        .join(
          "",
        )}</select></label></div><label class="check"><input id="identidad" type="checkbox" ${saved.identidad_verificada ? "checked" : ""}>Verifiqué la identidad y que esta persona puede gestionar la cuenta.</label><label class="check"><input id="fiscal" type="checkbox" ${saved.fiscal_verificado ? "checked" : ""}>Revisé los datos fiscales y la documentación que corresponde.</label><label class="check"><input id="reemplazar" type="checkbox" ${saved.reemplazar ? "checked" : ""}>Si tiene otro correo de acceso, confirmo su reemplazo y revocación.</label><label>Registro de la revisión<textarea id="revision" rows="3" maxlength="1500" placeholder="Cómo verificaste la identidad y qué documentación revisaste">${e(saved.revision || "")}</textarea></label><div class="altas-actions"><button class="btn btn-primary" data-action="plan">Revisar aprobación</button>${["recibida", "revisar"].includes(a.estado) ? '<button class="btn btn-danger" data-action="rechazar">Rechazar solicitud</button>' : ""}</div><label style="margin-top:18px">Motivo del rechazo<textarea id="motivo" rows="2" maxlength="1500" placeholder="Completalo sólo si vas a rechazar"></textarea></label>`
    : ""
}
${a.estado === "error_aprobacion" ? '<div class="altas-note error">Operación incompleta. El reintento conserva los pasos ya realizados y las condiciones elegidas. No vuelvas a cargar otra solicitud.</div>' : ""}${a.estado === "aprobando" ? '<div class="altas-note warn">Hay una aprobación en curso. Actualizá la bandeja para consultar el resultado. Si no termina, requiere revisión técnica.</div>' : ""}${a.resultado?.partner_id ? `<div class="altas-note">Ficha Odoo: ${a.resultado.partner_id} · Usuario: ${a.resultado.user_id || "pendiente"}<br>Invitación: ${e(a.resultado.invitacion || "acceso existente")}</div>` : ""}${a.motivo ? `<p>Motivo: ${e(a.motivo)}</p>` : ""}<h3>Historial</h3><ul class="alta-history">${r.eventos.map((v) => `<li>${new Date(v.creada).toLocaleString("es-AR")} · ${e(v.accion.replaceAll("_", " "))} · ${e(v.actor)}${v.detalle?.mensaje ? " · " + e(v.detalle.mensaje) : ""}</li>`).join("")}</ul></article>`;
    $("#detalle").dataset.paths = JSON.stringify(a.archivos.map((f) => f.path));
  }
  function choices() {
    return {
      id: selected,
      lista_id: Number($("#lista").value),
      comercial_id: Number($("#comercial").value),
      identidad_verificada: $("#identidad").checked,
      fiscal_verificado: $("#fiscal").checked,
      reemplazar: $("#reemplazar").checked,
      revision: $("#revision").value,
      responsabilidad_id: Number($("#responsabilidad").value),
    };
  }
  $("#recargar").onclick = () => task(load);
  $("#busqueda").oninput = list;
  $("#estado").onchange = list;
  $("#bandeja").onclick = (ev) => {
    const b = ev.target.closest("[data-alta]");
    if (b) task(() => detail(b.dataset.alta));
  };
  $("#detalle").onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    task(async () => {
      if (b.dataset.file !== undefined) {
        const paths = JSON.parse($("#detalle").dataset.paths);
        const r = await api("archivo", {
          id: selected,
          path: paths[Number(b.dataset.file)],
        });
        const link = document.createElement("a");
        link.href = r.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.click();
        return;
      }
      if (b.dataset.action === "analizar") {
        notice("Consultando identidad fiscal y cuentas existentes…");
        await api("reanalizar", { id: selected });
        await load();
      }
      if (b.dataset.action === "plan") {
        pending = choices();
        const r = await api("aprobar", { ...pending, ensayo: true });
        $("#plan").innerHTML = r.plan.pasos
          .map((s) => `<li>${e(s)}</li>`)
          .join("");
        $("#confirmacion").showModal();
      }
      if (b.dataset.action === "rechazar") {
        await api("rechazar", { id: selected, motivo: $("#motivo").value });
        await load();
        notice("Solicitud rechazada. No se creó un cliente en Odoo.");
      }
      if (b.dataset.action === "subir") {
        const f = $("#documento").files[0];
        if (!f) throw Error("Elegí un documento.");
        if (f.size > 5 * 1024 * 1024) throw Error("El archivo supera 5 MB.");
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1]);
          r.onerror = reject;
          r.readAsDataURL(f);
        });
        await api("subir", {
          id: selected,
          archivo: { nombre: f.name, tipo: f.type, b64 },
        });
        await detail(selected);
        notice("Documento guardado de forma privada.");
      }
    });
  };
  $("#cancelar-plan").onclick = () => {
    $("#confirmacion").close();
    pending = null;
  };
  $("#confirmar-plan").onclick = () =>
    task(async () => {
      $("#confirmacion").close();
      notice("Aplicando la aprobación en Odoo…");
      await api("aprobar", pending);
      pending = null;
      await load();
      notice(
        "Acceso aprobado. Consultá el resultado y la invitación en la ficha.",
      );
    });
  task(load);
})();

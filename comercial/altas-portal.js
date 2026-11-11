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
    busy = false,
    current = null;
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
  function customerReview(a,closed){
    const matches=a.analisis?.odoo?.fichas||[];if(matches.length!==1)return '';
    const p=matches[0],saved=a.aprobacion||{},selected=saved.datos_actualizar||[];
    const fields=[['name','Nombre',a.nombre_propuesto||a.datos.razon],['x_studio_nombre_fantasia','Nombre comercial',a.datos.cartel],['email','Correo de contacto',a.email],['phone','Teléfono',a.datos.telefono],['street','Calle y número',a.datos.calle],['street2','Piso, departamento o referencia',a.datos.complemento],['city','Localidad',a.datos.localidad],['state_id','Provincia',a.datos.provincia]];
    const changes=fields.map(([key,label,value])=>({key,label,value,current:key==='state_id'?p.state_id?.[1]||'':p[key]||''})).filter(x=>x.value&&String(x.value).trim()!==String(x.current).trim());
    return `<section class="alta-customer-review" data-customer-version="${e(p.write_date||'')}"><h3>Datos del cliente existente</h3><p>Vincularemos esta solicitud a <strong>${e(p.name)}</strong>, sin crear otro cliente. Marcá únicamente los datos que verificaste y querés actualizar. El resto se conserva.</p>${p.write_date?changes.length?`<div class="alta-change-list">${changes.map(x=>`<label class="alta-change"><input type="checkbox" data-contact-field="${x.key}" ${selected.includes(x.key)?'checked':''} ${closed?'disabled':''}><span><b>${e(x.label)}</b><small>Actual: ${e(x.current||'Sin dato')}</small><span>Solicitado: ${e(x.value)}</span></span></label>`).join('')}</div>`:'<p>No hay diferencias en los datos de contacto.</p>':'<p>Usá «Revisar contacto en Odoo» para cargar la comparación actual.</p>'}<p class="alta-preserve">Documento y condición fiscal se conservan. Lista actual: ${e(p.property_product_pricelist?.[1]||'Sin asignar')}. Responsable: ${e(p.user_id?.[1]||'Sin asignar')}.</p>${!closed?`<label class="check"><input id="actualizar-condiciones" type="checkbox" ${saved.actualizar_condiciones?'checked':''}>También quiero modificar la lista y el responsable con las opciones elegidas abajo.</label>${p.documento_coincide===false?`<label class="check"><input id="documento-revisado" type="checkbox" ${saved.documento_revisado?'checked':''}>El documento declarado difiere; verifiqué que esta solicitud corresponde a este cliente. Conservar su documento actual.</label>`:''}`:''}</section>`;
  }
  function simpleView(r){
    const a=r.solicitud,p=a.analisis.odoo.fichas[0],s=r.resumen,changes=s.changes||[];
    const fiscal={RI:'Responsable inscripto',MONO:'Monotributista',CF:'Consumidor final',EXENTO:'Exento'}[a.datos.condicion_iva];
    const button=s.resume?'Reintentar habilitación':s.existing_access?'Aprobar actualización':'Aprobar acceso';
    const lastError=[...(r.eventos||[])].reverse().find(v=>v.accion==='error_aprobacion')?.detalle?.mensaje;
    $('#detalle').innerHTML=`<article class="alta-panel alta-simple"><p class="eyebrow">${e(states[a.estado])}</p><h2>${e(p.name)}</h2><p class="alta-simple-contact">${e(a.email)}<br><span>${e(opts.tipos[a.datos.tipo]||a.datos.tipo)} · ${e(fiscal)}</span></p><div class="alta-match"><span aria-hidden="true">✓</span><div><strong>Cliente existente identificado</strong><p>${e(s.reason)}</p></div></div>
${s.resume?`<div class="altas-note error"><strong>El acceso quedó pendiente</strong><p>${e(lastError||'Odoo no pudo terminar la activación.')}</p><p>El reintento retoma lo ya aprobado. No hace falta repetir la revisión.</p></div>`:changes.length?`<section class="alta-simple-changes"><h3>${changes.length===1?'Un dato nuevo':changes.length+' datos nuevos'}</h3><div class="alta-diff-table">${changes.map(c=>`<div class="alta-diff-row"><strong>${e(c.label)}</strong><span><small>Actual</small>${e(c.current)}</span><span><small>Solicitado</small>${e(c.proposed)}</span></div>`).join('')}</div><label class="check alta-include"><input id="incluir-cambios" type="checkbox">Actualizar estos datos al aprobar</label><details class="alta-pick"><summary>Elegir datos por separado</summary>${changes.map(c=>`<label class="check"><input type="checkbox" data-simple-field="${c.field}">${e(c.label)}</label>`).join('')}</details></section>`:'<p class="alta-no-changes">No hay datos nuevos para actualizar.</p>'}
<p class="alta-preserve">Se conservan el historial, la condición fiscal y las condiciones comerciales. La contraseña vigente elegida en esta solicitud se aplica al aprobar, también si el cliente ya tenía acceso.</p><div class="alta-simple-submit"><button class="btn btn-primary" data-action="simple" data-label="${e(button)}">${e(button)}</button><small>Esta acción autoriza el acceso y aplica sólo los cambios seleccionados.</small></div>
<details class="alta-extra"><summary>Ver datos, documentos e historial</summary><dl><dt>${e(a.datos.documento_tipo||'CUIT')}</dt><dd>${e(a.cuit)}</dd><dt>Teléfono</dt><dd>${e(a.datos.telefono)}</dd><dt>Domicilio solicitado</dt><dd>${e([a.datos.calle,a.datos.complemento,a.datos.localidad,a.datos.provincia].filter(Boolean).join(', '))}</dd><dt>Ficha Odoo</dt><dd>${p.id}</dd><dt>Lista actual</dt><dd>${e(p.property_product_pricelist?.[1]||'Sin asignar')}</dd><dt>Responsable</dt><dd>${e(p.user_id?.[1]||'Sin asignar')}</dd></dl>${s.resume&&changes.length?`<h3>Datos nuevos aún por revisar</h3><p>El reintento conserva las selecciones de la aprobación inicial.</p><ul>${changes.map(c=>`<li>${e(c.label)}: ${e(c.current)} → ${e(c.proposed)}</li>`).join('')}</ul>`:''}<h3>Documentos</h3><ul>${a.archivos.map((f,i)=>`<li><button class="btn" data-file="${i}">${e(f.nombre)} ↗</button></li>`).join('')||'<li>Sin documentos adjuntos.</li>'}</ul><h3>Historial</h3><ul class="alta-history">${r.eventos.map(v=>`<li>${new Date(v.creada).toLocaleString('es-AR')} · ${e(v.accion.replaceAll('_',' '))} · ${e(v.actor)}</li>`).join('')}</ul><button class="btn" data-action="manual">Revisar un caso especial</button></details>
${!s.resume?'<details class="alta-extra"><summary>No aprobar esta solicitud</summary><label>Motivo<textarea id="motivo" rows="2" maxlength="1500"></textarea></label><button class="btn btn-danger" data-action="rechazar">Rechazar solicitud</button></details>':''}</article>`;
    $('#detalle').dataset.paths=JSON.stringify(a.archivos.map(f=>f.path));
  }
  function simpleChoices(){
    const a=current.solicitud,p=a.analisis.odoo.fichas[0];
    if(current.resumen.resume)return {id:selected,...a.aprobacion,via_simple:true};
    return {id:selected,via_simple:true,lista_id:opts.listas.some(x=>x.id===p.property_product_pricelist?.[0])?p.property_product_pricelist[0]:32,comercial_id:opts.comerciales.some(x=>x.id===p.user_id?.[0])?p.user_id[0]:opts.comerciales[0]?.id,responsabilidad_id:current.resumen.fiscal_id,identidad_verificada:true,fiscal_verificado:true,reemplazar:false,actualizar_condiciones:false,documento_revisado:false,revision_cliente:p.write_date,datos_actualizar:Array.from(document.querySelectorAll('[data-simple-field]:checked')).map(x=>x.dataset.simpleField),revision:'Aprobación humana desde el resumen de cliente existente. Correo, documento y condición fiscal coinciden con Odoo. Conservar condiciones y aplicar sólo los datos seleccionados.'};
  }
  function resolvedView(r){
    const a=r.solicitud;
    $('#detalle').innerHTML=`<article class="alta-panel alta-simple"><p class="eyebrow">Aprobada</p><h2>${e(a.datos.razon)}</h2><p class="alta-simple-contact">${e(a.email)}</p><div class="alta-match"><span aria-hidden="true">✓</span><div><strong>Acceso habilitado</strong><p>La aprobación quedó registrada en la ficha del cliente.</p></div></div><p class="alta-preserve">${a.resultado?.datos_actualizados?'Se aplicaron los datos seleccionados.':'Se conservaron los datos de la ficha.'}${a.resultado?.clave_aplicada?' El cliente puede usar la contraseña que eligió al registrarse.':''}${a.resultado?.aviso_acceso==='en_cola'?' El aviso de acceso quedó preparado para envío.':''}</p><details class="alta-extra"><summary>Ver resolución e historial</summary><p>Ficha Odoo: ${a.resultado?.partner_id||'—'} · Usuario: ${a.resultado?.user_id||'—'}</p><ul class="alta-history">${r.eventos.map(v=>`<li>${new Date(v.creada).toLocaleString('es-AR')} · ${e(v.accion.replaceAll('_',' '))} · ${e(v.actor)}</li>`).join('')}</ul></details></article>`;
  }
  function accessLinkPanel(){
    return `<section class="alta-access-link"><h3>Crear una nueva contraseña</h3><p>Generá un enlace personal para compartir con este cliente por WhatsApp. No tiene que solicitar ni esperar un correo.</p><button class="btn" data-action="generar-enlace">Generar enlace de acceso</button><div id="enlace-acceso" aria-live="polite"></div></section>`;
  }
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
    const waiting=items.filter(a=>!['aprobada','rechazada'].includes(a.estado));
    if(!selected&&waiting.length===1)selected=waiting[0].id;
    if (selected && items.some((a) => a.id === selected))
      await detail(selected);
  }
  async function detail(id,manual=false,skipRefresh=false) {
    const item=items.find(a=>a.id===id);let refreshError='';
    if(!manual&&!skipRefresh&&['recibida','revisar'].includes(item?.estado)){
      notice('Comprobando la ficha en Odoo…');
      try{await api('revisar_odoo',{id});}catch(err){refreshError=err.message;}
    }
    const r = await api("detalle", { id });
    current=r;
    selected = id;
    items=items.map(item=>item.id===id?r.solicitud:item);
    const a = r.solicitud,
      an = a.analisis || {},
      ar = an.arca || {},
      closed = ["aprobada", "rechazada", "aprobando"].includes(a.estado),
      saved = a.aprobacion || {};
    list();
    if(!manual&&a.estado==='aprobada'){resolvedView(r);$('#detalle .alta-extra').insertAdjacentHTML('beforebegin',accessLinkPanel());return;}
    if(!manual&&!refreshError&&r.resumen?.available){simpleView(r);notice('Solicitud lista para decidir.');return;}
    const pairs = [
      ...(!closed&&!an.odoo?.fichas?.length&&a.nombre_propuesto?[["Nombre en Odoo",a.nombre_propuesto]]:[]),
      [a.datos.documento_tipo || "CUIT", a.cuit],
      ["Condición declarada", ({RI:"Responsable inscripto",MONO:"Monotributista",CF:"Consumidor final",EXENTO:"Exento"})[a.datos.condicion_iva] || "Sin declarar (alta anterior)"],
      ["Contraseña", a.resultado?.clave_aplicada ? "Aplicada al acceso" : a.datos.clave_elegida ? "Elegida al registrarse · protegida" : "Por enlace de acceso"],
      ["Actividad", opts.tipos[a.datos.tipo]],
      ["Nombre comercial", a.datos.cartel || "—"],
      ["Correo", a.email],
      ["Teléfono", a.datos.telefono],
      [
        "Domicilio",
        [a.datos.calle, a.datos.complemento, a.datos.localidad, a.datos.provincia].filter(Boolean).join(", "),
      ],
    ];
    $("#detalle").innerHTML =
      `<article class="alta-panel"><p class="eyebrow">${e(states[a.estado])}</p><h2>${e(a.datos.razon)}</h2><dl>${pairs.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl><h3>Identidad fiscal y coincidencias</h3>${an.consultada ? `<p>Consulta: ${new Date(an.consultada).toLocaleString("es-AR")}</p><div class="altas-note ${an.alertas?.length ? "warn" : ""}">${e(ar.nombre_completo || ar.error || "Sin datos fiscales")}<br>${e(ar.estado || "")} · ${e(ar.iva || "Sin condición fiscal confirmada")}</div><ul>${(an.alertas || []).map((s) => `<li>${e(s)}</li>`).join("")}</ul><ul>${(an.odoo?.fichas || []).map((p) => `<li>Ficha ${p.id}: ${e(p.name)} · correo ${e(p.email || "sin correo")} · lista ${e(p.property_product_pricelist?.[1] || "—")}</li>`).join("")}${(an.odoo?.usuarios || []).map((u) => `<li>Acceso ${e(u.login)} · ${u.share ? "portal" : "interno"} · ${u.active ? "activo" : "archivado"}</li>`).join("")}</ul>` : "<p>Consultá ARCA y Odoo antes de decidir.</p>"}${["recibida", "revisar"].includes(a.estado) ? '<button class="btn" data-action="analizar">Verificar identidad y datos</button>' : ""}
<h3>Documentación</h3><ul>${a.archivos.map((f, i) => `<li><button class="btn" data-file="${i}">${e(f.nombre)} ↗</button></li>`).join("") || "<li>Sin documentos adjuntos.</li>"}</ul>${["recibida", "revisar"].includes(a.estado) ? '<label>Agregar constancia o documentación<input id="documento" type="file" accept="application/pdf,image/jpeg,image/png"></label><button class="btn" data-action="subir">Guardar documento</button><p>PDF, JPG o PNG · hasta 5 MB. Acceso privado.</p>' : ""}
${
  !closed
    ? `<h3>Condiciones del acceso</h3><div class="alta-controls"><label>Lista de precios<select id="lista">${opts.listas.map((x) => `<option value="${x.id}" ${x.id === (saved.lista_id || 32) ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label><label>Responsable comercial<select id="comercial">${opts.comerciales.map((x) => `<option value="${x.id}" ${x.id === saved.comercial_id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label><label>Condición IVA verificada<select id="responsabilidad"><option value="0">Usar consulta ARCA</option>${[
        { id: 1, name: "Responsable inscripto" },
        { id: 6, name: "Monotributista" },
        { id: 5, name: "Consumidor final" },
        { id: 4, name: "Exento" },
      ]
        .map(
          (x) =>
            `<option value="${x.id}" ${x.id === (saved.responsabilidad_id || (a.datos.condicion_iva === "CF" ? 5 : 0)) ? "selected" : ""}>${e(x.name)}</option>`,
        )
        .join(
          "",
        )}</select></label></div><label class="check"><input id="identidad" type="checkbox" ${saved.identidad_verificada ? "checked" : ""}>Verifiqué la identidad y que esta persona puede gestionar la cuenta.</label><label class="check"><input id="fiscal" type="checkbox" ${saved.fiscal_verificado ? "checked" : ""}>Revisé los datos fiscales y la documentación que corresponde.</label><label class="check"><input id="reemplazar" type="checkbox" ${saved.reemplazar ? "checked" : ""}>Si tiene otro correo de acceso, confirmo su reemplazo y revocación.</label><label>Registro de la revisión<textarea id="revision" rows="3" maxlength="1500" placeholder="Cómo verificaste la identidad y qué documentación revisaste">${e(saved.revision || "")}</textarea></label><div class="altas-actions"><button class="btn btn-primary" data-action="plan">Revisar aprobación</button>${["recibida", "revisar"].includes(a.estado) ? '<button class="btn btn-danger" data-action="rechazar">Rechazar solicitud</button>' : ""}</div><label style="margin-top:18px">Motivo del rechazo<textarea id="motivo" rows="2" maxlength="1500" placeholder="Completalo sólo si vas a rechazar"></textarea></label>`
    : ""
}
${a.estado === "error_aprobacion" ? '<div class="altas-note error">Operación incompleta. El reintento conserva los pasos ya realizados y las condiciones elegidas. No vuelvas a cargar otra solicitud.</div>' : ""}${a.estado === "aprobando" ? '<div class="altas-note warn">Hay una aprobación en curso. Actualizá la bandeja para consultar el resultado. Si no termina, requiere revisión técnica.</div>' : ""}${a.resultado?.partner_id ? `<div class="altas-note">Ficha Odoo: ${a.resultado.partner_id} · Usuario: ${a.resultado.user_id || "pendiente"}<br>Acceso: ${e(a.resultado.clave_aplicada ? "con contraseña elegida" : (a.resultado.invitacion || "existente"))}</div>` : ""}${a.motivo ? `<p>Motivo: ${e(a.motivo)}</p>` : ""}<h3>Historial</h3><ul class="alta-history">${r.eventos.map((v) => `<li>${new Date(v.creada).toLocaleString("es-AR")} · ${e(v.accion.replaceAll("_", " "))} · ${e(v.actor)}${v.detalle?.mensaje ? " · " + e(v.detalle.mensaje) : ""}</li>`).join("")}</ul></article>`;
    $("#detalle").dataset.paths = JSON.stringify(a.archivos.map((f) => f.path));
    const panel=$('#detalle .alta-panel');
    if(manual&&r.resumen?.available){const back=document.createElement('button');back.type='button';back.className='btn';back.dataset.action='resumen';back.textContent='Volver al resumen';panel.prepend(back);}
    if(!closed){const button=document.createElement('button');button.type='button';button.className='btn';button.dataset.action='odoo';button.textContent='Revisar contacto en Odoo';panel.querySelector('h3').before(button);}
    const controls=panel.querySelector('.alta-controls');if(controls)controls.insertAdjacentHTML('beforebegin',customerReview(a,closed));else panel.insertAdjacentHTML('beforeend',customerReview(a,closed));
    const p=an.odoo?.fichas?.length===1?an.odoo.fichas[0]:null;
    if(p&&!closed&&!a.aprobacion){if(opts.listas.some(x=>x.id===p.property_product_pricelist?.[0]))$('#lista').value=String(p.property_product_pricelist[0]);if(opts.comerciales.some(x=>x.id===p.user_id?.[0]))$('#comercial').value=String(p.user_id[0]);}
    if(refreshError)notice(refreshError,true);
    else if(r.resumen?.reason&&!closed)notice('Revisión particular: '+r.resumen.reason);
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
      datos_actualizar:Array.from(document.querySelectorAll('[data-contact-field]:checked')).map(x=>x.dataset.contactField),
      revision_cliente:$('#detalle [data-customer-version]')?.dataset.customerVersion||'',
      actualizar_condiciones:$('#actualizar-condiciones')?.checked===true,
      documento_revisado:$('#documento-revisado')?.checked===true,
    };
  }
  $("#recargar").onclick = () => task(load);
  $("#busqueda").oninput = list;
  $("#estado").onchange = list;
  $('#detalle').onchange=(ev)=>{
    if(!current?.resumen?.available)return;
    if(ev.target.id==='incluir-cambios')document.querySelectorAll('[data-simple-field]').forEach(x=>x.checked=ev.target.checked);
    const fields=Array.from(document.querySelectorAll('[data-simple-field]')),count=fields.filter(x=>x.checked).length,all=$('#incluir-cambios');
    if(all){all.checked=count===fields.length;all.indeterminate=count>0&&count<fields.length;}
    const button=$('[data-action="simple"]');if(button&&!current.resumen.resume)button.textContent=count?'Aprobar y actualizar '+count+(count===1?' dato':' datos'):button.dataset.label;
  };
  $("#bandeja").onclick = (ev) => {
    const b = ev.target.closest("[data-alta]");
    if (b) task(() => detail(b.dataset.alta));
  };
  $("#detalle").onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    task(async () => {
      if(b.dataset.action==='generar-enlace'){
        notice('Generando el enlace personal en Odoo…');
        const r=await api('generar_enlace',{id:selected});
        $('#enlace-acceso').innerHTML=`<label for="enlace-acceso-url">Enlace para ${e(current.solicitud.email)}</label><div class="alta-link-copy"><input id="enlace-acceso-url" type="text" readonly autocomplete="off" spellcheck="false" value="${e(r.url)}"><button class="btn btn-primary" data-action="copiar-enlace">Copiar enlace</button></div><p class="alta-link-note">Válido durante ${e(r.horas)} horas. Se invalida al usarlo o al iniciar sesión. Compartilo sólo con este cliente.</p>`;
        notice('Enlace listo para copiar. No se envió ningún correo.');return;
      }
      if(b.dataset.action==='copiar-enlace'){
        const field=$('#enlace-acceso-url');
        try{await navigator.clipboard.writeText(field.value);notice('Enlace copiado. Ya podés pegarlo en el chat del cliente.');}
        catch{field.focus();field.select();notice('El enlace quedó seleccionado. Copialo para enviarlo al cliente.');}
        return;
      }
      if(b.dataset.action==='manual'){await detail(selected,true,true);return;}
      if(b.dataset.action==='resumen'){await detail(selected,false,true);return;}
      if(b.dataset.action==='simple'){
        const choices=simpleChoices();notice(current.resumen.resume?'Retomando la habilitación…':'Aprobando el acceso…');
        try{await api('aprobar',choices);await load();notice('Solicitud aprobada. El acceso y los cambios seleccionados quedaron registrados.');}
        catch(err){await detail(selected,false,true);throw err;}
        return;
      }
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
      if(b.dataset.action==='odoo'){
        notice('Revisando contacto, acceso y datos actuales en Odoo…');
        await api('revisar_odoo',{id:selected});await load();
        notice('Datos de Odoo revisados. No se consultó ARCA ni se modificó el cliente.');
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

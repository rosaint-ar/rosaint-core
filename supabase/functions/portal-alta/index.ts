import {simpleApprovalSummary} from './approval-simple.ts';
import {accessCreationError} from './access-error.ts';
// Rosaint · alta pública y aprobación interna. No hay autoaprobación.
import { admin, kw, lookupLogin, diagnostic, SB, SERVICE, OD, COMPANY } from "./odoo.ts";
import { consultarArca, diagnosticoArca } from "./arca.ts";
import { configDiagnostic } from "./config-diagnostic.ts";
import { install } from "./install.ts";
import { encrypt, readPassword, validPassword, passwordContext } from "./secrets.ts";
import { installArcaSigner } from './arca-signer.ts';
import {contactChanges,planContactUpdate,selectedContactFields,sameApproval} from './customer-update.ts';

const TYPES = {
  cosmetologia: "Cosmetología / Cosmiatría",
  estetica: "Estética",
  masajes: "Masajes / Kinesiología",
  salud: "Profesional de salud",
  estudiante: "Estudiante",
  profesional: "Profesional",
  revendedor: "Revendedor",
  mayorista: "Mayorista",
  academia: "Academia o formación",
  otro: "Otra actividad",
};
const ORIGINS = [
  "https://rosaint.odoo.com",
  "https://pro.rosaint.online",
  "https://rosaint-ar.github.io",
];
const FISCAL = {RI:1, MONO:6, CF:5, EXENTO:4};
const DOCUMENTS = {CUIT:4, DNI:5, CUIL:6};
const LISTS = [32, 60]; // IDs verificados en Odoo, no IDs de Core.
const enc = (v: unknown) => encodeURIComponent(String(v));
const digits = (v: unknown) => String(v || "").replace(/\D/g, "");
const fmt = (s: string) => `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}`;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
class Failure extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function contactPlan(...args:Parameters<typeof planContactUpdate>){try{return planContactUpdate(...args);}catch(e){throw new Failure(e.message,409);}}
function chosenFields(v:any){try{return selectedContactFields(v);}catch(e){throw new Failure(e.message);}}
export function validCuit(s: string) {
  if (!/^\d{11}$/.test(s) || /^([0-9])\1+$/.test(s)) return false;
  const n =
    11 -
    ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce(
      (t, w, i) => t + w * Number(s[i]),
      0,
    ) %
      11);
  return Number(s[10]) === (n === 11 ? 0 : n === 10 ? 9 : n);
}
export function validate(raw: any) {
  const d: Record<string, string> = {};
  for (const k of [
    "tipo",
    "cuit",
    "documento_tipo",
    "documento",
    "condicion_iva",
    "razon",
    "cartel",
    "calle",
    "localidad",
    "provincia",
    "telefono",
    "email",
  ])
    d[k] = String(raw?.[k] ?? "").trim();
  d.documento_tipo = d.documento_tipo || 'CUIT';
  d.documento = digits(d.documento || d.cuit);
  d.cuit = d.documento; // Campo legado de almacenamiento; el tipo distingue DNI/CUIT/CUIL.
  if(!Object.hasOwn(DOCUMENTS,d.documento_tipo))throw new Failure('Elegí el tipo de documento.');
  if(d.condicion_iva && !Object.hasOwn(FISCAL,d.condicion_iva))throw new Failure('Elegí una condición IVA válida.');
  if(d.documento_tipo!=='CUIT' && d.condicion_iva!=='CF')throw new Failure('DNI y CUIL se admiten para consumidor final. Para otra condición, ingresá CUIT.');
  d.email = d.email.toLowerCase();
  if (!Object.hasOwn(TYPES, d.tipo)) throw new Failure("Elegí tu actividad.");
  if(d.documento_tipo==='DNI') {
    if(!/^\d{7,8}$/.test(d.documento)||/^([0-9])\1+$/.test(d.documento))throw new Failure('Revisá el DNI: debe tener 7 u 8 dígitos.');
  } else if(!validCuit(d.documento)) throw new Failure('Revisá el CUIT o CUIL.');
  for (const k of ["razon", "calle", "localidad", "provincia"])
    if (d[k].length < 2 || d[k].length > 180)
      throw new Failure("Completá los datos del domicilio y nombre.");
  if (
    d.cartel.length > 180 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) ||
    d.email.length > 200
  )
    throw new Failure("Revisá el correo.");
  if (digits(d.telefono).length < 10 || d.telefono.length > 35)
    throw new Failure("Revisá el teléfono con código de área.");
  return d;
}
async function db(path: string, method = "GET", body?: unknown) {
  const r = await fetch(SB + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: "Bearer " + SERVICE,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw new Failure(
      "No se pudo guardar la operación en Core. Volvé a consultar su estado.",
      503,
    );
  const s = await r.text();
  return s ? JSON.parse(s) : null;
}
async function row(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id || ""))
    throw new Failure("Solicitud inválida.");
  const a = (await db("portal_altas?id=eq." + enc(id)))[0];
  if (!a) throw new Failure("Solicitud no encontrada.", 404);
  return a;
}
async function patch(id: string, data: any) {
  return db("portal_altas?id=eq." + enc(id), "PATCH", {
    ...data,
    actualizada: new Date().toISOString(),
  });
}
async function event(id: string, actor: string, accion: string, detalle = {}) {
  await db("portal_altas_eventos", "POST", {
    alta_id: id,
    actor,
    accion,
    detalle,
  });
}
async function options() {
  const lists = await kw(
    "product.pricelist",
    "search_read",
    [
      [
        ["id", "in", LISTS],
        ["active", "=", true],
      ],
    ],
    { fields: ["id", "name", "company_id"] },
  );
  const commercials = await kw(
    "res.users",
    "search_read",
    [
      [
        ["share", "=", false],
        ["active", "=", true],
        ["company_ids", "in", [COMPANY]],
      ],
    ],
    { fields: ["id", "name"] },
  );
  const states = await kw(
    "res.country.state",
    "search_read",
    [[["country_id", "=", 10]]],
    { fields: ["id", "name"], order: "name" },
  );
  return {
    listas: lists.filter(
      (x: any) => !x.company_id || x.company_id[0] === COMPANY,
    ),
    comerciales: commercials,
    provincias: states,
    tipos: TYPES,
  };
}
async function look(d: any) {
  const dni=d.documento_tipo==='DNI', doc=d.documento||d.cuit;
  const variants=dni?[doc,doc.replace(/\B(?=(\d{3})+(?!\d))/g,'.')]:[doc,fmt(doc),`AR${doc}`];
  const partners = await kw(
    "res.partner",
    "search_read",
    [
      [
        ["parent_id", "=", false],
        "|",
        ["email", "=ilike", d.email],
        "&",
        ["l10n_latam_identification_type_id", "in", dni?[5]:[4,6]],
        ["vat", "in", variants],
      ],
    ],
    {
      fields: [
        "id",
        "name",
        "vat",
        "email",
        "phone",
        "active",
        "user_id",
        "property_product_pricelist",
        "company_id",
        "street", "city", "state_id", "write_date", "x_studio_nombre_fantasia",
        "l10n_latam_identification_type_id", "l10n_ar_afip_responsibility_type_id",
      ],
      context: { active_test: false },
      limit: 30,
    },
  );
  partners.forEach((p:any)=>p.documento_coincide=digits(p.vat)===doc&&p.l10n_latam_identification_type_id?.[0]===(DOCUMENTS[d.documento_tipo||'CUIT']));
  const ids = partners.map((p: any) => p.id);
  const userDomain = ids.length
    ? [
        "|",
        ["login", "=ilike", d.email],
        ["partner_id.commercial_partner_id", "in", ids],
      ]
    : [["login", "=ilike", d.email]];
  const users = await kw("res.users", "search_read", [userDomain], {
    fields: ["id", "name", "login", "partner_id", "active", "share"],
    context: { active_test: false },
    limit: 50,
  });
  const globalLogin=await lookupLogin(d.email);
  const uniqueUsers=new Map([...users,...globalLogin].map((u:any)=>[u.id,u]));
  return { fichas: partners, usuarios: Array.from(uniqueUsers.values()) };
}
async function analyze(d: any) {
  const odoo = await look(d);
  let arca: any;
  try {
    arca = d.condicion_iva==='CF'
      ? {ok:true,no_aplica:true,iva:'CF',error:'Consumidor final: verificar identidad y documento. No requiere constancia de inscripción.'}
      : await consultarArca(d.documento||d.cuit);
  } catch {
    arca = {
      ok: false,
      error:
        "ARCA no pudo verificarse. Adjuntá una constancia y revisala antes de aprobar.",
    };
  }
  const alertas: string[] = [];
  if (odoo.fichas.length > 1)
    alertas.push(
      "Hay varias fichas con ese documento. Resolver duplicados antes de aprobar.",
    );
  if (odoo.fichas.some((x: any) => !x.active))
    alertas.push("Hay una ficha archivada. Revisar en Odoo.");
  if (odoo.usuarios.some((x: any) => !x.share))
    alertas.push(
      "Coincidencia con usuario interno: no habilitar desde este circuito.",
    );
  if (odoo.fichas.length)
    alertas.push(
      "Cliente existente: verificar identidad y titularidad del correo antes de dar acceso.",
    );
  if (
    !arca.no_aplica && (!arca.ok ||
    !arca.existe ||
    arca.sin_constancia ||
    arca.estado !== "ACTIVO")
  )
    alertas.push("Identidad fiscal pendiente de revisión manual.");
  if(!arca.no_aplica && arca.iva && d.condicion_iva && arca.iva!==d.condicion_iva)
    alertas.push('La condición declarada no coincide con ARCA. Revisala antes de aprobar.');
  return {
    consultada: new Date().toISOString(),
    odoo,
    arca,
    alertas,
    semaforo: alertas.length ? "revisar" : "coincidente",
    decision: "Requiere aprobación humana",
  };
}
async function review(a: any, actor: string) {
  if (!["recibida", "revisar"].includes(a.estado))
    throw new Failure("Esta solicitud no admite reanálisis.", 409);
  const an = await analyze(a.datos);
  const changed = await db(
    `portal_altas?id=eq.${enc(a.id)}&version=eq.${a.version}&estado=in.(recibida,revisar)`,
    "PATCH",
    {
      analisis: an,
      estado: "revisar",
      actualizada: new Date().toISOString(),
      version: a.version + 1,
    },
  );
  if (!changed.length)
    throw new Failure("La solicitud cambió. Actualizá la bandeja.", 409);
  await event(a.id, actor, "analizada");
  return changed[0];
}
async function plan(a: any, b: any) {
  if (!["recibida", "revisar", "error_aprobacion"].includes(a.estado))
    throw new Failure("La solicitud ya fue resuelta o está en proceso.", 409);
  const opts = {
    lista_id: Number(b.lista_id),
    comercial_id: Number(b.comercial_id),
    identidad_verificada: b.identidad_verificada === true,
    fiscal_verificado: b.fiscal_verificado === true,
    reemplazar: b.reemplazar === true,
    revision: String(b.revision || "").trim(),
    responsabilidad_id: Number(b.responsabilidad_id || 0),
    ...(b.datos_actualizar!==undefined||b.actualizar_condiciones!==undefined?{datos_actualizar:chosenFields(b.datos_actualizar),revision_cliente:String(b.revision_cliente||''),actualizar_condiciones:b.actualizar_condiciones===true,documento_revisado:b.documento_revisado===true}:{}),
  };
  if (
    !opts.identidad_verificada ||
    !opts.fiscal_verificado ||
    opts.revision.length < 8 ||
    opts.revision.length > 1500
  )
    throw new Failure("Registrá la revisión de identidad y situación fiscal.");
  if (a.aprobacion && !sameApproval(a.aprobacion, opts))
    throw new Failure(
      "Hay una aprobación parcial. Reintentá con las mismas condiciones.",
      409,
    );
  const op = await options();
  if (
    !op.listas.some((x: any) => x.id === opts.lista_id) ||
    !op.comerciales.some((x: any) => x.id === opts.comercial_id)
  )
    throw new Failure("Lista o comercial no permitido.");
  const o = await look(a.datos);
  if(b.via_simple===true){const summary=simpleApprovalSummary({...a,analisis:{...a.analisis,odoo:o}});if(!summary.available||b.actualizar_condiciones===true)throw new Failure('La solicitud requiere revisión: '+(summary.reason||'cambiaron las condiciones.'),409);}
  if (o.fichas.length > 1 || o.fichas.some((p: any) => !p.active))
    throw new Failure(
      "Resolvé las fichas duplicadas o archivadas en Odoo antes de aprobar.",
    );
  const partner = o.fichas[0];
  if(partner&&!partner.documento_coincide&&b.documento_revisado!==true)throw new Failure('El documento declarado no coincide con la ficha existente. Verificá que se trate de la misma persona antes de vincular el acceso.');
  const consumer=a.datos.condicion_iva==='CF';
  if(consumer && opts.responsabilidad_id!==5)throw new Failure('Confirmá Consumidor final en la condición IVA.');
  if(!consumer && opts.responsabilidad_id===5)throw new Failure('La solicitud no fue declarada como consumidor final. Revisá la identidad fiscal.');
  if(!consumer && opts.responsabilidad_id && ![1,4,6].includes(opts.responsabilidad_id))throw new Failure('Condición IVA no permitida.');
  const fiscal=a.analisis?.arca;
  if(!consumer && opts.responsabilidad_id && fiscal?.iva && FISCAL[fiscal.iva]!==opts.responsabilidad_id && !a.archivos.length)
    throw new Failure('La condición elegida difiere de ARCA. Adjuntá la constancia y registrá la revisión.');
  if (
    !consumer && !partner &&
    !a.resultado?.partner_id &&
    (!a.analisis?.arca?.ok || !a.analisis?.arca?.existe || a.analisis?.arca?.sin_constancia || a.analisis?.arca?.estado !== 'ACTIVO' ||
      !["RI", "MONO", "EXENTO"].includes(a.analisis?.arca?.iva)) &&
    (!a.archivos.length || ![1, 4, 6].includes(opts.responsabilidad_id))
  )
    throw new Failure(
      "Adjuntá y verificá una constancia fiscal vigente, y elegí la condición IVA. ARCA no pudo verificarse automáticamente.",
    );
  if (partner?.company_id && partner.company_id[0] !== COMPANY)
    throw new Failure("La ficha pertenece a otra empresa.");
  if (o.usuarios.some((u: any) => !u.share))
    throw new Failure(
      "Hay un usuario interno vinculado. Se requiere revisión en Odoo.",
    );
  const own = o.usuarios.filter((u: any) => u.partner_id[0] === partner?.id);
  const target = o.usuarios.find((u: any) => u.login.toLowerCase() === a.email);
  if (target && target.partner_id[0] !== partner?.id)
    throw new Failure("El correo ya pertenece a otra ficha.");
  const others = own.filter(
    (u: any) => u.active && u.login.toLowerCase() !== a.email,
  );
  if (o.usuarios.some((u: any) => u.partner_id[0] !== partner?.id))
    throw new Failure(
      "Hay accesos vinculados a contactos dependientes: revisar en Odoo.",
    );
  if (others.length && !opts.reemplazar)
    throw new Failure(
      "Ya existe acceso con otro correo. Confirmá explícitamente su reemplazo.",
    );
  const state = op.provincias.find(
    (s: any) =>
      s.name.toLocaleLowerCase() === a.datos.provincia.toLocaleLowerCase(),
  );
  if (!state)
    throw new Failure("La provincia no coincide con las opciones de Odoo.");
  const passwordAvailable=!!(await readPassword(a));
  const changes=partner?contactChanges(partner,a.datos,state.id):[];
  const contactUpdate=partner?contactPlan(partner,a.datos,state.id,b.datos_actualizar,String(b.revision_cliente||''),a.resultado?.cambios_cliente):null;
  return {
    cambios_cliente:contactUpdate,
    clave_disponible: passwordAvailable,
    opciones: opts,
    partner,
    usuario: target,
    anteriores: others,
    state_id: state.id,
    pasos: [
      partner
        ? `Vincular ficha ${partner.id}: ${partner.name}`
        : "Crear ficha de cliente en Odoo",
      ...(partner&&!b.actualizar_condiciones?['Conservar la lista de precios y el responsable comercial actuales']:[`Asignar ${op.listas.find((x: any) => x.id === opts.lista_id).name}`,`Responsable: ${op.comerciales.find((x: any) => x.id === opts.comercial_id).name}`]),
      ...(partner?[...(changes.filter((x:any)=>Object.hasOwn(contactUpdate?.values||{},x.field)).map((x:any)=>`${x.label}: ${x.current_label||'sin dato'} → ${x.proposed_label}`)), 'Conservar los demás datos, documento y condición fiscal del cliente']:[]),
      others.length
        ? "Revocar accesos anteriores confirmados"
        : "Conservar accesos ajenos sin cambios",
      passwordAvailable || a.resultado?.clave_aplicada
        ? (target?.active
          ? "Actualizar el acceso existente con la contraseña elegida en esta solicitud y avisar por correo"
          : "Habilitar acceso con la contraseña elegida y avisar por correo")
        : target?.active
          ? "Conservar acceso existente: no hay una contraseña pendiente vigente"
          : "Habilitar acceso y enviar enlace para crear contraseña (solicitud anterior o contraseña pendiente vencida)",
      "Guardar resolución y revisión en Core",
    ],
  };
}
async function approve(a: any, b: any, actor: string) {
  if (a.estado === "aprobada") return { solicitud: a, ya_resuelta: true };
  const p = await plan(a, b);
  if (b.ensayo === true) return { ensayo: true, plan: p };
  const locked = await db(
    `portal_altas?id=eq.${enc(a.id)}&version=eq.${a.version}&estado=in.(recibida,revisar,error_aprobacion)`,
    "PATCH",
    {
      estado: "aprobando",
      aprobacion: p.opciones,
      resuelta_por: actor,
      version: a.version + 1,
      actualizada: new Date().toISOString(),
    },
  );
  if (!locked.length)
    throw new Failure(
      "Otra persona está resolviendo esta solicitud. Actualizá.",
      409,
    );
  let r = { ...a.resultado };
  const save = async () => {
    await patch(a.id, { resultado: r });
  };
  try {
    await event(a.id, actor, "aprobacion_iniciada", { opciones: p.opciones });
    let pid = p.partner?.id || r.partner_id;
    // Ref determinista: recupera una creación cuyo resultado se perdió por red.
    if (!pid) {
      const found = await kw(
        "res.partner",
        "search_read",
        [[["ref", "=", `ROSAINT-ALTA-${a.id}`]]],
        { fields: ["id", "vat"], limit: 2 },
      );
      if (found.length > 1)
        throw new Failure("Revisar duplicados de la operación.");
      pid = found[0]?.id;
    }
    if (!pid) {
      const fiscal = a.analisis?.arca;
      const resp = a.datos.condicion_iva==='CF' ? 5 :
        [1,4,6].includes(p.opciones.responsabilidad_id) && a.archivos.length ? p.opciones.responsabilidad_id :
        fiscal?.iva === "RI"
          ? 1
          : fiscal?.iva === "MONO"
            ? 6
            : fiscal?.iva === "EXENTO"
              ? 4
              : [1, 4, 6].includes(p.opciones.responsabilidad_id) &&
                  a.archivos.length
                ? p.opciones.responsabilidad_id
                : false;
      if (!resp)
        throw new Failure(
          "Completá la consulta ARCA antes de crear una ficha fiscal nueva.",
        );
      pid = await kw("res.partner", "create", [
        {
          name: a.datos.razon,
          x_studio_nombre_fantasia: a.datos.cartel || false,
          ref: `ROSAINT-ALTA-${a.id}`,
          vat: a.datos.documento_tipo==='DNI' ? a.cuit : fmt(a.cuit),
          company_type: a.datos.documento_tipo!=='DNI' && a.cuit.startsWith("3") ? "company" : "person",
          company_id: false,
          country_id: 10,
          state_id: p.state_id,
          street: a.datos.calle,
          city: a.datos.localidad,
          phone: a.datos.telefono,
          email: a.email,
          l10n_latam_identification_type_id: DOCUMENTS[a.datos.documento_tipo||'CUIT'],
          l10n_ar_afip_responsibility_type_id: resp,
          customer_rank: 1,
          property_product_pricelist: p.opciones.lista_id,
          user_id: p.opciones.comercial_id,
        },
      ]);
    }
    r.partner_id = pid;
    await save();
    if(!p.partner || b.actualizar_condiciones===true)await kw("res.partner", "write", [
      [pid],
      {
        property_product_pricelist: p.opciones.lista_id,
        user_id: p.opciones.comercial_id,
      },
    ]);
    if(p.partner&&p.cambios_cliente&&Object.keys(p.cambios_cliente.values).length){
      if(!r.cambios_cliente){r.cambios_cliente=p.cambios_cliente;await save();}
      const [current]=await kw('res.partner','read',[[pid]],{fields:['name','x_studio_nombre_fantasia','email','phone','street','city','state_id','write_date']});
      const update=contactPlan(current,a.datos,p.state_id,b.datos_actualizar,String(b.revision_cliente||''),r.cambios_cliente);
      if(!update.already_applied)await kw('res.partner','write',[[pid],update.values]);
      r.datos_actualizados=true;await save();
    }
    // Copia de los documentos revisados al legajo del cliente, con referencia idempotente.
    for (const file of a.archivos) {
      const marker = `ROSAINT-ALTA:${a.id}:${file.path}`;
      const found = await kw(
        "ir.attachment",
        "search_read",
        [
          [
            ["res_model", "=", "res.partner"],
            ["res_id", "=", pid],
            ["description", "=", marker],
          ],
        ],
        { fields: ["id"], limit: 1 },
      );
      if (!found.length) {
        const response = await storage(
          "object/portal-altas/" + file.path,
          "GET",
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await kw("ir.attachment", "create", [
          {
            name: file.nombre,
            res_model: "res.partner",
            res_id: pid,
            type: "binary",
            datas: btoa(binary),
            mimetype: file.tipo,
            description: marker,
            public: false,
          },
        ]);
      }
    }
    if (!r.nota) {
      await kw("res.partner", "message_post", [[pid]], {
        body: `Solicitud de portal Rosaint ${esc(a.id)}. Aprobada por ${esc(actor)}. Actividad: ${esc(TYPES[a.datos.tipo])}. Revisión: ${esc(p.opciones.revision)}`,
        message_type: "comment",
        subtype_xmlid: "mail.mt_note",
      });
      r.nota = true;
      await save();
    }
    let u = p.usuario;
    if (!u) {
      const found = await kw(
        "res.users",
        "search_read",
        [[["login", "=ilike", a.email]]],
        {
          fields: ["id", "partner_id", "share", "active"],
          context: { active_test: false },
          limit: 2,
        },
      );
      u = found[0];
    }
    if (u && (!u.share || u.partner_id[0] !== pid))
      throw new Failure("El correo cambió de titular durante la aprobación.");
    // The approved application's chosen password also replaces an existing
    // portal user's password, after the identity/ownership checks above.
    const chosenPassword=!r.clave_aplicada ? await readPassword(a) : null;
    if (!u) {
      const id = await kw(
        "res.users",
        "create",
        [
          {
            ...(!p.partner?{name:a.datos.razon,email:a.email}:{}),
            login: a.email,
            partner_id: pid,
            groups_id: [[6, 0, [10]]],
            company_id: COMPANY,
            company_ids: [[6, 0, [COMPANY]]],
            // Odoo propagates this flag to the linked partner during create.
            active: true,
            ...(chosenPassword?{password:chosenPassword}:{}),
          },
        ],
        {
          context: {
            no_reset_password: true,
            mail_create_nosubscribe: true,
            mail_notrack: true,
          },
        },
      ).catch((e) => { throw new Failure(accessCreationError(e)); });
      u = { id, active: true, share: true, partner_id: [pid] };
      r.acceso_activado=true;
      if(chosenPassword)r.clave_aplicada=true;
    } else if(chosenPassword) {
      try { await kw('res.users','write',[[u.id],{password:chosenPassword}],{context:{no_reset_password:true}}); }
      catch {throw new Failure('No se pudo aplicar la contraseña elegida. Reintentá desde la aprobación incompleta.');}
      r.clave_aplicada=true;
    }
    r.user_id = u.id;
    await save();
    if (p.anteriores.length) {
      await kw("res.users", "write", [
        p.anteriores.map((x: any) => x.id),
        { active: false },
      ]);
      r.revocados = p.anteriores.map((x: any) => ({
        id: x.id,
        login: x.login,
      }));
      await save();
    }
    if (!u.active) {
      await kw("res.users", "write", [[u.id], { active: true }]);
      r.acceso_activado = true;
      await save();
    }
    // Marcar antes del envío: ante respuesta incierta no se duplica una invitación automáticamente.
    if(r.clave_aplicada && !r.aviso_acceso) {
      const messageId=`<rosaint-alta-aprobada-${a.id}@rosaint.com.ar>`;
      const existing=await kw('mail.mail','search_read',[[['message_id','=',messageId]]],{fields:['id'],limit:1});
      if(!existing.length)await kw('mail.mail','create',[{subject:'Rosaint · Ya podés ingresar al portal profesional',email_to:a.email,email_from:'contacto@rosaint.com.ar',message_id:messageId,auto_delete:false,state:'outgoing',
        body_html:`<div style="font-family:'Source Sans 3',sans-serif;color:#34495e;line-height:1.5"><h2 style="font-family:Sora,sans-serif;font-weight:400">Tu acceso está habilitado</h2><p>Hola ${esc(a.datos.razon)}. Ya podés ingresar con tu correo y la contraseña que elegiste al solicitar el alta.</p><p><a href="${esc(OD)}/web/login">Ingresar al portal profesional</a></p><p>Si no la recordás, usá «Restablecer contraseña» en la pantalla de ingreso.</p><p>Rosaint · Cosmética profesional</p></div>`}]);
      r.aviso_acceso='en_cola'; r.invitacion='no_requiere'; await save();
    }
    if (!r.clave_aplicada && !r.invitacion && (!p.usuario?.active || r.acceso_activado)) {
      r.invitacion = "en_proceso";
      await save();
      await kw("res.users", "action_reset_password", [[u.id]], {
        context: { create_user: true },
      });
      r.invitacion = "enviada";
      await save();
    }
    if (!r.aviso_comercial) {
      const commercial = (
        await kw("res.users", "read", [[p.opciones.comercial_id]], {
          fields: ["partner_id"],
        })
      )[0];
      // Nota interna, sólo al responsable comercial, sin publicar en el portal del cliente.
      const marker = `[ROSAINT-ALTA-${a.id}]`;
      const notes = await kw(
        "mail.message",
        "search_read",
        [
          [
            ["model", "=", "res.partner"],
            ["res_id", "=", pid],
            ["body", "ilike", marker],
          ],
        ],
        { fields: ["id"], limit: 1 },
      );
      if (!notes.length)
        await kw("res.partner", "message_post", [[pid]], {
          body: `${marker} Acceso profesional aprobado. Lista: ${p.opciones.lista_id}. Aprobador: ${esc(actor)}.`,
          message_type: "notification",
          subtype_xmlid: "mail.mt_note",
          partner_ids: [commercial.partner_id[0]],
        });
      r.aviso_comercial = "registrado";
      await save();
    }
    for (const previous of r.revocados || []) {
      const messageId = `<rosaint-alta-${a.id}-${previous.id}@rosaint.com.ar>`;
      const exists = await kw(
        "mail.mail",
        "search_read",
        [[["message_id", "=", messageId]]],
        { fields: ["id"], limit: 1 },
      );
      if (!exists.length)
        await kw("mail.mail", "create", [
          {
            subject: "Rosaint · Actualización del acceso profesional",
            email_to: previous.login,
            email_from: "contacto@rosaint.com.ar",
            body_html:
              "<p>El acceso a tu cuenta profesional de Rosaint con este correo fue revocado tras una revisión de titularidad.</p><p>Si no reconocés este cambio, contactanos en contacto@rosaint.com.ar o al WhatsApp 341 6644887.</p>",
            message_id: messageId,
            auto_delete: false,
            state: "outgoing",
          },
        ]);
    }
    const result = await patch(a.id, {
      estado: "aprobada",
      resultado: r,
      resuelta_por: actor,
    });
    await event(a.id, actor, "aprobada", { partner_id: pid, user_id: u.id });
    return { solicitud: result[0] };
  } catch (e) {
    await patch(a.id, { estado: "error_aprobacion", resultado: r });
    await event(a.id, actor, "error_aprobacion", {
      mensaje: String(e.message).slice(0, 500),
    });
    throw new Failure(
      "La aprobación quedó incompleta. Revisá su estado antes de reintentar. " +
        String(e.message).slice(0, 220),
      409,
    );
  }
}
async function storage(
  path: string,
  method: string,
  body?: BodyInit,
  headers = {},
) {
  const r = await fetch(SB + "/storage/v1/" + path, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: "Bearer " + SERVICE,
      ...headers,
    },
    body,
  });
  if (!r.ok) throw new Failure("No se pudo acceder al documento.", 503);
  return r;
}
async function handle(req: Request, b: any) {
  if (b.accion === "config")
    return {
      tipos: TYPES,
      portal: OD,
      modo: "revision_humana",
      contrasena: "elegida_en_alta_activada_tras_aprobar",
      documentos: ['CUIT','DNI','CUIL'], condiciones_iva: Object.keys(FISCAL),
    };
  if (b.accion === "enviar") {
    if (b.web) return { recibida: true };
    if (b.acepto !== true)
      throw new Failure("Aceptá el uso de tus datos para gestionar el alta.");
    const d = validate(b.datos);
    if(!d.condicion_iva)throw new Failure('Elegí tu condición frente al IVA.');
    if(!validPassword(b.clave,d.email))throw new Failure('La contraseña debe tener entre 8 y 64 caracteres, con letras y números.');
    const cifrada=await encrypt(b.clave,passwordContext(d));
    // HMAC del origen: no se conservan IPs en claro.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SERVICE),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "desconocido";
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(ip),
    );
    const hash = Array.from(new Uint8Array(sig))
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const received = await db("rpc/portal_alta_recibir_v2", "POST", {
      p_datos: d,
      p_ip_hash: hash,
      p_cifrada: cifrada,
    });
    if (!received)
      throw new Failure(
        "Se alcanzó el límite de solicitudes. Intentá más tarde o contactanos por WhatsApp.",
        429,
      );
    // Misma respuesta con solicitud repetida o límite: no revela la existencia de clientes.
    return { recibida: true };
  }
  const actor = await admin(req);
  if (b.accion === "instalar") return install();
  if (b.accion === "diagnostico") return diagnostic();
  if (b.accion === "diagnostico_arca") return diagnosticoArca();
  if (b.accion === "instalar_arca") return installArcaSigner();
  if (b.accion === "diagnostico_configuracion") return configDiagnostic();
  if (b.accion === "listar")
    return {
      solicitudes: await db("portal_altas?order=creada.desc&limit=200"),
      opciones: await options(),
      actor,
    };
  if (b.accion === "probar")
    return { ensayo: true, analisis: await analyze(validate(b.datos)) };
  const a = await row(b.id);
  if (b.accion === "detalle")
    return {
      solicitud: a,
      resumen: simpleApprovalSummary(a),
      eventos: await db(
        "portal_altas_eventos?alta_id=eq." + enc(a.id) + "&order=creada.asc",
      ),
    };
  if (b.accion === "reanalizar") return { solicitud: await review(a, actor) };
  if(b.accion==='revisar_odoo'){
    if(!['recibida','revisar'].includes(a.estado))throw new Failure('La solicitud no admite una nueva revisión.',409);
    const odoo=await look(a.datos);
    const alertas=['Revisión de Odoo: verificar identidad y datos declarados antes de aprobar.'];
    if(odoo.fichas.length)alertas.push('Cliente existente: los datos y las condiciones actuales se conservan salvo selección explícita.');
    if(odoo.fichas.length>1)alertas.push('Hay varias coincidencias. Resolverlas en Odoo antes de aprobar.');
    const changed=await db(`portal_altas?id=eq.${enc(a.id)}&version=eq.${a.version}&estado=in.(recibida,revisar)`,'PATCH',{analisis:{...a.analisis,odoo,alertas,consultada:new Date().toISOString()},estado:'revisar',actualizada:new Date().toISOString(),version:a.version+1});
    if(!changed.length)throw new Failure('La solicitud cambió. Actualizá la bandeja.',409);
    await event(a.id,actor,'odoo_revisado');return {solicitud:changed[0]};
  }
  if (b.accion === "aprobar") return approve(a, b, actor);
  if (b.accion === "rechazar") {
    if (!["recibida", "revisar"].includes(a.estado))
      throw new Failure("No se puede rechazar una aprobación iniciada.", 409);
    const motivo = String(b.motivo || "").trim();
    if (motivo.length < 8 || motivo.length > 1500)
      throw new Failure("Escribí el motivo del rechazo.");
    const changed = await db(
      `portal_altas?id=eq.${enc(a.id)}&version=eq.${a.version}&estado=in.(recibida,revisar)`,
      "PATCH",
      {
        estado: "rechazada",
        motivo,
        resuelta_por: actor,
        version: a.version + 1,
        actualizada: new Date().toISOString(),
      },
    );
    if (!changed.length) throw new Failure("La solicitud cambió.", 409);
    await event(a.id, actor, "rechazada", { motivo });
    return { solicitud: changed[0] };
  }
  if (b.accion === "archivo") {
    if (!a.archivos.some((f: any) => f.path === b.path))
      throw new Failure("Documento no encontrado.", 404);
    const r = await storage(
      "object/sign/portal-altas/" + b.path,
      "POST",
      JSON.stringify({ expiresIn: 600 }),
      { "Content-Type": "application/json" },
    );
    const j = await r.json();
    return { url: SB + "/storage/v1" + j.signedURL };
  }
  if (b.accion === "subir") {
    if (!["recibida", "revisar"].includes(a.estado))
      throw new Failure("La solicitud no admite cambios.", 409);
    if (a.archivos.length >= 8) throw new Failure("Máximo 8 documentos.");
    const f = b.archivo;
    const mime = String(f?.tipo || "");
    if (!["application/pdf", "image/jpeg", "image/png"].includes(mime))
      throw new Failure("Usá PDF, JPG o PNG.");
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    } catch {
      throw new Failure("Archivo inválido.");
    }
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      throw new Failure("Máximo 5 MB por archivo.");
    const sig = Array.from(bytes.slice(0, 8));
    if (
      (mime === "application/pdf" &&
        new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") ||
      (mime === "image/jpeg" &&
        !(sig[0] === 255 && sig[1] === 216 && sig[2] === 255)) ||
      (mime === "image/png" && sig.join(",") !== "137,80,78,71,13,10,26,10")
    )
      throw new Failure("El contenido no coincide con el formato.");
    const path =
      a.id +
      "/" +
      crypto.randomUUID() +
      { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" }[
        mime
      ];
    await storage("object/portal-altas/" + path, "POST", bytes, {
      "Content-Type": mime,
    });
    const archivos = [
      ...a.archivos,
      {
        path,
        nombre: String(f.nombre || "Documento").slice(0, 180),
        tipo: mime,
      },
    ];
    const changed = await db(
      `portal_altas?id=eq.${enc(a.id)}&version=eq.${a.version}&estado=in.(recibida,revisar)`,
      "PATCH",
      {
        archivos,
        version: a.version + 1,
        actualizada: new Date().toISOString(),
      },
    );
    if (!changed.length) {
      await storage(
        "object/portal-altas",
        "DELETE",
        JSON.stringify({ prefixes: [path] }),
        { "Content-Type": "application/json" },
      );
      throw new Failure(
        "La solicitud cambió. Volvé a subir el documento.",
        409,
      );
    }
    await event(a.id, actor, "documento_agregado", {
      nombre: String(f.nombre).slice(0, 180),
    });
    return { solicitud: changed[0] };
  }
  throw new Failure("Acción desconocida.");
}
export async function handler(req: Request) {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (origin && ORIGINS.includes(origin))
    headers["Access-Control-Allow-Origin"] = origin;
  if (origin && !ORIGINS.includes(origin))
    return new Response(
      JSON.stringify({ ok: false, error: "Origen no autorizado" }),
      { status: 403, headers },
    );
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "POST")
    return new Response(
      JSON.stringify({ ok: false, error: "Método no permitido" }),
      { status: 405, headers },
    );
  try {
    if (Number(req.headers.get("content-length")) > 7.2e6)
      throw new Failure("Solicitud demasiado grande.", 413);
    const text = await req.text();
    if (text.length > 7.2e6)
      throw new Failure("Solicitud demasiado grande.", 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Failure("Solicitud inválida.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Failure("Solicitud inválida.");
    const result = await handle(req, body);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers });
  } catch (e) {
    const auth = ["AUTH", "FORBIDDEN"].includes(e.message);
    const status = auth ? 403 : e instanceof Failure ? e.status : 503;
    return new Response(
      JSON.stringify({
        ok: false,
        error: auth
          ? "Iniciá sesión con una cuenta autorizada."
          : e instanceof Failure
            ? e.message
            : "No se pudo completar la operación. Consultá el estado en Core.",
      }),
      { status, headers },
    );
  }
}
if (typeof Deno.serve === "function") Deno.serve(handler);

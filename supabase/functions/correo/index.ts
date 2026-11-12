import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding@1/base64";
import * as Facturas from "./facturas.ts";

// ====== correo — conector COMPLETO de la casilla de Rosaint (leer, ordenar, borrar, carpetas, enviar) ======
// Ferozo bloquea las conexiones IMAP que salen de Supabase (corta apenas abre el TLS), así que el trabajo
// con la casilla lo hace `correo-puente.php`, alojado en el hosting de Rosaint (mismo servidor que el correo).
// Esta función: 1) controla quién entra, 2) le agrega la casilla y la contraseña (secretos de acá),
// 3) guarda los adjuntos en Storage y 4) anota en `correo_registro` todo lo que cambia algo.
//
// Secretos: MAIL_IMAP_USER · MAIL_IMAP_PASSWORD · CORREO_PUENTE_TOKEN · CORREO_PUENTE_URL (opcional)
// Pedido: POST { accion, ...datos } — mismas acciones que el puente:
//   estado · carpetas{conteos?} · buscar{carpeta,desde,hasta,de,para,asunto,texto,sin_leer,destacados,desde_uid,limite,pagina}
//   leer{carpeta,uid,marcar_leido?} · adjunto{carpeta,uid,parte,en_linea?} → enlace de 1 h (o base64 si en_linea)
//   marcar{carpeta,uids,leido?,destacado?,respondido?} · mover/copiar{carpeta,uids,destino}
//   borrar{carpeta,uids,definitivo?} (sin definitivo va a la Papelera)
//   crear_carpeta{nombre,padre?} · renombrar_carpeta{carpeta,nuevo} · borrar_carpeta{carpeta,forzar?}
//   enviar / guardar_borrador{para,cc,cco,asunto,texto,html,adjuntos:[{nombre,tipo,base64}|{ruta}],responder?,reenviar?}
//     (adjuntos con "ruta" = archivo ya subido al bucket correo-adjuntos)
//   facturas{dias?} · factura_descartar{id,descartada} · factura_pagada{id,pagada} · facturas_odoo{ids?}
//   facturas_registrar{items:[{carpeta,correo}]} · facturas_releer{ids}
//     (tarjeta «Facturas»: ver facturas.ts; el cron de las reglas también las detecta y las cruza con Odoo)
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const BUCKET = "correo-adjuntos";
const PUENTE = Deno.env.get("CORREO_PUENTE_URL") || "https://rosaint.online/correo-puente.php";
// Solo estas cuentas del Core pueden usar el correo (el registro de usuarios de Supabase está abierto).
const PERMITIDOS = new Map([
  ["8a55f15a-184e-430b-9d2d-9067c1dbbd8a", "contacto@rosaint.com.ar"],
  ["c0e45351-4a9f-43ec-8197-784672a00653", "rosaint.ar@gmail.com"],
]);
const SOLO_LECTURA = new Set(["estado", "carpetas", "buscar", "leer", "adjunto", "remitentes", "reglas", "lista_blanca", "facturas"]);
type Rec = Record<string, unknown>;

// devuelve quién llama (o null si no puede)
async function quien(req: Request): Promise<string | null> {
  const interna = Deno.env.get("CONTROL_CRON_KEY") || "";
  if (interna && req.headers.get("x-cron-key") === interna) return "sistema (clave interna)";
  const a = req.headers.get("Authorization") || "";
  if (!a.startsWith("Bearer ")) return null;
  if (SRK && a.slice(7) === SRK) return "sistema (service role)";
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: req.headers.get("apikey") || PUB, Authorization: a } });
    if (!r.ok) return null;
    const u = await r.json();
    return PERMITIDOS.get(String(u?.id || "")) || null;
  } catch { return null; }
}

const sbHeaders = (extra: Rec = {}) => ({ Authorization: `Bearer ${SRK}`, apikey: SRK, ...extra }) as Record<string, string>;

async function registrar(fila: Rec) {
  try {
    await fetch(`${SB_URL}/rest/v1/correo_registro`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(fila) });
  } catch { /* el registro no frena la acción */ }
}

async function bajarDeStorage(ruta: string): Promise<Uint8Array> {
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(ruta)}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`No se encontró el archivo a adjuntar: ${ruta}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function guardarAdjunto(carpeta: string, uid: number, nombre: string, tipo: string, datos: Uint8Array) {
  const seguro = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\\/:*?"<>|]+/g, "_").replace(/[^\x20-\x7e]/g, "_");   // Storage no admite tildes
  const ruta = `${carpeta.replace(/[^A-Za-z0-9._-]+/g, "_")}/${uid}/${seguro}`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: sbHeaders({ "Content-Type": tipo || "application/octet-stream", "x-upsert": "true" }), body: datos });
  if (!up.ok) throw new Error("No se pudo guardar el adjunto: " + (await up.text()).slice(0, 200));
  const sg = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(ruta)}`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: 3600 }) });
  const sj = await sg.json();
  return { ruta, enlace: sj.signedURL ? `${SB_URL}/storage/v1${encodeURI(decodeURI(sj.signedURL))}` : null };
}

Deno.serve(async (req: Request) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Content-Type": "application/json" };
  const responder = (o: Rec, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const usuario = await quien(req);
  if (!usuario) return responder({ ok: false, error: "No autorizado" }, 401);

  let body: Rec = {};
  try { body = await req.json(); } catch { return responder({ ok: false, error: "JSON inválido" }, 400); }
  delete body.cred;   // la casilla y la contraseña las pone esta función, nunca quien llama
  const accion = String(body.accion || body.modo || "");
  if (!accion) return responder({ ok: false, error: "Falta la acción" }, 400);
  body.accion = accion;

  const casilla = (Deno.env.get("MAIL_IMAP_USER") || "").trim();
  const clave = (Deno.env.get("MAIL_IMAP_PASSWORD") || "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const token = Deno.env.get("CORREO_PUENTE_TOKEN") || "";
  if (!casilla || !clave) return responder({ ok: false, error: "Falta configurar la casilla (secretos MAIL_IMAP_USER y MAIL_IMAP_PASSWORD)" });
  if (!token) return responder({ ok: false, error: "Falta el secreto CORREO_PUENTE_TOKEN" });

  try {
    // ---- reglas para ordenar (las elige la persona en Correo → Ordenar; viven en correo_reglas)
    const db = (ruta: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${ruta}`, { ...init, headers: sbHeaders({ "Content-Type": "application/json", ...(init.headers as Record<string, string> || {}) }) });
    // el puente del hosting (todo lo que toca la casilla pasa por acá)
    const puente = async (b: Rec): Promise<Rec> => {
      const rp = await fetch(PUENTE, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Puente-Token": token, "User-Agent": "rosaint-core-correo/1" },
        body: JSON.stringify({ ...b, cred: { usuario: casilla, clave } }),
        signal: AbortSignal.timeout(140000),
      });
      const t = await rp.text();
      try { return JSON.parse(t); }
      catch { return { ok: false, error: `El puente del hosting no respondió bien (HTTP ${rp.status})`, detalle: t.replace(clave, "***").slice(0, 300) }; }
    };

    // ---- facturas recibidas (tarjeta «Facturas» de la pantalla Correo)
    if (accion === "facturas") return responder(await Facturas.listar(db, Number(body.dias) || 90));
    if (accion === "factura_descartar") {
      const id = Number(body.id); if (!id) return responder({ ok: false, error: "Falta id" });
      const r = await db(`correo_facturas?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ descartada: body.descartada !== false }) });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, asunto: j[0]?.asunto ?? null, detalle: { id, descartada: body.descartada !== false } });
      return responder({ ok: r.ok, factura: j[0] });
    }
    if (accion === "factura_pagada") {
      // para las que no están en Odoo (o RST): se marca a mano. pagada:false vuelve a dejarla en manos de Odoo
      const id = Number(body.id); if (!id) return responder({ ok: false, error: "Falta id" });
      const si = body.pagada !== false;
      const r = await db(`correo_facturas?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify(si ? { pagada: true, pago_origen: "manual" } : { pagada: null, pago_origen: null }) });
      const j = await r.json();
      if (!si) await Facturas.cruzarOdoo(db, [id]);
      await registrar({ usuario, accion, ok: r.ok, asunto: j[0]?.asunto ?? null, detalle: { id, pagada: si } });
      return responder({ ok: r.ok, factura: j[0] });
    }
    if (accion === "facturas_releer") {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(Number).filter(Boolean) : [];
      if (!ids.length) return responder({ ok: false, error: "Faltan ids" });
      const res = await Facturas.releer(puente, db, ids.slice(0, 25));
      const odoo = await Facturas.cruzarOdoo(db, ids.slice(0, 25));
      return responder({ ok: true, resultados: res, odoo });
    }
    if (accion === "facturas_odoo") {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(Number).filter(Boolean) : undefined;
      return responder({ ok: true, ...(await Facturas.cruzarOdoo(db, ids)) });
    }
    if (accion === "facturas_registrar") {
      const res: Rec[] = [];
      for (const it of (body.items as Rec[]) || []) {
        try { res.push({ uid: (it.correo as Rec)?.uid, ...(await Facturas.registrarFactura(puente, db, String(it.carpeta), it.correo as Rec)) }); }
        catch (e) { res.push({ uid: (it.correo as Rec)?.uid, error: String((e as Error).message || e) }); }
      }
      const nuevas = res.filter((x) => x.id && !x.repetida).map((x) => Number(x.id));
      const odoo = nuevas.length ? await Facturas.cruzarOdoo(db, nuevas) : null;
      await registrar({ usuario, accion, ok: true, destino: Facturas.CARPETA_FACTURAS, detalle: { nuevas: nuevas.length, errores: res.filter((x) => x.error).length } });
      return responder({ ok: true, resultados: res, odoo });
    }

    if (accion === "reglas") {
      const r = await db("correo_reglas?select=*&order=carpeta,patron");
      return responder({ ok: true, reglas: await r.json() });
    }
    if (accion === "regla_guardar") {
      const patron = String(body.patron || "").trim().toLowerCase(), carpetaR = String(body.carpeta || "");
      if (!/^(\*|[^@\s*]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(patron) || !carpetaR) return responder({ ok: false, error: "Regla inválida: hace falta remitente o @dominio, y la carpeta" });
      const r = await db("correo_reglas?on_conflict=patron", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ patron, carpeta: carpetaR, activa: body.activa !== false, creado_por: usuario }) });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, destino: carpetaR, para: patron, error: r.ok ? null : JSON.stringify(j).slice(0, 300) });
      return responder(r.ok ? { ok: true, regla: j[0] } : { ok: false, error: "No se pudo guardar la regla" });
    }
    if (accion === "regla_borrar") {
      const id = Number(body.id); if (!id) return responder({ ok: false, error: "Falta id" });
      const r = await db(`correo_reglas?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, para: j[0]?.patron ?? null, destino: j[0]?.carpeta ?? null });
      return responder({ ok: r.ok });
    }
    // ---- lista blanca: remitentes que nunca son spam (Correo → Ordenar → Lista blanca)
    if (accion === "lista_blanca") {
      const r = await db("correo_lista_blanca?select=*&order=patron");
      return responder({ ok: true, lista: await r.json() });
    }
    if (accion === "lista_blanca_agregar") {
      const patron = String(body.patron || "").trim().toLowerCase();
      if (!/^(\*|[^@\s*]+)@[a-z0-9.-]+\.[a-z]{2,}$/.test(patron)) return responder({ ok: false, error: "Escribí una dirección (persona@empresa.com) o un dominio (*@empresa.com)" });
      const r = await db("correo_lista_blanca?on_conflict=patron", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ patron, nota: body.nota ? String(body.nota).slice(0, 200) : null, creado_por: usuario }) });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, para: patron, error: r.ok ? null : JSON.stringify(j).slice(0, 300) });
      return responder(r.ok ? { ok: true, item: j[0] } : { ok: false, error: "No se pudo guardar" });
    }
    if (accion === "lista_blanca_quitar" || accion === "lista_blanca_ferozo") {
      const id = Number(body.id); if (!id) return responder({ ok: false, error: "Falta id" });
      const r = accion === "lista_blanca_quitar"
        ? await db(`correo_lista_blanca?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=representation" } })
        : await db(`correo_lista_blanca?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ en_ferozo: !!body.en_ferozo }) });
      const j = await r.json();
      await registrar({ usuario, accion, ok: r.ok, para: j[0]?.patron ?? null, detalle: accion === "lista_blanca_ferozo" ? { en_ferozo: !!body.en_ferozo } : { estaba_en_ferozo: j[0]?.en_ferozo } });
      return responder({ ok: r.ok, item: j[0] });
    }

    let reglasActivas: Rec[] = [];
    let facturasOut: Rec | null = null;
    if (accion === "aplicar_reglas") {
      // antes de que las reglas muevan nada: las facturas nuevas de la Bandeja y de Spam (copia a «Facturas»)
      if (!body.simular) {
        try {
          facturasOut = await Facturas.detectar(puente, db);
          // cruce con Odoo: si llegaron facturas, o cada 30 minutos (lo cargado en Odoo cambia sin aviso)
          const ultima = await (await db("correo_estado?select=actualizado&clave=eq.facturas:odoo")).json();
          if (Number(facturasOut.facturas) > 0 || !ultima.length || Date.now() - new Date(ultima[0].actualizado).getTime() > 30 * 60e3) {
            facturasOut.odoo = await Facturas.cruzarOdoo(db);
            await db("correo_estado?on_conflict=clave", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify({ clave: "facturas:odoo", valor: facturasOut.odoo, actualizado: new Date().toISOString() }) });
          }
        } catch (e) { facturasOut = { error: String((e as Error).message || e) }; }
        if (facturasOut && (Number(facturasOut.facturas) > 0 || facturasOut.error || (facturasOut.errores as string[] | undefined)?.length))
          await registrar({ usuario, accion: "facturas_detectar", ok: !facturasOut.error, error: facturasOut.error ? String(facturasOut.error).slice(0, 500) : null, destino: Facturas.CARPETA_FACTURAS, detalle: facturasOut });
      }
      reglasActivas = await (await db("correo_reglas?select=id,patron,carpeta&activa=eq.true")).json();
      // primero las de una dirección puntual, después las de dominio: así una excepción gana sobre la regla general
      reglasActivas.sort((a, b) => Number(String(a.patron).startsWith("@")) - Number(String(b.patron).startsWith("@")));
      // al final, la lista blanca: lo que siga en Spam de esos remitentes vuelve a la Bandeja
      // (en la Bandeja misma no hace nada: es su propia carpeta)
      const blanca: Rec[] = await (await db("correo_lista_blanca?select=patron")).json();
      const reglasTodas = [...reglasActivas.map((x) => ({ patron: x.patron, carpeta: x.carpeta })), ...blanca.map((x) => ({ patron: x.patron, carpeta: "INBOX" }))];
      if (!reglasTodas.length) return responder({ ok: true, movidos: 0, reglas: [] });
      // se revisa la Bandeja y también Spam: Ferozo manda ahí correos de proveedores y de Odoo, y los borra a los ~30 días
      body = { accion: "ordenar", origenes: ["INBOX", "spam"], simular: !!body.simular, reglas: reglasTodas };
    }

    // adjuntos para enviar que ya están en Storage → base64 para el puente
    if ((accion === "enviar" || accion === "guardar_borrador") && Array.isArray(body.adjuntos)) {
      const lista: Rec[] = [];
      for (const a of body.adjuntos as Rec[]) {
        if (a.ruta) {
          const datos = await bajarDeStorage(String(a.ruta));
          lista.push({ nombre: a.nombre || String(a.ruta).split("/").pop(), tipo: a.tipo || "application/octet-stream", base64: encodeBase64(datos) });
        } else lista.push(a);
      }
      body.adjuntos = lista;
    }

    let out: Rec = await puente(body);
    if (facturasOut) out = { ...out, facturas: facturasOut };

    if (accion === "adjunto" && out.ok && !body.en_linea) {
      const datos = decodeBase64(String(out.base64 || ""));
      const g = await guardarAdjunto(String(body.carpeta || "INBOX"), Number(body.uid), String(out.nombre || "adjunto"), String(out.tipo || ""), datos);
      delete out.base64;
      out = { ...out, ...g };
    }

    // reglas aplicadas: cuándo y cuántos movió cada una
    if (accion === "aplicar_reglas" && out.ok && !out.simulado) {
      const ahora = new Date().toISOString();
      const ids = reglasActivas.map((x) => x.id).join(",");
      if (ids) await db(`correo_reglas?id=in.(${ids})`, { method: "PATCH", body: JSON.stringify({ ultima_vez: ahora }) });
      const porPatron: Record<string, number> = {};
      for (const f of (out.reglas as Rec[]) || []) if (Number(f.movidos) > 0) porPatron[String(f.patron)] = (porPatron[String(f.patron)] || 0) + Number(f.movidos);
      for (const [patron, n] of Object.entries(porPatron)) {
        const regla = reglasActivas.find((x) => x.patron === patron);
        if (!regla) continue;
        const act = await (await db(`correo_reglas?select=movidos&id=eq.${regla.id}`)).json();
        await db(`correo_reglas?id=eq.${regla.id}`, { method: "PATCH", body: JSON.stringify({ movidos: Number(act[0]?.movidos || 0) + n }) });
      }
    }

    // el cron aplica las reglas cada 10 min: solo se anota cuando movió algo (o falló)
    const anotar = accion === "aplicar_reglas" ? (!out.ok || Number(out.movidos) > 0) && !out.simulado : !SOLO_LECTURA.has(accion);
    if (anotar) {
      if (accion === "aplicar_reglas" || accion === "ordenar") {
        const hechas = ((out.reglas as Rec[]) || []).filter((f) => Number(f.movidos) > 0 || f.error).map((f) => ({ patron: f.patron, carpeta: f.carpeta, movidos: f.movidos, error: f.error }));
        await registrar({ usuario, accion, ok: !!out.ok, error: out.ok ? null : String(out.error || "").slice(0, 500), carpeta: body.carpeta ?? "INBOX",
          detalle: { movidos: out.movidos, simulado: out.simulado || undefined, reglas: hechas } });
        return responder(out);
      }
      const para = [body.para, body.cc, body.cco].flat().filter(Boolean).map((x) => typeof x === "string" ? x : (x as Rec).email).join(", ");
      await registrar({
        usuario, accion, ok: !!out.ok, error: out.ok ? null : String(out.error || "").slice(0, 500),
        carpeta: body.carpeta ?? null, uids: body.uids ?? (body.uid ? [body.uid] : null),
        destino: body.destino ?? body.nuevo ?? body.nombre ?? null,
        para: para || null, asunto: body.asunto ?? null,
        detalle: { definitivo: body.definitivo ?? undefined, forzar: body.forzar ?? undefined, responder: body.responder ?? undefined, reenviar: body.reenviar ?? undefined,
          adjuntos: Array.isArray(body.adjuntos) ? (body.adjuntos as Rec[]).map((a) => a.nombre) : undefined, message_id: out.message_id ?? undefined, aviso: out.aviso ?? undefined },
      });
    }
    return responder(out);
  } catch (e) {
    const msg = String((e as Error).message || e).replace(clave, "***");
    if (!SOLO_LECTURA.has(accion)) await registrar({ usuario, accion, ok: false, error: msg.slice(0, 500), carpeta: body.carpeta ?? null });
    return responder({ ok: false, error: msg });
  }
});

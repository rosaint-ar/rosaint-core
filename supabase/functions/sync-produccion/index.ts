import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { modoPlan, modoControl, modoConteoSync, modoEtiquetar, modoPostergar, modoEntregaHoy, usuarioValido } from "./plan.ts";

const ODOO_URL = Deno.env.get("ODOO_URL")!;
const ODOO_DB = Deno.env.get("ODOO_DB")!;
const ODOO_LOGIN = Deno.env.get("ODOO_LOGIN")!;
const ODOO_KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY_ID = 2;
const CTX_COMPANY = { allowed_company_ids: [COMPANY_ID], force_company: COMPANY_ID };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function escapeXml(s: string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function unescapeXml(s: string){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");}
function xmlValue(v: unknown): string {
  if(typeof v==="number")return Number.isInteger(v)?`<value><int>${v}</int></value>`:`<value><double>${v}</double></value>`;
  if(typeof v==="boolean")return `<value><boolean>${v?1:0}</boolean></value>`;
  if(typeof v==="string")return `<value><string>${escapeXml(v)}</string></value>`;
  if(Array.isArray(v))return `<value><array><data>${v.map(xmlValue).join("")}</data></array></value>`;
  if(v&&typeof v==="object"){const m=Object.entries(v as Record<string,unknown>).map(([k,val])=>`<member><name>${escapeXml(k)}</name>${xmlValue(val)}</member>`).join("");return `<value><struct>${m}</struct></value>`;}
  return `<value><boolean>0</boolean></value>`;
}
function buildRequest(method:string,params:unknown[]){return `<?xml version=\"1.0\"?><methodCall><methodName>${method}</methodName><params>${params.map(p=>`<param>${xmlValue(p)}</param>`).join("")}</params></methodCall>`;}
class Cursor{s:string;i:number;constructor(s:string){this.s=s;this.i=0;}
  nextTag(){const lt=this.s.indexOf("<",this.i);if(lt===-1)return null;const gt=this.s.indexOf(">",lt);if(gt===-1)return null;let raw=this.s.slice(lt+1,gt).trim();this.i=gt+1;if(raw.startsWith("?"))return this.nextTag();const closing=raw.startsWith("/");if(closing)raw=raw.slice(1).trim();const selfClose=raw.endsWith("/");if(selfClose)raw=raw.slice(0,-1).trim();return{tag:raw.split(/\s/)[0].toLowerCase(),closing,selfClose};}
  readTextUntilClose(tag:string){const close=`</${tag}>`;const idx=this.s.toLowerCase().indexOf(close,this.i);const end=idx===-1?this.s.length:idx;const t=this.s.slice(this.i,end);this.i=(idx===-1?this.s.length:idx+close.length);return t;}}
function peekTag(cur:Cursor){const s=cur.i;const t=cur.nextTag();cur.i=s;return t;}
function seekOpen(cur:Cursor,tag:string){for(;;){const t=cur.nextTag();if(!t)return;if(!t.closing&&t.tag===tag)return;}}
function consumeClose(cur:Cursor,tag:string){const c=`</${tag}>`;const idx=cur.s.toLowerCase().indexOf(c,cur.i);if(idx!==-1)cur.i=idx+c.length;}
function parseValueBody(cur:Cursor): unknown {
  const save=cur.i;const t=cur.nextTag();if(!t)return "";if(t.closing&&t.tag==="value")return "";
  switch(t.tag){
    case "int":case "i4":{const x=cur.readTextUntilClose(t.tag);consumeClose(cur,"value");return parseInt(x.trim()||"0",10);}
    case "double":{const x=cur.readTextUntilClose("double");consumeClose(cur,"value");return parseFloat(x.trim()||"0");}
    case "boolean":{const x=cur.readTextUntilClose("boolean");consumeClose(cur,"value");return x.trim()==="1";}
    case "string":{const x=cur.readTextUntilClose("string");consumeClose(cur,"value");return unescapeXml(x);}
    case "nil":{if(!t.selfClose)consumeClose(cur,"nil");consumeClose(cur,"value");return null;}
    case "array":{const arr:unknown[]=[];seekOpen(cur,"data");for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="data"){cur.nextTag();break;}if(p.tag==="value"&&!p.closing){cur.nextTag();arr.push(parseValueBody(cur));}else cur.nextTag();}consumeClose(cur,"array");consumeClose(cur,"value");return arr;}
    case "struct":{const obj:Record<string,unknown>={};for(;;){const p=peekTag(cur);if(!p)break;if(p.closing&&p.tag==="struct"){cur.nextTag();break;}if(p.tag==="member"&&!p.closing){cur.nextTag();seekOpen(cur,"name");const n=cur.readTextUntilClose("name").trim();seekOpen(cur,"value");obj[n]=parseValueBody(cur);consumeClose(cur,"member");}else cur.nextTag();}consumeClose(cur,"value");return obj;}
    default:{cur.i=save;const x=cur.readTextUntilClose("value");return unescapeXml(x.trim());}
  }
}
function parseResponse(xml:string){if(/<fault>/i.test(xml)){const c=new Cursor(xml);seekOpen(c,"value");throw new Error("Odoo fault: "+JSON.stringify(parseValueBody(c)));}const c=new Cursor(xml);seekOpen(c,"value");return parseValueBody(c);}
async function xmlrpcCall(endpoint:string,method:string,params:unknown[]){const res=await fetch(`${ODOO_URL}${endpoint}`,{method:"POST",headers:{"Content-Type":"text/xml"},body:buildRequest(method,params)});return parseResponse(await res.text());}
async function authenticate(){const uid=await xmlrpcCall("/xmlrpc/2/common","authenticate",[ODOO_DB,ODOO_LOGIN,ODOO_KEY,{}]);if(!uid||typeof uid!=="number")throw new Error("Auth fallida");return uid as number;}
async function execKw(uid:number,model:string,method:string,args:unknown[],kwargs:Record<string,unknown>={}){return await xmlrpcCall("/xmlrpc/2/object","execute_kw",[ODOO_DB,uid,ODOO_KEY,model,method,args,kwargs]);}
async function execKwCompany(uid:number,model:string,method:string,args:unknown[],kwargs:Record<string,unknown>={}){
  return await execKw(uid, model, method, args, { ...kwargs, context: CTX_COMPANY });
}

type Row = Record<string, unknown>;
function m2oId(v: unknown): number | null { return Array.isArray(v) ? (v[0] as number) ?? null : null; }
function m2oName(v: unknown): string { return Array.isArray(v) ? String(v[1] ?? "") : ""; }

const DOMAIN_PENDIENTES = [
  ["state", "=", "sale"],
  ["company_id", "=", COMPANY_ID],
  ["delivery_status", "in", ["pending", "started", "partial"]]
];

async function modoContar(uid: number) {
  const n = await execKw(uid, "sale.order", "search_count", [DOMAIN_PENDIENTES]) as number;
  return { ok: true, pendientes: n, company_id: COMPANY_ID };
}

async function modoPedidos(uid: number, sb: ReturnType<typeof createClient>) {
  const t0 = Date.now();
  const pedidos = await execKw(uid, "sale.order", "search_read", [DOMAIN_PENDIENTES], {
    fields: ["id", "name", "partner_id", "date_order", "commitment_date", "state", "delivery_status", "amount_total"],
    order: "date_order asc"
  }) as Row[];
  const orderIds = pedidos.map(p => p.id as number);
  const lineas = orderIds.length ? (await execKw(uid, "sale.order.line", "search_read", [
    [["order_id", "in", orderIds], ["display_type", "=", false]]
  ], { fields: ["id", "order_id", "product_id", "product_uom_qty", "qty_delivered"] }) as Row[]) : [];
  const lineasPend = lineas.filter(l => Number(l.product_uom_qty ?? 0) > Number(l.qty_delivered ?? 0));
  await sb.from("prod_pedido_lineas").delete().neq("id", -1);
  await sb.from("prod_pedidos").delete().neq("id", -1);
  const pedidosRows = pedidos.map(p => ({
    id: p.id, numero: String(p.name ?? ""), cliente: m2oName(p.partner_id) || "",
    fecha_pedido: p.date_order ? String(p.date_order).split(" ")[0] : null,
    fecha_compromiso: p.commitment_date ? String(p.commitment_date).split(" ")[0] : null,
    estado: String(p.delivery_status ?? p.state ?? ""), entregado_pct: null,
    monto_total: Number(p.amount_total ?? 0)
  }));
  if (pedidosRows.length) {
    const { error } = await sb.from("prod_pedidos").insert(pedidosRows);
    if (error) throw new Error("insert pedidos: " + error.message);
  }
  const lineasRows = lineasPend.map(l => ({
    id: l.id, pedido_id: m2oId(l.order_id),
    sku: `ODOO_${m2oId(l.product_id)}`, nombre_producto: m2oName(l.product_id),
    qty_pedida: Number(l.product_uom_qty ?? 0), qty_entregada: Number(l.qty_delivered ?? 0)
  })).filter(x => x.pedido_id != null);
  for (let i = 0; i < lineasRows.length; i += 500) {
    const chunk = lineasRows.slice(i, i + 500);
    const { error } = await sb.from("prod_pedido_lineas").insert(chunk);
    if (error) throw new Error("insert lineas: " + error.message);
  }
  const productIds = [...new Set(lineasPend.map(l => m2oId(l.product_id)).filter((x): x is number => !!x))];
  return { ok: true, duracion_ms: Date.now() - t0, pedidos: pedidosRows.length, lineas: lineasRows.length, product_ids: productIds };
}

async function modoProductos(uid: number, sb: ReturnType<typeof createClient>, productIds: number[]) {
  const t0 = Date.now();
  if (!productIds.length) return { ok: true, stock: 0, tmpl_ids: [] };
  const out: Row[] = [];
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    const r = await execKwCompany(uid, "product.product", "read", [chunk], {
      fields: ["id", "default_code", "name", "qty_available", "free_qty", "product_tmpl_id"]
    }) as Row[];
    out.push(...r);
  }
  const rowsStock: Array<Record<string, unknown>> = [];
  const skuByPid = new Map<number, { sku: string; nombre: string; tmpl: number | null }>();
  for (const p of out) {
    const pid = p.id as number;
    const sku = String(p.default_code ?? "").trim() || `ODOO_${pid}`;
    const nombre = String(p.name ?? "");
    const tmpl = m2oId(p.product_tmpl_id);
    skuByPid.set(pid, { sku, nombre, tmpl });
    rowsStock.push({
      sku, nombre_producto: nombre,
      qty_disponible: Number(p.qty_available ?? 0),
      qty_reservada: Math.max(0, Number(p.qty_available ?? 0) - Number(p.free_qty ?? 0))
    });
  }
  for (const [pid, info] of skuByPid) {
    await sb.from("prod_pedido_lineas").update({ sku: info.sku, nombre_producto: info.nombre }).eq("sku", `ODOO_${pid}`);
  }
  const uniq = new Map<string, Record<string, unknown>>();
  for (const r of rowsStock) uniq.set(String(r.sku), r);
  const insert = [...uniq.values()];
  for (let i = 0; i < insert.length; i += 500) {
    const chunk = insert.slice(i, i + 500);
    const { error } = await sb.from("prod_stock").upsert(chunk, { onConflict: "sku" });
    if (error) throw new Error("upsert stock: " + error.message);
  }
  const tmplIds = [...new Set([...skuByPid.values()].map(v => v.tmpl).filter((t): t is number => !!t))];
  return { ok: true, duracion_ms: Date.now() - t0, stock: insert.length, tmpl_ids: tmplIds };
}

async function modoCatalogo(uid: number, sb: ReturnType<typeof createClient>, offset: number, limit: number) {
  const t0 = Date.now();
  const domain = [ ["active", "=", true], ["default_code", "!=", false] ];
  const total = await execKwCompany(uid, "product.product", "search_count", [domain]) as number;
  const productos = await execKwCompany(uid, "product.product", "search_read", [domain], {
    fields: ["id", "default_code", "name", "qty_available", "free_qty", "product_tmpl_id"],
    order: "default_code asc", offset, limit
  }) as Row[];

  const rows: Array<Record<string, unknown>> = [];
  const tmplIds = new Set<number>();
  for (const p of productos) {
    const sku = String(p.default_code ?? "").trim();
    if (!sku) continue;
    rows.push({
      sku, nombre_producto: String(p.name ?? ""),
      qty_disponible: Number(p.qty_available ?? 0),
      qty_reservada: Math.max(0, Number(p.qty_available ?? 0) - Number(p.free_qty ?? 0))
    });
    const tmpl = m2oId(p.product_tmpl_id);
    if (tmpl) tmplIds.add(tmpl);
  }
  const uniq = new Map<string, Record<string, unknown>>();
  for (const r of rows) uniq.set(String(r.sku), r);
  const insert = [...uniq.values()];
  for (let i = 0; i < insert.length; i += 500) {
    const chunk = insert.slice(i, i + 500);
    const { error } = await sb.from("prod_stock").upsert(chunk, { onConflict: "sku" });
    if (error) throw new Error("upsert catalogo: " + error.message);
  }
  return {
    ok: true, duracion_ms: Date.now() - t0,
    total, offset, limit, procesados: productos.length,
    tmpl_ids: [...tmplIds],
    has_more: (offset + productos.length) < total
  };
}

// Paginado: caller pasa tmpl_ids chunkeados (≤50 recomendado) + reset=true en el primer batch
async function modoBomCompleto(uid: number, sb: ReturnType<typeof createClient>, tmplIds: number[], reset: boolean) {
  const t0 = Date.now();
  if (reset) await sb.from("prod_bom").delete().neq("producto_sku", "__x__");
  if (!tmplIds.length) return { ok: true, bom: 0, reset };

  const domainBom = (chunk: number[]) => [
    ["product_tmpl_id", "in", chunk], ["active", "=", true],
    "|", ["company_id", "=", COMPANY_ID], ["company_id", "=", false]
  ];
  const boms: Row[] = [];
  for (let i = 0; i < tmplIds.length; i += 100) {
    const chunk = tmplIds.slice(i, i + 100);
    const r = await execKw(uid, "mrp.bom", "search_read", [domainBom(chunk)],
      { fields: ["id", "product_tmpl_id", "product_qty", "bom_line_ids"] }) as Row[];
    boms.push(...r);
  }
  const lineIds: number[] = [];
  for (const b of boms) for (const id of ((b.bom_line_ids as number[]) || [])) lineIds.push(id);
  const bomLines: Row[] = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    const chunk = lineIds.slice(i, i + 200);
    const r = await execKw(uid, "mrp.bom.line", "read", [chunk], {
      fields: ["id", "bom_id", "product_id", "product_qty"]
    }) as Row[];
    bomLines.push(...r);
  }

  const tmplToSku = new Map<number, string>();
  for (let i = 0; i < tmplIds.length; i += 200) {
    const chunk = tmplIds.slice(i, i + 200);
    const r = await execKw(uid, "product.product", "search_read", [
      [["product_tmpl_id", "in", chunk]]
    ], { fields: ["id", "default_code", "product_tmpl_id"] }) as Row[];
    for (const p of r) {
      const tmpl = m2oId(p.product_tmpl_id);
      const sku = String(p.default_code ?? "").trim();
      if (tmpl && sku && !tmplToSku.has(tmpl)) tmplToSku.set(tmpl, sku);
    }
  }

  const compPids = [...new Set(bomLines.map(l => m2oId(l.product_id)).filter((x): x is number => x != null))];
  const compSkuByPid = new Map<number, { sku: string; nombre: string }>();
  for (let i = 0; i < compPids.length; i += 200) {
    const chunk = compPids.slice(i, i + 200);
    const r = await execKw(uid, "product.product", "read", [chunk], {
      fields: ["id", "default_code", "name"]
    }) as Row[];
    for (const p of r) {
      const pid = p.id as number;
      const sku = String(p.default_code ?? "").trim();
      if (sku) compSkuByPid.set(pid, { sku, nombre: String(p.name ?? "") });
    }
  }

  const bomRows: Array<Record<string, unknown>> = [];
  for (const bl of bomLines) {
    const bomId = m2oId(bl.bom_id);
    const bom = boms.find(b => b.id === bomId);
    if (!bom) continue;
    const tmpl = m2oId(bom.product_tmpl_id);
    if (!tmpl) continue;
    const productoSku = tmplToSku.get(tmpl);
    if (!productoSku) continue;
    const compPid = m2oId(bl.product_id);
    if (compPid == null) continue;
    const comp = compSkuByPid.get(compPid);
    if (!comp) continue;
    const bomQty = Number(bom.product_qty ?? 1);
    const lineQty = Number(bl.product_qty ?? 0);
    const qtyPorUnidad = bomQty > 0 ? lineQty / bomQty : lineQty;
    bomRows.push({
      producto_sku: productoSku, componente_sku: comp.sku,
      componente_nombre: comp.nombre, qty_por_unidad: qtyPorUnidad
    });
  }

  const uniq = new Map<string, Record<string, unknown>>();
  for (const r of bomRows) uniq.set(`${r.producto_sku}||${r.componente_sku}`, r);
  const bomInsert = [...uniq.values()];
  for (let i = 0; i < bomInsert.length; i += 500) {
    const chunk = bomInsert.slice(i, i + 500);
    const { error } = await sb.from("prod_bom").upsert(chunk, { onConflict: "producto_sku,componente_sku" });
    if (error) throw new Error("upsert bom: " + error.message);
  }
  return { ok: true, duracion_ms: Date.now() - t0, bom: bomInsert.length, tmpls: tmplIds.length, reset };
}

// Legacy: preservo modoBom del flujo antiguo
async function modoBom(uid: number, sb: ReturnType<typeof createClient>, tmplIds: number[]) {
  return await modoBomCompleto(uid, sb, tmplIds, true);
}

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json"
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* */ }
    const modo = String(body.modo ?? "contar");

    // Todos los modos piden sesión de Core. Las excepciones son lo que corre el cron: el control
    // y la foto de Odoo (plan), que se identifican con una clave propia (CONTROL_CRON_KEY) en vez de un usuario.
    const cronKey = Deno.env.get("CONTROL_CRON_KEY") || "";
    const esCron = (modo === "control" || modo === "plan") && !!cronKey && req.headers.get("x-cron-key") === cronKey;
    const usuario = esCron ? null : await usuarioValido(req);
    if (!esCron && !usuario) return new Response(JSON.stringify({ ok: false, error: "No autorizado: iniciá sesión en Core" }), { headers: cors });

    // Programador de producción (ver plan.ts)
    if (modo === "plan") return new Response(JSON.stringify(await modoPlan()), { headers: cors });
    if (modo === "control") return new Response(JSON.stringify(await modoControl()), { headers: cors });
    if (modo === "etiquetar" || modo === "postergar" || modo === "entrega_hoy" || modo === "conteo_sync") {
      const r = modo === "etiquetar" ? await modoEtiquetar(body) : modo === "postergar" ? await modoPostergar(body, usuario!) : modo === "conteo_sync" ? await modoConteoSync(body) : await modoEntregaHoy(body, usuario!);
      return new Response(JSON.stringify(r), { headers: cors });
    }

    const uid = await authenticate();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let result: unknown = {};
    if (modo === "contar") result = await modoContar(uid);
    else if (modo === "pedidos") result = await modoPedidos(uid, sb);
    else if (modo === "productos") {
      const ids = ((body.product_ids as number[]) || []).map(Number).filter(Boolean);
      result = await modoProductos(uid, sb, ids);
    }
    else if (modo === "bom") {
      const ids = ((body.tmpl_ids as number[]) || []).map(Number).filter(Boolean);
      result = await modoBom(uid, sb, ids);
    }
    else if (modo === "catalogo") {
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 100);
      result = await modoCatalogo(uid, sb, offset, limit);
    }
    else if (modo === "bom_completo") {
      const ids = ((body.tmpl_ids as number[]) || []).map(Number).filter(Boolean);
      const reset = Boolean(body.reset);
      result = await modoBomCompleto(uid, sb, ids, reset);
    }
    else throw new Error("modo inválido: " + modo);

    return new Response(JSON.stringify(result), { headers: cors });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    try {
      const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      await sb.from("prod_sync_log").insert({ ok: false, error: msg });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ ok: false, error: msg }), { headers: cors, status: 200 });
  }
});

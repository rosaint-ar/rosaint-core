const SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUB = "sb_publishable_I2b_s6jYVI1Cas3vGHLvbQ_OWXkU0vB";
const OD = Deno.env.get("ODOO_URL")!.replace(/\/+$/, "");
const DB = Deno.env.get("ODOO_DB")!;
const LOGIN = Deno.env.get("ODOO_LOGIN")!;
const KEY = Deno.env.get("ODOO_KEY")!;
const COMPANY = 2;
const APPROVERS = ["contacto@rosaint.com.ar", "rosaint.ar@gmail.com"];
export async function admin(req: Request) {
  const a = req.headers.get("authorization") || "";
  if (SERVICE && a === "Bearer " + SERVICE) return "sistema";
  if (!a.startsWith("Bearer ")) throw new Error("AUTH");
  const r = await fetch(SB + "/auth/v1/user", {
    headers: { apikey: PUB, Authorization: a },
  });
  if (!r.ok) throw new Error("AUTH");
  const u = await r.json();
  if (
    !u.email_confirmed_at ||
    !APPROVERS.includes(String(u.email).toLowerCase())
  )
    throw new Error("FORBIDDEN");
  return u.email;
}
let uid: number;
export async function serviceUserId() { uid ||= await rpc('common','authenticate',[DB,LOGIN,KEY,{}]);if(!uid)throw Error('No se pudo autenticar la integración.');return uid; }
async function rpc(service: string, method: string, args: unknown[]) {
  const r = await fetch(OD + "/jsonrpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: crypto.randomUUID(),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok || j.error) {
    const error=new Error(String(j.error?.data?.message || "Odoo no respondió"));
    const kind=String(j.error?.data?.name||'');
    // Exception class only; never attach RPC arguments, credentials or traceback.
    if(/^[A-Za-z_][A-Za-z0-9_.]{0,120}$/.test(kind))Object.assign(error,{odooErrorType:kind});
    // Retain only the recognized constraint category, never traceback data.
    const frames=Array.from(String(j.error?.data?.debug||'').matchAll(/^\s*File "[^"\r\n]+", line \d+, in ([A-Za-z_][A-Za-z0-9_]*)\s*$/gm),m=>m[1]);
    if(frames.includes('_check_login'))Object.assign(error,{odooLoginConflict:true});
    throw error;
  }
  return j.result;
}
export async function kw(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
) {
  uid ||= await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
  if (!uid) throw new Error("No se pudo conectar con Odoo");
  return rpc("object", "execute_kw", [
    DB,
    uid,
    KEY,
    model,
    method,
    args,
    {
      ...kwargs,
      context: {
        ...((kwargs.context as object) || {}),
        allowed_company_ids: [COMPANY],
        company_id: COMPANY,
      },
    },
  ]);
}
// Login uniqueness is database-wide. Search only this login, using the service
// user's existing companies, including archived access within that scope.
export async function lookupLogin(login:string) {
 const id=await serviceUserId();
 const [service]=await kw('res.users','read',[[id]],{fields:['company_ids']});
 const companies=Array.isArray(service?.company_ids)&&service.company_ids.length?service.company_ids:[COMPANY];
 return rpc('object','execute_kw',[DB,id,KEY,'res.users','search_read',[[['login','=ilike',login]]],{
  fields:['id','name','login','partner_id','active','share','company_id','company_ids'],limit:10,
  context:{active_test:false,allowed_company_ids:companies,company_id:COMPANY},
 }]);
}
export async function diagnostic() {
  const result: Record<string, unknown> = { odoo_url: OD, company_id: COMPANY };
  for (const [name, model, args, fields] of [
    [
      "company",
      "res.company",
      [[["id", "=", COMPANY]]],
      ["id", "name", "partner_id"],
    ],
    ["websites", "website", [[]], ["id", "name", "domain", "company_id"]],
    [
      "lists",
      "product.pricelist",
      [[]],
      ["id", "name", "company_id", "active"],
    ],
    ["country", "res.country", [[["code", "=", "AR"]]], ["id", "name"]],
    [
      "portal_group",
      "ir.model.data",
      [
        [
          ["module", "=", "base"],
          ["name", "=", "group_portal"],
        ],
      ],
      ["res_id"],
    ],
    [
      "commercials",
      "res.users",
      [
        [
          ["share", "=", false],
          ["active", "=", true],
        ],
      ],
      ["id", "name", "company_ids"],
    ],
    [
      "id_types",
      "l10n_latam.identification.type",
      [[["name", "ilike", "CUIT"]]],
      ["id", "name"],
    ],
    [
      "fiscal_types",
      "l10n_ar.afip.responsibility.type",
      [[]],
      ["id", "name", "code"],
    ],
  ] as any[]) {
    try {
      result[name] = await kw(model, "search_read", args, {
        fields,
        limit: 100,
      });
    } catch (e) {
      result[name] = { error: String(e.message) };
    }
  }
  result.partner_fields = Object.keys(
    await kw("res.partner", "fields_get", [], { attributes: ["type"] }),
  ).filter((k) => /pricelist|fantasia|rubro|category|padron/.test(k));
  result.provincias = await kw(
    "res.country.state",
    "search_read",
    [[["country_id", "=", 10]]],
    { fields: ["id", "name"], order: "name" },
  );
  result.portal_scope = await kw("ir.config_parameter", "get_param", [
    "auth_signup.invitation_scope",
  ]);
  result.typography_views = await kw('ir.ui.view','search_read',[[['key','in',['web.login_layout','rosaint.portal_login_alta','website.rosaint_portal_alta','rosaint.portal_access_type']]]],{fields:['id','key','arch_db','write_date'],limit:10});
  return result;
}
export { SB, SERVICE, PUB, OD, COMPANY };

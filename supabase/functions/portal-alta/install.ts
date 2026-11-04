import { kw, COMPANY } from "./odoo.ts";
import { ALTA_XML } from "./template.ts";
export async function install() {
  const websites = await kw("website", "search_read", [[]], {
    fields: ["id", "company_id"],
    limit: 5,
  });
  if (websites.length !== 1 || websites[0].company_id[0] !== COMPANY)
    throw Error("Revisar el sitio y empresa antes de instalar.");
  const website = websites[0].id;
  const existing = await kw(
    "website.page",
    "search_read",
    [[["url", "=", "/alta"]]],
    { fields: ["id", "view_id"], limit: 2 },
  );
  let view = (
    await kw(
      "ir.ui.view",
      "search_read",
      [[["key", "=", "website.rosaint_portal_alta"]]],
      { fields: ["id"], limit: 1 },
    )
  )[0]?.id;
  if (
    existing.length &&
    (existing.length > 1 || existing[0].view_id[0] !== view)
  )
    throw Error("La ruta /alta está ocupada por otra página.");
  if (view) await kw("ir.ui.view", "write", [[view], { arch_db: ALTA_XML }]);
  else
    view = await kw("ir.ui.view", "create", [
      {
        name: "Rosaint · Solicitud de acceso profesional",
        key: "website.rosaint_portal_alta",
        type: "qweb",
        arch_db: ALTA_XML,
        website_id: website,
      },
    ]);
  const page =
    existing[0]?.id ||
    (await kw("website.page", "create", [
      {
        name: "Solicitar acceso profesional",
        url: "/alta",
        view_id: view,
        website_id: website,
        website_published: true,
        website_indexed: false,
      },
    ]));
  const login = (
    await kw("ir.ui.view", "search_read", [[["key", "=", "web.login"]]], {
      fields: ["id"],
      limit: 1,
    })
  )[0]?.id;
  if (!login) throw Error("No se encontró la plantilla de ingreso.");
  const arch = `<data><xpath expr="//form" position="after"><div class="text-center mt-4 mb-3" style="color:#34495e"><p style="font-size:16px;margin-bottom:10px">Profesionales · Revendedores · Mayoristas · Academias</p><a href="/alta" class="btn btn-outline-primary" style="border-radius:12px;padding:12px 22px">Solicitar acceso profesional</a><p style="font-size:14px;margin-top:10px">Revisaremos tu solicitud antes de habilitar la cuenta.</p></div></xpath></data>`;
  let loginExtra = (
    await kw(
      "ir.ui.view",
      "search_read",
      [[["key", "=", "rosaint.portal_login_alta"]]],
      { fields: ["id"], limit: 1 },
    )
  )[0]?.id;
  if (loginExtra)
    await kw("ir.ui.view", "write", [
      [loginExtra],
      { arch_db: arch, active: true },
    ]);
  else
    loginExtra = await kw("ir.ui.view", "create", [
      {
        name: "Rosaint · Solicitar acceso desde login",
        key: "rosaint.portal_login_alta",
        type: "qweb",
        inherit_id: login,
        arch_db: arch,
        priority: 90,
        website_id: website,
      },
    ]);
  // La invitación con token sigue disponible; el registro libre queda cerrado.
  await kw("ir.config_parameter", "set_param", [
    "auth_signup.invitation_scope",
    "b2b",
  ]);
  return {
    page_id: page,
    view_id: view,
    login_view_id: loginExtra,
    registro: "solo_invitacion",
    url: "https://rosaint.odoo.com/alta",
  };
}

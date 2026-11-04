import { kw, COMPANY } from "./odoo.ts";
const dig = (x: unknown) => String(x || "").replace(/\D/g, "");
const esc = (x: unknown) =>
  String(x || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const xmlTag = (x: string, t: string) => {
  const m = x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? m[1].trim() : "";
};
const xmlTodos = (x: string, t: string) =>
  [...x.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "g"))].map(
    (m) => m[1],
  );
const desXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

async function ticketArca() {
  const leer = async () =>
    (
      await kw(
        "l10n_ar.afipws.connection",
        "search_read",
        [
          [
            ["company_id", "=", COMPANY],
            ["l10n_ar_afip_ws", "=", "ws_sr_constancia_inscripcion"],
            ["type", "=", "production"],
          ],
        ],
        {
          fields: ["token", "sign", "expiration_time"],
          order: "id desc",
          limit: 1,
        },
      )
    )?.[0];
  let t = await leer();
  const vence = (x: { expiration_time?: string }) =>
    x?.expiration_time
      ? Date.parse(x.expiration_time.replace(" ", "T") + "Z")
      : 0;
  if (!t || vence(t) < Date.now() + 5 * 60e3) {
    // Renovar: Odoo arma el ticket nuevo al consultar el padrón. Se le pregunta por
    // la propia empresa; el método sólo devuelve datos, no escribe la ficha.
    const comp = (
      await kw("res.company", "read", [[COMPANY], ["partner_id"]])
    )[0];
    await kw("res.partner", "get_data_from_padron_afip", [
      [comp.partner_id[0]],
    ]);
    t = await leer();
  }
  if (!t?.token || !t?.sign) throw new Error("Odoo no tiene ticket de ARCA");
  return t;
}
export async function diagnosticoArca() {
  try {
    const t = await ticketArca();
    return { disponible: true, vence: t.expiration_time };
  } catch (e) {
    return { disponible: false, motivo: String(e.message).slice(0, 500) };
  }
}
// deno-lint-ignore no-explicit-any
export async function consultarArca(cuit: string): Promise<any> {
  const t = await ticketArca();
  const empresa = dig(
    (await kw("res.company", "read", [[COMPANY], ["vat"]]))[0].vat,
  );
  const sobre = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/"><soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>${esc(t.token)}</token><sign>${esc(t.sign)}</sign><cuitRepresentada>${empresa}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`;
  const r = await fetch(
    "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
    {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: sobre,
    },
  );
  const x = await r.text();
  const falla = xmlTag(x, "faultstring");
  if (falla) {
    if (/no existe persona/i.test(falla))
      return { ok: true, existe: false, error: desXml(falla) };
    throw new Error("ARCA: " + desXml(falla).slice(0, 200));
  }
  const dg = xmlTag(x, "datosGenerales");
  if (!dg) {
    const err = xmlTodos(xmlTag(x, "errorConstancia"), "error")
      .map(desXml)
      .join(" · ");
    return {
      ok: true,
      existe: !!err,
      sin_constancia: true,
      error: err || "ARCA no devolvió datos",
      nombre: desXml(xmlTag(xmlTag(x, "errorConstancia"), "apellido")),
    };
  }
  const dom = xmlTag(dg, "domicilioFiscal");
  const rg = xmlTag(x, "datosRegimenGeneral"),
    mono = xmlTag(x, "datosMonotributo");
  const acts = [
    ...xmlTodos(rg, "actividad").map((a) => ({
      id: xmlTag(a, "idActividad"),
      desc: desXml(xmlTag(a, "descripcionActividad")),
      orden: Number(xmlTag(a, "orden") || 9),
    })),
    ...xmlTodos(mono, "actividadMonotributista").map((a) => ({
      id: xmlTag(a, "idActividad"),
      desc: desXml(xmlTag(a, "descripcionActividad")),
      orden: 1,
    })),
  ].sort((a, b) => a.orden - b.orden);
  const imp = xmlTodos(rg, "impuesto").map((i) => ({
    id: xmlTag(i, "idImpuesto"),
    desc: desXml(xmlTag(i, "descripcionImpuesto")),
  }));
  const apellido = desXml(xmlTag(dg, "apellido")),
    nombre = desXml(xmlTag(dg, "nombre")),
    razon = desXml(xmlTag(dg, "razonSocial"));
  const iva = imp.some((i) => i.id === "30")
    ? "RI"
    : mono
      ? "MONO"
      : imp.some((i) => i.id === "32")
        ? "EXENTO"
        : "";
  return {
    ok: true,
    existe: true,
    tipo: xmlTag(dg, "tipoPersona"),
    estado: xmlTag(dg, "estadoClave"),
    apellido,
    nombre,
    razon,
    nombre_completo: razon || [apellido, nombre].filter(Boolean).join(", "),
    domicilio: desXml(xmlTag(dom, "direccion")),
    localidad: desXml(xmlTag(dom, "localidad")),
    cp: xmlTag(dom, "codPostal"),
    provincia: desXml(xmlTag(dom, "descripcionProvincia")),
    actividades: acts.map(({ id, desc }) => ({ id, desc })),
    impuestos: imp,
    iva,
    categoria_mono:
      xmlTag(mono, "descripcionCategoria") ||
      xmlTag(mono, "categoriaMonotributo") ||
      "",
  };
}

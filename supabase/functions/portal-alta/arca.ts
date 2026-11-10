import { kw, COMPANY } from "./odoo.ts";
import { rosArcaTicket } from "./arca-signer.ts";
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

const ticketArca = rosArcaTicket;
export async function diagnosticoArca() {
  try {
    const t = await ticketArca();
    const propia=await consultarArca(t.cuit);
    return { disponible: propia.ok===true && propia.existe===true, vence: t.expiration_time, consulta_empresa:{ok:propia.ok,existe:propia.existe,iva:propia.iva,estado:propia.estado,error:propia.error} };
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
    // El webservice sigue en afip.gov.ar (aws.arca.gov.ar NO existe en DNS; verificado 10-nov-2026)
    "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
    {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: sobre,
      signal: AbortSignal.timeout(25000),
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

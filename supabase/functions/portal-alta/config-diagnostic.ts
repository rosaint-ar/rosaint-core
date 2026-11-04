import { kw, COMPANY } from './odoo.ts';
// Sólo metadatos de configuración. No devuelve certificados, claves ni tickets.
export async function configDiagnostic() {
  const result: Record<string,unknown> = {};
  const read = async (name:string, model:string, domain:unknown[], fields:string[], limit=50) => {
    try { result[name]=await kw(model,'search_read',[domain],{fields,limit}); }
    catch(e) { result[name]={error:String(e.message).slice(0,400)}; }
  };
  await read('modules','ir.module.module',[['state','=','installed'],'|','|',['name','ilike','l10n_ar'],['name','ilike','afip'],['name','ilike','padron']],['name','installed_version']);
  await read('models','ir.model',['|','|',['model','ilike','afip'],['model','ilike','arca'],['model','ilike','certificate']],['model','name']);
  await read('identifications','l10n_latam.identification.type',[['name','in',['CUIT','CUIL','DNI']]],['id','name','l10n_ar_afip_code']);
  await read('responsibilities','l10n_ar.afip.responsibility.type',[],['id','name','code']);
  await read('connections','l10n_ar.afipws.connection',[['company_id','=',COMPANY]],['id','l10n_ar_afip_ws','type','expiration_time']);
  await read('partner_views','ir.ui.view',[['model','=','res.partner'],'|',['arch_db','ilike','padron'],['arch_db','ilike','afip']],['key','arch_db'],15);
  for(const model of ['l10n_ar.afipws.connection','res.company']) {
    try { const f=await kw(model,'fields_get',[],{attributes:['type','string','relation','selection']}); result[model]=Object.fromEntries(Object.entries(f).filter(([k])=>model!=='res.company'||/arca|afip|cert|vat/.test(k))); }
    catch(e) { result[model]={error:String(e.message).slice(0,400)}; }
  }
  return result;
}

import { kw, COMPANY, serviceUserId, SB, SERVICE } from './odoo.ts';
import { signedCms } from './cms.ts';
import { encrypt,decrypt } from './secrets.ts';
const PARAM='rosaint.portal_arca.signer', CACHE='rosaint-2-constancia-production';
export async function installArcaSigner() {
 const user=await serviceUserId();
 const code=`# Rosaint: firma exclusiva de TRA de constancia; nunca exporta la clave privada.
if env.uid != ${user}:
    raise UserError('Operación reservada a la integración de Rosaint.')
company = env['res.company'].browse(${COMPANY})
key = company.l10n_ar_afip_ws_key_id
cert = company.l10n_ar_afip_ws_crt_id
if not key or not cert or key.company_id.id != ${COMPANY} or cert.company_id.id != ${COMPANY}:
    raise UserError('Revisar certificado y clave ARCA de la empresa Rosaint.')
if not cert.is_valid:
    raise UserError('El certificado ARCA está vencido o no es válido.')
now = datetime.datetime.utcnow()
generation = (now - datetime.timedelta(minutes=3)).strftime('%Y-%m-%dT%H:%M:%SZ')
expiration = (now + datetime.timedelta(hours=11)).strftime('%Y-%m-%dT%H:%M:%SZ')
tra = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>%s</uniqueId><generationTime>%s</generationTime><expirationTime>%s</expirationTime></header><service>ws_sr_constancia_inscripcion</service></loginTicketRequest>' % (int(time.time()), generation, expiration)
signature = key._sign(tra, hashing_algorithm='sha256', formatting='base64').decode('ascii')
action = {'type':'ir.actions.client','tag':'rosaint_arca_signature','params':{'tra':tra,'signature':signature,'certificate':cert.with_context(bin_size=False).pem_certificate.decode('ascii'),'cuit':company.vat}}
`;
 let id=Number(await kw('ir.config_parameter','get_param',[PARAM])||0);
 const model=(await kw('ir.model','search_read',[[['model','=','res.company']]],{fields:['id'],limit:1}))[0];
 if(id){const current=(await kw('ir.actions.server','read',[[id],['name','model_id']]))[0];if(current?.name!=='Rosaint Core · Ticket ARCA padrón'||current.model_id[0]!==model.id)throw Error('Revisar acción de firma existente.');await kw('ir.actions.server','write',[[id],{code}]);}
 else {id=await kw('ir.actions.server','create',[{name:'Rosaint Core · Ticket ARCA padrón',model_id:model.id,state:'code',code}]);await kw('ir.config_parameter','set_param',[PARAM,String(id)]);}
 return {accion_id:id,empresa:COMPANY,clave_privada:'permanece_en_odoo'};
}
async function cache(method='GET',data?:any) {
 const res=await fetch(SB+'/rest/v1/portal_arca_cache?id=eq.'+CACHE,{method,headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 if(!res.ok)throw Error('No se pudo acceder al ticket de ARCA.');
 return method==='GET'?(await res.json())[0]:null;
}
async function cachedTicket(){const c=await cache();if(!c?.cifrada||Date.parse(c.vence)<Date.now()+5*60e3)return null;try{return JSON.parse(await decrypt(c.cifrada,CACHE));}catch{return null;}}
function xml(x:string,tag:string){return x.match(new RegExp('<(?:\\w+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?'+tag+'>'))?.[1]?.trim()||'';}
const unescape=(x:string)=>x.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
export async function rosArcaTicket(){
 let saved=await cachedTicket();if(saved)return saved;
 const lock=await fetch(SB+'/rest/v1/rpc/portal_arca_tomar',{method:'POST',headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':'application/json'},body:'{}'});
 if(!lock.ok)throw Error('No se pudo reservar la renovación de ARCA.');
 if(!await lock.json()) {for(let n=0;n<5;n++){await new Promise(r=>setTimeout(r,1000));saved=await cachedTicket();if(saved)return saved;}throw Error('ARCA se está renovando. Volvé a consultar en unos segundos.');}
 try {
  saved=await cachedTicket();if(saved)return saved;
  const id=Number(await kw('ir.config_parameter','get_param',[PARAM])||0);if(!id)throw Error('Falta instalar la firma de padrón ARCA en Rosaint.');
  const result=await kw('ir.actions.server','run',[[id]],{context:{active_model:'res.company',active_id:COMPANY,active_ids:[COMPANY]}});
  const p=result?.params;if(result?.tag!=='rosaint_arca_signature'||!p?.tra||!p.signature||!p.certificate)throw Error('Odoo no devolvió la firma del ticket.');
  const cms=signedCms(p.tra,p.signature,p.certificate);
  const soap=`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><ws:loginCms><ws:in0>${cms}</ws:in0></ws:loginCms></soapenv:Body></soapenv:Envelope>`;
  const response=await fetch('https://wsaa.afip.gov.ar/ws/services/LoginCms',{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:soap,signal:AbortSignal.timeout(25000)});
  const body=await response.text(),fault=unescape(xml(body,'faultstring'));
  if(fault)throw Error('ARCA WSAA: '+fault.slice(0,300));
  const ticket=unescape(xml(body,'loginCmsReturn'));
  const token=xml(ticket,'token'),sign=xml(ticket,'sign'),expires=xml(ticket,'expirationTime');
  if(!response.ok||!token||!sign||!Number.isFinite(Date.parse(expires)))throw Error('ARCA no devolvió un ticket válido.');
  const value={token,sign,expiration_time:expires,cuit:String(p.cuit).replace(/\D/g,'')};
  await cache('PATCH',{cifrada:await encrypt(JSON.stringify(value),CACHE),vence:expires});
  return value;
 } finally {await cache('PATCH',{bloqueado_hasta:null});}
}

import { kw, COMPANY, SB, SERVICE } from './odoo.ts';
import { signedCms } from './cms.ts';
import { encrypt,decrypt } from './secrets.ts';
// Firma del ticket de ARCA para ws_sr_constancia_inscripcion (consulta de padrón del alta profesional).
// 10/11/2026: la firma se hace ACÁ, con el certificado propio del Core ("rosaint-core", CUIT 20310924130,
// vence 30/06/2028) guardado en los secretos ARCA_CORE_CERT_B64 y ARCA_CORE_KEY_B64 (PEM en base64).
// Antes la hacía una acción de servidor de Odoo con la clave de facturación; se sacó porque Odoo cobra
// mantenimiento por cada línea de código propio. La clave de facturación de Odoo no se usa ni se toca.
const CACHE='rosaint-2-constancia-production';
function pemDer(pem:string){const clean=pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');return Uint8Array.from(atob(clean),c=>c.charCodeAt(0));}
function credenciales(){
 const cert=Deno.env.get('ARCA_CORE_CERT_B64')||'', key=Deno.env.get('ARCA_CORE_KEY_B64')||'';
 if(!cert||!key)throw Error('Falta el certificado del Core para ARCA (secretos ARCA_CORE_CERT_B64 y ARCA_CORE_KEY_B64).');
 return {certB64:cert,keyPem:atob(key)};
}
async function firmar(tra:string,keyPem:string){
 const k=await crypto.subtle.importKey('pkcs8',pemDer(keyPem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const sig=new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',k,new TextEncoder().encode(tra)));
 let s='';for(const b of sig)s+=String.fromCharCode(b);return btoa(s);
}
// Ya no instala nada en Odoo: verifica que la firma local esté lista (el nombre queda por compatibilidad).
export async function installArcaSigner() {
 const {certB64,keyPem}=credenciales();
 await firmar('prueba',keyPem);
 signedCms('prueba',await firmar('prueba',keyPem),certB64);
 return {firma:'supabase',certificado:'rosaint-core',empresa:COMPANY,odoo:'sin código propio'};
}
async function cache(method='GET',data?:any) {
 const res=await fetch(SB+'/rest/v1/portal_arca_cache?id=eq.'+CACHE,{method,headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 if(!res.ok)throw Error('No se pudo acceder al ticket de ARCA.');
 return method==='GET'?(await res.json())[0]:null;
}
async function cachedTicket(){const c=await cache();if(!c?.cifrada||Date.parse(c.vence)<Date.now()+5*60e3)return null;try{return JSON.parse(await decrypt(c.cifrada,CACHE));}catch{return null;}}
function xml(x:string,tag:string){return x.match(new RegExp('<(?:\\w+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?'+tag+'>'))?.[1]?.trim()||'';}
const unescape=(x:string)=>x.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const isoZ=(d:Date)=>d.toISOString().slice(0,19)+'Z';
export async function rosArcaTicket(){
 let saved=await cachedTicket();if(saved)return saved;
 const lock=await fetch(SB+'/rest/v1/rpc/portal_arca_tomar',{method:'POST',headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':'application/json'},body:'{}'});
 if(!lock.ok)throw Error('No se pudo reservar la renovación de ARCA.');
 if(!await lock.json()) {for(let n=0;n<5;n++){await new Promise(r=>setTimeout(r,1000));saved=await cachedTicket();if(saved)return saved;}throw Error('ARCA se está renovando. Volvé a consultar en unos segundos.');}
 try {
  saved=await cachedTicket();if(saved)return saved;
  const {certB64,keyPem}=credenciales();
  const empresa=(await kw('res.company','read',[[COMPANY],['vat']]))[0];
  const now=Date.now();
  const tra=`<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now/1000)}</uniqueId><generationTime>${isoZ(new Date(now-3*60e3))}</generationTime><expirationTime>${isoZ(new Date(now+11*3600e3))}</expirationTime></header><service>ws_sr_constancia_inscripcion</service></loginTicketRequest>`;
  const cms=signedCms(tra,await firmar(tra,keyPem),certB64);
  const soap=`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><ws:loginCms><ws:in0>${cms}</ws:in0></ws:loginCms></soapenv:Body></soapenv:Envelope>`;
  const response=await fetch('https://wsaa.afip.gov.ar/ws/services/LoginCms',{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:soap,signal:AbortSignal.timeout(25000)});
  const body=await response.text(),fault=unescape(xml(body,'faultstring'));
  if(fault)throw Error('ARCA WSAA: '+fault.slice(0,300));
  const ticket=unescape(xml(body,'loginCmsReturn'));
  const token=xml(ticket,'token'),sign=xml(ticket,'sign'),expires=xml(ticket,'expirationTime');
  if(!response.ok||!token||!sign||!Number.isFinite(Date.parse(expires)))throw Error('ARCA no devolvió un ticket válido.');
  const value={token,sign,expiration_time:expires,cuit:String(empresa?.vat||'').replace(/\D/g,'')};
  await cache('PATCH',{cifrada:await encrypt(JSON.stringify(value),CACHE),vence:expires});
  return value;
 } finally {await cache('PATCH',{bloqueado_hasta:null});}
}

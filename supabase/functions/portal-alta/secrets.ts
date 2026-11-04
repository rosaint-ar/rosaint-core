import { SB, SERVICE } from './odoo.ts';
let key: CryptoKey | undefined;
async function encryptionKey() {
  if(!key) {
    const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(SERVICE),'HKDF',false,['deriveKey']);
    key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode('rosaint-portal-alta'),info:new TextEncoder().encode('secreto-temporal-v1')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  return key;
}
export function validPassword(value:unknown,email:string) {
  return typeof value==='string' && value.length>=8 && value.length<=64 && /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value) && /\d/.test(value) && value.toLowerCase()!==email.toLowerCase();
}
export function passwordContext(d:any) { return `clave:${d.documento_tipo||'CUIT'}:${d.documento||d.cuit}:${d.email}`; }
export async function encrypt(value:string,context:string) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(context)},await encryptionKey(),new TextEncoder().encode(value)));
  return 'v1.'+btoa(String.fromCharCode(...iv,...cipher));
}
export async function decrypt(value:string,context:string) {
  if(!value.startsWith('v1.'))throw Error('Formato de secreto inválido');
  const bytes=Uint8Array.from(atob(value.slice(3)),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:new TextEncoder().encode(context)},await encryptionKey(),bytes.slice(12)));
}
export async function readPassword(a:any):Promise<string|null> {
  const response=await fetch(SB+'/rest/v1/portal_altas_clave?alta_id=eq.'+encodeURIComponent(a.id)+'&select=cifrada,vence',{headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE}});
  if(!response.ok)throw Error('No se pudo consultar la contraseña pendiente.');
  const row=(await response.json())[0];
  if(!row||Date.parse(row.vence)<=Date.now())return null;
  try{return await decrypt(row.cifrada,passwordContext(a.datos));}catch{return null;}
}

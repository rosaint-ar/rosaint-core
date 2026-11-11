import {tipoOracion} from './name-format.ts';
const fiscal:Record<string,number>={RI:1,MONO:6,CF:5,EXENTO:4};
const clean=(v:any)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();
const phone=(v:any)=>{let n=String(v||'').replace(/\D/g,'');if(n.startsWith('0054'))n=n.slice(2);if(n.startsWith('54')&&[12,13].includes(n.length))n=n.slice(2);if(n.length===11&&n.startsWith('9'))n=n.slice(1);return n;};
const equal=(field:string,a:any,b:any)=>field==='phone'?phone(a)===phone(b):field==='state_id'?clean(a).replace(/\s*\(ar\)$/,'')===clean(b).replace(/\s*\(ar\)$/,''):clean(a)===clean(b);
export function automaticApprovalSummary(a:any){
 const o=a.analisis?.odoo,users=o?.usuarios||[],fichas=o?.fichas;
 const unavailable=(reason:string)=>({available:false,reason,changes:[]});
 if(!['recibida','revisar','error_aprobacion'].includes(a.estado))return unavailable('Solicitud resuelta o en proceso.');
 if(!Array.isArray(fichas))return unavailable('No pudimos comprobar los datos actuales en Odoo.');
 if(fichas.length>1)return unavailable('Hay más de un cliente coincidente.');
 const fid=fiscal[a.datos.condicion_iva];if(!fid)return unavailable('Falta definir la condición de facturación.');
 if(!fichas.length){
  if(users.length)return unavailable('El correo ya tiene un acceso que necesita revisión.');
  const ar=a.analisis?.arca;
  if(fid!==5&&(!ar?.ok||!ar.existe||ar.sin_constancia||ar.estado!=='ACTIVO'||fiscal[ar.iva]!==fid))return unavailable('No pudimos confirmar la condición fiscal declarada.');
  return {available:true,new_client:true,reason:fid===5?'Cliente nuevo. Consumidor final: no necesita constancia de inscripción.':'Cliente nuevo. Condición fiscal comprobada.',changes:[],fiscal_id:fid,resume:!!a.aprobacion,access_change:false,previous_logins:[]};
 }
 const p=fichas[0];
 if(!p.active||(p.company_id&&p.company_id[0]!==2))return unavailable('La ficha está archivada o pertenece a otra compañía.');
 if(!p.documento_coincide)return unavailable('El documento declarado no coincide con el cliente existente.');
 if(p.l10n_ar_afip_responsibility_type_id?.[0]!==fid)return unavailable('La condición fiscal cambió y requiere revisión.');
 if(users.some((u:any)=>!u.share||u.partner_id?.[0]!==p.id))return unavailable('Hay un acceso interno o vinculado a otro cliente.');
 if(users.length>1&&!(a.aprobacion?.reemplazar&&a.resultado?.user_id&&users.some((u:any)=>u.id===a.resultado.user_id)))return unavailable('Hay varios accesos y necesitamos revisar cuál conservar.');
 const previous=users.filter((u:any)=>u.active&&clean(u.login)!==clean(a.email)).map((u:any)=>u.login);
 const changedEmail=clean(p.email)!==clean(a.email)||previous.length>0;
 if(changedEmail&&(!clean(p.name)||clean(p.name)!==clean(a.datos.razon)||phone(p.phone).length<10||phone(p.phone)!==phone(a.datos.telefono)))return unavailable('El correo cambió y los datos restantes no permiten identificar con claridad al cliente.');
 if(a.aprobacion?.actualizar_condiciones)return unavailable('La aprobación anterior incluye condiciones comerciales especiales.');
 const fields=[['name','Nombre',p.name,tipoOracion(a.datos.razon)],['x_studio_nombre_fantasia','Nombre comercial',p.x_studio_nombre_fantasia,a.datos.cartel],['email','Correo',p.email,a.email],['phone','Teléfono',p.phone,a.datos.telefono],['street','Domicilio',p.street,a.datos.calle],['street2','Piso, departamento o referencia',p.street2,a.datos.complemento],['city','Localidad',p.city,a.datos.localidad],['state_id','Provincia',p.state_id?.[1],a.datos.provincia]];
 const changes=fields.filter(([f,,current,value])=>value&&!equal(f,current,value)).map(([field,label,current,value])=>({field,label,current:String(current||'Sin dato'),proposed:String(value)}));
 return {available:true,new_client:false,reason:changedEmail?'Documento, nombre y teléfono coinciden con el cliente existente.':'Cliente existente identificado por documento y correo.',changes,fiscal_id:fid,resume:!!a.aprobacion,access_change:previous.length>0,previous_logins:previous,existing_access:users.some((u:any)=>u.active)};
}

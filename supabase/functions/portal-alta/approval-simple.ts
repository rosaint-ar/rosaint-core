// A human still approves. Only matching existing customers get the short path.
const fiscal:Record<string,number>={RI:1,MONO:6,CF:5,EXENTO:4};
const clean=(v:any)=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();
const normal=(field:string,v:any)=>field==='phone'?String(v||'').replace(/\D/g,''):field==='state_id'?clean(v).replace(/\s*\(ar\)$/,''):clean(v);
export function simpleApprovalSummary(a:any){
 const fichas=a.analisis?.odoo?.fichas,users=a.analisis?.odoo?.usuarios||[];
 const unavailable=(reason:string)=>({available:false,reason,changes:[]});
 if(!['recibida','revisar','error_aprobacion'].includes(a.estado))return unavailable('Solicitud resuelta o en proceso.');
 if(!Array.isArray(fichas))return unavailable('No se pudo comprobar la ficha de Odoo.');
 if(fichas.length!==1)return unavailable(fichas.length?'Hay varias fichas coincidentes.':'Cliente nuevo: revisá sus condiciones de alta.');
 const p=fichas[0];
 if(!p.active||p.company_id&&p.company_id[0]!==2)return unavailable('La ficha está archivada o pertenece a otra empresa.');
 if(!p.documento_coincide||clean(p.email)!==clean(a.email))return unavailable('El correo o el documento difieren de la ficha.');
 if(!fiscal[a.datos.condicion_iva]||p.l10n_ar_afip_responsibility_type_id?.[0]!==fiscal[a.datos.condicion_iva])return unavailable('La condición fiscal declarada difiere de Odoo.');
 if(users.some((u:any)=>!u.share||u.partner_id?.[0]!==p.id||clean(u.login)!==clean(a.email)))return unavailable('Hay otro acceso vinculado que necesita revisión.');
 if(a.aprobacion?.actualizar_condiciones)return unavailable('La aprobación anterior incluye condiciones comerciales especiales.');
 const fields=[['name','Nombre',p.name,a.datos.razon],['x_studio_nombre_fantasia','Nombre comercial',p.x_studio_nombre_fantasia,a.datos.cartel],['email','Correo',p.email,a.email],['phone','Teléfono',p.phone,a.datos.telefono],['street','Domicilio',p.street,a.datos.calle],['city','Localidad',p.city,a.datos.localidad],['state_id','Provincia',p.state_id?.[1],a.datos.provincia]];
 const changes=fields.filter(([field,,current,value])=>value&&normal(field,current)!==normal(field,value)).map(([field,label,current,value])=>({field,label,current:String(current||'Sin dato'),proposed:String(value)}));
 return {available:true,reason:'Correo, documento y condición fiscal coinciden con Odoo.',changes,resume:a.estado==='error_aprobacion',existing_access:users.some((u:any)=>u.active),fiscal_id:fiscal[a.datos.condicion_iva]};
}

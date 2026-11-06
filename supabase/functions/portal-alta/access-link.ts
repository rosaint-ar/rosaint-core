import {kw,OD,COMPANY} from './odoo.ts';

// Generate Odoo's signed reset URL through its standard template preview.
// No mail is created/sent, no password is read/written, no token is persisted here.
export async function accessLink(a:any,dryRun=false,call=kw){
 if(a.estado!=='aprobada')throw Error('Primero aprobá el acceso del cliente.');
 const uid=a.resultado?.user_id,pid=a.resultado?.partner_id;
 if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(pid)||pid<1)throw Error('La aprobación no tiene un acceso vinculado.');
 const [u]=await call('res.users','read',[[uid]],{fields:['id','login','partner_id','active','share','groups_id','company_ids'],context:{active_test:false}});
 const [portal]=await call('ir.model.data','search_read',[[['module','=','base'],['name','=','group_portal']]],{fields:['res_id'],limit:1});
 if(!u?.active||!u.share||!portal?.res_id||!u.groups_id?.includes(portal.res_id)||!u.company_ids?.includes(COMPANY)||u.partner_id?.[0]!==pid||String(u.login).toLowerCase()!==String(a.email).toLowerCase())throw Error('El acceso no coincide con la aprobación o no está habilitado como portal de VELAZQUEZ.');
 const peers=await call('res.users','search_read',[[['partner_id','=',pid]]],{fields:['id'],context:{active_test:false},limit:2});
 if(peers.length!==1||peers[0].id!==uid)throw Error('Hay más de un acceso en la ficha. Revisá el cliente antes de generar un enlace.');
 const [ref]=await call('ir.model.data','search_read',[[['module','=','auth_signup'],['name','=','set_password_email']]],{fields:['res_id'],limit:1});
 if(!ref?.res_id)throw Error('No se encontró la plantilla de acceso de Odoo.');
 const [template]=await call('mail.template','read',[[ref.res_id]],{fields:['model','report_template_ids']});
 if(template?.model!=='res.users'||template.report_template_ids?.length)throw Error('La plantilla de acceso requiere revisión.');
 const rawHours=await call('ir.config_parameter','get_param',['auth_signup.reset_password.validity.hours','4']);
 const hours=Number(rawHours);
 if(!Number.isInteger(hours)||hours<=0)throw Error('La vigencia del enlace de Odoo no es válida.');
 if(dryRun)return {ensayo:true,usuario_id:uid,horas:hours};
 let preview:number|undefined;
 try{
  await call('res.partner','signup_prepare',[[pid]],{signup_type:'reset'});
  preview=await call('mail.template.preview','create',[{mail_template_id:ref.res_id,resource_ref:`res.users,${uid}`}]);
  const [rendered]=await call('mail.template.preview','read',[[preview]],{fields:['body_html','error_msg']});
  if(rendered?.error_msg)throw Error('render');
  const urls=Array.from(String(rendered?.body_html||'').matchAll(/href\s*=\s*["']([^"']+)["']/gi),m=>m[1].replace(/&amp;/g,'&').replace(/&#38;/g,'&'));
  const base=new URL(OD);
  const link=urls.map(s=>{try{return new URL(s,base);}catch{return null;}}).find(url=>url?.origin===base.origin&&url.pathname==='/web/reset_password'&&url.searchParams.get('token'));
  if(!link)throw Error('link');
  link.searchParams.set('redirect','/inicio');
  return {url:link.href,horas:hours,usuario_id:uid};
 }catch{
  // Never return a rendered email, RPC detail or token-bearing error.
  throw Error('Odoo no pudo generar el enlace. El acceso y la contraseña actual se conservan.');
 }finally{
  if(preview)try{await call('mail.template.preview','unlink',[[preview]]);}catch{/* Odoo also expires transient previews. */}
 }
}

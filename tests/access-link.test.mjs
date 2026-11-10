import assert from 'node:assert/strict';
globalThis.Deno={env:{get:k=>({ODOO_URL:'https://odoo.test',ODOO_DB:'test',ODOO_LOGIN:'test',ODOO_KEY:'test',SUPABASE_URL:'https://sb.test',SUPABASE_SERVICE_ROLE_KEY:'test-service'}[k])}};
const {accessLink}=await import('../supabase/functions/portal-alta/access-link.ts');
const a={estado:'aprobada',email:'cliente@example.com',resultado:{user_id:31,partner_id:149}};
let calls=[],user,peers,html;
function reset(){calls=[];user={id:31,login:a.email,partner_id:[149,'Cliente'],active:true,share:true,groups_id:[10],company_ids:[2,1]};peers=[{id:31}];html='<a href="https://odoo.test/web/reset_password?db=test&amp;token=TOKEN_PRUEBA">Elegir</a>';}
async function call(model,method,args,kwargs){
 calls.push({model,method,args,kwargs});
 if(model==='res.users')return method==='read'?[user]:peers;
 if(model==='ir.model.data')return [{res_id:args[0].some(d=>d[2]==='group_portal')?10:11}];
 if(model==='mail.template')return [{model:'res.users',report_template_ids:[]}];
 if(model==='ir.config_parameter')return '4';
 if(model==='res.partner'&&method==='signup_prepare'){assert.deepEqual(args,[[149]]);assert.equal(kwargs.signup_type,'reset');return true;}
 if(model==='mail.template.preview'){
  if(method==='create'){assert.equal(args[0].resource_ref,'res.users,31');return 77;}
  if(method==='read')return [{body_html:html,error_msg:false}];
  if(method==='unlink')return true;
 }
 throw Error('Operación no autorizada en prueba');
}
reset();let r=await accessLink(a,true,call);assert.equal(r.ensayo,true);assert.ok(calls.every(c=>['read','search_read','get_param'].includes(c.method)));
reset();r=await accessLink(a,false,call);assert.equal(r.horas,4);assert.equal(new URL(r.url).searchParams.get('redirect'),'/inicio');assert.equal(new URL(r.url).searchParams.get('token'),'TOKEN_PRUEBA');assert.ok(calls.some(c=>c.model==='mail.template.preview'&&c.method==='unlink'));assert.ok(!calls.some(c=>c.model==='mail.mail'||c.method==='action_reset_password'||(c.model==='res.users'&&c.method==='write')));
for(const changes of [{active:false},{share:false},{groups_id:[9]},{company_ids:[1]},{login:'otra@example.com'},{partner_id:[999,'Otro']}]){reset();Object.assign(user,changes);await assert.rejects(()=>accessLink(a,false,call));assert.ok(!calls.some(c=>c.method==='signup_prepare'));}
reset();peers.push({id:32});await assert.rejects(()=>accessLink(a,false,call));assert.ok(!calls.some(c=>c.method==='signup_prepare'));
reset();await assert.rejects(()=>accessLink({...a,estado:'recibida'},false,call));assert.equal(calls.length,0);
reset();html='<a href="https://evil.test/web/reset_password?token=SECRETO">Enlace</a>';await assert.rejects(()=>accessLink(a,false,call),err=>!err.message.includes('SECRETO'));assert.ok(calls.some(c=>c.method==='unlink'));
console.log('11 casos de enlace: titularidad, portal, compañía, estado, ensayo, sin correo, limpieza y URL segura verificados.');

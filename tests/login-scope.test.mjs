import assert from 'node:assert/strict';
globalThis.Deno={env:{get:k=>({ODOO_URL:'https://odoo.test',ODOO_DB:'test',ODOO_LOGIN:'test',ODOO_KEY:'test',SUPABASE_URL:'https://sb.test',SUPABASE_SERVICE_ROLE_KEY:'test-service'}[k])}};
let permitted=[2], calls=[];
globalThis.fetch=async(url,options)=>{
 assert.equal(new URL(url).hostname,'odoo.test');
 const p=JSON.parse(options.body).params;
 if(p.service==='common')return Response.json({result:2});
 const [, , ,model,method,args,kwargs]=p.args;
 calls.push({model,method,args,kwargs});
 assert.equal(model,'res.users');
 if(method==='read')return Response.json({result:[{id:2,company_ids:permitted}]});
 assert.equal(method,'search_read');
 return Response.json({result:[]});
};
const {lookupLogin}=await import('../supabase/functions/portal-alta/odoo.ts');
for(const scope of [[2],[2,1]]){
 permitted=scope;calls=[];
 await lookupLogin('customer@example.com');
 const search=calls.find(c=>c.method==='search_read');
 assert.deepEqual(search.args,[[['login','=ilike','customer@example.com']]]);
 assert.deepEqual(search.kwargs.context.allowed_company_ids,scope);
 assert.equal(search.kwargs.context.company_id,2);
 assert.equal(search.kwargs.context.active_test,false);
 assert.ok(calls.every(c=>['read','search_read'].includes(c.method)));
 assert.ok(!search.kwargs.fields.includes('password'));
}
console.log('Consulta de acceso limitada al correo y a las compañías ya permitidas: verificada.');

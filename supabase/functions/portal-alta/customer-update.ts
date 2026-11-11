import {tipoOracion} from './name-format.ts';
// Existing customer data is preserved unless an approver selects individual fields.
export const CONTACT_FIELDS=['name','x_studio_nombre_fantasia','email','phone','street','street2','city','state_id'];
// JSONB does not preserve object key order. A retry compares values, not serialization order.
export function sameApproval(a:any,b:any){const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return JSON.stringify(stable(a))===JSON.stringify(stable(b));}
const labels={name:'Nombre',x_studio_nombre_fantasia:'Nombre comercial',email:'Correo de contacto',phone:'Teléfono',street:'Calle y número',street2:'Piso, departamento o referencia',city:'Localidad',state_id:'Provincia'};
const text=(v:any)=>String(v||'').trim();
export function proposedContact(d:any,stateId:number){return {name:tipoOracion(d.razon),x_studio_nombre_fantasia:text(d.cartel),email:text(d.email).toLowerCase(),phone:text(d.telefono),street:text(d.calle),street2:text(d.complemento),city:text(d.localidad),state_id:stateId};}
export function selectedContactFields(value:any){if(value===undefined)return [];if(!Array.isArray(value)||value.some(k=>typeof k!=='string'||!CONTACT_FIELDS.includes(k)))throw Error('Selección de datos inválida.');return [...new Set(value)].sort();}
export function contactChanges(partner:any,d:any,stateId:number){
 const proposed=proposedContact(d,stateId);
 return CONTACT_FIELDS.flatMap(field=>{const current=field==='state_id'?partner.state_id?.[0]||false:partner[field]||'';const next=proposed[field];if(!next||text(current)===text(next))return [];return [{field,label:labels[field],current,proposed:next,current_label:field==='state_id'?partner.state_id?.[1]||'':text(current),proposed_label:field==='state_id'?d.provincia:text(next)}];});
}
export function planContactUpdate(partner:any,d:any,stateId:number,selected:any,version:string,prior:any=null){
 const fields=selectedContactFields(selected),proposed=proposedContact(d,stateId),values:any={},before:any={};
 if(!fields.length)return {values,before,already_applied:false};
 for(const field of fields){if(!proposed[field])throw Error('No se pueden borrar datos existentes desde el alta.');values[field]=proposed[field];before[field]=field==='state_id'?partner.state_id?.[0]||false:partner[field]||'';}
 if(prior){if(!sameApproval(prior.values,values))throw Error('El reintento debe conservar los cambios revisados.');const already=fields.every(f=>text(before[f])===text(values[f]));if(already)return {...prior,already_applied:true};if(fields.some(f=>text(before[f])!==text(prior.before[f])))throw Error('Los datos del cliente cambiaron durante la aprobación. Revisá Odoo antes de continuar.');}
 else if(!version||partner.write_date!==version)throw Error('La ficha del cliente cambió. Volvé a revisar los datos de Odoo antes de aprobar.');
 return {values,before,already_applied:false};
}

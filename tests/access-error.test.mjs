import assert from 'node:assert/strict';
import {accessCreationError} from '../supabase/functions/portal-alta/access-error.ts';
for(const kind of ['odoo.exceptions.UserError','odoo.exceptions.ValidationError','psycopg2.errors.NotNullViolation']){
 const result=accessCreationError({message:'Información remota sensible ElegidaSegura123',odooErrorType:kind});
 assert.ok(result.includes(kind.split('.').pop()));assert.ok(!result.includes('ElegidaSegura123'));
}
assert.ok(!accessCreationError({message:'ElegidaSegura123',odooErrorType:'secreto.ElegidaSegura123'}).includes('ElegidaSegura123'));
console.log('4 pruebas de diagnóstico sin exposición de valores aprobadas.');
assert.match(accessCreationError({message:'No puede haber dos usuarios con el mismo nombre de inicio de sesión!',odooLoginConflict:true}),/Recuperá ese acceso/);
assert.ok(!accessCreationError({message:'secreto',odooErrorType:'odoo.exceptions.ValidationError',odooErrorFrames:['secreto']}).includes('secreto'));
console.log('2 pruebas de conflicto de acceso y retirada de trazas aprobadas.');

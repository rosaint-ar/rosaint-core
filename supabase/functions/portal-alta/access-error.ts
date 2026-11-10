// Only known categories are exposed. Raw remote messages may contain credentials.
export function accessCreationError(error:unknown){
 const m=String((error as any)?.message||'').toLowerCase();
 const base='No se pudo crear el acceso. Reintentá desde la aprobación incompleta.';
 const kind=String((error as any)?.odooErrorType||'');
 if((error as any)?.odooLoginConflict===true)return 'Odoo ya tiene un acceso con ese correo, posiblemente archivado o en otra empresa. Recuperá ese acceso antes de reintentar la aprobación.';
 if(/notification|notificaci[oó]n/.test(m))return base+' Odoo rechazó la configuración de notificaciones del usuario.';
 if(/(?:^|\.)(AccessDenied|AccessError)$/.test(kind))return base+' Odoo denegó esta operación de acceso (control de seguridad).';
 if(error instanceof SyntaxError||/unexpected token|abort|timeout|fetch failed|odoo no respondió/.test(m))return base+' La respuesta de Odoo no permitió completar la operación.';
 if(/(?:^|\.)(AssertionError|TypeError|ValueError)$/.test(kind))return base+' Odoo rechazó la estructura de la creación ('+kind.split('.').pop()+').';
 if(/password|contrase[nñ]a/.test(m)&&/short|length|longitud|caracter|character|least|m[ií]nimo|policy|pol[ií]tica/.test(m))return base+' Odoo rechazó la contraseña por su política de seguridad.';
 if(/mandatory|required field|campo obligatorio|obligatori[oa]|not-null/.test(m))return base+' Odoo exige un dato obligatorio en el usuario.';
 if(/invalid field|campo no v[aá]lido|campo inv[aá]lido/.test(m))return base+' Un campo del alta no es compatible con esta versión de Odoo.';
 if(/access rights|permission|not allowed|not authorized|derechos de acceso|permisos|no tiene acceso|no est[aá] autorizado|no puede crear|no puede modificar|no est[aá] permitido|restricciones de seguridad/.test(m))return base+' La integración no tiene permiso para crear este usuario.';
 if(/more than one user type|m[aá]s de un tipo de usuario|user types|tipos de usuario/.test(m))return base+' Odoo detectó tipos de usuario incompatibles.';
 if(/same login|mismo.*login|mismo.*usuario|already exists|ya existe|unique/.test(m))return base+' Odoo ya tiene un acceso con ese identificador.';
 if(/company|companies|compa[nñ][ií]a|empresa/.test(m))return base+' Odoo detectó una incompatibilidad de empresa en el usuario.';
 const known=kind.split('.').pop()||'';
 // An allowlist of exception names gives support a useful category without
 // exposing remote messages, SQL, submitted values or credentials.
 if(['UserError','ValidationError','NotNullViolation','CheckViolation','IntegrityError','UniqueViolation','KeyError','AttributeError','ProgrammingError','UndefinedColumn'].includes(known)){
  return base+' Código técnico: '+known+'.';
 }
 return base;
}

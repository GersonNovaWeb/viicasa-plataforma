import {id,hash,fail} from '../viicasa-backend/src/lib.js';
import {key,now,auditDoc} from '../viicasa-backend/src/firestore-store.js';

// Optional deployment-only, one-time provisioning. The secret hash must arrive
// through Hostinger's private environment, never source code or a public route.
export async function ensureConfiguredAdmin(store,env,{demo,projectId}){
  if(env.ADMIN_BOOTSTRAP_ENABLED!=='true')return {state:'disabled'};
  if(demo||projectId!=='viicasa')fail(400,'El alta administrativa requiere el proyecto real de VII');
  const email=env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const encoded=env.ADMIN_BOOTSTRAP_PASSWORD_HASH;
  const name=env.ADMIN_BOOTSTRAP_NAME?.trim()||'Administración VII';
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||name.length<2||name.length>120||typeof encoded!=='string'||!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded))fail(400,'Configuración de alta administrativa inválida');
  const userId=id(),fingerprint=hash(encoded);
  return store.transaction(async tx=>{
    const marker=await tx.get('system','password_admin_bootstrap');
    const index=await tx.get('unique_keys',key('email',email));
    if(marker){
      if(marker.email!==email||marker.fingerprint!==fingerprint||index?.owner!==marker.user_id)fail(409,'El alta inicial ya fue utilizada; administra los accesos desde el panel');
      // Password changes and revocation remain intact across redeployments.
      return {state:'already_configured'};
    }
    if(index)fail(409,'El correo administrativo ya existe; no se modificó la cuenta');
    const created_at=now();
    tx.create('users',userId,{email,name,password_hash:encoded,role:'admin',active:true,auth_version:1,created_at});
    tx.create('unique_keys',key('email',email),{owner:userId});
    tx.create('system','password_admin_bootstrap',{email,user_id:userId,fingerprint,created_at});
    auditDoc(tx,userId,'admin.deployment_bootstrap',userId);
    return {state:'created'};
  });
}

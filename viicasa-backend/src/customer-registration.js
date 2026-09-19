import {id,hash} from './lib.js';
import {key,now,afterMinutes} from './firestore-store.js';

// Registration location is an IP estimate, not nationality or verified residence.
// No raw IP, precise location or browser-provided country is persisted.
export function registrationRegion(country) {
  const code=typeof country==='string'&&/^[A-Z]{2}$/.test(country)&&!['ZZ','XX'].includes(country)?country:null;
  return {country:code,region:code==='CA'?'canada':code?'rest_of_world':'unknown',source:code?'ip':'unavailable'};
}

// Call only after Firebase has verified the Google identity on the server.
export async function saveGoogleCustomer(store,user,country,secret) {
  const accountId=key('google',user.uid);
  return store.transaction(async tx=>{
    const account=await tx.get('platform_accounts',accountId),gid=account?.guest_id||id();
    const old=await tx.get('guests',gid),timestamp=now();
    // Preserve first registration even when the customer travels or changes VPN.
    // Legacy accounts have no historic IP evidence: never fabricate a country.
    const registration=old?.registration||{...registrationRegion(account?null:country),recorded_at:account?null:timestamp};
    const record={...old,expires_at:afterMinutes(30*24*60),created_at:old?.created_at||timestamp,
      google_uid:user.uid,name:user.name||user.email,email:user.email,registration};
    tx.put('guests',gid,record);
    tx.put('platform_accounts',accountId,{...account,guest_id:gid});
    tx.create('guest_tokens',hash(secret),{guest_id:gid,expires_at:afterMinutes(30*24*60)});
    return record;
  });
}

export const publicCustomer = row => ({name:row.name||'',email:row.email||'',created_at:row.created_at||null,
  registration:row.registration||{...registrationRegion(null),recorded_at:null}});

export async function listRegisteredCustomers(store,{limit=20,cursor}={}) {
  // Document-id pagination includes older accounts without creation metadata and
  // requires no new composite index. Anonymous guests are not registered users.
  const accounts=await store.list('platform_accounts',{order:[['__name__','asc']],limit:limit+1,...(cursor?{cursor:[cursor]}:{})});
  const page=accounts.slice(0,limit);
  const rows=await Promise.all(page.map(async a=>{const row=await store.get('guests',a.guest_id);return row?.google_uid?{id:a.id,...publicCustomer(row)}:null;}));
  return {items:rows.filter(Boolean),next_cursor:accounts.length>limit?page.at(-1).id:null,limit};
}

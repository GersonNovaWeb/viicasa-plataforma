import pg from 'pg';

export function databaseIdentity(value){
  let url;try{url=new URL(value);}catch{throw Error('Invalid Phase 2 PostgreSQL connection URL.');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.pathname.length<2)throw Error('Phase 2 requires a PostgreSQL database URL.');
  // TLS is configured explicitly. Never accept downgrade parameters inside URLs.
  for(const name of ['ssl','sslmode','sslcert','sslkey','sslrootcert'])if(url.searchParams.has(name))throw Error('Configure PHASE2_DATABASE_SSL explicitly instead of URL TLS parameters.');
  return url.hostname+':'+(url.port||5432)+url.pathname;
}
export function postgresDatabase(connectionString,{ssl=true,Pool=pg.Pool}={}){
  databaseIdentity(connectionString);
  const pool=new Pool({connectionString,ssl:ssl?{rejectUnauthorized:true}:false,max:8,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
  // Idle socket errors are observable without logging URLs or credentials.
  pool.on('error',()=>console.error('Phase 2 database connection interrupted.'));
  const wrap=client=>({query:(sql,args)=>client.query(sql,args),exec:sql=>client.query(sql)});
  const transaction=async fn=>{
    const client=await pool.connect();let begun=false;
    try{await client.query('BEGIN');begun=true;const result=await fn(wrap(client));await client.query('COMMIT');return result;}
    catch(error){if(begun)try{await client.query('ROLLBACK');}catch{}throw error;}
    finally{client.release();}
  };
  async function exclusiveJob(key,fn){
    const client=await pool.connect();let locked=false;
    try{locked=(await client.query('SELECT pg_try_advisory_lock($1) AS acquired',[key])).rows[0].acquired;if(!locked)return{skipped:true,reason:'another_worker'};return await fn();}
    finally{if(locked)try{await client.query('SELECT pg_advisory_unlock($1)',[key]);}catch{}client.release();}
  }
  return{...wrap(pool),transaction,exclusiveJob,close:()=>pool.end(),waitReady:pool.query('SELECT 1')};
}

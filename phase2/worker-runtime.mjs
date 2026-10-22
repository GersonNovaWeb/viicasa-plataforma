import {randomUUID} from 'node:crypto';
export function backgroundProcessor(db,steps,{automaticStripeCharging=false}={}){
  let running=false,active;
  const execute=async()=>{
    const id=randomUUID(),results=[];await db.query("INSERT INTO worker_runs(id,status) VALUES($1,'running')",[id]);
    for(const [name,task] of steps){try{await task();results.push({name,ok:true});}catch{results.push({name,ok:false,error:'Operation incomplete. Review the corresponding queue.'});}await db.query('UPDATE worker_runs SET steps=$2 WHERE id=$1',[id,JSON.stringify(results)]);}
    const status=results.every(r=>r.ok)?'completed':'partial';await db.query('UPDATE worker_runs SET status=$2,finished_at=now() WHERE id=$1',[id,status]);
    await db.query('DELETE FROM worker_runs WHERE id NOT IN(SELECT id FROM worker_runs ORDER BY started_at DESC LIMIT 100)');return{id,status,steps:results};
  };
  return{
    run:async()=>{if(running)return{skipped:true,reason:'local_worker_busy'};running=true;try{active=db.exclusiveJob?db.exclusiveJob(73182019,execute):execute();return await active;}finally{running=false;active=null;}},
    drain:async()=>{if(active)await active;},
    status:async()=>({running,rows:(await db.query('SELECT * FROM worker_runs ORDER BY started_at DESC LIMIT 30')).rows,automatic_stripe_charging:automaticStripeCharging}),
  };
}
export function workerRole(env){const role=env.PHASE2_RUN_ROLE||'embedded';if(!['embedded','web','worker'].includes(role))throw Error('Invalid PHASE2_RUN_ROLE.');if(role==='worker'&&env.PHASE2_DATABASE_DRIVER!=='postgres')throw Error('Separate workers require PostgreSQL; PGlite must have a single process.');return role;}

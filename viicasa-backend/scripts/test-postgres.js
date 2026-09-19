import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,dirname} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
const exec=promisify(execFile);
const bin=process.env.PG_BIN || (process.platform==='win32'?'C:/Program Files/PostgreSQL/16/bin':'');
const executable=name=>bin?join(bin,`${name}${process.platform==='win32'?'.exe':''}`):name;
const temp=await mkdtemp(join(tmpdir(),'viicasa-pg-'));
const data=join(temp,'cluster');
const port=await new Promise((accept,reject)=>{
  const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const number=server.address().port;server.close(()=>accept(number));
  });
});
let started=false;
try{
  await exec(executable('initdb'),['-D',data,'--username=viicasa_test','--auth=trust','--encoding=UTF8','--no-locale'],{windowsHide:true});
  await exec(executable('pg_ctl'),['-D',data,'-l',join(temp,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -F`,'-w','start'],{windowsHide:true});
  started=true;console.log('Ejecutando pruebas en PostgreSQL nativo temporal, con conexiones concurrentes.');
  process.exitCode=await new Promise((accept,reject)=>{
    const child=spawn(process.execPath,['--test','--test-concurrency=1','test/phase1.test.js'],{
      env:{...process.env,TEST_DATABASE_URL:`postgresql://viicasa_test@127.0.0.1:${port}/postgres`},stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',code=>accept(code??1));
  });
}finally{
  if(started)await exec(executable('pg_ctl'),['-D',data,'-w','-m','fast','stop'],{windowsHide:true});
  // Remove only the new, isolated test cluster, after the server has stopped.
  if(!basename(temp).startsWith('viicasa-pg-') || resolve(dirname(temp))!==resolve(tmpdir()))throw new Error('Ruta temporal inesperada');
  await rm(temp,{recursive:true,force:true});
}

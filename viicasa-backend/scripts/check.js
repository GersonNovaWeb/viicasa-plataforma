import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
let count=0;
for(const dir of ['src','scripts','test']){
  for(const file of await readdir(dir)){
    if(!file.endsWith('.js'))continue;
    const result=spawnSync(process.execPath,['--check',join(dir,file)],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);count++;
  }
}
console.log(`${count} archivos JavaScript verificados`);

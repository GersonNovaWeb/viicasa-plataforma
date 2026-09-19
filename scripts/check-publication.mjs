import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const files=execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const problems=[];
for(const file of files){
  if(/(^|\/)(node_modules|data|\.secrets|\.npm-cache)(\/|$)|firebase-adminsdk|service-account|(^|\/)\.env(?!\.example$)/i.test(file)){problems.push(file+' (private path)');continue;}
  if(!/\.(js|mjs|json|yaml|yml|md|txt|example|html|css|rules)$/.test(file))continue;
  const source=await readFile(file,'utf8');
  const expressions=[/-----BEGIN (?:RSA )?PRIVATE KEY-----/,/\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/,/\bwhsec_[A-Za-z0-9]{24,}\b/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,/\bgithub_pat_[A-Za-z0-9_]{30,}\b/];
  if(expressions.some(re=>re.test(source)))problems.push(file+' (possible credential; value hidden)');
}
for(const problem of problems)console.error(problem);
console.log(`${files.length} staged paths reviewed; ${problems.length} possible secret exposures.`);
if(problems.length)process.exitCode=1;

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const exceptions=JSON.parse(fs.readFileSync(path.join(root,'scripts/brand-audit-exceptions.json'),'utf8'));
const files=execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const failures=[];
for(const file of files){
 if(file.startsWith('.env')||file.startsWith('prisma/migrations/')||!fs.existsSync(path.join(root,file)))continue;
 const bytes=fs.readFileSync(path.join(root,file));if(bytes.includes(0)||/\.(png|jpe?g|ico|zip|pdf|woff2?)$/.test(file))continue;
 const lines=bytes.toString('utf8').split('\n');
 for(const [index,line] of lines.entries()){
  // Retained endpoints and addresses are infrastructure, not product copy.
  const clean=(line+' '+line.replace(/<[^>]*>/g,'')).replace(/https?:\/\/[^\s"'<>`]+|[\w.+-]+@[\w.-]+/g,'');
  if(!/church[-_]?os|COSUB_|COSQ_/i.test(clean))continue;
  if(exceptions[file])continue;
  failures.push(`${file}:${index+1}: unexpected legacy brand`);
 }
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log('Brand audit passed. Legacy exceptions are documented in scripts/brand-audit-exceptions.json.');

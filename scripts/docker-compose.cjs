#!/usr/bin/env node
'use strict';
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname,'..');
const storageRecord = path.join(root, '.ops', 'docker-storage.json');
const legacy = ['churchos-backend_postgres_data','churchos-backend_redis_data'];
const modern = ['belivrhq-backend_postgres_data','belivrhq-backend_redis_data'];
function run(args, options={}) {
 const result=spawnSync('docker',args,{cwd:root,encoding:'utf8',...options});
 if(result.error)throw result.error;
 return result;
}
function exists(name) { return run(['volume','inspect',name]).status===0; }
function selection() {
 if(run(['info','--format','{{.ServerVersion}}']).status!==0)throw new Error('Docker is unavailable; no storage was changed.');
 const found=legacy.map(exists);
 if(found[0]!==found[1])throw new Error('Only one legacy data volume exists. Refusing partial or empty startup.');
 const names=found.every(Boolean)?legacy:modern;
 if(fs.existsSync(storageRecord)) {
  const previous=JSON.parse(fs.readFileSync(storageRecord,'utf8'));
  if(JSON.stringify(previous.names)!==JSON.stringify(names)||!previous.names.every(exists))
   throw new Error('Previously selected storage is missing or changed. Refusing an empty-volume startup. Restore the recorded volumes before retrying.');
 }
 return {names,legacy:names===legacy};
}
function main() {
 const action=process.argv[2]||'status';
 if(!['up','down','status','config'].includes(action))throw new Error('Use up, down, status or config.');
 if(process.argv.slice(3).length)throw new Error('Extra Docker flags are not accepted. Volume deletion is never supported.');
 const selected=selection();
 const args=['compose','-f','docker-compose.yml',...(selected.legacy?['-f','docker-compose.legacy.yml']:[])];
 const env={...process.env,POSTGRES_DATA_VOLUME:selected.names[0],REDIS_DATA_VOLUME:selected.names[1]};
 if(action==='up') {
  const old=run(['ps','--filter','label=com.docker.compose.project=churchos-backend','--format','{{.Names}}']);
  if(old.stdout.trim())throw new Error('Legacy containers are running. Complete the verified backup and controlled cutover before starting BelivrHQ.');
  for(const [index,container] of ['belivrhq-postgres','belivrhq-redis'].entries()) {
   const current=run(['inspect',container,'--format','{{range .Mounts}}{{.Name}} {{end}}']);
   if(current.status===0&&!current.stdout.split(/\s+/).includes(selected.names[index]))throw new Error('Existing BelivrHQ container uses different storage. Refusing to replace it.');
  }
  if(!selected.legacy)for(const name of selected.names)if(!exists(name)) {
   const created=run(['volume','create',name]);if(created.status!==0)throw new Error('Could not initialize fresh storage.');
  }
 }
 console.log(`${selected.legacy?'Preserving existing':'Using fresh'} volumes: ${selected.names.join(', ')}`);
 const command=action==='up'?['up','-d']:action==='down'?['down']:action==='status'?['ps']:['config','--quiet'];
 const result=run([...args,...command],{env,stdio:'inherit'});
 if(action==='up'&&result.status===0){fs.mkdirSync(path.dirname(storageRecord),{recursive:true});fs.writeFileSync(storageRecord,JSON.stringify({names:selected.names},null,2)+'\n',{mode:0o600});}
 process.exitCode=result.status??1;
}
try { main(); } catch(error) { console.error(error.message);process.exitCode=1; }

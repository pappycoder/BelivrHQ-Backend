const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
function scenario(volumes,record){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'belivrhq-storage-test-'));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'.ops'));fs.mkdirSync(path.join(root,'bin'));
 fs.copyFileSync(path.join(__dirname,'../../scripts/docker-compose.cjs'),path.join(root,'scripts/docker-compose.cjs'));
 if(record)fs.writeFileSync(path.join(root,'.ops/docker-storage.json'),JSON.stringify({names:record}));
 const log=path.join(root,'calls');
 fs.writeFileSync(path.join(root,'bin/docker'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');const volumes=JSON.parse(process.env.TEST_VOLUMES);if(args[0]==='volume'&&args[1]==='inspect')process.exit(volumes.includes(args[2])?0:1);if(args[0]==='inspect')process.exit(1);if(args[0]==='info')console.log('16');`,{mode:0o755});
 const result=spawnSync(process.execPath,[path.join(root,'scripts/docker-compose.cjs'),'up'],{encoding:'utf8',env:{...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,TEST_VOLUMES:JSON.stringify(volumes),CALLS:log}});
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);fs.rmSync(root,{recursive:true,force:true});return {result,calls};
}
const legacy=['churchos-backend_postgres_data','churchos-backend_redis_data'];
test('existing installation uses the override and creates no new volumes',()=>{
 const {result,calls}=scenario(legacy);assert.equal(result.status,0);assert(calls.some(args=>args.includes('docker-compose.legacy.yml')));assert(!calls.some(args=>args[0]==='volume'&&args[1]==='create'));
});
test('partial legacy storage refuses startup',()=>{
 const {result,calls}=scenario([legacy[0]]);assert.equal(result.status,1);assert.match(result.stderr,/partial or empty/);assert(!calls.some(args=>args[0]==='compose'));
});
test('previously selected missing storage cannot turn into a fresh installation',()=>{
 const {result,calls}=scenario([],legacy);assert.equal(result.status,1);assert.match(result.stderr,/Previously selected storage/);assert(!calls.some(args=>args[0]==='compose'||args[1]==='create'));
});
test('fresh installation creates only the canonical volume pair',()=>{
 const {result,calls}=scenario([]);assert.equal(result.status,0);assert.deepEqual(calls.filter(args=>args[1]==='create').map(args=>args[2]),['belivrhq-backend_postgres_data','belivrhq-backend_redis_data']);assert(!calls.some(args=>args.includes('docker-compose.legacy.yml')));
});

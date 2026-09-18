// Opt-in integration check against the installed Codex CLI/app-server. Uses an
// isolated local Postgres cluster, synthetic cinema credentials and a temporary
// MCP name provided only through CLI overrides. Never touches production.
// Requires Node >=22, Codex login, initdb and pg_ctl on PATH.
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const repo=process.cwd(), exec=promisify(execFile);
const {databasePool}=await import(repo+'/dist/hosted-store.js');
const {migrationSql}=await import(repo+'/dist/migrations.js');
const {createHostedApp}=await import(repo+'/dist/hosted.js');
const dir=await mkdtemp(join(tmpdir(),'cinve-codex-auth-'));
const alias='cinve_ux_'+randomBytes(4).toString('hex');
let pool,app,config,server,pgStarted=false;
const children=new Set();
function run(args){
 const child=spawn('codex',args,{cwd:repo,stdio:['pipe','pipe','pipe']});children.add(child);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.on('exit',code=>{children.delete(child);resolve(code);});});
 return {child,done};
}
try {
 await exec('initdb',['-D',join(dir,'data'),'--auth=trust','--no-locale','--encoding=UTF8']);
 await exec('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'postgres.log'),'-o',`-k ${dir} -h ''`,'-w','start']);pgStarted=true;
 pool=databasePool(`postgresql://${encodeURIComponent(userInfo().username)}@localhost/postgres?host=${encodeURIComponent(dir)}`);
 await pool.query(await migrationSql());
 app=await createHostedApp({publicUrl:'http://127.0.0.1:0',allowLocal:true,pool,key:randomBytes(32),request:async()=>new Response('["Caracas"]'),
 authenticate:async(provider,username,password,store)=>{
  assert.equal(username,'synthetic@example.test');assert.equal(password,'SYNTHETIC_PASSWORD');
  await store.save({version:1,provider,access_token:'SYNTHETIC_TOKEN',expires_at:Date.now()+600000});
  return {provider,authenticated:true,profile_update_requested:false};
 }});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 config=`mcp_servers.${alias}.url="${origin}/mcp"`;
 console.log('Synthetic fixture started; production configuration is not modified.');
 // Persistent app-server begins BEFORE OAuth, matching the user's open conversation.
 const persistent=run(['-c',config,'-c','mcp_servers.cinve.enabled=false','app-server','--stdio']);server=persistent.child;
 let buffer='',events=[];const pending=new Map();let nextId=1;
 server.stdout.on('data',chunk=>{
  buffer+=chunk.toString();let cut;
  while((cut=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,cut);buffer=buffer.slice(cut+1);
   try {const e=JSON.parse(line);events.push(e);if(e.id&&pending.has(e.id)){pending.get(e.id)(e);pending.delete(e.id);}}catch{}
  }
 });
 server.stderr.on('data',()=>{});
 async function request(method,params){
  const id=nextId++;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(new Error('App-server request timed out: '+method));},60000);
   pending.set(id,e=>{clearTimeout(timer);e.error?reject(new Error(JSON.stringify(e.error))):resolve(e.result);});
   server.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
 }
 await request('initialize',{clientInfo:{name:'cinve_synthetic_ux',version:'1'}});
 server.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const started=await request('thread/start',{cwd:repo,approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:true});
 const threadId=started.thread.id;
 const tool = (name,args={})=>request('mcpServer/tool/call',{threadId,server:alias,tool:name,arguments:args});
 const anonymous=await tool('get_auth_status');
 assert.equal(anonymous.structuredContent.connection.client_authorized,false);
 console.log('Anonymous tool call identifies client authorization as required.');
 const configured=response=>response.structuredContent?.providers?.some(p=>p.provider==='cinesunidos'&&p.status==='configured')===true;
 const cinemaLink=response=>response.structuredContent?.url?.startsWith(origin+'/connect#')===true;
 async function login(decision){
  const {child,done}=run(['-c',config,'mcp','login',alias]);
  let log='';
  const url=await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{child.kill();reject(new Error('No OAuth URL from Codex'));},30000);
   function read(chunk){log+=chunk.toString();const m=log.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/);if(m){clearTimeout(timeout);resolve(m[0]);}}
   child.stdout.on('data',read);child.stderr.on('data',read);
  });
  const page=await fetch(url);assert.equal(page.status,200);const html=await page.text();
  const request_id=html.match(/name="request_id" value="([^"]+)"/)[1],csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const approved=await fetch(origin+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{Origin:origin,Cookie:page.headers.get('set-cookie').split(';')[0]},body:new URLSearchParams({request_id,csrf,decision})});
  assert.equal(approved.status,303);
  const callback=await fetch(approved.headers.get('location'));
  console.log('Synthetic callback HTTP:',callback.status,'decision:',decision);
  if(decision==='deny' && callback.status===400){
   console.log('Codex rejects the standard access_denied callback and keeps waiting; cancel test process.');
   child.kill('SIGTERM');await done;return;
  }
  const exit=await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Codex callback did not complete')),15000))]);
  assert.equal(exit===0,decision==='approve');
  console.log('Codex OAuth',decision,'completed with expected exit:',exit);
 }
 await login('deny');
 await login('approve');
 const {rows}=await pool.query('SELECT user_id FROM cinev_oauth_grants');assert.equal(rows.length,1);
 const user=rows[0].user_id;
 const invite=await app.links.issue(user,await app.users.hash(user),'cinesunidos');
 const post=(path,token,data={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Cinev-Connection':token},body:JSON.stringify(data)});
 const exchanged=await post('/connect/exchange',invite.token);const browser=await exchanged.json();
 assert.equal((await post('/connect/login',browser.browser_token,{username:'synthetic@example.test',password:'SYNTHETIC_PASSWORD'})).status,200);
 const after=await tool('get_auth_status');
 console.log('Same conversation after CLI OAuth configured:',configured(after));
 try {const link=await tool('connect_account',{provider:'cinesunidos'});console.log('Retry connect_account after CLI OAuth returns cinema link:',cinemaLink(link));}catch(e){console.log('Retry connect_account after CLI OAuth still needs auth:',e.message.slice(0,120));}
 await request('config/mcpServer/reload',{});
 const refreshed=await tool('get_auth_status');
 console.log('After native MCP refresh configured:',configured(refreshed));
 assert.ok(configured(refreshed));
 assert.equal(refreshed.structuredContent.connection.client_authorized,true);
 // Native app-server OAuth should notify and update the same running thread.
 const native=await request('mcpServer/oauth/login',{threadId,name:alias,timeoutSecs:30});
 console.log('Native login response fields:',Object.keys(native));
 const nativeUrl=native.authorizationUrl;
 assert.ok(nativeUrl);
 const page=await fetch(nativeUrl),html=await page.text();
 const request_id=html.match(/name="request_id" value="([^"]+)"/)[1],csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 const approval=await fetch(origin+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{Origin:origin,Cookie:page.headers.get('set-cookie').split(';')[0]},body:new URLSearchParams({request_id,csrf,decision:'approve'})});
 const callback=await fetch(approval.headers.get('location'));assert.equal(callback.status,200);
 const deadline=Date.now()+10000;
 while(!events.some(e=>e.method==='mcpServer/oauthLogin/completed'&&e.params?.name===alias)){
  if(Date.now()>deadline)throw new Error('Missing native login completion event');
  await new Promise(r=>setTimeout(r,100));
 }
 const event=events.find(e=>e.method==='mcpServer/oauthLogin/completed'&&e.params?.name===alias);
 assert.equal(event.params.success,true);
 const nativeLink=await tool('connect_account',{provider:'cinesunidos'});
 assert.ok(cinemaLink(nativeLink));
 console.log('Native login automatically updates the running thread: true');
 // Exercise the shipped continuation against the real installed App Server.
 const {codexClientScript}=await import(repo+'/dist/codex-client-script.js');
 const helper=join(dir,'cinve-codex.mjs');await writeFile(helper,codexClientScript);
 const actualCodex=(await exec('which',['codex'])).stdout.trim();
 const bin=join(dir,'bin');await mkdir(bin);
 const wrapper=join(bin,'codex');
 await writeFile(wrapper,'#!/usr/bin/env node\nconst {spawn}=require("node:child_process");const p=spawn('+JSON.stringify(actualCodex)+','+JSON.stringify(['-c',config,'-c','mcp_servers.cinve.enabled=false'])+'.concat(process.argv.slice(2)),{stdio:"inherit"});p.on("exit",c=>process.exit(c??1));');
 await chmod(wrapper,0o700);
 const companion=spawn(process.execPath,[helper,'--server',alias,'connect','cinesunidos'],{cwd:repo,env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
 children.add(companion);let companionBuffer='',companionEvents=[],connectWork=Promise.resolve();
 companion.stderr.on('data',()=>{});
 companion.stdout.on('data',chunk=>{
  companionBuffer+=chunk;let end;
  while((end=companionBuffer.indexOf('\n'))>=0){
   const line=companionBuffer.slice(0,end);companionBuffer=companionBuffer.slice(end+1);
   const event=JSON.parse(line);companionEvents.push(event);
   if(event.event==='connect_cinema')connectWork=(async()=>{
    const token=new URL(event.url).hash.slice(1);
    const exchanged=await post('/connect/exchange',token);const browser=await exchanged.json();
    assert.equal((await post('/connect/login',browser.browser_token,{username:'synthetic@example.test',password:'SYNTHETIC_PASSWORD'})).status,200);
   })();
  }
 });
 const companionTimer=setTimeout(()=>companion.kill(),20000);
 const companionCode=await new Promise(resolve=>companion.on('exit',resolve));clearTimeout(companionTimer);children.delete(companion);
 await connectWork;assert.equal(companionCode,0);
 assert.ok(companionEvents.some(e=>e.event==='ready'));
 assert.ok(!companionEvents.some(e=>e.event==='authorize_cinve'));
 console.log('Shipped local continuation reuses saved OAuth and completes cinema connection: true');
 const queried=await exec(process.execPath,[helper,'--server',alias,'call','list_cities',JSON.stringify({provider:'cinesunidos'})],{cwd:repo,env:{...process.env,PATH:bin+':'+process.env.PATH}});
 assert.equal(JSON.parse(queried.stdout).structuredContent.status,'available');
 console.log('Fresh continuation returns the original query result without restarting the existing conversation: true');
 console.log('Synthetic OAuth and cinema form test completed.');
} catch(e){console.error('Synthetic test failed:',e.message);process.exitCode=1;}
finally {
 for(const child of children)child.kill('SIGTERM');
 if(config)await exec('codex',['-c',config,'mcp','logout',alias]).catch(()=>{});
 if(app){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
 if(pool)await pool.end();
 if(pgStarted)await exec('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']).catch(()=>{});
 await rm(dir,{recursive:true,force:true});
}

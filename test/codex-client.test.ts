import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { codexClientScript } from '../src/codex-client-script.js';
import { hostedAuthInstructions } from '../src/hosted-auth-guidance.js';
import { installGuide } from '../src/install.js';

async function runFixture(t: any, mode: string, args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'cinve-companion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'client.mjs'); await writeFile(helper, codexClientScript);
  await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
const readline=require('node:readline');let authorized=${mode === 'existing'},connected=false,calls=0;
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;let result={};
 if(r.method==='initialize')result={};
 else if(r.method==='thread/start')result={thread:{id:'fixture'}};
 else if(r.method==='config/mcpServer/reload')result={};
 else if(r.method==='mcpServer/oauth/login'){
  if(${mode === 'existing'}){send({id:r.id,error:{message:'Must not repeat OAuth'}});return}
  result={authorizationUrl:'https://example.test/oauth'};
  setTimeout(()=>{authorized=${mode !== 'denied'};send({method:'mcpServer/oauthLogin/completed',params:{name:'cinve',success:authorized}})},20);
 }
 else if(r.method==='mcpServer/tool/call'){
  const name=r.params.tool;
  if(name==='get_auth_status'){if(calls)connected=true;result={structuredContent:{connection:{client_authorized:authorized},providers:[{provider:'cinex',status:connected?'configured':'missing'}]}}}
  else if(name==='connect_account'){if(!authorized){send({id:r.id,error:{message:'Not authorized'}});return}calls++;result={structuredContent:{url:'https://example.test/connect#one-use',expires_at:new Date(Date.now()+60000).toISOString()}}}
  else result={structuredContent:{status:'available',items:[{name:'verified result'}]},isError:false};
 }
 else {send({id:r.id,error:{message:'Unexpected RPC'}});return}
 send({id:r.id,result});
});`);
  await chmod(join(dir, 'codex'), 0o700);
  const child = spawn(process.execPath, [helper, ...args], { env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise(resolve => child.on('exit', resolve)); clearTimeout(timer);
  return { code, out, err };
}

test('companion continues saved OAuth through cinema connection without another authorization', async t => {
  const r = await runFixture(t, 'existing', ['connect', 'cinex']);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /connect_cinema/); assert.match(r.out, /"event":"ready"/); assert.doesNotMatch(r.out, /authorize_cinve/);
});
test('companion presents native authorization and continues automatically', async t => {
  const r = await runFixture(t, 'new', ['connect', 'cinex']);
  assert.equal(r.code, 0, r.out + r.err); assert.ok(r.out.indexOf('authorize_cinve') < r.out.indexOf('connect_cinema')); assert.match(r.out, /"event":"ready"/);
});
test('companion stops on denied OAuth and never generates a cinema link', async t => {
  const r = await runFixture(t, 'denied', ['connect', 'cinex']);
  assert.equal(r.code, 1); assert.match(r.out, /cancelled/); assert.doesNotMatch(r.out, /connect_cinema|"event":"ready"/);
});
test('companion reads original queries but rejects mutation and credential tools', async t => {
  const r = await runFixture(t, 'existing', ['call', 'get_seats', '{"provider":"cinex"}']);
  assert.equal(r.code, 0); assert.match(r.out, /verified result/);
  const bad = await runFixture(t, 'existing', ['call', 'disconnect_account', '{}']); assert.equal(bad.code, 2);
});
test('served instructions direct local stale connections to continuation', () => {
  for (const s of [hostedAuthInstructions, installGuide('https://example.test')]) {
    assert.match(s, /codex-client.mjs/); assert.match(s, /get_seats/);
  }
});

import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {setupElectronicIdentity,issuanceTokenValid,identityPassword} from '../../server/electronic-identity.ts';
import {hashPassword,verifyPassword} from '../../server/db.ts';
test('Issuance token and 8-character password validation reject weak or malformed values',()=>{
 assert(identityPassword('Abc123xy'));for(const p of ['12345678','abcdefgh','ABCDEFG1','Ab12345','Ab1234567'])assert(!identityPassword(p));
 assert(issuanceTokenValid('Bearer synthetic-token','synthetic-token'));assert(!issuanceTokenValid('Bearer wrong','synthetic-token'));assert(!issuanceTokenValid('Bearer synthetic-token',undefined));
});
test('Teacher activation stores only a hash, pupils use source Auth, and missing mailbox never reports readiness',async()=>{
 const old=process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN,oldProject=process.env.EDNEVNIK_SUPABASE_PROJECT_ID;
 process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN='synthetic-token';process.env.EDNEVNIK_SUPABASE_PROJECT_ID='source';
 let kind='staff',hash=null,ready=true,sourceCalls=0;const changes=[];
 const database={query:async(sql,args)=>{
  if(sql.startsWith('select u.id'))return {rows:ready?[{id:1,email:'ivan.horvat@skolehr.xyz',auth_kind:kind}]:[]};
  if(sql.startsWith('update users')){hash=args[1];changes.push(sql);return {rows:[{password:hash}]};}
  changes.push(sql);return {rows:[]};
 }};
 const app=express();app.use(express.json());setupElectronicIdentity(app,{database,transact:async work=>work(database),verifyStudent:async()=>{sourceCalls++;return {projectId:'source',userId:'10000000-0000-4000-8000-000000000001'};},hashPassword,verifyPassword,staffSecret:p=>'test-pepper:'+p});app.use((error,_q,r,_n)=>r.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/integrations/ednevnik/electronic-identity';
 const body={user_id:'10000000-0000-4000-8000-000000000001',school_id:'school',email:'ivan.horvat@skolehr.xyz',relationship:'TEACHER',operation:'activate',password:'Abc123xy'};
 const call=(value=body,token='synthetic-token')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(value)});
 try{
  assert.equal((await call(body,'wrong')).status,401);assert.equal(changes.length,0);
  let response=await call();assert.equal(response.status,200);assert.equal((await response.json()).ready,true);assert.notEqual(hash,body.password);assert(await verifyPassword('test-pepper:'+body.password,hash));assert.equal(sourceCalls,0,'teacher password does not touch source Auth or its PIN/TOTP');
  kind='ednevnik';response=await call({...body,relationship:'STUDENT'});assert.equal(response.status,200);assert.equal(sourceCalls,1);
  ready=false;response=await call({...body,operation:'prepare'});assert.equal(response.status,409);
 }finally{await new Promise(r=>server.close(r));if(old===undefined)delete process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN;else process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN=old;if(oldProject===undefined)delete process.env.EDNEVNIK_SUPABASE_PROJECT_ID;else process.env.EDNEVNIK_SUPABASE_PROJECT_ID=oldProject;}
});

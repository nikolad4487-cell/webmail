import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {once} from 'node:events';
const url=process.env.TEST_FORMAPOINT_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw new Error('Use an empty disposable local TEST_FORMAPOINT_DATABASE_URL.');
Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',DEMO_MODE:'1',ADMIN_ORIGIN:'',FORMAPOINT_AUTO_MAILBOXES:'1',FORMAPOINT_SUPABASE_PROJECT_ID:'forma-test',FORMAPOINT_PROVISION_SECRET:'local-formapoint-provision-secret-0123456789',CLOUDFLARE_INBOUND_SECRET:'local-inbound-secret-01234567890123456789',MAILJET_API_KEY:'local',MAILJET_SECRET_KEY:'local'});
delete process.env.APP_ORIGIN;
let db,server,base,org;
const person=(email='alice@example.test',id=randomUUID())=>({id,email,name:'Alice',confirmed:true,anonymous:false});
async function sync(users=[],options={}){
  const body=JSON.stringify({project:'forma-test',users,...options.data});
  const timestamp=String(options.timestamp??Date.now()),hash=createHash('sha256').update(body).digest('hex');
  const signature=createHmac('sha256',process.env.FORMAPOINT_PROVISION_SECRET).update(timestamp+'\n'+hash).digest('hex');
  const r=await fetch(base+'/api/integrations/formapoint/provision',{method:'POST',headers:{'Content-Type':'application/json','x-webmail-sync-timestamp':timestamp,'x-webmail-sync-hash':hash,'x-webmail-sync-signature':signature,...options.headers},body:options.raw??body});
  const output=await r.text();assert.equal(r.status,options.status??200,output);return JSON.parse(output);
}
before(async()=>{
  ({db}=await import('../../server/db.ts'));
  assert.equal((await db.query("select to_regclass('users') name")).rows[0].name,null);
  for(const file of ['server/schema.sql','migrations/001-native-mail.sql','migrations/002-mail-passwords.sql','migrations/003-mailbox-provisioning.sql'])await db.query(await readFile(new URL('../../'+file,import.meta.url),'utf8'));
  org=(await db.query("insert into organizations(name) values('FormaPoint') returning id")).rows[0].id;
  await db.query("insert into domains(name,org) values('formapoint.online',$1)",[org]);
  const {default:app}=await import('../../server/app.ts');server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server?.close();await db?.end();});
test('Service authenticates body, freshness, source and server origin before writing',async()=>{
  await sync([],{headers:{'x-webmail-sync-signature':'0'.repeat(64)},status:401});
  await sync([],{timestamp:Date.now()-600000,status:401});
  await sync([],{raw:'{}',status:401});
  await sync([],{data:{project:'different'},status:403});
  await sync([],{headers:{Origin:'https://formapoint.online'},status:403});
  await sync([person()],{status:200}).then(r=>assert.equal(r.results[0].status,'conflict'));
  assert.equal((await db.query('select count(*)::int n from users')).rows[0].n,0);
});
test('Explicit setup selects native app storage, preserves domain organization and is repeatable',async()=>{
  await sync([],{data:{setup:true}});await sync([],{data:{setup:true}});
  assert.deepEqual((await db.query("select org,mailbox_backend from domains where name='formapoint.online'")).rows,[{org,mailbox_backend:'native'}]);
  assert.equal((await db.query("select count(*)::int n from audits where action='formapoint.domain.enable'")).rows[0].n,1);
});
let alice,address,uid,box;
test('Concurrent verified registrations create exactly one stable account and private mailbox',async()=>{
  alice=person();const results=await Promise.all(Array.from({length:4},()=>sync([alice])));
  assert.equal(results.flatMap(r=>r.results).filter(r=>r.status==='created').length,1);
  const rows=(await db.query('select u.*,m.id box,m.storage_kind from users u join mailboxes m on m.address=u.email where u.source_user_id=$1',[alice.id])).rows;
  assert.equal(rows.length,1);const u=rows[0];address=u.email;uid=u.id;box=u.box;
  assert.match(address,/^alice\.[a-f0-9]{16}@formapoint\.online$/);assert.equal(u.role,'user');assert.equal(u.password,null);assert.equal(u.storage_kind,'native');
  assert.equal(u.source_email,alice.email);
  assert.deepEqual((await db.query('select uid,can_send,can_calendar from grants where box=$1',[box])).rows,[{uid,can_send:true,can_calendar:true}]);
  assert.equal((await db.query('select uid from directory_identities where project=$1 and subject=$2',['forma-test',alice.id])).rows[0].uid,uid);
});
test('Unconfirmed, anonymous and identity-override payloads cannot create mailboxes',async()=>{
  await sync([{...person(),confirmed:false}],{status:400});
  await sync([{...person(),anonymous:true}],{status:400});
  await sync([{...person(),role:'root'}],{status:400});
});
test('Source changes preserve assigned address and local password while revoking old sessions',async()=>{
  const hash=await (await import('../../server/db.ts')).hashPassword('existing-password');
  await db.query('update users set password=$2 where id=$1',[uid,hash]);
  await db.query("insert into sessions values('test-session',$1,now()+interval '1 hour')",[uid]);
  const r=await sync([{...alice,email:'new-alice@example.test',name:'Alice New'}]);assert.equal(r.results[0].address,address);
  const u=(await db.query('select * from users where id=$1',[uid])).rows[0];assert.equal(u.password,hash);assert.equal(u.name,'Alice New');assert.equal(u.source_email,'new-alice@example.test');
  assert.equal((await db.query('select count(*)::int n from sessions where uid=$1',[uid])).rows[0].n,0);
});
test('Disabled users, reserved addresses and someone else\'s address cannot be adopted',async()=>{
  await db.query('update users set active=false where id=$1',[uid]);
  assert.equal((await sync([alice])).results[0].status,'conflict');await db.query('update users set active=true where id=$1',[uid]);
  assert.equal((await sync([person('new-alice@example.test')])).results[0].status,'conflict');
  await db.query('insert into aliases values($1,$2,false)',['reserved@formapoint.online',box]);
  assert.equal((await sync([person('reserved@formapoint.online')])).results[0].status,'conflict');
  assert.equal((await db.query("select count(*)::int n from users where email='reserved@formapoint.online'")).rows[0].n,0);
});
test('Existing personal password survives linking and IMAP storage requires explicit activation',async()=>{
  const p=person('existing@formapoint.online'),hash=await (await import('../../server/db.ts')).hashPassword('existing-password');
  const u=(await db.query("insert into users(org,email,name,password,auth_kind) values($1,$2,'Old',$3,'formapoint') returning id",[org,p.email,hash])).rows[0];
  const b=(await db.query("insert into mailboxes(org,address,label) values($1,$2,'Old IMAP') returning id",[org,p.email])).rows[0];
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[u.id,b.id]);
  assert.equal((await sync([p])).results[0].status,'needs_activation');
  assert.equal((await db.query('select storage_kind from mailboxes where id=$1',[b.id])).rows[0].storage_kind,'imap');
  assert.equal((await db.query('select password from users where id=$1',[u.id])).rows[0].password,hash);
});
test('Source-linked login verifies the original source identity and grants only its own mailbox',async()=>{
  const p=person('login@example.test');const result=(await sync([p])).results[0];
  process.env.FORMAPOINT_SUPABASE_URL='http://127.0.0.1:1';process.env.FORMAPOINT_SUPABASE_AUTH_KEY='local-public';
  const originalFetch=globalThis.fetch;let sourceId=p.id;
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith('http://127.0.0.1:1/auth/')){assert.equal(JSON.parse(options.body).email,p.email);return Response.json({user:{id:sourceId}});}
    return originalFetch(url,options);
  };
  try{
    const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:p.email,password:'source-password'})});assert.equal(r.status,200,await r.text());
    const me=await fetch(base+'/api/me',{headers:{cookie:r.headers.get('set-cookie').split(';')[0]}}).then(r=>r.json());
    assert.equal(me.boxes.length,1);assert.equal(me.boxes[0].address,result.address);
    sourceId=randomUUID();
    const wrong=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:p.email,password:'source-password'})});assert.equal(wrong.status,401);
  }finally{globalThis.fetch=originalFetch;}
});

test('Verified own-domain names are kept verbatim and never grant administrator roles',async()=>{
  const {personAddress}=await import('../../server/directory-source.ts');
  assert.equal(personAddress('formapoint','formapoint.online','admin@formapoint.online',randomUUID()),'admin@formapoint.online');
  assert.equal(personAddress('ednevnik','skolehr.xyz','admin@skolehr.xyz',randomUUID()),undefined);
  const p=person('webmaster@formapoint.online');
  const r=(await sync([p])).results[0];assert.equal(r.address,p.email);
  assert.equal((await db.query('select role from users where source_user_id=$1',[p.id])).rows[0].role,'user');
});
test('Original-address repair refuses collisions and preserves account, password, mailbox IDs, messages, attachments and grants',async()=>{
  const previous='admin.7b806f4df0c35d76@formapoint.online',original='admin@formapoint.online';
  const hash=await (await import('../../server/db.ts')).hashPassword('preserved-password');
  const u=(await db.query(`insert into users(org,email,name,password,auth_kind,source_project,source_user_id,source_email)
    values($1,$2,'Personal user',$3,'formapoint','heseilggogbtmqeuwlku',$4,$5) returning *`,[org,previous,hash,randomUUID(),original])).rows[0];
  const b=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,'Existing personal mailbox','native') returning *",[org,previous])).rows[0];
  await db.query('insert into grants values($1,$2,true,true)',[u.id,b.id]);
  await db.query("insert into sessions values('repair-session',$1,now()+interval '1 hour')",[u.id]);
  const {storeNative}=await import('../../server/native-mail.ts'),{mime}=await import('../../server/mail.ts');
  const raw=await mime({from:'sender@example.test',to:[previous],subject:'Preserved mail',text:'Existing mail',attachments:[{filename:'kept.txt',content:Buffer.from('preserved attachment')}]});
  const saved=await storeNative(previous,'INBOX',raw,{from:'sender@example.test'});
  const sql=await readFile(new URL('../../migrations/004-formapoint-original-address.sql',import.meta.url),'utf8');
  const occupied=(await db.query("insert into mailboxes(org,address,label) values($1,$2,'Occupied') returning id",[org,original])).rows[0];
  await assert.rejects(db.query(sql),/already assigned/);
  assert.equal((await db.query('select email from users where id=$1',[u.id])).rows[0].email,previous);
  await db.query('delete from mailboxes where id=$1',[occupied.id]);
  await db.query(sql);await db.query(sql);
  const afterUser=(await db.query('select * from users where id=$1',[u.id])).rows[0];
  assert.deepEqual(afterUser,{...u,email:original});
  assert.deepEqual((await db.query('select * from mailboxes where id=$1',[b.id])).rows[0],{...b,address:original});
  assert.deepEqual((await db.query('select * from grants where box=$1',[b.id])).rows,[{uid:u.id,box:b.id,can_send:true,can_calendar:true}]);
  assert.equal((await db.query('select box from native_messages where id=$1',[saved.id])).rows[0].box,b.id);
  assert.equal((await db.query('select raw from native_messages where id=$1',[saved.id])).rows[0].raw.compare(raw),0);
  assert.equal((await db.query('select content from native_attachments where message=$1',[saved.id])).rows[0].content.toString(),'preserved attachment');
  assert.equal((await db.query('select count(*)::int n from sessions where uid=$1',[u.id])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from audits where uid=$1 and action='formapoint.address.correct'",[u.id])).rows[0].n,1);
});

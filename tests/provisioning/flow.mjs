import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import worker from '../../cloudflare/email-worker.mjs';

const url=process.env.TEST_PROVISION_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw new Error('Use an empty disposable local TEST_PROVISION_DATABASE_URL.');
process.env.DATABASE_URL=url;process.env.NODE_ENV='test';process.env.DEMO_MODE='1';process.env.ADMIN_ORIGIN='';delete process.env.APP_ORIGIN;
process.env.CLOUDFLARE_INBOUND_SECRET='local-provisioning-only-secret-01234567890123456789';
process.env.MAILJET_API_KEY='local';process.env.MAILJET_SECRET_KEY='local';
process.env.NATIVE_ENABLED_ADDRESSES='demo@skolehr.xyz';
let db,server,base,root,admin,org,foreign,alice,bob,viktor,hash,attach,demoBox;
const userCookies=new Map();
async function request(path,{session=root,body,method=body?'POST':'GET',status=200}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(session?{cookie:session}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const output=await r.text();assert.equal(r.status,status,path+' '+output);
  return r.headers.get('content-type')?.includes('application/json')?JSON.parse(output):output;
}
async function createUser(address,organization=org,extra={}){
  const u=(await db.query(`insert into users(org,email,name,password,auth_kind,role,active)
    values($1,$2,$2,$3,'staff',$4,$5) returning *`,[organization,address,hash,extra.role??'user',extra.active??true])).rows[0];
  const key=randomBytes(32).toString('hex'),digest=createHash('sha256').update(key).digest('hex');
  await db.query("insert into sessions values($1,$2,now()+interval '1 hour')",[digest,u.id]);
  userCookies.set(u.id,'wm_session='+key);return u;
}
const boxInput=address=>({org,address,label:address,shared:false,active:true,target_quota_gb:15});
const migrate=async()=>db.query(await readFile(new URL('../../migrations/003-mailbox-provisioning.sql',import.meta.url),'utf8'));
before(async()=>{
  ({db}=await import('../../server/db.ts'));
  assert.equal((await db.query("select to_regclass('users') name")).rows[0].name,null);
  for(const file of ['server/schema.sql','migrations/001-native-mail.sql','migrations/002-mail-passwords.sql'])await db.query(await readFile(new URL('../../'+file,import.meta.url),'utf8'));
  hash=await (await import('../../server/db.ts')).hashPassword('12345678');
  org=(await db.query("insert into organizations(name) values('School') returning id")).rows[0].id;
  foreign=(await db.query("insert into organizations(name) values('Zoho org') returning id")).rows[0].id;
  await db.query("insert into domains(name,org) values('skolehr.xyz',$1),('formapoint.online',$2)",[org,foreign]);
  const demo=await createUser('demo@skolehr.xyz');
  demoBox=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,'Demo','native') returning id",[org,demo.email])).rows[0].id;
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[demo.id,demoBox]);
  viktor=await createUser('viktor.beljan@skolehr.xyz');
  const old=(await db.query("insert into mailboxes(org,address,label) values($1,$2,'Old IMAP') returning id",[org,viktor.email])).rows[0].id;
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[viktor.id,old]);
  const rootUser=await createUser('root@skolehr.xyz',org,{role:'root'});root=userCookies.get(rootUser.id);
  const orgAdmin=await createUser('admin@skolehr.xyz',org,{role:'admin'});admin=userCookies.get(orgAdmin.id);
  // Existing admin mailbox avoids including the administrator in candidate assertions.
  await db.query("insert into mailboxes(org,address,label) values($1,$2,'Admin IMAP')",[org,orgAdmin.email]);
  alice=await createUser('alice@skolehr.xyz');bob=await createUser('bob@skolehr.xyz');
  await createUser('disabled@skolehr.xyz',org,{active:false});
  await createUser('zoho@formapoint.online',foreign);
  const alias=await createUser('alias@skolehr.xyz');
  await db.query('insert into aliases values($1,$2,false)',[alias.email,demoBox]);
  const reserved=await createUser('reserved@skolehr.xyz');
  await db.query("insert into senders(org,address,reply_to,kind) values($1,$2,'demo@skolehr.xyz','order')",[org,reserved.email]);
  const managed=await createUser('managed@skolehr.xyz');
  await db.query("insert into directory_identities values('local','managed',$1)",[managed.id]);
  await migrate();await migrate();
  const {default:app}=await import('../../server/app.ts');
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server?.close();await db?.end();});

test('One-time migration infers existing native domain and preserves Zoho and explicit later choices',async()=>{
  const rows=(await db.query('select name,mailbox_backend from domains order by name')).rows;
  assert.deepEqual(rows,[{name:'formapoint.online',mailbox_backend:'imap'},{name:'skolehr.xyz',mailbox_backend:'native'}]);
  await db.query("update domains set mailbox_backend='imap' where name='skolehr.xyz'");await migrate();
  assert.equal((await db.query("select mailbox_backend from domains where name='skolehr.xyz'")).rows[0].mailbox_backend,'imap');
  await db.query("update domains set mailbox_backend='native' where name='skolehr.xyz'");
});
test('Creating a personal mailbox automatically enables native storage and grants only its active owner',async()=>{
  await request('/admin/mailboxes',{body:{...boxInput(alice.email),storage_kind:'imap'}});
  const m=(await db.query('select * from mailboxes where address=$1',[alice.email])).rows[0];assert.equal(m.storage_kind,'native');
  assert.deepEqual((await db.query('select uid,can_send,can_calendar from grants where box=$1',[m.id])).rows,[{uid:alice.id,can_send:true,can_calendar:true}]);
  await request('/admin/mailboxes',{body:boxInput('missing@skolehr.xyz'),status:409});
  await request('/admin/mailboxes',{body:boxInput('disabled@skolehr.xyz'),status:409});
  await request('/admin/mailboxes',{body:boxInput('managed@skolehr.xyz'),status:409});
  assert.equal((await db.query("select count(*)::int n from mailboxes where address in ('missing@skolehr.xyz','disabled@skolehr.xyz','managed@skolehr.xyz')")).rows[0].n,0);
  await request('/admin/mailboxes',{body:{...boxInput('shared@skolehr.xyz'),shared:true}});
  assert.equal((await db.query("select storage_kind from mailboxes where address='shared@skolehr.xyz'")).rows[0].storage_kind,'imap');
});
test('Bulk preview is scoped and excludes existing, inactive, alias, reserved and directory users',async()=>{
  const plan=await request('/admin/mailboxes/provision');assert.deepEqual(plan.users.map(u=>u.email),[bob.email]);
  assert.deepEqual((await request('/admin/mailboxes/provision',{session:admin})).users.map(u=>u.email),[bob.email]);
  await request('/admin/mailboxes/provision?org='+foreign,{session:admin,status:403});
  await request('/admin/mailboxes/provision',{session:userCookies.get(alice.id),status:403});
  const other=(await db.query("select id from users where email='zoho@formapoint.online'")).rows[0].id;
  await request('/admin/mailboxes/provision',{session:admin,body:{org:null,uids:[other]},status:403});
  await request('/admin/domains',{session:admin,body:{key:'skolehr.xyz',org,name:'skolehr.xyz',inbound:true,outbound:true,mailbox_backend:'imap'},status:403});
});
test('Concurrent repeated bulk requests create one mailbox and preserve every existing IMAP mailbox',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>request('/admin/mailboxes/provision',{session:admin,body:{org:null,uids:[bob.id]}})));
  assert.equal(results.reduce((n,r)=>n+r.created,0),1);
  assert.equal((await db.query('select count(*)::int n from mailboxes where address=$1',[bob.email])).rows[0].n,1);
  assert.equal((await db.query('select storage_kind from mailboxes where address=$1',[viktor.email])).rows[0].storage_kind,'imap');
  assert.equal((await db.query('select count(*)::int n from grants g join mailboxes m on m.id=g.box where m.address=$1 and g.uid=$2',[bob.email,bob.id])).rows[0].n,1);
  assert.equal((await request('/admin/mailboxes/provision')).users.length,0);
});
test('Domain-policy recipients work without address env edits; unknown addresses are never provisioned by delivery',async()=>{
  const {mime}=await import('../../server/mail.ts');
  const raw=await mime({from:'sender@example.test',to:[bob.email],subject:'Auto-created mailbox',text:'Personal mail',attachments:[{filename:'personal.txt',content:Buffer.from('Bob private file')}]});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://webmailhr.com/api/inbound/cloudflare');return originalFetch(base+'/api/inbound/cloudflare',options);};
  try{
    let rejected;
    await worker.email({from:'sender@example.test',to:bob.email,rawSize:raw.length,raw:new Blob([raw]).stream(),setReject:r=>{rejected=r;}},{INBOUND_URL:'https://webmailhr.com/api/inbound/cloudflare',INBOUND_SECRET:process.env.CLOUDFLARE_INBOUND_SECRET,ENABLED_RECIPIENTS:'*'});
    assert.equal(rejected,undefined);
    await worker.email({from:'sender@example.test',to:'unknown@skolehr.xyz',rawSize:raw.length,raw:new Blob([raw]).stream(),setReject:r=>{rejected=r;}},{INBOUND_URL:'https://webmailhr.com/api/inbound/cloudflare',INBOUND_SECRET:process.env.CLOUDFLARE_INBOUND_SECRET,ENABLED_RECIPIENTS:'*'});
    assert.match(rejected,/HTTP_404/);
    assert.equal((await db.query("select count(*)::int n from mailboxes where address='unknown@skolehr.xyz'")).rows[0].n,0);
  }finally{globalThis.fetch=originalFetch;}
  const me=await request('/me',{session:userCookies.get(bob.id)});assert.equal(me.boxes.length,1);
  const m=me.boxes[0],row=(await request('/mail/'+m.id,{session:userCookies.get(bob.id)}))[0];
  attach='/mail/'+m.id+'/attachment?'+new URLSearchParams({path:row.path,id:row.id})+'&index=0';
  assert.equal(await request(attach,{session:userCookies.get(bob.id)}),'Bob private file');
  await request(attach,{session:userCookies.get(alice.id),status:403});
});
test('Batch rechecks stale users and enforces configured mail services before changing anything',async()=>{
  const stale=await createUser('stale@skolehr.xyz');
  assert.ok((await request('/admin/mailboxes/provision')).users.some(u=>u.id===stale.id));
  await db.query('update users set active=false where id=$1',[stale.id]);
  assert.deepEqual(await request('/admin/mailboxes/provision',{body:{org,uids:[stale.id]}}),{created:0,skipped:1});
  const pending=await createUser('pending@skolehr.xyz');
  const key=process.env.MAILJET_API_KEY;delete process.env.MAILJET_API_KEY;
  try{await request('/admin/mailboxes/provision',{body:{org,uids:[pending.id]},status:503});}finally{process.env.MAILJET_API_KEY=key;}
  assert.equal((await db.query('select count(*)::int n from mailboxes where address=$1',[pending.email])).rows[0].n,0);
  await request('/admin/mailboxes/provision',{body:{org,uids:[pending.id]}});
});
test('Root can explicitly opt a second supported domain in; Zoho stays unchanged until that choice',async()=>{
  assert.equal((await request('/admin/mailboxes/provision?org='+foreign)).users.length,0);
  await request('/admin/domains',{body:{key:'formapoint.online',org:foreign,name:'formapoint.online',inbound:true,outbound:true,mailbox_backend:'native'}});
  const plan=await request('/admin/mailboxes/provision?org='+foreign);assert.deepEqual(plan.users.map(u=>u.email),['zoho@formapoint.online']);
  await request('/admin/domains',{body:{key:'formapoint.online',org:foreign,name:'formapoint.online',inbound:true,outbound:true,mailbox_backend:'imap'}});
  assert.equal((await request('/admin/mailboxes/provision?org='+foreign)).users.length,0);
});
test('Preview batches are bounded and advance past existing mailboxes',async()=>{
  const ids=[];
  for(let i=0;i<101;i++)ids.push((await createUser('batch'+i+'@skolehr.xyz')).id);
  const first=await request('/admin/mailboxes/provision');assert.equal(first.users.length,100);assert.equal(first.hasMore,true);
  await request('/admin/mailboxes/provision',{body:{org,uids:ids},status:400});
  assert.equal((await request('/admin/mailboxes/provision',{body:{org,uids:first.users.map(u=>u.id)}})).created,100);
  const last=await request('/admin/mailboxes/provision');assert.equal(last.users.length,1);assert.equal(last.hasMore,false);
});

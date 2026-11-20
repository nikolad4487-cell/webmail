import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import worker from '../../cloudflare/email-worker.mjs';

if(!process.env.TEST_DATABASE_URL)throw new Error('Set TEST_DATABASE_URL to an isolated disposable PostgreSQL database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.NODE_ENV='test';process.env.DEMO_MODE='1';
process.env.CLOUDFLARE_INBOUND_SECRET='local-native-test-secret-only-0123456789';
process.env.MAILJET_API_KEY='local-key';process.env.MAILJET_SECRET_KEY='local-secret';
process.env.MAILJET_SANDBOX='1';process.env.NATIVE_ENABLED_ADDRESSES='demo@skolehr.xyz';
process.env.ADMIN_ORIGIN='http://admin.localhost';
let db,appServer,jetServer,base,cookie,otherCookie,box,otherBox,raw,location;
const sent=[];let jetFailure=false;
async function request(path,{body,method=body?'POST':'GET',session=cookie,status=200}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(session?{cookie:session}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const text=await r.text();assert.equal(r.status,status,path+' '+text);
  return {body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
function headers(bytes=raw,to='demo@skolehr.xyz',timestamp=String(Date.now())){
  const from='sender@example.test',hash=createHash('sha256').update(bytes).digest('hex');
  return {'Content-Type':'message/rfc822','x-webmail-to':to,'x-webmail-from':from,'x-webmail-timestamp':timestamp,'x-webmail-sha256':hash,
    'x-webmail-signature':createHmac('sha256',process.env.CLOUDFLARE_INBOUND_SECRET).update([timestamp,from,to,hash].join('\n')).digest('hex')};
}
const deliver=(bytes=raw,h=headers(bytes))=>fetch(base+'/api/inbound/cloudflare',{method:'POST',headers:h,body:bytes});
before(async()=>{
  ({db}=await import('../../server/db.ts'));
  // Explicit opt-in to fixtures; schema is additive, fixture tables must be empty.
  assert.equal((await db.query("select to_regclass('users') as name")).rows[0].name,null,'Use an empty disposable test DB');
  await db.query(await readFile(new URL('../../server/schema.sql',import.meta.url),'utf8'));
  const migration=await readFile(new URL('../../migrations/001-native-mail.sql',import.meta.url),'utf8');
  await db.query(migration);await db.query(migration);
  await db.query(await readFile(new URL('../../migrations/002-mail-passwords.sql',import.meta.url),'utf8'));
  const {hashPassword}=await import('../../server/db.ts');
  const {staffSecret}=await import('../../server/identity.ts');
  const password=await hashPassword(staffSecret('12345678'));
  const org=(await db.query("insert into organizations(name) values('Native pilot') returning id")).rows[0].id;
  await db.query("insert into domains(name,org) values('skolehr.xyz',$1),('formapoint.test',$1)",[org]);
  const owner=(await db.query("insert into users(org,email,name,password,auth_kind,password_scheme) values($1,'demo@skolehr.xyz','Demo',$2,'staff','staff_pin') returning id",[org,password])).rows[0].id;
  const other=(await db.query("insert into users(org,email,name,password,auth_kind,password_scheme) values($1,'other@formapoint.test','Other',$2,'staff','staff_pin') returning id",[org,password])).rows[0].id;
  box=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,'demo@skolehr.xyz','demo@skolehr.xyz','native') returning id",[org])).rows[0].id;
  otherBox=(await db.query("insert into mailboxes(org,address,label) values($1,'other@formapoint.test','Other') returning id",[org])).rows[0].id;
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true),($3,$4,true)',[owner,box,other,otherBox]);
  jetServer=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    sent.push({body:JSON.parse(text),authorization:req.headers.authorization,url:req.url});
    res.setHeader('Content-Type','application/json');
    if(jetFailure){res.statusCode=500;res.end(JSON.stringify({Messages:[{Status:'error'}]}));}
    else res.end(JSON.stringify({Messages:[{Status:'success',To:[{Email:'sender@example.test'}]}]}));
  }).listen(0,'127.0.0.1');await once(jetServer,'listening');
  process.env.MAILJET_TEST_URL='http://127.0.0.1:'+jetServer.address().port+'/v3.1/send';
  const {default:app}=await import('../../server/app.ts');
  appServer=app.listen(0,'127.0.0.1');await once(appServer,'listening');base='http://127.0.0.1:'+appServer.address().port;
  cookie=(await request('/login',{body:{identifier:'demo@skolehr.xyz',password:'12345678'},session:null})).cookie;
  otherCookie=(await request('/login',{body:{identifier:'other@formapoint.test',password:'12345678'},session:null})).cookie;
  const {mime}=await import('../../server/mail.ts');
  raw=await mime({from:'sender@example.test',to:['demo@skolehr.xyz'],subject:'Primitak s privitkom',text:'Izvorni tekst čćž.',headers:{'Message-ID':'<native-pilot@example.test>'},attachments:[{filename:'provjera.txt',content:Buffer.from('Sadržaj privitka čćž.')} ]});
});
after(async()=>{appServer?.close();jetServer?.close();await db?.end();});

test('HMAC, izmjena tijela, istek potpisa, drugi primatelj i admin host odbijeni',async()=>{
  assert.equal((await deliver(raw,{...headers(),'x-webmail-signature':'0'.repeat(64)})).status,401);
  assert.equal((await deliver(Buffer.concat([raw,Buffer.from('tampered')]),headers())).status,401);
  assert.equal((await deliver(raw,headers(raw,'demo@skolehr.xyz',String(Date.now()-600000)))).status,401);
  assert.equal((await deliver(raw,headers(raw,'other@skolehr.xyz'))).status,403);
  const adminStatus=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api/inbound/cloudflare',{method:'POST',headers:{...headers(),host:'admin.localhost'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end(raw);
  });
  assert.equal(adminStatus,403);
  assert.equal((await deliver(Buffer.alloc(3_000_001),headers(Buffer.alloc(3_000_001)))).status,413);
});
test('Izravni HTTPS primitak i istodobne ponovljene dostave spremaju jednu poruku',async()=>{
  const results=await Promise.all(Array.from({length:6},()=>deliver()));
  assert.equal(results.filter(r=>r.status===201).length,1);
  const receipts=await Promise.all(results.map(r=>r.json()));
  assert.equal(new Set(receipts.map(x=>x.id)).size,1);
  assert.equal((await db.query('select count(*)::int as n from native_messages')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int as n from native_attachments')).rows[0].n,1);
  const me=(await request('/me')).body;assert.deepEqual(me.boxes.map(x=>x.address),['demo@skolehr.xyz']);
  const rows=(await request('/mail/'+box)).body;assert.equal(rows.length,1);assert.equal(rows[0].attachment,true);
  location=new URLSearchParams({id:rows[0].id,path:rows[0].path});
  const msg=(await request('/mail/'+box+'/message?'+location)).body;
  assert.match(msg.text,/Izvorni tekst čćž/);assert.equal(msg.attachments[0].name,'provjera.txt');
  assert.equal((await request('/mail/'+box+'/attachment?'+location+'&index=0')).body,'Sadržaj privitka čćž.');
});
test('Postojeće ovlasti štite popis, poruku, privitak, oznake, premještanje i slanje',async()=>{
  for(const route of ['/mail/'+box,'/mail/'+box+'/message?'+location,'/mail/'+box+'/attachment?'+location+'&index=0','/mail/'+box+'/quota']){
    await request(route,{session:otherCookie,status:403});
  }
  await request('/mail/'+box+'/message',{session:otherCookie,method:'PATCH',body:{path:'INBOX',id:Number(location.get('id')),flag:'read',value:true},status:403});
  await request('/mail/'+box+'/move',{session:otherCookie,body:{path:'INBOX',id:Number(location.get('id')),destination:'trash'},status:403});
  await request('/mail/'+box+'/send',{session:otherCookie,body:{from:'demo@skolehr.xyz',to:['sender@example.test'],subject:'No',text:'No'},status:403});
  await request('/mail/'+box+'/send',{body:{from:'other@skolehr.xyz',to:['sender@example.test'],subject:'No',text:'No'},status:403});
  const otherMe=(await request('/me',{session:otherCookie})).body;assert.equal(otherMe.boxes.some(x=>x.id===box),false);
  assert.equal((await db.query('select storage_kind from mailboxes where id=$1',[otherBox])).rows[0].storage_kind,'imap');
});
test('Odgovor preko probnog Mailjeta i kopija u Poslano',async()=>{
  const result=(await request('/mail/'+box+'/send',{body:{from:'demo@skolehr.xyz',to:['sender@example.test'],subject:'Re: Primitak s privitkom',text:'Odgovor.',inReplyTo:'<native-pilot@example.test>',attachments:[{filename:'odgovor.txt',data:Buffer.from('Reply attachment').toString('base64')}]}})).body;
  assert.match(result.warning,/nije stvarno poslana/);
  assert.equal(sent.length,1);assert.equal(sent[0].body.SandboxMode,true);
  const msg=sent[0].body.Messages[0];assert.equal(msg.From.Email,'demo@skolehr.xyz');assert.equal(msg.To[0].Email,'sender@example.test');
  assert.equal(msg.Headers['In-Reply-To'],'<native-pilot@example.test>');
  assert.equal(Buffer.from(msg.Attachments[0].Base64Content,'base64').toString(),'Reply attachment');
  assert.equal(sent[0].authorization,'Basic '+Buffer.from('local-key:local-secret').toString('base64'));
  const copies=(await request('/mail/'+box+'?folder=sent')).body;assert.equal(copies.length,1);assert.equal(copies[0].inReplyTo,'<native-pilot@example.test>');
  const sentLocation=new URLSearchParams({id:copies[0].id,path:copies[0].path});
  const saved=(await request('/mail/'+box+'/message?'+sentLocation)).body;
  assert.equal(saved.text.trim(),'Odgovor.');assert.equal(saved.attachments[0].name,'odgovor.txt');
  assert.equal((await request('/mail/'+box+'/attachment?'+sentLocation+'&index=0')).body,'Reply attachment');
  jetFailure=true;
  await request('/mail/'+box+'/send',{body:{from:'demo@skolehr.xyz',to:['sender@example.test'],subject:'Fail',text:'Fail'},status:502});
  jetFailure=false;assert.equal((await request('/mail/'+box+'?folder=sent')).body.length,1);
});
test('Skice, oznake, pretraživanje, premještanje i trajna deduplikacija nakon premještanja',async()=>{
  const body={path:'INBOX',id:Number(location.get('id')),flag:'star',value:true};
  await request('/mail/'+box+'/message',{method:'PATCH',body});
  assert.equal((await request('/mail/'+box+'?folder=starred')).body.length,1);
  assert.equal((await request('/mail/'+box+'?q=čćž')).body.length,1);
  await request('/mail/'+box+'/move',{body:{path:'INBOX',id:body.id,destination:'trash'}});
  assert.equal((await deliver()).status,200);assert.equal((await request('/mail/'+box)).body.length,0);
  assert.equal((await request('/mail/'+box+'?folder=trash')).body.length,1);
  const draft={from:'demo@skolehr.xyz',to:[],subject:'Skica',text:'Prva',draft:true};
  await request('/mail/'+box+'/send',{body:draft});
  const old=(await request('/mail/'+box+'?folder=drafts')).body[0];
  await request('/mail/'+box+'/send',{body:{...draft,text:'Druga',draftId:old.id}});
  assert.equal((await request('/mail/'+box+'?folder=drafts')).body.length,1);
  const quota=(await request('/mail/'+box+'/quota')).body;assert.ok(quota.used>raw.length);assert.equal(quota.limit,25_000_000);
});
test('Kvota i deaktivacija ne potvrđuju izgubljenu dostavu',async()=>{
  const next=Buffer.concat([raw,Buffer.from('\r\nDifferent delivery')]);
  process.env.NATIVE_TOTAL_BYTES='1';assert.equal((await deliver(next)).status,507);
  assert.equal((await deliver()).status,200);delete process.env.NATIVE_TOTAL_BYTES;
  await db.query('update mailboxes set active=false where id=$1',[box]);assert.equal((await deliver(next)).status,404);
  await db.query('update mailboxes set active=true where id=$1',[box]);
  assert.equal((await db.query("select count(*)::int as n from native_messages where delivery_hash is not null")).rows[0].n,1);
});
test('Worker prenosi izvorni MIME; izgubljeni HTTPS odgovor ne stvara duplikat',async()=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,opts)=>{
    assert.equal(url,'https://webmailhr.com/api/inbound/cloudflare');
    assert.deepEqual(Buffer.from(opts.body),raw);
    const response=await originalFetch(base+'/api/inbound/cloudflare',opts);
    if(++calls===1)throw new Error('Simulated lost acknowledgment');return response;
  };
  try{
    let rejected;
    await worker.email({to:'demo@skolehr.xyz',from:'sender@example.test',rawSize:raw.length,raw:new Blob([raw]).stream(),setReject:r=>{rejected=r;}},
      {INBOUND_URL:'https://webmailhr.com/api/inbound/cloudflare',INBOUND_SECRET:process.env.CLOUDFLARE_INBOUND_SECRET});
    assert.equal(rejected,undefined);assert.equal(calls,2);
  }finally{globalThis.fetch=originalFetch;}
  assert.equal((await db.query("select count(*)::int as n from native_messages where delivery_hash is not null")).rows[0].n,1);
});

test('Worker odbija poruku nakon iscrpljenih HTTPS pokušaja; Mailjet kvota sprječava novi poziv',async()=>{
  const originalFetch=globalThis.fetch;let calls=0,rejected;
  globalThis.fetch=async()=>{calls++;return new Response('unavailable',{status:503});};
  try{
    await worker.email({to:'demo@skolehr.xyz',from:'sender@example.test',rawSize:raw.length,raw:new Blob([raw]).stream(),setReject:r=>{rejected=r;}},
      {INBOUND_URL:'https://webmailhr.com/api/inbound/cloudflare',INBOUND_SECRET:process.env.CLOUDFLARE_INBOUND_SECRET});
    assert.equal(calls,3);assert.match(rejected,/storage unavailable/);
  }finally{globalThis.fetch=originalFetch;}
  process.env.MAILJET_DAILY_RECIPIENTS='1';
  const previous=sent.length;
  await request('/mail/'+box+'/send',{body:{from:'demo@skolehr.xyz',to:['sender@example.test'],subject:'Quota',text:'Quota'},status:429});
  assert.equal(sent.length,previous);delete process.env.MAILJET_DAILY_RECIPIENTS;
});

let nativeRoot,nativeOrg,viktorBox,viktorUid,viktorCookie;
async function adminRequest(path,{body,method=body?'POST':'GET',status=200}={}){
  return new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api'+path,{method,headers:{host:'admin.localhost',cookie:nativeRoot,...(body?{'Content-Type':'application/json'}:{})}},res=>{
      let output='';res.on('data',chunk=>{output+=chunk;});res.on('end',()=>{
        try{assert.equal(res.statusCode,status,path+' '+output);resolve(JSON.parse(output));}catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
test('Samo root uključuje native sandučić; serverska allowlista i osobni vlasnik su obavezni',async()=>{
  const {hashPassword,digest}=await import('../../server/db.ts');
  nativeOrg=(await db.query('select org from mailboxes where id=$1',[box])).rows[0].org;
  const root=(await db.query("insert into users(org,email,name,password,role) values($1,'root@formapoint.test','Root',$2,'root') returning id",[nativeOrg,await hashPassword('local-root-password')])).rows[0].id;
  const key=randomBytes(32).toString('hex');nativeRoot='wm_session='+key;
  await db.query("insert into sessions values($1,$2,now()+interval '1 hour')",[digest(key),root]);
  viktorUid=(await db.query("insert into users(org,email,name,password,auth_kind) values($1,'viktor.beljan@skolehr.xyz','Viktor',$2,'staff') returning id",[nativeOrg,await hashPassword('87654321')])).rows[0].id;
  viktorBox=(await db.query("insert into mailboxes(org,address,label) values($1,'viktor.beljan@skolehr.xyz','Viktor') returning id",[nativeOrg])).rows[0].id;
  const route='/admin/mailboxes/'+viktorBox+'/native';
  await request(route,{method:'POST',status:403});
  await db.query("update users set role='admin' where email='other@formapoint.test'");
  await request(route,{method:'POST',session:otherCookie,status:403});
  await db.query("update users set role='user' where email='other@formapoint.test'");
  await adminRequest(route,{method:'POST',status:409}); // Not allowlisted.
  process.env.NATIVE_ENABLED_ADDRESSES+=',viktor.beljan@skolehr.xyz';
  await adminRequest(route,{method:'POST',status:409}); // No owner.
  await db.query('insert into grants(uid,box,can_send) values($1,$2,false)',[viktorUid,viktorBox]);
  await adminRequest(route,{method:'POST',status:409}); // Cannot send.
  await db.query('update grants set can_send=true where box=$1',[viktorBox]);
  await db.query('update users set active=false where id=$1',[viktorUid]);
  await adminRequest(route,{method:'POST',status:409});
  await db.query('update users set active=true where id=$1',[viktorUid]);
  const otherUid=(await db.query("select id from users where email='other@formapoint.test'")).rows[0].id;
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[otherUid,viktorBox]);
  await adminRequest(route,{method:'POST',status:409}); // Multiple owners.
  await db.query('delete from grants where uid=$1 and box=$2',[viktorUid,viktorBox]);
  await adminRequest(route,{method:'POST',status:409}); // Wrong email, even in same org.
  await db.query('delete from grants where box=$1',[viktorBox]);
  await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[viktorUid,viktorBox]);
  assert.equal((await db.query('select storage_kind from mailboxes where id=$1',[viktorBox])).rows[0].storage_kind,'imap');
});
test('Native aktivacija odbija zajednički, neaktivni i sinkronizirani IMAP sandučić te isključenu domenu',async()=>{
  const route='/admin/mailboxes/'+viktorBox+'/native';
  for(const change of ['shared=true','active=false']){
    await db.query('update mailboxes set '+change+' where id=$1',[viktorBox]);
    await adminRequest(route,{method:'POST',status:409});
    await db.query('update mailboxes set shared=false,active=true where id=$1',[viktorBox]);
  }
  await db.query("update domains set outbound=false where name='skolehr.xyz'");
  await adminRequest(route,{method:'POST',status:409});
  await db.query("update domains set outbound=true where name='skolehr.xyz'");
  await db.query("insert into directory_identities values('local-test','viktor',$1)",[viktorUid]);
  await db.query("insert into directory_mailboxes(box,uid,encrypted_password) values($1,$2,'test-only')",[viktorBox,viktorUid]);
  await adminRequest(route,{method:'POST',status:409});
  await db.query('delete from directory_identities where uid=$1',[viktorUid]);
  const secret=process.env.MAILJET_SECRET_KEY;delete process.env.MAILJET_SECRET_KEY;
  try{await adminRequest(route,{method:'POST',status:503});}finally{process.env.MAILJET_SECRET_KEY=secret;}
});
test('Native uključivanje je idempotentno, čuva dodjelu i izolira stvarni drugi osobni sandučić',async()=>{
  const route='/admin/mailboxes/'+viktorBox+'/native';
  await adminRequest(route,{method:'POST'});await adminRequest(route,{method:'POST'});
  const rows=await adminRequest('/admin/mailboxes');assert.equal(rows.find(x=>x.id===viktorBox).storage_kind,'native');
  assert.equal((await db.query("select count(*)::int n from audits where action='mailbox.native.enable' and target=$1",[String(viktorBox)])).rows[0].n,1);
  assert.equal((await db.query('select storage_kind from mailboxes where id=$1',[otherBox])).rows[0].storage_kind,'imap');
  viktorCookie=(await request('/login',{session:null,body:{identifier:'viktor.beljan@skolehr.xyz',password:'87654321'}})).cookie;
  assert.deepEqual((await request('/me',{session:viktorCookie})).body.boxes.map(x=>x.id),[viktorBox]);
  const {mime}=await import('../../server/mail.ts');
  const bytes=await mime({from:'sender@example.test',to:['viktor.beljan@skolehr.xyz'],subject:'Viktor personal',text:'Private mail',attachments:[{filename:'viktor.txt',content:Buffer.from('Viktor only')}]});
  assert.equal((await deliver(bytes,headers(bytes,'viktor.beljan@skolehr.xyz'))).status,201);
  const row=(await request('/mail/'+viktorBox,{session:viktorCookie})).body[0];
  const query=new URLSearchParams({path:row.path,id:row.id});
  assert.equal((await request('/mail/'+viktorBox+'/attachment?'+query+'&index=0',{session:viktorCookie})).body,'Viktor only');
  await request('/mail/'+viktorBox+'/message?'+query,{status:403});
  await request('/mail/'+box,{session:viktorCookie,status:403});
  await request('/mail/'+viktorBox+'/send',{session:viktorCookie,body:{from:'viktor.beljan@skolehr.xyz',to:['sender@example.test'],subject:'Viktor reply',text:'Reply'}});
  assert.equal(sent.at(-1).body.Messages[0].From.Email,'viktor.beljan@skolehr.xyz');
});
test('Administracija čuva adresu i osobnu dodjelu aktiviranog native sandučića',async()=>{
  const update={key:viktorBox,org:nativeOrg,address:'viktor.beljan@skolehr.xyz',label:'Viktor',shared:false,active:true,target_quota_gb:15};
  await adminRequest('/admin/mailboxes',{body:{...update,address:'other@skolehr.xyz'},status:409});
  await adminRequest('/admin/mailboxes',{body:{...update,shared:true},status:409});
  await adminRequest('/admin/mailboxes',{body:{...update,storage_kind:'imap'}});
  assert.equal((await db.query('select storage_kind from mailboxes where id=$1',[viktorBox])).rows[0].storage_kind,'native');
  const otherUid=(await db.query("select id from users where email='other@formapoint.test'")).rows[0].id;
  await adminRequest('/admin/access/'+viktorBox,{method:'PUT',body:{kind:'grant',uid:otherUid,remove:false,can_send:true,can_calendar:false},status:409});
});

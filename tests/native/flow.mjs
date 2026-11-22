import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
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
  const {hashPassword}=await import('../../server/db.ts');
  const {staffSecret}=await import('../../server/identity.ts');
  const password=await hashPassword(staffSecret('12345678'));
  const org=(await db.query("insert into organizations(name) values('Native pilot') returning id")).rows[0].id;
  await db.query("insert into domains(name,org) values('skolehr.xyz',$1),('formapoint.test',$1)",[org]);
  const owner=(await db.query("insert into users(org,email,name,password,auth_kind) values($1,'demo@skolehr.xyz','Demo',$2,'staff') returning id",[org,password])).rows[0].id;
  const other=(await db.query("insert into users(org,email,name,password,auth_kind) values($1,'other@formapoint.test','Other',$2,'staff') returning id",[org,password])).rows[0].id;
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

test('Izdani identitet: nastavnikova Webmail lozinka i učenikov izvorni Auth otvaraju samo dodijeljeni sandučić',async()=>{
 const {hashPassword,verifyPassword}=await import('../../server/db.ts'),{staffSecret}=await import('../../server/identity.ts');
 const project='identity-test-source',schoolSource='identity-test-school',teacherId='10000000-0000-4000-8000-000000000001',pupilId='10000000-0000-4000-8000-000000000002';
 const teacherEmail='identity-teacher@skolehr.xyz',pupilEmail='identity-pupil@skolehr.xyz',teacherPassword='Te9abcXY',pupilPassword='St8abcXY';
 const keys=['EDNEVNIK_IDENTITY_ISSUANCE_TOKEN','EDNEVNIK_SUPABASE_PROJECT_ID','EDNEVNIK_SUPABASE_URL','EDNEVNIK_USERNAME_LOGIN_URL','EDNEVNIK_USERNAME_LOGIN_TOKEN'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 let sourceCalls=0;
 const source=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const x=JSON.parse(raw);sourceCalls++;res.setHeader('Content-Type','application/json');if(req.headers.authorization==='Bearer identity-source-token'&&x.username===pupilEmail&&x.password===pupilPassword)res.end(JSON.stringify({user_id:pupilId}));else{res.statusCode=401;res.end(JSON.stringify({error:'invalid'}));}}).listen(0,'127.0.0.1');await once(source,'listening');
 process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN='identity-issuance-token';process.env.EDNEVNIK_SUPABASE_PROJECT_ID=project;process.env.EDNEVNIK_SUPABASE_URL='http://127.0.0.1:'+source.address().port;process.env.EDNEVNIK_USERNAME_LOGIN_URL=process.env.EDNEVNIK_SUPABASE_URL+'/student';process.env.EDNEVNIK_USERNAME_LOGIN_TOKEN='identity-source-token';
 try{
  const org=(await db.query("select id from organizations where name='Native pilot'")).rows[0].id;
  const school=(await db.query("insert into schools(org,name) values($1,'Identity school') returning id",[org])).rows[0].id;
  await db.query('insert into directory_schools(project,subject,school) values($1,$2,$3)',[project,schoolSource,school]);
  const teacher=(await db.query("insert into users(org,school,email,name,password,auth_kind) values($1,$2,$3,'Ogledni nastavnik',$4,'staff') returning id",[org,school,teacherEmail,await hashPassword(staffSecret('12345678'))])).rows[0].id;
  const pupil=(await db.query("insert into users(org,school,email,name,password,auth_kind,source_project,source_user_id) values($1,$2,$3,'Ogledni učenik',null,'ednevnik',$4,$5) returning id",[org,school,pupilEmail,project,pupilId])).rows[0].id;
  const boxes=[];
  for(const [uid,subject,address]of[[teacher,teacherId,teacherEmail],[pupil,pupilId,pupilEmail]]){
   await db.query('insert into directory_identities(project,subject,uid) values($1,$2,$3)',[project,subject,uid]);await db.query('insert into directory_school_memberships(uid,school) values($1,$2)',[uid,school]);
   const b=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,$2,'native') returning id",[org,address])).rows[0].id;boxes.push(b);
   await db.query("insert into directory_mailboxes(box,uid,encrypted_password,ready) values($1,$2,'synthetic-transport-placeholder',true)",[b,uid]);await db.query('insert into grants(uid,box) values($1,$2)',[uid,b]);
  }
  const activate=async(user_id,email,relationship,password)=>{
   for(const operation of ['prepare','activate']){
    const r=await fetch(base+'/api/integrations/ednevnik/electronic-identity',{method:'POST',headers:{Authorization:'Bearer identity-issuance-token','Content-Type':'application/json'},body:JSON.stringify({operation,user_id,school_id:schoolSource,email,relationship,...(operation==='activate'?{password}:{})})});
    assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).ready,true);
   }
  };
  await activate(teacherId,teacherEmail,'TEACHER',teacherPassword);assert.equal(sourceCalls,0,'nastavnikova lozinka ne mijenja izvorni PIN/autentifikator');
  await request('/login',{body:{identifier:teacherEmail,password:'12345678'},session:null,status:401});
  const teacherSession=(await request('/login',{body:{identifier:teacherEmail,password:teacherPassword},session:null})).cookie;
  assert.deepEqual((await request('/mail/'+boxes[0],{session:teacherSession})).body,[]);await request('/mail/'+boxes[1],{session:teacherSession,status:403});
  await activate(pupilId,pupilEmail,'STUDENT',pupilPassword);
  const pupilSession=(await request('/login',{body:{identifier:pupilEmail,password:pupilPassword},session:null})).cookie;
  assert.deepEqual((await request('/mail/'+boxes[1],{session:pupilSession})).body,[]);await request('/mail/'+boxes[0],{session:pupilSession,status:403});
  assert.equal((await db.query('select password from users where id=$1',[pupil])).rows[0].password,null);
 }finally{await new Promise(r=>source.close(r));for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

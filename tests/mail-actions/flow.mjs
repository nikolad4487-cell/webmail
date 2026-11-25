import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
const url=process.env.TEST_MAIL_ACTIONS_DATABASE_URL;
if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw new Error('Use an empty disposable local TEST_MAIL_ACTIONS_DATABASE_URL.');
Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',DEMO_MODE:'1',ADMIN_ORIGIN:''});delete process.env.APP_ORIGIN;
let db,server,base,box,otherBox,cookie,otherCookie,readOnlyCookie,storeNative,nativeQuota;
const address='owner@skolehr.xyz';
async function request(route,body,status=200,session=cookie,origin){
 const r=await fetch(base+'/api/mail/'+box+route,{method:'POST',headers:{'Content-Type':'application/json',...(session?{cookie:session}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
 const result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;
}
async function add(path,options={}){
 const {rows:[row]}=await db.query(`insert into native_messages(box,path,raw,subject,text_body,sent_at,bytes,starred) values($1,$2,$3,$4,'Body',now(),100,true) returning id,path`,[options.box||box,path,Buffer.from('Subject: Fixture\r\n\r\nBody'),options.subject||'Fixture']);
 await db.query("insert into native_attachments values($1,0,'a.txt','text/plain',$2)",[row.id,Buffer.from('attachment')]);return row;
}
async function session(uid,seed){const value=seed.repeat(64);await db.query("insert into sessions values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(value).digest('hex'),uid]);return 'wm_session='+value;}
before(async()=>{
 ({db}=await import('../../server/db.ts'));assert.equal((await db.query("select to_regclass('users') name")).rows[0].name,null);
 for(const f of ['server/schema.sql','migrations/001-native-mail.sql','migrations/002-mail-passwords.sql','migrations/003-mailbox-provisioning.sql','migrations/006-school-mailboxes.sql'])await db.query(await readFile(new URL('../../'+f,import.meta.url),'utf8'));
 const org=(await db.query("insert into organizations(name) values('Mail action test') returning id")).rows[0].id;
 await db.query("insert into domains(name,org,mailbox_backend) values('skolehr.xyz',$1,'native')",[org]);
 const ids=[];for(const name of ['owner','other','reader'])ids.push((await db.query("insert into users(org,email,name,password,auth_kind) values($1,$2,$3,'unused','staff') returning id",[org,name+'@skolehr.xyz',name])).rows[0].id);
 box=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,'Owner','native') returning id",[org,address])).rows[0].id;
 otherBox=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,'other@skolehr.xyz','Other','native') returning id",[org])).rows[0].id;
 await db.query('insert into grants values($1,$2,true,true),($3,$4,true,true),($5,$2,false,false)',[ids[0],box,ids[1],otherBox,ids[2]]);
 cookie=await session(ids[0],'a');otherCookie=await session(ids[1],'b');readOnlyCookie=await session(ids[2],'c');
 ({storeNative,nativeQuota}=await import('../../server/native-mail.ts'));
 const {default:app}=await import('../../server/app.ts');server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db?.end();});
test('Bulk selection handles source folders, deduplicates identifiers and supports flags and moves',async()=>{
 const messages=await Promise.all(['INBOX','Sent','Drafts'].map(p=>add(p)));
 assert.equal((await request('/bulk',{action:'unread',messages:[...messages,messages[0]]})).affected,3);
 await request('/bulk',{action:'unstar',messages});
 assert.equal((await db.query('select count(*)::int n from native_messages where box=$1 and (seen or starred)',[box])).rows[0].n,0);
 await request('/bulk',{action:'trash',messages});
 assert.equal((await db.query("select count(*)::int n from native_messages where box=$1 and path='Trash'",[box])).rows[0].n,3);
});
test('Foreign, stale, invalid-folder and read-only requests cannot permanently delete a mixed batch',async()=>{
 const own=await add('Trash'),foreign=await add('Trash',{box:otherBox}),inbox=await add('INBOX');
 await request('/bulk',{action:'delete',messages:[own,foreign]},404);
 await request('/bulk',{action:'delete',messages:[own,inbox]},403);
 await request('/bulk',{action:'delete',messages:[own]},403,otherCookie);
 await request('/bulk',{action:'delete',messages:[own]},403,readOnlyCookie);
 await request('/bulk',{action:'trash',messages:[inbox]},403,readOnlyCookie);
 await request('/empty',{folder:'trash'},403,readOnlyCookie);
 await request('/empty',{folder:'inbox'},400);
 await request('/bulk',{action:'delete',messages:[]},400);
 await request('/bulk',{action:'delete',messages:[own]},403,cookie,'https://evil.example');
 assert.equal((await db.query('select count(*)::int n from native_messages where id=any($1::int[])',[[own.id,foreign.id,inbox.id]])).rows[0].n,3);
 await request('/bulk',{action:'read',messages:[inbox]},200,readOnlyCookie);
});
test('Permanent Trash/Junk deletion removes attachment bytes and lowers quota while preserving other folders',async()=>{
 const trash=await add('Trash'),junk=await add('Junk'),sent=await add('Sent');
 const before=await nativeQuota(address);
 const result=await request('/bulk',{action:'delete',messages:[trash,junk]});assert.equal(result.affected,2);assert.equal(result.freedBytes,200);
 assert.equal((await nativeQuota(address)).used,before.used-200);
 assert.equal((await db.query('select count(*)::int n from native_attachments where message=any($1::int[])',[[trash.id,junk.id]])).rows[0].n,0);
 assert.ok((await db.query('select 1 from native_messages where id=$1',[sent.id])).rowCount);
});
test('Emptying a folder deletes beyond the 80-message list cap and leaves Junk and the other mailbox untouched',async()=>{
 await request('/empty',{folder:'trash'});
 for(let i=0;i<90;i++)await add('Trash');
 const junk=await add('Junk'),foreign=await add('Trash',{box:otherBox});
 const r=await fetch(base+'/api/mail/'+box+'?folder=trash',{headers:{cookie}});assert.equal((await r.json()).length,80);
 const before=await nativeQuota(address),result=await request('/empty',{folder:'trash'});
 assert.equal(result.affected,90);assert.equal(result.freedBytes,9000);assert.equal((await nativeQuota(address)).used,before.used-9000);
 assert.equal((await db.query('select count(*)::int n from native_messages where id=any($1::int[])',[[junk.id,foreign.id]])).rows[0].n,2);
 assert.equal((await request('/empty',{folder:'trash'})).affected,0);
});
test('Freed storage immediately permits a previously over-quota receipt',async()=>{
 const disposable=await add('Junk');const used=(await nativeQuota(address)).used;
 const raw=Buffer.from('From: sender@example.test\r\nTo: '+address+'\r\nSubject: Freed\r\nContent-Type: text/plain\r\n\r\nReleased');
 process.env.NATIVE_MAILBOX_BYTES=String(used+raw.length+Buffer.byteLength('Released')-1);
 await assert.rejects(storeNative(address,'INBOX',raw,{from:'sender@example.test'}),error=>error.status===507);
 await request('/bulk',{action:'delete',messages:[disposable]});
 const saved=await storeNative(address,'INBOX',raw,{from:'sender@example.test'});assert.ok(saved.id);
 delete process.env.NATIVE_MAILBOX_BYTES;
});

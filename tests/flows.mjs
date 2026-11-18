import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const base=process.env.APP_ORIGIN || 'http://127.0.0.1:3001';
const order='order_test_key_only_0000000000000000';
const promotion='promotion_test_key_only_00000000000';
const attachment='Provjera privitka čćž.';
const run=randomUUID();
async function request(path,{cookie,body,method=body===undefined?'GET':'POST',key,status=200}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(key?{authorization:'Bearer '+key}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const output=await response.text();
  assert.equal(response.status,status,path+' '+output);
  return {body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(output):output,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const sessions=new Map();
async function login(email){
  if(sessions.has(email)) return sessions.get(email);
  const {cookie}=await request('/login',{body:{email,password:'Webmail-Test-2026'}});
  const {body}=await request('/me',{cookie});
  const result={cookie,boxes:body.boxes,user:body.account};
  sessions.set(email,result);
  return result;
}
async function receive(box,cookie,subject){
  for(let i=0;i<18;i++){
    const list=(await request('/mail/'+box,{cookie})).body;
    const row=list.find(x=>x.subject===subject);
    if(row)return new URLSearchParams({path:row.path,id:String(row.id)});
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.fail('Poruka nije stigla: '+subject);
}
function send(box,cookie,to,subject){
  return request('/mail/'+box.id+'/send',{cookie,body:{to:[to],from:box.address,subject,text:'Probna poruka.',attachments:[{filename:'provjera.txt',data:Buffer.from(attachment).toString('base64')}]}});
}
test('Izolacija dviju škola, zajednička referada i odbijanje tuđeg pošiljatelja',async()=>{
  const ivan=await login('ivan@skolehr.test'), mia=await login('mia@skolehr.test');
  const shared=ivan.boxes.find(x=>x.address==='referada@skolehr.test');
  assert.ok(shared.can_send);
  assert.equal(mia.boxes.length,1);
  await request('/mail/'+shared.id,{cookie:ivan.cookie});
  for(const box of [shared,ivan.boxes[0]]){
    await request('/mail/'+box.id,{cookie:mia.cookie,status:403});
    await request('/mail/'+box.id+'/attachment?path=INBOX&id=1&index=0',{cookie:mia.cookie,status:403});
  }
  await request('/mail/'+mia.boxes[0].id+'/send',{cookie:mia.cookie,body:{from:shared.address,to:['ivan@skolehr.test'],subject:'Zabranjeno',text:'Test'},status:403});
});
test('SMTP/IMAP u oba smjera, privitak, jedna kopija Poslano i kvota',async()=>{
  const ivan=await login('ivan@skolehr.test'),mia=await login('mia@skolehr.test');
  for(const [from,to] of [[ivan,mia],[mia,ivan]]){
    const sender=from.boxes[0], receiver=to.boxes[0],subject=run+' '+sender.address;
    const {body:result}=await send(sender,from.cookie,receiver.address,subject);
    assert.equal(result.warning,undefined);
    const location=await receive(receiver.id,to.cookie,subject);
    const {body:file}=await request('/mail/'+receiver.id+'/attachment?'+location+'&index=0',{cookie:to.cookie});
    assert.equal(file,attachment);
    const sent=(await request('/mail/'+sender.id+'?folder=sent',{cookie:from.cookie})).body;
    assert.equal(sent.filter(x=>x.subject===subject).length,1);
    const {body:quota}=await request('/mail/'+receiver.id+'/quota',{cookie:to.cookie});
    assert.equal(quota.target,15);
    if(process.env.DEMO_TLS==='1'){assert.equal(quota.limit,15*1024*1024*1024);assert.ok(quota.used>0);}
    else assert.equal(quota.limit,null);
  }
});
test('Zajednički kalendar, Zagreb i pozivnica',async()=>{
  const ivan=await login('ivan@skolehr.test'),mia=await login('mia@skolehr.test');
  const shared=ivan.boxes.find(x=>x.can_calendar&&x.address.startsWith('referada'));
  const event={box:shared.id,title:'Sjednica '+run,starts:'2026-11-18T10:00:00+01:00',ends:'2026-11-18T10:30:00+01:00',attendees:['mia@skolehr.test']};
  const {body}=await request('/events',{cookie:ivan.cookie,body:event});
  const invite='/events/'+body.id+'/ics';
  assert.match((await request(invite,{cookie:ivan.cookie})).body,/DTSTART:20261118T090000Z/);
  await request(invite,{cookie:mia.cookie,status:403});
  await request('/events/'+body.id,{cookie:ivan.cookie,method:'PUT',body:{...event,title:'Uređeno'}});
  assert.match((await request(invite,{cookie:ivan.cookie})).body,/SUMMARY:Uređeno/);
});
test('Idempotentna narudžba, ovlast ključa, marketinška odjava i dostava',async()=>{
  const requestSend='/integrations/formapoint/send';
  const consent='/integrations/formapoint/consent';
  const recipient='mia@skolehr.test',mia=await login(recipient);
  const event={kind:'order',eventId:run,recipient,subject:'Narudžba '+run,text:'Potvrda.'};
  await request(requestSend,{key:promotion,body:event,status:403});
  const first=(await request(requestSend,{key:order,body:event})).body;
  assert.equal(first.status,'submitted');
  const second=(await request(requestSend,{key:order,body:{...event,recipient:'ivan@skolehr.test'}})).body;
  assert.equal(second.id,first.id);assert.equal(second.duplicate,true);
  await receive(mia.boxes[0].id,mia.cookie,event.subject);
  const campaign={...event,kind:'promotion',list:'novosti',subject:'Promocija '+run};
  await request(consent,{key:promotion,method:'PUT',body:{list:'novosti',recipient,allowed:true}});
  const sent=(await request(requestSend,{key:promotion,body:campaign})).body;
  await request('/integrations/formapoint/delivery/'+sent.id,{key:promotion,method:'PUT',body:{status:'delivered'}});
  const message=await receive(mia.boxes[0].id,mia.cookie,campaign.subject);
  const {body:mail}=await request('/mail/'+mia.boxes[0].id+'/message?'+message,{cookie:mia.cookie});
  assert.equal(mail.replyTo,'info@formapoint.test');
  const link=mail.text.match(/\/api(\/unsubscribe\/\d+\/[a-f0-9]{64})/)[1];
  await request(link);
  await request(link,{method:'POST'});
  await request(requestSend,{key:promotion,body:{...campaign,eventId:run+'-next'},status:403});
  const receipt=(await request(requestSend,{key:order,body:{...event,eventId:run+'-next'}})).body;
  assert.equal(receipt.status,'submitted');
});
test('Skica se može zamijeniti i poruka označiti',async()=>{
  const account=await login('ivan@skolehr.test'), cookie=account.cookie, box=account.boxes[0];
  const base='/mail/'+box.id;
  const first={from:box.address,to:[],subject:'Skica '+run,text:'Prva verzija',draft:true};
  await request(base+'/send',{cookie,body:first});
  const drafts=async()=>(await request(base+'?folder=drafts',{cookie})).body;
  const old=(await drafts()).find(x=>x.subject===first.subject);
  assert.ok(old);
  const {body:result}=await request(base+'/send',{cookie,body:{...first,subject:'Uređena '+first.subject,text:'Nova verzija',draftId:old.id}});
  assert.equal(result.warning,undefined);
  const rows=await drafts();
  assert.equal(rows.some(x=>x.id===old.id),false);
  const row=rows.find(x=>x.subject==='Uređena '+first.subject);
  assert.ok(row);
  await request(base+'/message',{cookie,method:'PATCH',body:{path:row.path,id:row.id,flag:'star',value:true}});
  const starred=(await request(base+'?folder=starred',{cookie})).body;
  assert.ok(starred.some(x=>x.path===row.path&&x.id===row.id));
});
test('Oporavak preko potvrđene adrese, jednokratan token i opoziv sesije',async()=>{
  const root=await login('lena@formapoint.test'), mia=await login('mia@skolehr.test');
  const {body:orgs}=await request('/admin/organizations',{cookie:root.cookie});
  const org=orgs.find(x=>x.name==='ŠkoleHR').id;
  const address='oporavak-'+run+'@skolehr.test';
  await request('/admin/users',{cookie:root.cookie,body:{org,email:address,name:'Probni oporavak',school:null,role:'user',active:true,recovery:'mia@skolehr.test',password:'Webmail-Test-2026'}});
  const old=await login(address);
  const mailbox='/mail/'+mia.boxes[0].id;
  const previous=new Set((await request(mailbox,{cookie:mia.cookie})).body.map(row=>row.id));
  await request('/recover',{body:{email:address}});
  let key;
  for(let i=0;i<18&&!key;i++){
    const {body:rows}=await request(mailbox,{cookie:mia.cookie});
    const row=rows.find(x=>!previous.has(x.id) && x.subject==='Ponovno postavljanje lozinke');
    if(row){
      const {body:mail}=await request(mailbox+'/message?'+new URLSearchParams({id:String(row.id),path:row.path}),{cookie:mia.cookie});
      key=mail.text.match(/\?reset=([a-f0-9]{64})/)?.[1];
      if(key){
        const response=await request('/reset',{body:{key,password:'New-Webmail-Test-2026'},status:200});
        assert.equal(response.body.ok,true);
        break;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(key);
  await request('/reset',{body:{key,password:'Other-Webmail-Test-2026'},status:400});
  await request('/me',{cookie:old.cookie,status:401});
  await request('/login',{body:{email:address,password:'New-Webmail-Test-2026'}});
});

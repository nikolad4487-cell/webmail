import {db,transaction} from './db.js';
import {HttpError,type Outgoing,demo} from './mail.js';
import {enabledNativeAddress} from './inbound.js';

export async function sendMailjet(account:string,input:Outgoing,fromName?:string){
  if(!(await enabledNativeAddress(account)) || input.from!==account)throw new HttpError(403,'Pošiljatelj nije omogućen za probu.');
  const key=process.env.MAILJET_API_KEY,secret=process.env.MAILJET_SECRET_KEY;
  if(!key||!secret)throw new HttpError(503,'Mailjet nije konfiguriran.');
  // Test endpoint can only target loopback outside production. Production destination is fixed.
  const url=new URL(process.env.MAILJET_TEST_URL && demo?process.env.MAILJET_TEST_URL:'https://api.mailjet.com/v3.1/send');
  if(url.origin!=='https://api.mailjet.com' && !(demo&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw new HttpError(503,'Neispravan Mailjet servis.');
  const sandbox=process.env.MAILJET_SANDBOX!=='0';
  const attempt=await transaction(async c=>{
    await c.query("select pg_advisory_xact_lock(hashtext('webmailhr.native.mailjet'))");
    const daily=Number(process.env.MAILJET_DAILY_RECIPIENTS||100),monthly=Number(process.env.MAILJET_MONTHLY_RECIPIENTS||1000);
    if(!Number.isSafeInteger(daily)||daily<1||!Number.isSafeInteger(monthly)||monthly<1)throw new HttpError(503,'Mailjet kvota nije konfigurirana.');
    const {rows:[usage]}=await c.query(`select
      coalesce(sum(recipients) filter(where at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)::int as daily,
      coalesce(sum(recipients),0)::int as monthly from native_send_attempts
      where at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'`);
    if(usage.daily+input.to.length>daily||usage.monthly+input.to.length>monthly)throw new HttpError(429,'Dosegnuta je probna Mailjet kvota.');
    const {rows:[row]}=await c.query(`insert into native_send_attempts(box,recipients)
      select id,$2 from mailboxes where address=$1 and active and storage_kind='native' returning id`,[account,input.to.length]);
    if(!row)throw new HttpError(403,'Sandučić nije aktivan.');
    return row.id;
  });
  try{
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12_000),
      headers:{Authorization:'Basic '+Buffer.from(key+':'+secret).toString('base64'),'Content-Type':'application/json'},
      body:JSON.stringify({SandboxMode:sandbox,Messages:[{
        From:{Email:input.from,...(fromName?{Name:fromName}:{})},To:input.to.map(Email=>({Email})),Subject:input.subject,TextPart:input.text,
        ...(input.replyTo?{ReplyTo:{Email:input.replyTo}}:{}),
        ...(input.inReplyTo?{Headers:{'In-Reply-To':input.inReplyTo,References:input.inReplyTo}}:{}),
        Attachments:input.attachments?.map(x=>({ContentType:'application/octet-stream',Filename:x.filename,Base64Content:x.content.toString('base64')})),
      }]})});
    const result=await response.json() as {Messages?:{Status:string;To?:unknown[]}[]};
    if(!response.ok||result.Messages?.length!==1||result.Messages[0].Status!=='success')throw new Error('Mailjet rejected');
    await db.query('update native_send_attempts set status=$2 where id=$1',[attempt,sandbox?'sandbox':'submitted']);
    return {accepted:input.to.length,rejected:0,sandbox};
  }catch{
    // Do not automatically retry an ambiguous send: provider may have accepted it already.
    throw new HttpError(502,'Mailjet predaja nije potvrđena. Provjerite Mailjet zapis prije ponovnog slanja.');
  }
}

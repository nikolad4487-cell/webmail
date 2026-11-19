import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {db,transaction} from './db.js';
import {HttpError} from './mail.js';

export const MAX_NATIVE_BYTES=3_000_000;
export const nativePaths:Record<string,string>={inbox:'INBOX',sent:'Sent',drafts:'Drafts',junk:'Junk',trash:'Trash'};
export async function isNative(address:string){
  const {rows:[m]}=await db.query('select storage_kind from mailboxes where address=$1',[address]);
  return m?.storage_kind==='native';
}
export function nativeBudget(key:'NATIVE_MAILBOX_BYTES'|'NATIVE_TOTAL_BYTES',fallback:number){
  const n=Number(process.env[key] || fallback);
  if(!Number.isSafeInteger(n)||n<1)throw new HttpError(503,'Kvota pohrane nije konfigurirana.');
  return n;
}
export async function storeNative(address:string,path:string,raw:Buffer,inbound?:{from:string}){
  if(raw.length>MAX_NATIVE_BYTES)throw new HttpError(413,'Poruka prelazi ograničenje od 3 MB.');
  const parsed=await simpleParser(raw,{skipImageLinks:true,skipTextLinks:true,skipTextToHtml:true});
  const hash=inbound?createHash('sha256').update(raw).digest('hex'):null;
  const bytes=raw.length+Buffer.byteLength(parsed.text||'')+parsed.attachments.reduce((n,x)=>n+x.content.length,0);
  if(parsed.attachments.length>50)throw new HttpError(413,'Previše privitaka.');
  return transaction(async c=>{
    // Serializes budget accounting and duplicate checks across concurrent function instances.
    await c.query("select pg_advisory_xact_lock(hashtext('webmailhr.native.storage'))");
    const {rows:[box]}=await c.query(`select m.id,d.inbound,d.outbound from mailboxes m join domains d
      on d.name=split_part(m.address,'@',2) and d.org=m.org
      where m.address=$1 and m.active and not m.shared and m.storage_kind='native' for update of m`,[address]);
    if(!box || (inbound&&!box.inbound))throw new HttpError(404,'Primatelj nije omogućen.');
    if(hash){
      const {rows:[old]}=await c.query('select id from native_messages where box=$1 and delivery_hash=$2',[box.id,hash]);
      if(old)return {id:old.id,duplicate:true};
    }
    const {rows:[usage]}=await c.query('select coalesce(sum(bytes),0)::float8 as total,coalesce(sum(bytes) filter(where box=$1),0)::float8 as used from native_messages',[box.id]);
    if(usage.used+bytes>nativeBudget('NATIVE_MAILBOX_BYTES',25_000_000) || usage.total+bytes>nativeBudget('NATIVE_TOTAL_BYTES',100_000_000)){
      throw new HttpError(507,'Nema dovoljno prostora za poruku.');
    }
    const {rows:[row]}=await c.query(`insert into native_messages(box,path,delivery_hash,envelope_from,raw,subject,sender_name,sender_address,text_body,message_id,in_reply_to,sent_at,seen,bytes)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [box.id,path,hash,inbound?.from,raw,parsed.subject||'(Bez predmeta)',parsed.from?.value[0]?.name,parsed.from?.value[0]?.address,
        parsed.text||'',parsed.messageId,parsed.inReplyTo,parsed.date||new Date(),path!=='INBOX',bytes]);
    for(const [i,a] of parsed.attachments.entries())await c.query('insert into native_attachments values($1,$2,$3,$4,$5)',[row.id,i,a.filename||'privitak',a.contentType,a.content]);
    return {id:row.id,duplicate:false};
  });
}
export async function nativeListing(address:string,key:string,q:string){
  if(key!=='starred'&&!Object.hasOwn(nativePaths,key))throw new HttpError(400,'Nepoznata mapa.');
  const {rows}=await db.query(`select n.id,n.path,n.subject,coalesce(nullif(n.sender_name,''),n.sender_address,'Nepoznato') as "from",
    n.sender_address as address,n.sent_at as date,n.message_id as "messageId",n.in_reply_to as "inReplyTo",n.seen as read,n.starred as star,
    exists(select 1 from native_attachments a where a.message=n.id) as attachment
    from native_messages n join mailboxes m on m.id=n.box where m.address=$1
    and (($2='starred' and n.starred) or n.path=$3)
    and ($4='' or strpos(lower(n.subject||' '||coalesce(n.sender_address,'')||' '||n.text_body),lower($4))>0)
    order by n.sent_at desc,n.id desc limit 80`,[address,key,nativePaths[key]||null,q]);
  return rows;
}
export async function nativeMessage(address:string,path:string,id:number,markRead=false){
  const {rows:[row]}=await db.query(`select n.raw from native_messages n join mailboxes m on m.id=n.box
    where m.address=$1 and n.path=$2 and n.id=$3`,[address,path,id]);
  if(!row)throw new HttpError(404,'Poruka nije pronađena.');
  if(markRead)await changeNative(address,path,id,{flag:'read',value:true});
  return simpleParser(row.raw,{skipImageLinks:true,skipTextLinks:true,skipTextToHtml:true});
}
export async function changeNative(address:string,path:string,id:number,change:{flag:'read'|'star';value:boolean}|{destination:string}){
  const column='flag' in change?(change.flag==='read'?'seen':'starred'):'path';
  const value='flag' in change?change.value:nativePaths[change.destination];
  if(value===undefined)throw new HttpError(400,'Nepoznata mapa.');
  const result=await db.query(`update native_messages n set ${column}=$4 from mailboxes m
    where n.box=m.id and m.address=$1 and n.path=$2 and n.id=$3`,[address,path,id,value]);
  if(!result.rowCount)throw new HttpError(404,'Poruka nije pronađena.');
}
export async function nativeQuota(address:string){
  const {rows:[r]}=await db.query(`select coalesce(sum(n.bytes),0)::float8 as used from native_messages n
    join mailboxes m on m.id=n.box where m.address=$1`,[address]);
  return {used:r.used,limit:nativeBudget('NATIVE_MAILBOX_BYTES',25_000_000)};
}

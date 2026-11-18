import { readFileSync } from 'node:fs';
import { ImapFlow, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { db } from './db.js';

export const demo = process.env.DEMO_MODE === '1' && process.env.NODE_ENV !== 'production';
const demoTls=demo && process.env.DEMO_TLS==='1';
const tls=demoTls ? {ca:readFileSync('.quota-demo/tls/cert.pem')} : undefined;
type Endpoint = {host: string; port: number; user: string; password: string; secure?: boolean};
const routes: Record<string, {imap: Endpoint; smtp: Endpoint}> = JSON.parse(process.env.MAIL_ROUTES || '{}');
export const addressing = (address: string) => address.split('@').at(-1)!;
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function endpoint(address: string, protocol: 'imap' | 'smtp') {
  const domain = addressing(address);
  const {rows} = await db.query('select inbound,outbound from domains where name=$1', [domain]);
  if (!rows[0]?.[protocol === 'imap' ? 'inbound' : 'outbound']) throw new HttpError(409, 'Protokol nije omogućen za ovu domenu.');
  if (demo && domain.endsWith('.test')) {
    return {host:'127.0.0.1',port:protocol === 'imap' ? (demoTls?3993:3143) : (demoTls?3465:3025),user:address,password:'LocalTestMail-2026',secure:demoTls};
  }
  const config = routes[address]?.[protocol];
  if (!config) throw new HttpError(503, 'Poštanski servis nije konfiguriran za ovu adresu.');
  return config;
}
export async function imap<T>(address: string, callback: (client: ImapFlow) => Promise<T>) {
  const {host,port,user,password,secure=true} = await endpoint(address,'imap');
  const client = new ImapFlow({host,port,secure,tls,doSTARTTLS: !secure && !demo,auth:{user,pass:password},logger:false,connectionTimeout:8000,socketTimeout:25000,disableAutoIdle:true});
  try { await client.connect(); return await callback(client); }
  finally { await client.logout().catch(() => client.close()); }
}
const special = {sent:'\\Sent', drafts:'\\Drafts', junk:'\\Junk', trash:'\\Trash'} as const;
export async function folder(client: ImapFlow, key: string, create = false): Promise<string | undefined> {
  if (key==='inbox' || key==='starred') return 'INBOX';
  if (!Object.hasOwn(special,key)) throw new HttpError(400,'Nepoznata mapa.');
  const flag = special[key as keyof typeof special];
  const fallback = flag.slice(1);
  const boxes = await client.list();
  const match = boxes.find(box => box.specialUse === flag) ?? boxes.find(box => box.path.toLowerCase() === fallback.toLowerCase());
  if (match) return match.path;
  if (create) { await client.mailboxCreate(fallback); return fallback; }
}
export async function quotaFor(address:string) {
  const quota=await imap(address,async client=>client.capabilities.has('QUOTA')?client.getQuota('INBOX'):false);
  return {used:quota ? quota.storage?.usage ?? null : null,limit:quota ? quota.storage?.limit ?? null : null};
}
export async function listing(address: string, key: string, query: string) {
  return imap(address, async client => {
    const folders = key==='starred' ? await client.list() : [];
    const path = key==='starred' ? undefined : await folder(client,key);
    const selected = key==='starred' ? folders.filter(x => !x.flags.has('\\Noselect')).map(x => x.path) : path ? [path] : [];
    const messages = [];
    for (const path of selected) {
      const lock = await client.getMailboxLock(path);
      try {
        const filter: SearchObject = query ? {or:[{subject:query},{from:query},{text:query}]} : {all:true};
        if (key==='starred') filter.flagged = true;
        const ids = await client.search(filter,{uid:true});
        if (!ids || !ids.length) continue;
        for await (const item of client.fetch(ids.slice(-80), {uid:true,envelope:true,flags:true,bodyStructure:true}, {uid:true})) {
          const e = item.envelope;
          messages.push({id:item.uid,path,subject:e?.subject || '(Bez predmeta)',from:e?.from?.[0]?.name || e?.from?.[0]?.address || 'Nepoznato',address:e?.from?.[0]?.address,date:e?.date,messageId:e?.messageId,inReplyTo:e?.inReplyTo,read:item.flags?.has('\\Seen'),star:item.flags?.has('\\Flagged'),attachment:item.bodyStructure?.childNodes?.some(x=>x.disposition==='attachment')});
        }
      } finally { lock.release(); }
    }
    return messages.sort((a,b)=>+(b.date ?? 0)-+(a.date ?? 0) || b.id-a.id).slice(0,80);
  });
}
export async function message(address: string, path: string, id: number, markRead = false) {
  return imap(address, async client => {
    const lock = await client.getMailboxLock(path);
    try {
      const info = await client.fetchOne(String(id), {size:true}, {uid:true});
      if (!info) throw new HttpError(404,'Poruka nije pronađena.');
      if ((info.size ?? 0)>30_000_000) throw new HttpError(413,'Poruka je prevelika za pregled.');
      const item = await client.fetchOne(String(id), {source:true}, {uid:true});
      if (!item || !item.source) throw new HttpError(404,'Poruka nije pronađena.');
      if (markRead) await client.messageFlagsAdd(String(id),['\\Seen'],{uid:true});
      const parsed = await simpleParser(item.source,{skipImageLinks:true,skipTextLinks:true,skipTextToHtml:true});
      return parsed;
    } finally { lock.release(); }
  });
}
export type Outgoing = {from:string;to:string[];subject:string;text:string;replyTo?:string;inReplyTo?:string;attachments?:{filename:string;content:Buffer}[];headers?:Record<string,string>};
export async function mime(input: Outgoing) {
  return (await nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows',disableFileAccess:true,disableUrlAccess:true}).sendMail(input)).message as Buffer;
}
export async function smtp(account: string, input: Outgoing, raw: Buffer) {
  const {host,port,user,password,secure=false} = await endpoint(account,'smtp');
  const transport = nodemailer.createTransport({host,port,secure,tls,requireTLS:!secure&&!demo,auth:{user,pass:password},connectionTimeout:8000,socketTimeout:25000,disableFileAccess:true,disableUrlAccess:true});
  if (demo && input.to.some(x=>!x.endsWith('.test'))) throw new HttpError(400,'Probno slanje dopušteno je samo na .test adrese.');
  const result = await transport.sendMail({raw,envelope:{from:input.from,to:input.to}});
  return {accepted:result.accepted.length,rejected:result.rejected.length};
}
export async function archiveDraft(address:string,uid:number) {
  return imap(address,async client=>{
    const path=await folder(client,'drafts');
    if(!path) return;
    const trash=(await folder(client,'trash',true))!;
    const lock=await client.getMailboxLock(path);
    try{
      const current=await client.fetchOne(String(uid),{flags:true},{uid:true});
      if(current && !await client.messageMove(String(uid),trash,{uid:true})) throw new HttpError(409,'Stara skica nije premještena.');
    }finally{lock.release();}
  });
}
export async function append(address: string, key: 'sent'|'drafts', raw: Buffer) {
  return imap(address, async client => {
    const path = (await folder(client,key,true))!;
    return client.append(path,raw,key==='sent'?['\\Seen']:['\\Draft']);
  });
}

export async function applyMailcowQuota(address:string, gib:number){
  const host=process.env.MAILCOW_URL, key=process.env.MAILCOW_API_KEY;
  if(!host || !key) throw new HttpError(503,'Upravljanje kvotom na poštanskom servisu nije konfigurirano.');
  const url=new URL('/api/v1/edit/mailbox',host);
  if(url.protocol!=='https:' || url.username || url.password) throw new HttpError(503,'Mailcow mora imati HTTPS adresu.');
  const response=await fetch(url,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{'X-API-Key':key,'Content-Type':'application/json'},
    body:JSON.stringify({items:[address],attr:{quota:gib*1024}}),
  });
  const result:unknown=await response.json();
  if(!response.ok || !Array.isArray(result) || !result.length || result.some(x=>x?.type!=='success')){
    throw new HttpError(502,'Poštanski servis nije potvrdio promjenu kvote.');
  }
}

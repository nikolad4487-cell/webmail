import express,{type Express} from 'express';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {HttpError} from './mail.js';
import {MAX_NATIVE_BYTES,storeNative} from './native-mail.js';
import {db} from './db.js';
import {usesNativeDomain} from './mailbox-provisioning.js';
import type {PoolClient} from 'pg';

export async function enabledNativeAddress(address:string,client:Pick<PoolClient,'query'>=db){
  return (process.env.NATIVE_ENABLED_ADDRESSES||'demo@skolehr.xyz').split(',').map(x=>x.trim().toLowerCase()).includes(address)
    || await usesNativeDomain(client,address);
}
export function setupInbound(app:Express,allowedHost:(host:string)=>boolean){
  const path='/api/inbound/cloudflare';
  app.post(path,async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!allowedHost(req.get('host')?.toLowerCase()||'') || req.get('origin'))throw new HttpError(403,'Zahtjev nije dopušten.');
    const secret=process.env.CLOUDFLARE_INBOUND_SECRET;
    if(!secret || secret.length<32)throw new HttpError(503,'Primitak pošte nije konfiguriran.');
    // Authenticate before reading a body. Signature binds timestamp, SMTP envelope and raw MIME hash.
    const timestamp=req.get('x-webmail-timestamp')||'';
    const from=req.get('x-webmail-from')||'';
    const to=req.get('x-webmail-to')||'';
    const bodyHash=req.get('x-webmail-sha256')||'';
    const signature=req.get('x-webmail-signature')||'';
    if(!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300_000 ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(to) || from.length>254 || /[\r\n]/.test(from) || !/^[a-f0-9]{64}$/.test(bodyHash) || !/^[a-f0-9]{64}$/.test(signature)){
      throw new HttpError(401,'Neispravan potpis.');
    }
    const expected=createHmac('sha256',secret).update([timestamp,from,to,bodyHash].join('\n')).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new HttpError(401,'Neispravan potpis.');
    if(!await enabledNativeAddress(to))throw new HttpError(403,'Primatelj nije omogućen.');
    const recipient=await db.query("select 1 from mailboxes where address=$1 and active and not shared and storage_kind='native'",[to]);
    if(!recipient.rowCount)throw new HttpError(404,'Primatelj nije omogućen.');
    next();
  },express.raw({type:()=>true,limit:MAX_NATIVE_BYTES}),async(req,res)=>{
    const raw=req.body as Buffer;
    if(!Buffer.isBuffer(raw)||!raw.length)throw new HttpError(400,'Nedostaje izvorna poruka.');
    if(createHash('sha256').update(raw).digest('hex')!==req.get('x-webmail-sha256'))throw new HttpError(401,'Neispravan sadržaj poruke.');
    const result=await storeNative(req.get('x-webmail-to')!,'INBOX',raw,{from:req.get('x-webmail-from')!});
    res.status(result.duplicate?200:201).json({ok:true,...result});
  });
}

import express,{type Express} from 'express';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {HttpError} from './mail.js';
import {MAX_NATIVE_BYTES,storeNative} from './native-mail.js';

export function enabledNativeAddress(address:string){
  return (process.env.NATIVE_ENABLED_ADDRESSES||'demo@skolehr.xyz').split(',').map(x=>x.trim().toLowerCase()).includes(address)
    && ['skolehr.xyz','formapoint.online'].includes(address.split('@')[1]);
}
export function setupInbound(app:Express,allowedHost:(host:string)=>boolean){
  const path='/api/inbound/cloudflare';
  app.post(path,(req,res,next)=>{
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
    if(!enabledNativeAddress(to))throw new HttpError(403,'Primatelj nije omogućen za probu.');
    next();
  },express.raw({type:()=>true,limit:MAX_NATIVE_BYTES}),async(req,res)=>{
    const raw=req.body as Buffer;
    if(!Buffer.isBuffer(raw)||!raw.length)throw new HttpError(400,'Nedostaje izvorna poruka.');
    if(createHash('sha256').update(raw).digest('hex')!==req.get('x-webmail-sha256'))throw new HttpError(401,'Neispravan sadržaj poruke.');
    const result=await storeNative(req.get('x-webmail-to')!,'INBOX',raw,{from:req.get('x-webmail-from')!});
    res.status(result.duplicate?200:201).json({ok:true,...result});
  });
}

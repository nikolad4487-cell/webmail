// Run locally with server-only env settings. Never prints secrets or message content.
import {readFile} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
const url=new URL(process.env.INBOUND_PROBE_URL||'http://127.0.0.1:3000/api/inbound/cloudflare');
if(url.username||url.password||url.search||url.hash||url.pathname!=='/api/inbound/cloudflare'||
  !(url.origin==='https://webmailhr.com'||(url.protocol==='http:'&&url.hostname==='127.0.0.1'))){
  throw new Error('Dopušten je samo WebmailHR HTTPS ili lokalni loopback endpoint.');
}
const file=process.env.INBOUND_PROBE_FILE,secret=process.env.CLOUDFLARE_INBOUND_SECRET;
const from=process.env.INBOUND_PROBE_FROM||'sender@example.test',to='demo@skolehr.xyz';
if(!file||!secret||secret.length<32||from.length>254||/[\r\n]/.test(from))throw new Error('Postavite INBOUND_PROBE_FILE, CLOUDFLARE_INBOUND_SECRET i valjani INBOUND_PROBE_FROM.');
const raw=await readFile(file);
if(!raw.length||raw.length>3_000_000)throw new Error('MIME datoteka mora imati od 1 do 3.000.000 bajtova.');
const hash=createHash('sha256').update(raw).digest('hex');
for(let i=0;i<2;i++){
  const timestamp=String(Date.now());
  const signature=createHmac('sha256',secret).update([timestamp,from,to,hash].join('\n')).digest('hex');
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),body:raw,
    headers:{'Content-Type':'message/rfc822','X-Webmail-Timestamp':timestamp,'X-Webmail-From':from,'X-Webmail-To':to,
      'X-Webmail-Sha256':hash,'X-Webmail-Signature':signature}});
  if(!response.ok)throw new Error('Primitak nije potvrđen: HTTP '+response.status);
  const result=await response.json() as {ok:boolean;id:number;duplicate:boolean};
  if(!result.ok||!Number.isInteger(result.id))throw new Error('Neispravna potvrda primitka.');
  console.log({status:response.status,id:result.id,duplicate:result.duplicate});
}

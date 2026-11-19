// No forwarding address: SMTP envelope and original MIME go directly to WebmailHR.
export const MAX_RAW_BYTES=3_000_000;
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
async function receive(message,env){
    const allowed=(env.ENABLED_RECIPIENTS||'demo@skolehr.xyz').split(',').map(x=>x.trim().toLowerCase());
    const to=message.to.toLowerCase();
    if(!allowed.includes(to)||!['skolehr.xyz','formapoint.online'].includes(to.split('@')[1])){
      message.setReject('Recipient is not enabled');return;
    }
    if(message.rawSize>MAX_RAW_BYTES){message.setReject('Message exceeds 3 MB pilot limit');return;}
    if(!env.INBOUND_SECRET||env.INBOUND_SECRET.length<32)throw new Error('Missing inbound secret');
    if(env.INBOUND_URL!=='https://webmailhr.com/api/inbound/cloudflare')throw new Error('Invalid inbound URL');
    const reader=message.raw.getReader();
    const chunks=[];let size=0;
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_RAW_BYTES){await reader.cancel();message.setReject('Message exceeds 3 MB pilot limit');return;}
      chunks.push(value);
    }
    const raw=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
    const sha=hex(await crypto.subtle.digest('SHA-256',raw));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.INBOUND_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    for(let attempt=0;attempt<3;attempt++){
      const timestamp=String(Date.now());
      const signature=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode([timestamp,message.from,to,sha].join('\n'))));
      let response;
      try{
        response=await fetch(env.INBOUND_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),body:raw,
          headers:{'Content-Type':'message/rfc822','X-Webmail-Timestamp':timestamp,'X-Webmail-From':message.from,
            'X-Webmail-To':to,'X-Webmail-Sha256':sha,'X-Webmail-Signature':signature}});
        if(response.ok){
          const receipt=await response.json();
          if(receipt.ok===true&&Number.isInteger(receipt.id))return;
        }
        if(response.status===413){message.setReject('Message exceeds storage limit');return;}
      }catch{/* Retry same MIME; server deduplicates after committed delivery. */}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
    }
    // Never report success if HTTPS storage did not acknowledge commit. Monitor Worker exceptions.
    throw new Error('WebmailHR did not acknowledge delivery');
}
export default {
  async email(message,env){
    try{await receive(message,env);}
    catch{
      console.error('WebmailHR inbound delivery failed');
      message.setReject('WebmailHR storage unavailable; please contact administrator and resend');
    }
  },
};

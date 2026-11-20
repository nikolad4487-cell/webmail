// No forwarding address: SMTP envelope and original MIME go directly to WebmailHR.
const MAX_RAW_BYTES=3_000_000;
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
class DeliveryError extends Error {
  constructor(code){super(code);this.code=code;}
}
async function receive(message,env){
    const allowed=(env.ENABLED_RECIPIENTS||'demo@skolehr.xyz').split(',').map(x=>x.trim().toLowerCase());
    const to=message.to.toLowerCase();
    // '*' is an explicit one-time opt-in for a catch-all rule. WebmailHR checks its domain
    // policy and stores only existing active personal native mailboxes; it creates none on receipt.
    if(!(allowed.includes('*')||allowed.includes(to))||!['skolehr.xyz','formapoint.online'].includes(to.split('@')[1])){
      message.setReject('Recipient is not enabled');return;
    }
    if(message.rawSize>MAX_RAW_BYTES){message.setReject('Message exceeds 3 MB pilot limit');return;}
    const secret=(env.INBOUND_SECRET||'').trim();
    const url=(env.INBOUND_URL||'').trim();
    if(secret.length<32)throw new DeliveryError('CONFIG_SECRET');
    if(url!=='https://webmailhr.com/api/inbound/cloudflare')throw new DeliveryError('CONFIG_URL');
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
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    let failure='HTTPS_FETCH';
    for(let attempt=0;attempt<3;attempt++){
      const timestamp=String(Date.now());
      const signature=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode([timestamp,message.from,to,sha].join('\n'))));
      let response;
      failure='HTTPS_FETCH';
      try{
        // workerd supports only follow/manual; manual keeps signed MIME off redirect targets.
        response=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15_000),body:raw,
          headers:{'Content-Type':'message/rfc822','X-Webmail-Timestamp':timestamp,'X-Webmail-From':message.from,
            'X-Webmail-To':to,'X-Webmail-Sha256':sha,'X-Webmail-Signature':signature}});
        failure='HTTP_'+response.status;
        if(response.ok){
          failure='INVALID_RECEIPT';
          const receipt=await response.json();
          if(receipt.ok===true&&Number.isInteger(receipt.id))return;
        }
        if(response.status===413){message.setReject('Message exceeds storage limit');return;}
      }catch{/* Retry same MIME; server deduplicates after committed delivery. */}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
    }
    // Never report success if HTTPS storage did not acknowledge commit. Monitor Worker exceptions.
    throw new DeliveryError(failure);
}
export default {
  async email(message,env){
    try{await receive(message,env);}
    catch(error){
      // Only fixed internal codes: never log secrets, email contents or upstream bodies.
      const code=error instanceof DeliveryError?error.code:'WORKER_RUNTIME';
      console.error('WebmailHR inbound delivery failed',code);
      message.setReject('WebmailHR storage unavailable ['+code+']; please contact administrator and resend');
    }
  },
};

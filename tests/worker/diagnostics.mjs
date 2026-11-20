import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker from '../../cloudflare/email-worker.mjs';

const secret='local-worker-test-key-01234567890123456789';
const env={INBOUND_SECRET:secret,INBOUND_URL:'https://webmailhr.com/api/inbound/cloudflare'};
async function run(settings,fetcher,to='demo@skolehr.xyz'){
  const previousFetch=globalThis.fetch,previousError=console.error,logs=[];
  let rejected,calls=0;
  globalThis.fetch=async(...args)=>{calls++;return fetcher(...args);};
  console.error=(...args)=>logs.push(args);
  try{
    await worker.email({from:'sender@example.test',to,rawSize:4,
      raw:new Blob(['test']).stream(),setReject:value=>{rejected=value;}},settings);
    return {rejected,calls,logs};
  }finally{globalThis.fetch=previousFetch;console.error=previousError;}
}
test('Configuration errors have fixed codes and do not call HTTPS',async()=>{
  for(const [settings,code] of [[{...env,INBOUND_SECRET:''},'CONFIG_SECRET'],[{...env,INBOUND_URL:'https://other.test'},'CONFIG_URL']]){
    const r=await run(settings,()=>{throw new Error('Should not fetch');});
    assert.equal(r.calls,0);assert.match(r.rejected,new RegExp(code));
  }
});
test('Explicit wildcard supports a catch-all only on supported domains; default stays demo-only',async()=>{
  const success=async()=>Response.json({ok:true,id:1});
  const limited=await run(env,success,'new@skolehr.xyz');assert.equal(limited.calls,0);assert.match(limited.rejected,/Recipient is not enabled/);
  const enabled=await run({...env,ENABLED_RECIPIENTS:'*'},success,'new@skolehr.xyz');assert.equal(enabled.calls,1);assert.equal(enabled.rejected,undefined);
  const foreign=await run({...env,ENABLED_RECIPIENTS:'*'},success,'new@other.test');assert.equal(foreign.calls,0);assert.match(foreign.rejected,/Recipient is not enabled/);
});
test('Copied outer whitespace is removed; MIME signature and destination remain exact',async()=>{
  const r=await run({INBOUND_SECRET:' '+secret+'\n',INBOUND_URL:env.INBOUND_URL+'\n'},async(url,options)=>{
    assert.equal(url,env.INBOUND_URL);
    assert.equal(options.redirect,'manual');
    const h=options.headers;
    const expected=createHmac('sha256',secret).update([h['X-Webmail-Timestamp'],'sender@example.test','demo@skolehr.xyz',h['X-Webmail-Sha256']].join('\n')).digest('hex');
    assert.equal(h['X-Webmail-Signature'],expected);
    assert.equal(Buffer.from(options.body).toString(),'test');
    return Response.json({ok:true,id:5});
  });
  assert.equal(r.rejected,undefined);assert.equal(r.calls,1);
});
test('HTTP failure reports status without leaking response body or key',async()=>{
  const r=await run(env,async()=>new Response('private response contents',{status:401}));
  assert.equal(r.calls,3);assert.match(r.rejected,/HTTP_401/);
  assert.doesNotMatch(JSON.stringify(r),/private response contents/);
  assert.ok(!JSON.stringify(r).includes(secret));
});
test('Connection exceptions remain private and invalid receipts are distinguished',async()=>{
  const network=await run(env,async()=>{throw new Error(secret);});
  assert.match(network.rejected,/HTTPS_FETCH/);assert.ok(!JSON.stringify(network).includes(secret));
  const receipt=await run(env,async()=>Response.json({ok:true}));
  assert.match(receipt.rejected,/INVALID_RECEIPT/);
});

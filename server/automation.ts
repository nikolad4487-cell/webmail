import {createHmac,timingSafeEqual} from 'node:crypto';
import {type Router,type Request} from 'express';
import {z} from 'zod';
import {db,digest,transaction} from './db';
import {deny,email,text} from './http';
import {HttpError,mime,smtp,type Outgoing} from './mail';

const keys:z.infer<typeof keySchema>[]=JSON.parse(process.env.INTEGRATION_KEYS || '[]');
const keySchema=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),address:email,kind:z.enum(['order','promotion']),consent:z.boolean().optional(),delivery:z.boolean().optional()});
const signingKey=process.env.UNSUBSCRIBE_SECRET;
const linkOrigin=process.env.APP_ORIGIN;
const signature=(value:string)=>createHmac('sha256',signingKey!).update(value).digest('hex');
const equal=(a:string,b:string)=>a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function integration(req:Request){
  const authorization=req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/)?.[1];
  if(!authorization) return deny();
  const hash=digest(authorization);
  const key=keys.map(x=>keySchema.parse(x)).find(x=>equal(x.hash,hash));
  if(!key) return deny();
  const {rows:[sender]}=await db.query('select * from senders where address=$1 and kind=$2 and active',[key.address,key.kind]);
  if(!sender) return deny();
  return {key,sender};
}
export function setupAutomation(api:Router){
  api.put('/integrations/formapoint/consent',async(req,res)=>{
    const {key,sender}=await integration(req);
    if(key.kind!=='promotion' || !key.consent) deny();
    const x=z.object({recipient:email,list:text,allowed:z.boolean()}).parse(req.body);
    await db.query('insert into subscriptions values($1,$2,$3,$4) on conflict(sender,list,recipient) do update set allowed=excluded.allowed',[sender.id,x.list,x.recipient,x.allowed]);
    res.json({ok:true});
  });
  api.post('/integrations/formapoint/send',async(req,res)=>{
    const {key,sender}=await integration(req);
    const x=z.object({kind:z.enum(['order','promotion']),eventId:text,recipient:email,list:text.optional(),subject:text,text:z.string().min(1).max(100000)}).parse(req.body);
    if(x.kind!==key.kind) deny();
    const promotion=x.kind==='promotion', list=promotion?x.list:'';
    if(promotion && (!list || !signingKey || !linkOrigin)) throw new HttpError(503,'Lista ili odjava nije konfigurirana.');
    const attempt=await transaction(async c=>{
      if(promotion){
        const {rows:[permission]}=await c.query('select allowed from subscriptions where sender=$1 and list=$2 and recipient=$3 for update',[sender.id,list,x.recipient]);
        if(!permission?.allowed) deny();
      }
      const values=[sender.id,x.eventId,x.recipient,list];
      const {rows:[created]}=await c.query("insert into deliveries(sender,external_id,recipient,list,status) values($1,$2,$3,$4,'pending') on conflict do nothing returning id,status",values);
      if(created) return {record:created,duplicate:false};
      const {rows:[record]}=await c.query(promotion
        ?'select id,status from deliveries where sender=$1 and external_id=$2 and recipient=$3 and list=$4'
        :"select id,status from deliveries where sender=$1 and external_id=$2 and list=''",promotion?values:values.slice(0,2));
      return {record,duplicate:true};
    });
    const {record,duplicate}=attempt;
    if(duplicate){res.status(record.status==='pending'?202:200).json({...record,duplicate});return;}
    const mail:Outgoing={from:key.address,replyTo:sender.reply_to,to:[x.recipient],subject:x.subject,text:x.text};
    if(promotion){
      const link=`${linkOrigin}/api/unsubscribe/${record.id}/${signature(String(record.id))}`;
      mail.text+='\n\nOdjava s ove liste: '+link;
      mail.headers={'List-Unsubscribe':`<${link}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'};
    }
    let raw:Buffer;
    try{raw=await mime(mail);}catch{
      await db.query("update deliveries set status='failed' where id=$1",[record.id]);
      throw new HttpError(400,'Poruku nije bilo moguće pripremiti.');
    }
    try{await smtp(key.address,mail,raw);}catch(error){
      const responseCode=Number((error as {responseCode?:number}).responseCode);
      const status=error instanceof HttpError || responseCode>=400?'failed':'unknown';
      await db.query('update deliveries set status=$2 where id=$1',[record.id,status]);
      res.status(502).json({id:record.id,status,error:'SMTP predaja nije potvrđena.'});return;
    }
    await db.query("update deliveries set status='submitted' where id=$1 and status='pending'",[record.id]);
    res.json({id:record.id,status:'submitted'});
  });
  api.put('/integrations/formapoint/delivery/:id',async(req,res)=>{
    const {key,sender}=await integration(req);
    if(!key.delivery) return deny();
    const delivery=z.coerce.number().int().positive().parse(req.params.id), status=z.enum(['delivered','failed']).parse(req.body.status);
    const result=await db.query("update deliveries set status=$3 where id=$1 and sender=$2 and status in ('submitted','unknown',$3)",[delivery,sender.id,status]);
    if(!result.rowCount) return deny();
    res.json({ok:true});
  });
  const unsubscribe='/unsubscribe/:id/:signature';
  function signed(req:Request){
    const id=z.string().regex(/^\d{1,10}$/).parse(req.params.id);
    if(!signingKey || !equal(String(req.params.signature),signature(id))) return deny();
    return id;
  }
  api.get(unsubscribe,(req,res)=>{
    signed(req);
    res.type('html').send('<!doctype html><html lang="hr"><meta charset="utf-8"><title>Odjava s liste</title><main><h1>Odjava s marketinške liste</h1><form method="post"><button>Potvrdi odjavu</button></form></main></html>');
  });
  api.post(unsubscribe,async(req,res)=>{
    const id=signed(req);
    await db.query(`update subscriptions s set allowed=false from deliveries d where d.id=$1 and d.list<>'' and s.sender=d.sender and s.list=d.list and s.recipient=d.recipient`,[id]);
    res.type('text').send('Odjava je zabilježena.');
  });
}

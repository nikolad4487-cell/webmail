import {type Router} from 'express';
import {z} from 'zod';
import {db,hashPassword,transaction} from './db';
import {addressing,applyMailcowQuota,HttpError,quotaFor} from './mail';
import {deny,email,id,text,user} from './http';

const instant=z.string().datetime({offset:true});
const eventInput=z.object({title:text,starts:instant,ends:instant,attendees:z.array(email).max(40),box:id.nullable()}).refine(x=>Date.parse(x.ends)>Date.parse(x.starts));
const eventAccess=`((events.box is null and events.uid=$1) or exists(select 1 from grants g join mailboxes m on m.id=g.box where g.uid=$1 and g.box=events.box and g.can_calendar and m.active))`;
const contact=z.object({name:text,email});
const tables={
  organizations:{columns:'id,name',scope:'id',schema:z.object({name:text})},
  schools:{columns:'id,org,name',scope:'org',schema:z.object({name:text})},
  domains:{columns:'name,org,inbound,outbound',scope:'org',schema:z.object({name:z.string().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/).max(253),inbound:z.boolean(),outbound:z.boolean()})},
  users:{columns:'id,org,school,name,email,role,active,recovery',scope:'org',schema:z.object({name:text,email,school:id.nullable(),role:z.enum(['root','admin','user']),active:z.boolean(),recovery:email.nullable(),password:z.string().min(12).max(512).optional()})},
  mailboxes:{columns:'id,org,address,label,shared,active,target_quota_gb',scope:'org',schema:z.object({address:email,label:text,shared:z.boolean(),active:z.boolean(),target_quota_gb:z.number().int().min(1).max(10000)})},
  senders:{columns:'id,org,address,reply_to,kind,active',scope:'org',schema:z.object({address:email,reply_to:email,kind:z.enum(['order','promotion']),active:z.boolean()})},
};
const tableName=z.enum(['organizations','schools','domains','users','mailboxes','senders']);
function icsEscape(value:string){return value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g,x=>'\\'+x);}
const icsDate=(value:string|Date)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
function fold(line:string){
  let result='', width=0;
  for(const char of line){
    const size=Buffer.byteLength(char);
    if(width+size>75){result+='\r\n ';width=1;}
    result+=char;width+=size;
  }
  return result;
}
export function setupData(api:Router){
  api.get('/contacts',async(req,res)=>{
    const q=String(req.query.q || '').slice(0,200);
    res.json((await db.query('select id,name,email from contacts where uid=$1 and (name ilike $2 or email ilike $2) order by name',[user(req).id,'%'+q+'%'])).rows);
  });
  api.post('/contacts',async(req,res)=>{
    const x=contact.parse(req.body);
    res.json((await db.query('insert into contacts(uid,name,email) values($1,$2,$3) returning id',[user(req).id,x.name,x.email])).rows[0]);
  });
  api.put('/contacts/:id',async(req,res)=>{
    const x=contact.parse(req.body);
    const result=await db.query('update contacts set name=$3,email=$4 where uid=$1 and id=$2',[user(req).id,id.parse(req.params.id),x.name,x.email]);
    if(!result.rowCount) deny();
    res.json({ok:true});
  });
  api.get('/events',async(req,res)=>{
    const {start,end}=z.object({start:instant,end:instant}).parse(req.query);
    res.json((await db.query(`select * from events where ${eventAccess} and starts<$3 and ends>$2 order by starts`,[user(req).id,start,end])).rows);
  });
  api.get('/events/:id/ics',async(req,res)=>{
    const {rows:[x]}=await db.query(`select events.*,u.email as organizer from events join users u on u.id=events.uid where events.id=$2 and ${eventAccess}`,[user(req).id,id.parse(req.params.id)]);
    if(!x) return deny();
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//WebmailHR//Kalendar//HR','CALSCALE:GREGORIAN','METHOD:REQUEST','BEGIN:VEVENT',`UID:${x.id}@webmailhr.com`,`DTSTAMP:${icsDate(new Date())}`,`DTSTART:${icsDate(x.starts)}`,`DTEND:${icsDate(x.ends)}`,`SUMMARY:${icsEscape(x.title)}`,`ORGANIZER:mailto:${x.organizer}`,...x.attendees.map((a:string)=>`ATTENDEE;RSVP=TRUE:mailto:${a}`),'END:VEVENT','END:VCALENDAR'];
    res.attachment('pozivnica.ics').type('text/calendar').send(lines.map(fold).join('\r\n')+'\r\n');
  });
  api.post('/events',async(req,res)=>{
    const x=eventInput.parse(req.body), uid=user(req).id;
    const query=await db.query(`insert into events(uid,box,title,starts,ends,attendees) select $1,$2,$3,$4,$5,$6 where $2::int is null or exists (select 1 from grants g join mailboxes m on m.id=g.box where g.uid=$1 and g.box=$2 and g.can_calendar and m.active) returning id`,[uid,x.box,x.title,x.starts,x.ends,x.attendees]);
    if(!query.rowCount) deny();
    res.json(query.rows[0]);
  });
  api.put('/events/:id',async(req,res)=>{
    const x=eventInput.parse(req.body);
    const result=await db.query(`update events set title=$4,starts=$5,ends=$6,attendees=$7 where id=$2 and box is not distinct from $3 and ${eventAccess}`,[user(req).id,id.parse(req.params.id),x.box,x.title,x.starts,x.ends,x.attendees]);
    if(!result.rowCount) deny();
    res.json({ok:true});
  });
  api.use('/admin',(req,_res,next)=>{if(user(req).role==='user') deny();next();});
  api.post('/admin/storage/:box/apply',async(req,res)=>{
    const a=user(req), box=id.parse(req.params.box);
    await transaction(async c=>{
      const {rows:[m]}=await c.query('select * from mailboxes where id=$1 and active for update',[box]);
      if(!m || a.role!=='root') return deny();
      await applyMailcowQuota(m.address,m.target_quota_gb);
      await c.query('insert into audits(uid,action,target) values($1,$2,$3)',[a.id,'mailbox.quota.apply',String(box)]);
    });
    res.json({ok:true});
  });
  api.get('/admin/storage',async(req,res)=>{
    const a=user(req);
    const {rows}=await db.query('select address,target_quota_gb,active from mailboxes where ($1::int is null or org=$1) order by id',[a.role==='root'?null:a.org]);
    const boxes=[];
    for(let i=0;i<rows.length;i+=4){
      boxes.push(...await Promise.all(rows.slice(i,i+4).map(async box=>({
        address:box.address,target:box.target_quota_gb,
        ...await (box.active ? quotaFor(box.address).catch(()=>({used:null,limit:null})) : Promise.resolve({used:null,limit:null})),
      }))));
    }
    const configured=Number(process.env.MAIL_CAPACITY_BYTES);
    res.json({boxes,canApply:a.role==='root' && !!(process.env.MAILCOW_URL && process.env.MAILCOW_API_KEY),capacity:a.role==='root' && Number.isSafeInteger(configured) && configured>0 ? configured : null});
  });
  api.get('/admin/logs',async(req,res)=>{
    const a=user(req);
    res.json((await db.query('select d.*,s.address,s.kind from deliveries d join senders s on s.id=d.sender where ($1::int is null or s.org=$1) order by d.at desc limit 100',[a.role==='root'?null:a.org])).rows);
  });
  api.get('/admin/access/:box',async(req,res)=>{
    const a=user(req), box=id.parse(req.params.box);
    const {rows:[m]}=await db.query('select org from mailboxes where id=$1',[box]);
    if(!m || (a.role!=='root' && m.org!==a.org)) deny();
    const [grants,aliases]=await Promise.all([db.query('select g.uid,u.email,g.can_send,g.can_calendar from grants g join users u on u.id=g.uid where g.box=$1',[box]),db.query('select address,send_as from aliases where box=$1',[box])]);
    res.json({grants:grants.rows,aliases:aliases.rows});
  });
  api.put('/admin/access/:box',async(req,res)=>{
    const a=user(req), box=id.parse(req.params.box);
    const x=z.discriminatedUnion('kind',[
      z.object({kind:z.literal('grant'),uid:id,remove:z.boolean(),can_send:z.boolean(),can_calendar:z.boolean()}),
      z.object({kind:z.literal('alias'),address:email,remove:z.boolean(),send_as:z.boolean()})
    ]).parse(req.body);
    await transaction(async c=>{
      const {rows:[m]}=await c.query('select org from mailboxes where id=$1 for update',[box]);
      if(!m || (a.role!=='root' && m.org!==a.org)) deny();
      if(x.kind==='grant'){
        if(!(await c.query('select 1 from users where id=$1 and org=$2',[x.uid,m.org])).rowCount) deny();
        if(x.remove) await c.query('delete from grants where uid=$1 and box=$2',[x.uid,box]);
        else await c.query('insert into grants values($1,$2,$3,$4) on conflict(uid,box) do update set can_send=excluded.can_send,can_calendar=excluded.can_calendar',[x.uid,box,x.can_send,x.can_calendar]);
      }else{
        if(!(await c.query('select 1 from domains where org=$1 and name=$2',[m.org,addressing(x.address)])).rowCount) deny();
        if(x.remove) await c.query('delete from aliases where address=$1 and box=$2',[x.address,box]);
        else {
          await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[x.address]);
          const conflict=await c.query('select 1 from mailboxes where address=$1 union all select 1 from senders where address=$1 and $2',[x.address,x.send_as]);
          if(conflict.rowCount) throw new HttpError(409,'Adresa pripada stvarnom sandučiću ili je rezervirana za automatsko slanje.');
          const result=await c.query('insert into aliases values($1,$2,$3) on conflict(address) do update set send_as=excluded.send_as where aliases.box=excluded.box',[x.address,box,x.send_as]);
          if(!result.rowCount) throw new HttpError(409,'Alias već pripada drugom sandučiću.');
        }
      }
      await c.query('insert into audits(uid,action,target) values($1,$2,$3)',[a.id,x.kind+(x.remove?'.remove':'.save'),box+':'+(x.kind==='grant'?x.uid:x.address)]);
    });
    res.json({ok:true});
  });
  api.get('/admin/:table',async(req,res)=>{
    const a=user(req), name=tableName.parse(req.params.table), t=tables[name];
    res.json((await db.query(`select ${t.columns} from ${name} where ($1::int is null or ${t.scope}=$1) order by 1`,[a.role==='root'?null:a.org])).rows);
  });
  api.post('/admin/:table',async(req,res)=>{
    const a=user(req), name=tableName.parse(req.params.table), t=tables[name];
    const input:Record<string,unknown>=t.schema.parse(req.body);
    const org=a.role==='root' && name!=='organizations'?id.parse(req.body.org):a.org;
    if(name==='organizations' && a.role!=='root') deny();
    const identity=name==='domains'?'name':'id';
    const requested=req.body.key==null?null:identity==='name'?tables.domains.schema.shape.name.parse(req.body.key):id.parse(req.body.key);
    if(name==='domains' && requested!==null && requested!==input.name) throw new HttpError(400,'Za novu domenu dodajte novi zapis.');
    if(name==='users'){
      if(input.role!=='user' && a.role!=='root') deny();
      if(!requested && !input.password) throw new HttpError(400,'Unesite početnu lozinku.');
      if(input.password) input.password=await hashPassword(String(input.password));
      else delete input.password;
    }
    await transaction(async c=>{
      if(requested!==null){
        const {rows:[current]}=await c.query(`select * from ${name} where ${identity}=$1 for update`,[requested]);
        if(!current || (name!=='organizations' && current.org!==org) || (name==='users' && a.role!=='root' && current.role!=='user')) deny();
      }
      const address=input.address || input.email;
      if(address && !(await c.query('select 1 from domains where org=$1 and name=$2',[org,addressing(String(address))])).rowCount) throw new HttpError(400,'Domena nije registrirana za ovu organizaciju.');
      if(name==='mailboxes' || name==='senders'){
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[address]);
        const conflict=await c.query('select 1 from aliases where address=$1 and ($2 or send_as)',[address,name==='mailboxes']);
        if(conflict.rowCount) throw new HttpError(409,'Adresa se već koristi kao alias.');
      }
      if(name==='senders' && !(await c.query('select 1 from mailboxes where org=$1 and address=$2',[org,input.reply_to])).rowCount) throw new HttpError(400,'Adresa za odgovor mora biti sandučić organizacije.');
      const cols=Object.keys(input), vals=Object.values(input);
      if(requested!==null){
        await c.query(`update ${name} set ${cols.map((col,i)=>`${col}=$${i+1}`).join(',')} where ${identity}=$${vals.length+1}`,[...vals,requested]);
        if(name==='users' && input.password) await c.query('delete from sessions where uid=$1',[requested]);
      }else{
        if(name!=='organizations'){cols.push('org');vals.push(org);}
        await c.query(`insert into ${name}(${cols.join(',')}) values(${vals.map((_,i)=>'$'+(i+1)).join(',')})`,vals);
      }
      await c.query('insert into audits(uid,action,target) values($1,$2,$3)',[a.id,name+'.save',String(requested ?? address ?? input.name)]);
    });
    res.json({ok:true});
  });
}

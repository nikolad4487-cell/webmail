import {db,hashPassword,transaction} from '../server/db';
import {imap,mime,smtp,demo,type Outgoing} from '../server/mail';
import {DateTime} from 'luxon';
if(!demo) throw new Error('DEMO_MODE=1 is required.');
const password=await hashPassword('Webmail-Test-2026');
const school='skolehr.test', business='formapoint.test', faculty='fzom.isvu.test';
const inbox='info@'+business;
try {
  await transaction(async c=>{
    const organization=async(name:string)=>{
      const {rows:[x]}=await c.query('insert into organizations(name) values($1) on conflict(name) do update set name=excluded.name returning id',[name]);return x.id;
    };
    const form=await organization('FormaPoint'), schools=await organization('ŠkoleHR'), fzom=await organization('FZOM');
    for(const [org,name] of [[form,business],[form,'formapoint-orders.test'],[schools,school],[fzom,faculty]]){
      await c.query('insert into domains(org,name) values($1,$2) on conflict do nothing',[org,name]);
    }
    const makeSchool=async(name:string)=>(await c.query('insert into schools(org,name) values($1,$2) on conflict(org,name) do update set name=excluded.name returning id',[schools,name])).rows[0].id;
    const s1=await makeSchool('Osnovna škola Zagreb'),s2=await makeSchool('Gimnazija Rijeka');
    const account=async(org:number,address:string,name:string,role:string,schoolId:number|null=null)=>{
      const {rows:[u]}=await c.query('insert into users(org,email,name,role,password,school) values($1,$2,$3,$4,$5,$6) on conflict(email) do update set email=excluded.email returning id',[org,address,name,role,password,schoolId]);return u.id;
    };
    const lena=await account(form,'lena@'+business,'Lena Novak','root');
    const ivan=await account(schools,'ivan@'+school,'Ivan Marić','user',s1);
    const mia=await account(schools,'mia@'+school,'Mia Barić','user',s2);
    const f=await account(fzom,'petra@'+faculty,'Petra Radić','admin');
    for(const [org,address,label,shared,uid] of [[form,'lena@'+business,'Osobni sandučić',false,lena],[form,inbox,'FormaPoint · podrška',true,lena],[schools,'ivan@'+school,'Osobni sandučić',false,ivan],[schools,'mia@'+school,'Osobni sandučić',false,mia],[schools,'referada@'+school,'Školska referada',true,ivan],[fzom,'petra@'+faculty,'Osobni sandučić',false,f],[fzom,'referada@'+faculty,'Fakultetska referada',true,f]]){
      const {rows:[box]}=await c.query('insert into mailboxes(org,address,label,shared) values($1,$2,$3,$4) on conflict(address) do update set address=excluded.address returning id',[org,address,label,shared]);
      await c.query('insert into grants values($1,$2,true,true) on conflict do nothing',[uid,box.id]);
    }
    for(const [address,kind] of [['narudzba@formapoint-orders.test','order'],['promocije@formapoint.test','promotion']]){
      await c.query('insert into senders(org,address,reply_to,kind) values($1,$2,$3,$4) on conflict do nothing',[form,address,inbox,kind]);
    }
    for(const [name,email] of [['Ana Kovač','ana@kupci.test'],['Marko Babić','marko@partneri.test'],['Ivana Perić','ivana@racuni.test']]){
      await c.query('insert into contacts(uid,name,email) values($1,$2,$3) on conflict do nothing',[lena,name,email]);
    }
    if(!(await c.query('select 1 from events where uid=$1 limit 1',[lena])).rowCount){
      const day=DateTime.now().setZone('Europe/Zagreb').set({hour:10,minute:0,second:0,millisecond:0});
      await c.query('insert into events(uid,title,starts,ends,attendees) values($1,$2,$3,$4,$5)',[lena,'Sastanak s Anom',day.toISO(),day.plus({minutes:30}).toISO(),['ana@kupci.test']]);
    }
  });
  const fixtures=[
    ['Lucija Novak','lucija@kupci.test','Potvrda primitka','Hvala na brzom odgovoru i dostavljenoj dokumentaciji.'],
    ['Petra Horvat','petra@partneri.test','Dodatne informacije','Šaljem vam nekoliko dodatnih informacija o projektu.'],
    ['Tomislav Horvat','tomislav@partneri.test','Sastanak idući tjedan','Možemo li potvrditi termin sastanka za utorak?'],
    ['Ivana Perić','ivana@racuni.test','Dostava računa','U privitku se nalazi račun za prošli mjesec.'],
    ['Marko Babić','marko@partneri.test','Ponuda za suradnju','Zanima me mogućnost suradnje na projektu.'],
    ['Ana Kovač','ana@kupci.test','Upit o narudžbi','Pozdrav,\n\nKada mogu očekivati svoju narudžbu? Molim vas javite mi čim bude spremna za preuzimanje.\n\nLijep pozdrav,\nAna Kovač']
  ];
  const populated=await imap(inbox,async client=>((await client.status('INBOX',{messages:true})) || {}).messages);
  if(!populated){
    for(const [name,address,subject,body] of fixtures){
      const input:Outgoing={from:address,to:[inbox],subject,text:body,attachments: subject==='Upit o narudžbi'?[{filename:'Potvrda.txt',content:Buffer.from('Probna potvrda narudžbe WebmailHR.')}]:undefined};
      const {createTransport}=await import('nodemailer');
      const raw=(await createTransport({streamTransport:true,buffer:true}).sendMail({...input,from:{name,address}})).message as Buffer;
      if(process.env.DEMO_TLS==='1') await imap(inbox,async client=>{await client.append('INBOX',raw);});
      else await smtp(inbox,input,raw);
    }
  }
  const available=await db.query('select address from mailboxes where address<>$1',[inbox]);
  for(const row of available.rows){
    await imap(row.address,async client=>{await client.status('INBOX',{messages:true});});
  }
}finally{await db.end();}

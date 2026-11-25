import {build} from 'esbuild';import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';import {createServer} from 'node:http';import {resolve} from 'node:path';import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),out='/tmp/webmail-bulk-browser';await mkdir(out,{recursive:true});
const mock=`export const initials=s=>s.slice(0,2);export const toError=e=>e.message;
const folders={inbox:'INBOX',drafts:'Drafts',sent:'Sent',trash:'Trash',junk:'Junk'};
let id=0;window.fixture=[];window.calls=[];
for(const path of Object.values(folders))for(let i=0;i<3;i++)window.fixture.push({id:++id,path,subject:path+' '+(i+1),from:'Ogledni Korisnik',address:'test@example.test',date:'2026-11-25T12:00:00Z',read:true,star:true,messageId:'<'+id+'@test>',...(path==='INBOX'&&i===1?{inReplyTo:'<1@test>'}:{})});
export async function api(url,method='GET',body){
 if(url==='/contacts')return [];
 if(url.startsWith('/mail/1/quota'))return {used:window.fixture.length*100,limit:10000,target:15};
 if(url.startsWith('/mail/1/message?')){const p=new URLSearchParams(url.split('?')[1]);const r=window.fixture.find(r=>r.id===Number(p.get('id')));return {...r,text:'Ogledni sadržaj',from:{name:r.from,address:r.address},to:['test@example.test'],attachments:[]};}
 if(url==='/mail/1/bulk'){if(window.failBulk){window.failBulk=false;throw new Error('Provjera neuspjele radnje');}window.calls.push(body);const ids=new Set(body.messages.map(r=>r.id));if(body.action==='delete')window.fixture=window.fixture.filter(r=>!ids.has(r.id));else for(const r of window.fixture)if(ids.has(r.id)){if(folders[body.action])r.path=folders[body.action];if(body.action==='unstar')r.star=false;if(body.action==='unread')r.read=false;}return {affected:ids.size,freedBytes:body.action==='delete'?ids.size*100:0};}
 if(url==='/mail/1/empty'){window.calls.push(body);const count=window.fixture.filter(r=>r.path===folders[body.folder]).length;window.fixture=window.fixture.filter(r=>r.path!==folders[body.folder]);return {affected:count,freedBytes:count*100};}
 if(url.startsWith('/mail/1?')){const q=new URLSearchParams(url.split('?')[1]);return window.fixture.filter(r=>(q.get('folder')==='starred'?r.star:r.path===folders[q.get('folder')])&&r.subject.includes(q.get('q')||''));}
 return {ok:true};
}`;
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{Mailbox}from'${root}/src/mailbox.tsx';createRoot(document.getElementById('root')).render(<Mailbox session={{account:{name:'Test',email:'test@example.test',role:'user',auth_kind:'staff'},boxes:[{id:1,address:'test@example.test',label:'Test',can_send:true,can_calendar:true,aliases:[]}],demo:false}} recipient="" clearRecipient={()=>{}}/>);`,resolveDir:root,loader:'tsx'},bundle:true,format:'esm',write:false,plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:mock,loader:'js'}));}}]});
const css=await readFile(root+'/src/style.css');const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
const base='http://127.0.0.1:'+server.address().port;
async function folder(name){await page.locator('.folder-list button').filter({hasText:name}).click();await page.getByRole('checkbox',{name:'Označi sve prikazane poruke'}).waitFor();await page.waitForFunction(()=>!document.querySelector('.mail-selection input').disabled);}
try{
 for(const width of [390,1366]){
  await page.setViewportSize({width,height:900});await page.goto(base);await page.locator('.mail-item').first().waitFor();
  for(const name of ['Pristigla pošta','Skice','Poslano','Označeno','Neželjena pošta','Otpad']){
   await folder(name);const select=page.getByRole('checkbox',{name:'Označi sve prikazane poruke'});await select.check();assert(await page.locator('.mail-item input:checked').count()>0,name);assert(await page.getByRole('group',{name:'Radnje za označene poruke'}).isVisible());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflow '+width+' '+name);
   if(['Otpad','Neželjena pošta'].includes(name))assert(await page.locator('.bulk-actions').getByRole('button',{name:'Obriši trajno',exact:true}).isVisible());
  }
  await folder('Pristigla pošta');assert.equal(await page.locator('.mail-item input:checked').count(),0);
  await page.getByRole('checkbox',{name:'Označi sve prikazane poruke'}).check();await page.evaluate(()=>window.failBulk=true);await page.getByRole('button',{name:'Označi odabrane kao pročitane'}).click();await page.getByRole('alert').filter({hasText:'Provjera neuspjele radnje'}).waitFor();await page.waitForFunction(()=>!document.querySelector('.mail-selection input').disabled);assert(await page.getByRole('alert').isVisible());
  await page.getByRole('button',{name:'Prikaži razgovore'}).click();const group=page.getByRole('checkbox',{name:/Označi razgovor: INBOX 1/});await group.check();await page.getByRole('button',{name:'Premjesti odabrane u otpad'}).click();await page.getByRole('status').filter({hasText:'Obrađeno poruka: 2'}).waitFor();assert.equal(await page.evaluate(()=>window.calls.at(-1).messages.length),2);
  await folder('Otpad');await page.getByRole('checkbox',{name:'Označi sve prikazane poruke'}).check();
  const before=await page.evaluate(()=>window.calls.length);page.once('dialog',d=>d.dismiss());await page.locator('.bulk-actions').getByRole('button',{name:'Obriši trajno',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.length),before);
  await page.screenshot({path:out+'/trash-selection-'+width+'.png',fullPage:true});
  page.once('dialog',d=>d.accept());await page.locator('.bulk-actions').getByRole('button',{name:'Obriši trajno',exact:true}).click();await page.getByRole('status').filter({hasText:'Trajno obrisano: 5'}).waitFor();assert.equal(await page.evaluate(()=>window.fixture.filter(r=>r.path==='Trash').length),0);
  await folder('Neželjena pošta');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Isprazni neželjenu poštu',exact:true}).click();await page.getByRole('status').filter({hasText:'Trajno obrisano: 3'}).waitFor();assert.equal(await page.evaluate(()=>window.fixture.filter(r=>r.path==='Junk').length),0);
 }
 assert.deepEqual(errors,[]);console.log('PASS: six folders, select all, grouped messages, folder reset, cancel/confirm permanent deletion and empty Junk at 390 and 1366 px.');
}finally{await browser.close();await new Promise(r=>server.close(r));}

import {build} from 'esbuild';import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';import {createServer} from 'node:http';import {resolve} from 'node:path';import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),out='/tmp/webmail-responsive';await mkdir(out,{recursive:true});
const mock=`export const initials=s=>s.split(' ').map(x=>x[0]).slice(0,2).join('');export const toError=e=>e.message;
const user={id:2,org:1,school:1,name:'Ogledna Nastavnica s vrlo dugim prezimenom',email:'ogledna.nastavnica.s.dugim.prezimenom2@skolehr.xyz',role:'user',active:true,auth_kind:'staff'};
const box={id:1,address:user.email,label:'Osobni sandučić',can_send:true,can_calendar:true,aliases:[]};
export async function api(url,method='GET'){
 if(url==='/login-settings')return {adminSite:new URL(location.href).searchParams.get('view')==='admin',adminUrl:'',publicUrl:'',demo:false};
 if(url==='/me')return {account:{...user,role:'root',shared_password:false,student_password:false},boxes:[box],demo:false};
 if(url==='/admin/organizations')return [{id:1,name:'Ogledna organizacija s dugim nazivom'}];
 if(url==='/admin/schools')return [{id:1,org:1,name:'Ogledna srednja škola s dugim nazivom, Zagreb'}];
 if(url==='/admin/users')return [user];if(url==='/admin/mailboxes')return [{...box,org:1,active:true,shared:false,target_quota_gb:15,storage_kind:'native'}];
 if(url.startsWith('/mail/1/quota'))return {used:10,limit:1000,target:1000};
 if(url.startsWith('/mail/1/message?'))return {subject:'Ogledna poruka s dugim naslovom za provjeru prikaza',text:'DugaRiječ'.repeat(80),from:{name:user.name,address:user.email},to:[user.email],date:'2026-11-22T12:00:00Z',attachments:[{name:'DugiNazivPrivitka'.repeat(12)+'.pdf',size:1000}]};
 if(url.startsWith('/mail/1?'))return [{id:1,path:'INBOX',subject:'Ogledna poruka s dugim naslovom za provjeru prikaza',from:user.name,address:user.email,date:'2026-11-22T12:00:00Z',read:true,star:false,attachment:true}];
 if(url==='/contacts')return [];return [];
}`;
const bundle=await build({stdin:{contents:`import '${root}/src/main.tsx';`,resolveDir:root,loader:'tsx'},bundle:true,format:'esm',write:false,plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:mock,loader:'js'}));
 b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));
 b.onResolve({filter:/\?raw$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:'export default '+JSON.stringify(await readFile(a.path,'utf8')),loader:'js'}));
}}]});
const css=await readFile(root+'/src/style.css');const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
const widths=[320,360,390,640,768,980,1024,1280,1366,1536,1920,2560];
async function bounded(label){const width=page.viewportSize().width;const geometry=await page.evaluate(()=>({body:document.documentElement.scrollWidth,viewport:innerWidth,controls:[...document.querySelectorAll('.topbar button,.page-heading button,.modal input,.modal select')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right}))}));assert(geometry.body<=width+1,label+' page overflow '+width+': '+JSON.stringify(geometry));for(const c of geometry.controls)assert(c.x>=-1&&c.right<=width+1,label+' clipped control '+width+': '+JSON.stringify(c));}
try{
 for(const width of widths){
  await page.setViewportSize({width,height:900});await page.goto('http://127.0.0.1:'+server.address().port+'/?view=admin');
  await page.getByRole('button',{name:'Korisnici',exact:true}).click();await page.locator('.admin-table-users tbody tr').waitFor();await bounded('admin');
  const table=page.locator('.admin-table-users');await table.evaluate(e=>e.scrollLeft=e.scrollWidth);
  const first=await table.locator('tbody td').first().boundingBox(),wrap=await table.boundingBox();assert(first.x>=wrap.x-1,'Name clipped '+width);
  if(width<=980)assert(await table.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Cards overflow '+width);
  const action=page.getByRole('button',{name:'Generiraj / resetiraj lozinku',exact:true});await action.scrollIntoViewIfNeeded();const r=await action.boundingBox();assert(r.x>=0&&r.x+r.width<=width+1,'Password action clipped '+width);
  await page.getByTitle('Uredi',{exact:true}).click();await bounded('edit');await page.getByRole('button',{name:'Zatvori',exact:true}).click();
  if([390,1366,1920].includes(width))await page.screenshot({path:out+'/admin-'+width+'.png',fullPage:true});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?view=mail');await page.locator('.mail-row').first().click();await page.locator('.message-body').waitFor();await bounded('reader');
  if(width<=740)await page.getByRole('button',{name:'Popis poruka',exact:true}).click();
  await page.getByRole('button',{name:'Nova poruka',exact:true}).click();await page.locator('.composer').waitFor();await bounded('composer');
  const send=await page.getByRole('button',{name:'Pošalji',exact:true}).boundingBox();assert(send.x>=0&&send.x+send.width<=width+1,'Send clipped '+width);
 }
 assert.deepEqual(errors,[]);console.log('PASS: actual admin, user editing, mail reader and composer at 12 widths from 320 to 2560 px.');
}finally{await browser.close();await new Promise(r=>server.close(r));}

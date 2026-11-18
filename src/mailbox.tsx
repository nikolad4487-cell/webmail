import {useEffect,useState,type FormEvent} from 'react';
import {Archive,ArrowLeft,ArrowRight,ChevronDown,File,FileText,Inbox,Layers,Mail,MailOpen,Paperclip,Pencil,RefreshCw,Reply,Search,Send,ShieldAlert,Star,Trash2,X} from 'lucide-react';
import {api,initials,toError,type Box,type Contact,type Session} from './api';

const folders=[{key:'inbox',label:'Pristigla pošta',icon:Inbox},{key:'starred',label:'Označeno',icon:Star},{key:'sent',label:'Poslano',icon:Send},{key:'drafts',label:'Skice',icon:FileText},{key:'junk',label:'Neželjena pošta',icon:ShieldAlert},{key:'trash',label:'Otpad',icon:Trash2}];
type Row={id:number;path:string;subject:string;from:string;address:string;date:string;read:boolean;star:boolean;attachment?:boolean;messageId?:string;inReplyTo?:string};
type Message={subject:string;text:string;from?:{name:string;address:string};replyTo?:string;to:string[];date:string;messageId?:string;attachments:{name:string;size:number}[]};
type Compose={title:string;to:string;subject:string;text:string;inReplyTo?:string;source?:Row;draftId?:number};
type Quota={used:number|null;limit:number|null;target:number};
const empty=(to=''):Compose=>({title:'Nova poruka',to,subject:'',text:''});
const at=(value:string,full=false)=>value?new Intl.DateTimeFormat('hr-HR',full?{dateStyle:'long',timeStyle:'short',timeZone:'Europe/Zagreb'}:{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Zagreb'}).format(new Date(value)):'';
const size=(bytes:number)=>bytes<1024?bytes+' B':Math.round(bytes/1024)+' KB';
const quotaLabel=(bytes:number)=>bytes<1024**3?size(bytes):new Intl.NumberFormat('hr-HR',{maximumFractionDigits:2}).format(bytes/1024**3)+' GB';
function threads(rows:Row[]){
  const byMessageId=new Map(rows.filter(x=>x.messageId).map(x=>[x.messageId,x]));
  const groups=new Map<string,Row[]>();
  for(const row of rows){
    let root=row;
    const seen=new Set<Row>([root]);
    while(root.inReplyTo && byMessageId.has(root.inReplyTo)){
      const parent=byMessageId.get(root.inReplyTo)!;
      if(seen.has(parent))break;
      root=parent;seen.add(root);
    }
    const key=root.inReplyTo&&!byMessageId.has(root.inReplyTo)?root.inReplyTo:root.messageId||root.path+root.id;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key)!.push(row);
  }
  return [...groups.values()];
}
const query=(row:Row)=>new URLSearchParams({path:row.path,id:String(row.id)}).toString();

export function Mailbox({session,recipient,clearRecipient}:{session:Session;recipient:string;clearRecipient:()=>void}){
  const [boxId,setBoxId]=useState(session.boxes.find(x=>session.demo&&x.address==='info@formapoint.test')?.id??session.boxes[0]?.id);
  const box=session.boxes.find(x=>x.id===boxId), base='/mail/'+boxId;
  const [folder,setFolder]=useState('inbox'),[search,setSearch]=useState(''),[searchTerm,setSearchTerm]=useState('');
  const [rows,setRows]=useState<Row[]>([]),[selected,setSelected]=useState<Row>(),[msg,setMsg]=useState<Message>();
  const [quota,setQuota]=useState<Quota>(),[compose,setCompose]=useState<Compose>(),[mobileReader,setMobileReader]=useState(false);
  const [grouped,setGrouped]=useState(false);
  const [busy,setBusy]=useState(true),[refresh,setRefresh]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>setSearchTerm(search),250);return ()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    if(!box)return;
    let active=true;setBusy(true);setError('');
    api<Row[]>(base+'?'+new URLSearchParams({folder,q:searchTerm})).then(list=>{
      if(!active)return;
      setRows(list);setSelected(current=>list.find(x=>x.id===current?.id&&x.path===current?.path)||list[0]);
    }).catch(e=>{if(active){setError(toError(e));setRows([]);setSelected(undefined);}}).finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[base,folder,searchTerm,refresh,box]);
  useEffect(()=>{let active=true;setQuota(undefined);if(box)api<Quota>(base+'/quota').then(x=>{if(active)setQuota(x);}).catch(()=>{});return ()=>{active=false;};},[base,box,refresh]);
  useEffect(()=>{
    let active=true;setMsg(undefined);
    if(selected)api<Message>(base+'/message?'+query(selected)).then(x=>{if(active)setMsg(x);}).catch(e=>{if(active)setError(toError(e));});
    return ()=>{active=false;};
  },[base,selected?.id,selected?.path]);
  useEffect(()=>{if(recipient && box?.can_send){setCompose(empty(recipient));setMobileReader(true);clearRecipient();}},[recipient,box]);
  async function flag(row:Row,flag:'read'|'star',value:boolean){
    try{
      await api(base+'/message','PATCH',{path:row.path,id:row.id,flag,value});
      setRows(list=>list.map(x=>x.id===row.id && x.path===row.path?{...x,[flag]:value}:x));
      setSelected(x=>x?.id===row.id&&x.path===row.path?{...x,[flag]:value}:x);
      if(folder==='starred'&&flag==='star'&&!value)setRefresh(x=>x+1);
    }catch(e){setError(toError(e));}
  }
  async function move(row:Row,destination:string){
    try{
      await api(base+'/move','POST',{path:row.path,id:row.id,destination});
      setSelected(undefined);setMsg(undefined);setMobileReader(false);setRefresh(x=>x+1);
    }catch(e){setError(toError(e));}
  }
  function changeFolder(key:string){
    setFolder(key);setRows([]);setSelected(undefined);setMobileReader(false);setCompose(undefined);
  }
  function openRow(row:Row){setCompose(undefined);setSelected(row);setMobileReader(true);if(!row.read)void flag(row,'read',true);}
  function reply(forward=false){
    if(!msg)return;
    setCompose({title:forward?'Proslijedi poruku':'Odgovori',to:forward?'':msg.replyTo||msg.from?.address||'',subject:(forward?'Fwd: ':'Re: ')+(msg.subject||''),text:forward?'\n\n—— Proslijeđena poruka ——\n'+msg.text:'',inReplyTo:forward?undefined:msg.messageId,source:forward?selected:undefined});
    setMobileReader(true);
  }
  const groups=grouped?threads(rows):rows.map(row=>[row]);
  const thread=groups.find(group=>group.some(row=>row.id===selected?.id&&row.path===selected.path));
  const heading=folders.find(x=>x.key===folder)!.label;
  return <main className={'mail-layout '+(mobileReader?'reader-open':'')}>
    <aside className="sidebar mail-sidebar">
      <button className="primary new-message" disabled={!box?.can_send} onClick={()=>{setCompose(empty());setMobileReader(true);}}><Pencil size={18}/> Nova poruka</button>
      <label className="section-label" htmlFor="box-select">Sandučić</label>
      <div className="box-picker"><Inbox size={17}/><select id="box-select" value={boxId??''} onChange={e=>{setBoxId(Number(e.target.value));changeFolder('inbox');setSearch('');}}>{!box&&<option value="">Nema sandučića</option>}{session.boxes.map(x=><option value={x.id} key={x.id}>{x.label==='Osobni sandučić'?x.address:x.label}</option>)}</select><ChevronDown size={15}/></div>
      <nav className="folder-list" aria-label="Mape pošte">{folders.map(({key,label,icon:Icon})=><button key={key} className={folder===key?'active':''} onClick={()=>{if(folder!==key)changeFolder(key);else setMobileReader(false);}}><Icon size={19}/><span>{label}</span>{folder===key && rows.length>0&&<small>{rows.length}</small>}</button>)}</nav>
      <div className="storage"><span className="storage-title"><Archive size={16}/> Pohrana sandučića</span>{quota?.used!=null && quota.limit!=null?<><progress max={quota.limit||1} value={quota.used}/><small>{quotaLabel(quota.used)} od {quotaLabel(quota.limit)}</small></>:<small>{quota?'Kvotu ne prijavljuje poslužitelj.':'Kvota nije dostupna.'}</small>}</div>
    </aside>
    <section className="message-list"><div className="list-heading"><div className="heading-line"><h1>{heading}</h1><div className="actions"><button className={'icon secondary '+(grouped?'starred':'')} aria-label="Prikaži razgovore" aria-pressed={grouped} onClick={()=>setGrouped(x=>!x)}><Layers size={17}/></button><button className="icon secondary" title="Osvježi poštu" onClick={()=>setRefresh(x=>x+1)}><RefreshCw size={17}/></button></div></div><label className="search"><Search size={18}/><input aria-label="Pretraži poštu" placeholder="Pretraži poštu…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="icon ghost" aria-label="Očisti pretragu" onClick={()=>setSearch('')}><X size={15}/></button>}</label></div>
      <div className="list-meta">{busy?'Učitavanje…':rows.length===1?'1 poruka':rows.length+' poruka'}</div>
      <div className="rows">{groups.map((group,index)=>{const row=group[0];return <button key={row.path+row.id} className={'mail-row '+(group===thread?'selected':'')} onClick={()=>openRow(row)}>
        <span className={'avatar tone-'+index%4}>{initials(row.from)}</span><span className="row-main"><strong>{row.from}</strong><span>{row.subject}{group.length>1 && ` · ${group.length}`}</span></span><span className="row-end"><small>{at(row.date)}</small><span>{row.star&&<Star size={13} fill="currentColor"/>}{row.attachment&&<Paperclip size={14}/>} {!row.read&&<i className="unread"/>}</span></span>
      </button>;})}</div>
      {!busy&&!rows.length&&<div className="empty compact"><Inbox size={26}/><p>{searchTerm?'Nema rezultata pretrage.':'U ovoj mapi nema poruka.'}</p></div>}
    </section>
    <section className="reader"><button className="mobile-back secondary" onClick={()=>{setMobileReader(false);setCompose(undefined);}}><ArrowLeft size={17}/> Popis poruka</button>
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
      {compose&&box?<Composer key={compose.title+compose.subject} initial={compose} box={box} base={base} close={()=>setCompose(undefined)} done={(message)=>{setCompose(undefined);setNotice(message);setRefresh(x=>x+1);}}/>:
      msg&&selected?<article className="message">
        <div className="reader-heading"><h2>{msg.subject||'(Bez predmeta)'}</h2><div className="actions"><button className={'icon secondary '+(selected.star?'starred':'')} aria-label={selected.star?'Ukloni oznaku':'Označi zvjezdicom'} onClick={()=>flag(selected,'star',!selected.star)}><Star size={18} fill={selected.star?'currentColor':'none'}/></button><button className="icon secondary" title={selected.read?'Označi kao nepročitano':'Označi kao pročitano'} onClick={()=>flag(selected,'read',!selected.read)}>{selected.read?<Mail size={18}/>:<MailOpen size={18}/>}</button>{box?.can_send&&folder!=='trash'&&<button className="icon secondary" title="Premjesti u otpad" onClick={()=>move(selected,'trash')}><Trash2 size={17}/></button>}</div></div>
        {thread&&thread.length>1&&<nav className="thread-links" aria-label="Poruke razgovora">{thread.map(row=><button key={row.path+row.id} className="secondary" aria-pressed={row===selected} onClick={()=>openRow(row)}>{row.from} · {at(row.date)}</button>)}</nav>}
        <div className="sender"><span className="avatar big">{initials(msg.from?.name||msg.from?.address||'?')}</span><div><strong>{msg.from?.name||msg.from?.address||'Nepoznato'}</strong>{msg.from?.name&&<span className="sender-address">{msg.from.address}</span>}<small>Za: {msg.to.join(', ')}</small></div><time>{at(msg.date,true)}</time></div>
        <div className="message-body">{msg.text||'Poruka nema tekstualni sadržaj.'}</div>
        {msg.attachments.length>0&&<div className="attachments"><span className="section-label">Privitci ({msg.attachments.length})</span>{msg.attachments.map((file,index)=><a key={index} className="attachment" href={base+'/attachment?'+query(selected)+'&index='+index}><span className="file-icon"><File size={19}/></span><span><strong>{file.name}</strong><small>{size(file.size)}</small></span></a>)}</div>}
        {box?.can_send&&(folder==='junk'||folder==='trash')&&<div className="actions"><button className="secondary" onClick={()=>move(selected,'inbox')}>Vrati u pristiglu poštu</button></div>}
        {box?.can_send&&<div className="reader-buttons">{folder==='drafts'?<button className="primary" onClick={()=>setCompose({title:'Uredi skicu',to:msg.to.join(', '),subject:msg.subject||'',text:msg.text,source:selected,draftId:selected.id})}><Pencil size={17}/> Uredi skicu</button>:<><button className="primary" onClick={()=>reply()}><Reply size={18}/> Odgovori</button><button className="secondary" onClick={()=>reply(true)}><ArrowRight size={18}/> Proslijedi</button></>}</div>}
      </article>:<div className="empty reader-empty"><span><Mail size={29}/></span><h2>{selected?'Učitavanje poruke…':'Odaberite poruku'}</h2>{!selected&&<p>Otvorite poruku s popisa za pregled sadržaja.</p>}</div>}
    </section>
  </main>;
}
function Composer({initial,box,base,close,done}:{initial:Compose;box:Box;base:string;close:()=>void;done:(message:string)=>void}){
  const [value,setValue]=useState(initial),[from,setFrom]=useState(box.address),[files,setFiles]=useState<File[]>([]),[originals,setOriginals]=useState<{filename:string;data:string}[]>([]),[contacts,setContacts]=useState<Contact[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    api<Contact[]>('/contacts').then(setContacts).catch(()=>{});
    if(initial.source){
      const source=initial.source;
      api<Message>(base+'/message?'+query(source)).then(async message=>setOriginals(await Promise.all(message.attachments.map(async (file,index)=>{
        const response=await fetch('/api'+base+'/attachment?'+query(source)+'&index='+index);
        if(!response.ok)throw new Error('Privitak nije dostupan.');
        return {filename:file.name,data:await encode(await response.blob())};
      })))).catch(e=>setError(toError(e)));
    }
  },[base,initial.source]);
  function encode(file:Blob):Promise<string>{
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
  }
  async function save(draft:boolean){
    setBusy(true);setError('');
    try{
      if(files.length+originals.length>5 || files.some(x=>x.size>5_000_000) || files.reduce((n,x)=>n+x.size,0)+originals.reduce((n,x)=>n+x.data.length*.75,0)>12_000_000)throw new Error('Do 5 privitaka, najviše 5 MB po datoteci i ukupno 12 MB.');
      const attachments=[...originals,...await Promise.all(files.map(async file=>({filename:file.name,data:await encode(file)})))];
      const result=await api<{warning?:string}>(base+'/send','POST',{from,to:value.to.split(/[;,]/).map(x=>x.trim()).filter(Boolean),subject:value.subject,text:value.text,inReplyTo:value.inReplyTo,draft,draftId:value.draftId,attachments});
      done(result.warning || (draft?'Skica je spremljena.':'Poruka je predana poštanskom servisu.'));
    }catch(e){setError(toError(e));}finally{setBusy(false);}
  }
  function submit(event:FormEvent){event.preventDefault();void save(false);}
  return <article className="composer"><div className="reader-heading"><h2>{value.title}</h2><button className="icon secondary" aria-label="Zatvori uređivanje" onClick={close}><X size={18}/></button></div>
    <form onSubmit={submit}>
      <label>Od<select value={from} onChange={e=>setFrom(e.target.value)}>{[box.address,...box.aliases].map(x=><option key={x}>{x}</option>)}</select></label>
      <label>Za<input list="recipient-options" value={value.to} onChange={e=>setValue({...value,to:e.target.value})} placeholder="primatelj@domena" required/><datalist id="recipient-options">{contacts.map(c=><option key={c.id} value={c.email}>{c.name}</option>)}</datalist></label>
      <label>Predmet<input value={value.subject} onChange={e=>setValue({...value,subject:e.target.value})} placeholder="Predmet poruke"/></label>
      <label>Poruka<textarea value={value.text} onChange={e=>setValue({...value,text:e.target.value})} placeholder="Napišite poruku…" rows={9}/></label>
      <div className="compose-files">{originals.map((x,i)=><button key={i} type="button" className="chip" onClick={()=>setOriginals(originals.filter((_,j)=>i!==j))}>{x.filename}<X size={14}/></button>)}{files.map((x,i)=><button key={i} type="button" className="chip" onClick={()=>setFiles(files.filter((_,j)=>i!==j))}>{x.name}<X size={14}/></button>)}</div>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="reader-buttons"><button className="primary" disabled={busy}><Send size={17}/> Pošalji</button><button type="button" className="secondary" disabled={busy} onClick={()=>save(true)}>Spremi skicu</button><label className="secondary upload"><Paperclip size={18}/> Privitak<input type="file" multiple onChange={e=>{setFiles([...files,...Array.from(e.target.files||[])]);e.target.value='';}}/></label></div>
    </form></article>;
}

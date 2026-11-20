import {useEffect,useState,type FormEvent} from 'react';
import {Building2,ClipboardList,Globe,Inbox,KeyRound,Eye,EyeOff,Pencil,Plus,School,Search,Send,UsersRound,X} from 'lucide-react';
import {api,toError,type Session} from './api';
import {accountKinds,usesUsername,type AccountKind} from './account-kinds';
type RecordRow=Record<string,string|number|boolean|null>;
type Field={key:string;label:string;type?:string;options?:[string,string][];optional?:boolean};
const active={key:'active',label:'Aktivno',type:'check'};
const address={key:'address',label:'E-mail adresa',type:'email'};
const name={key:'name',label:'Naziv'};
const sections={
  organizations:{label:'Organizacije',icon:Building2,fields:[name]},
  schools:{label:'Škole i ustanove',icon:School,fields:[name]},
  domains:{label:'Domene',icon:Globe,fields:[{key:'name',label:'Domena'},{key:'inbound',label:'IMAP / primanje',type:'check'},{key:'outbound',label:'SMTP / slanje',type:'check'}]},
  users:{label:'Korisnici',icon:UsersRound,fields:[name,{...address,key:'email'},{key:'school',label:'Škola ili ustanova',type:'school',optional:true},{key:'role',label:'Uloga',options:[['user','Korisnik'],['admin','Administrator organizacije'],['root','Glavni administrator']] as [string,string][]},active,{key:'auth_kind',label:'Vrsta računa',options:accountKinds.map(([key,label]):[string,string]=>[key,label])},{key:'source_user_id',label:'Stabilni ID korisnika (za povezani račun)',optional:true},{key:'source_email',label:'E-mail postojećeg FormaPoint računa (neobavezno)',type:'email'},{key:'recovery',label:'Potvrđena adresa za oporavak',type:'email',optional:true},{key:'password',label:'Lozinka',type:'password'}]},
  mailboxes:{label:'Sandučići',icon:Inbox,fields:[address,{key:'label',label:'Naziv'},{key:'shared',label:'Zajednički sandučić',type:'check'},active,{key:'target_quota_gb',label:'Ciljana kvota (GB)',type:'number'}]},
  senders:{label:'Automatski pošiljatelji',icon:Send,fields:[address,{...address,key:'reply_to',label:'Adresa za odgovor'},{key:'kind',label:'Namjena',options:[['order','Narudžbe'],['promotion','Promocije']] as [string,string][]},active]},
  logs:{label:'Zapisi dostave',icon:ClipboardList,fields:[address,{key:'external_id',label:'Događaj'},{key:'recipient',label:'Primatelj'},{key:'status',label:'Status'},{key:'at',label:'Vrijeme'}]},
};
type Section=keyof typeof sections;
const statuses:Record<string,string>={pending:'U tijeku',submitted:'Predano servisu',failed:'Greška',delivered:'Dostavljeno',unknown:'Ishod nepoznat'};
type Storage={canApply:boolean;capacity:number|null;boxes:{address:string;target:number;limit:number|null;used:number|null}[]};
const storageSize=(value:number|null)=>{
  if(value==null)return '—';
  if(value>=1024**3)return new Intl.NumberFormat('hr-HR',{maximumFractionDigits:2}).format(value/1024**3)+' GiB';
  if(value>=1024**2)return new Intl.NumberFormat('hr-HR',{maximumFractionDigits:1}).format(value/1024**2)+' MiB';
  if(value>=1024)return Math.round(value/1024)+' KiB';
  return value+' B';
};
type Access={grants:RecordRow[];aliases:RecordRow[]};
export function Admin({session}:{session:Session}){
  const root=session.account.role==='root';
  const [section,setSection]=useState<Section>(location.pathname.endsWith('/automatsko-slanje')?'senders':'mailboxes');
  const [rows,setRows]=useState<RecordRow[]>([]),[orgs,setOrgs]=useState<RecordRow[]>([]),[schools,setSchools]=useState<RecordRow[]>([]);
  const [storage,setStorage]=useState<Storage>(),[storageBusy,setStorageBusy]=useState(false);
  const [error,setError]=useState(''),[search,setSearch]=useState(''),[filter,setFilter]=useState(''),[edit,setEdit]=useState<RecordRow>(),[org,setOrg]=useState(''),[access,setAccess]=useState<RecordRow>();
  const [kind,setKind]=useState<AccountKind>('staff');
  const [pin,setPin]=useState<string>(),[rotating,setRotating]=useState(false);
  const [editPassword,setEditPassword]=useState(''),[passwordVisible,setPasswordVisible]=useState(false);
  const [nativeBusy,setNativeBusy]=useState(false),[notice,setNotice]=useState('');
  const config=sections[section],fields:Field[]=config.fields;
  async function load(){try{setRows(await api<RecordRow[]>('/admin/'+section));}catch(e){setError(toError(e));}}
  useEffect(()=>{let alive=true;setRows([]);setError('');api<RecordRow[]>('/admin/'+section).then(x=>{if(alive)setRows(x);}).catch(e=>{if(alive)setError(toError(e));});return ()=>{alive=false;};},[section]);
  useEffect(()=>{api<RecordRow[]>('/admin/organizations').then(setOrgs).catch(()=>{});api<RecordRow[]>('/admin/schools').then(setSchools).catch(()=>{});},[section]);
  function open(key:Section){setSection(key);setEdit(undefined);setAccess(undefined);setSearch('');setFilter('');setNotice('');history.replaceState(null,'',key==='senders'?'/admin/automatsko-slanje':'/admin');}
  function begin(row:RecordRow={}){setEditPassword('');setPasswordVisible(false);setKind((row.auth_kind as AccountKind|undefined)??'staff');setEdit(row);setOrg(String(row.org??filter??''));setError('');}
  async function save(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');
    const data=new FormData(e.currentTarget),values:Record<string,unknown>={key:edit?.id??(section==='domains'?edit?.name:undefined),org};
    for(const field of fields){
      if(!showField(field)) continue;
      const value=data.get(field.key);
      if(field.key==='password'&&!value)continue;
      values[field.key]=field.type==='check'?data.has(field.key):field.type==='number'||field.type==='school'?(value?Number(value):null):value||null;
    }
    if(section==='users' && kind!=='local')values.recovery=null;
    try{await api('/admin/'+section,'POST',values);setEdit(undefined);await load();}catch(e){setError(toError(e));}
  }
  function showField(field:Field){
    if(section!=='users')return true;
    if(field.key==='source_user_id')return usesUsername(kind);
    if(field.key==='source_email')return kind==='formapoint';
    if(field.key==='password')return kind!=='ednevnik';
    if(field.key==='recovery')return kind==='local';
    return true;
  }
  async function rotatePin(row:RecordRow){
    setRotating(true);setError('');
    try{setPin((await api<{password:string}>('/admin/users/'+row.id+'/password','POST')).password);}
    catch(e){setError(toError(e));}finally{setRotating(false);}
  }
  async function downloadInitialPins(){
    if(!window.confirm('Generirati početne lozinke za do 50 djelatnika i FormaPoint korisnika bez WebmailHR lozinke? Datoteka ih sadrži u čitljivom obliku.'))return;
    setRotating(true);setError('');
    try{
      const {generated}=await api<{generated:{email:string;password:string}[]}>('/admin/users/initial-passwords','POST',{org:filter?Number(filter):null});
      if(!generated.length){
        setError('U odabranoj organizaciji nema djelatnika ni FormaPoint korisnika bez početne lozinke.');
        return;
      }
      const url=URL.createObjectURL(new Blob([JSON.stringify(generated.map(({email,password})=>({email,password})),null,2)],{type:'application/json'}));
      const link=document.createElement('a');
      link.href=url;link.download='webmailhr-pocetne-lozinke.json';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(toError(e));}finally{setRotating(false);}
  }
  async function loadStorage(){
    setStorageBusy(true);setError('');
    try{setStorage(await api<Storage>('/admin/storage'));}catch(e){setError(toError(e));}finally{setStorageBusy(false);}
  }
  async function applyStorage(id:RecordRow[string]){
    setStorageBusy(true);setError('');
    try{await api('/admin/storage/'+id+'/apply','POST');await loadStorage();}
    catch(e){setError(toError(e));}finally{setStorageBusy(false);}
  }
  async function enableNative(){
    if(!edit?.id)return;
    setNativeBusy(true);setError('');setNotice('');
    try{
      await api('/admin/mailboxes/'+edit.id+'/native','POST');
      setEdit(undefined);setStorage(undefined);await load();
      setNotice('Sandučić koristi Cloudflare / Mailjet. Za primitak dodajte adresu u Worker i pravilo Email Routing.');
    }catch(e){setError(toError(e));}finally{setNativeBusy(false);}
  }
  const filtered=rows.filter(row=>(!filter||String(row.org)===filter)&&Object.values(row).some(x=>String(x).toLowerCase().includes(search.toLowerCase())));
  const visible=fields.filter(x=>!['password','recovery','source_user_id','source_email'].includes(x.key));
  const display=(value:RecordRow[string],field:Field)=>{
    if(typeof value==='boolean')return value?'Da':'Ne';
    if(field.key==='status')return <span className={'status '+String(value)}>{statuses[String(value)]}</span>;
    if(field.key==='at')return new Intl.DateTimeFormat('hr-HR',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Zagreb'}).format(new Date(String(value)));
    if(field.type==='school')return schools.find(x=>x.id===value)?.name||'—';
    if(field.key==='target_quota_gb')return value+' GB';
    return field.options?.find(x=>x[0]===value)?.[1]||String(value??'—');
  };
  return <main className="workspace-layout"><aside className="sidebar"><p className="section-label">Administracija</p><nav className="folder-list" aria-label="Administracija">{Object.entries(sections).map(([key,{label,icon:Icon}])=><button className={section===key?'active':''} key={key} onClick={()=>open(key as Section)}><Icon size={18}/>{label}</button>)}</nav></aside><section className="workspace-content">
    <div className="page-heading"><h1>{config.label}</h1>{section==='users'&&root&&<button className="secondary" disabled={rotating} onClick={downloadInitialPins}><KeyRound size={16}/> Početne lozinke</button>}{section!=='logs'&&(section!=='organizations'||root)&&<button className="primary" onClick={()=>begin()}><Plus size={18}/> {section==='mailboxes'?'Novi sandučić':section==='senders'?'Dodaj pošiljatelja':'Dodaj zapis'}</button>}</div>
    <div className="filters">{section!=='organizations'&&section!=='logs'&&root&&<select aria-label="Organizacija" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Sve organizacije</option>{orgs.map(x=><option key={String(x.id)} value={String(x.id)}>{x.name}</option>)}</select>}<label className="search wide-search"><Search size={18}/><input aria-label="Pretraži zapise" placeholder="Pretraži zapise…" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
    {section==='mailboxes'&&<div className="storage-admin"><p className="muted">Stvarna kvota i usmjeravanje aliasa ovise o poštanskom poslužitelju.</p><button className="secondary" disabled={storageBusy} onClick={loadStorage}>{storageBusy?'Dohvaćanje…':'Osvježi stanje pohrane'}</button></div>}
    {section==='mailboxes'&&storage&&<p className="storage-summary">Kapacitet: {storageSize(storage.capacity)} · Prijavljena potrošnja: {storageSize(storage.boxes.reduce((sum,x)=>sum+(x.used??0),0))} · Ciljane kvote: {storage.boxes.reduce((sum,x)=>sum+x.target,0)} GiB · Izmjerena kvota: {storage.boxes.filter(x=>x.limit!=null).length}/{storage.boxes.length} sandučića</p>}
    {error&&!edit&&<p className="error">{error}</p>}
    {notice&&!edit&&<p className="notice" role="status">{notice}</p>}
    <div className="table-wrap"><table><thead><tr>{visible.map(f=><th key={f.key}>{f.label}</th>)}{section==='mailboxes'&&<th>Poštanski servis</th>}{'org' in (rows[0]??{})&&<th>Organizacija</th>}{section==='mailboxes'&&storage&&<th>Potrošnja / stvarna kvota</th>}{section!=='logs'&&<th>Radnje</th>}</tr></thead><tbody>
    {filtered.map(row=><tr key={String(row.id??row.name)}>{visible.map(f=><td key={f.key}>{section==='mailboxes'&&row.storage_kind==='native'&&f.key==='target_quota_gb'?'Serverska kvota':display(row[f.key],f)}</td>)}{section==='mailboxes'&&<td>{row.storage_kind==='native'?'Cloudflare / Mailjet':'IMAP / SMTP'}</td>}{'org' in row&&<td>{orgs.find(x=>x.id===row.org)?.name||row.org}</td>}{section==='mailboxes'&&storage&&<td>{storageSize(storage.boxes.find(x=>x.address===row.address)?.used??null)} / {storageSize(storage.boxes.find(x=>x.address===row.address)?.limit??null)}</td>}{section!=='logs'&&<td><div className="actions">{(section!=='organizations'||root)&&<button className="icon secondary" title="Uredi" onClick={()=>begin(row)}><Pencil size={16}/></button>}{section==='users'&&['staff','formapoint'].includes(String(row.auth_kind))&&(root||row.role==='user')&&<button className="secondary" disabled={rotating} onClick={()=>rotatePin(row)}><KeyRound size={16}/> Generiraj / resetiraj lozinku</button>}{section==='mailboxes'&&<button className="icon secondary" title="Ovlasti i aliasi" onClick={()=>setAccess(row)}><KeyRound size={16}/></button>}{section==='mailboxes'&&storage?.canApply&&row.active&&row.storage_kind!=='native'&&<button className="secondary" disabled={storageBusy} onClick={()=>applyStorage(row.id)}>Primijeni kvotu</button>}</div></td>}</tr>)}
    </tbody></table>{!filtered.length&&<p className="empty compact">Nema zapisa za prikaz.</p>}</div>
    {edit&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Uredi zapis"><div className="reader-heading"><h2>{edit.id||edit.name?'Uredi zapis':'Novi zapis'}</h2><button className="icon secondary" aria-label="Zatvori" onClick={()=>setEdit(undefined)}><X size={18}/></button></div><form onSubmit={save}>
      {root&&section!=='organizations'&&<label>Organizacija<select required value={org} onChange={e=>setOrg(e.target.value)} disabled={!!edit.org}><option value="">Odaberite organizaciju</option>{orgs.map(x=><option key={String(x.id)} value={String(x.id)}>{x.name}</option>)}</select></label>}
      {fields.filter(showField).map(f=>{
        if(f.key==='auth_kind')return <label key={f.key}>{f.label}<select name={f.key} value={kind} onChange={e=>setKind(e.target.value as AccountKind)}>{accountKinds.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>;
        if(f.key==='password')return <label key={f.key}>Lozinka za WebmailHR{edit.id&&<small>Ostavite prazno ako je ne mijenjate.</small>}<span className="password"><input name="password" type={passwordVisible?'text':'password'} value={editPassword} onChange={e=>setEditPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={512} required={!edit.id&&kind!=='formapoint'}/><button type="button" className="icon ghost" aria-label={passwordVisible?'Sakrij lozinku':'Prikaži lozinku'} onClick={()=>setPasswordVisible(!passwordVisible)}>{passwordVisible?<EyeOff size={18}/>:<Eye size={18}/>}</button></span><button type="button" className="secondary" disabled={rotating} onClick={async()=>{setRotating(true);setError('');try{setEditPassword((await api<{password:string}>('/admin/passwords/generate','POST')).password);setPasswordVisible(true);}catch(e){setError(toError(e));}finally{setRotating(false);}}}><KeyRound size={16}/> Generiraj lozinku</button></label>;
        const value=edit[f.key];
        if(f.type==='check')return <label className="check" key={f.key}><input name={f.key} type="checkbox" defaultChecked={typeof value==='boolean'?value:f.key!=='shared'}/>{f.label}</label>;
        if(f.type==='school')return <label key={f.key}>{f.label}<select name={f.key} defaultValue={String(value??'')}><option value="">Bez odabira</option>{schools.filter(x=>!org||String(x.org)===org).map(x=><option key={String(x.id)} value={String(x.id)}>{x.name}</option>)}</select></label>;
        if(f.options)return <label key={f.key}>{f.label}<select name={f.key} defaultValue={String(value??f.options[0][0])}>{f.options.filter(x=>root||f.key!=='role'||x[0]==='user').map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>;
        return <label key={f.key}>{f.label}<input name={f.key} type={f.type||'text'} defaultValue={String(value??(f.key==='target_quota_gb'?15:''))} required={f.key==='source_user_id'?kind==='ednevnik':f.key==='source_email'?false:!f.optional} minLength={f.key==='password'?8:undefined}/></label>;
      })}{error&&<p className="error">{error}</p>}<button className="primary">Spremi</button>
    </form>{section==='mailboxes'&&edit.id&&<section aria-label="Poštanski servis"><h3>Poštanski servis</h3>{edit.storage_kind==='native'?<p>Cloudflare / Mailjet. Stvarnu kvotu provjerite putem stanja pohrane.</p>:<><p>IMAP / SMTP</p>{root&&<><p>Uključite Cloudflare / Mailjet za spremljeni aktivni osobni sandučić s jednim vlasnikom iste e-mail adrese. Postojeće poruke s IMAP poslužitelja ne prenose se. Kvotu određuju serverske postavke pohrane.</p><button className="secondary" disabled={nativeBusy} onClick={enableNative}>{nativeBusy?'Uključivanje…':'Uključi Cloudflare / Mailjet'}</button></>}</>}</section>}</section></div>}
    {pin!==undefined&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="assigned-password-title"><div className="reader-heading"><h2 id="assigned-password-title">Nova lozinka za WebmailHR</h2></div><p>Lozinka se prikazuje samo sada. Predajte je korisniku sigurnim kanalom.</p><output className="assigned-password">{pin}</output><button className="primary" onClick={()=>setPin(undefined)}>Zatvori</button></section></div>}
    {access&&<Permissions box={access} close={()=>setAccess(undefined)}/>}
  </section></main>;
}
function Permissions({box,close}:{box:RecordRow;close:()=>void}){
  const [data,setData]=useState<Access>({grants:[],aliases:[]}),[users,setUsers]=useState<RecordRow[]>([]),[error,setError]=useState('');
  const url='/admin/access/'+box.id;
  async function load(){try{setData(await api<Access>(url));}catch(e){setError(toError(e));}}
  useEffect(()=>{void load();api<RecordRow[]>('/admin/users').then(x=>setUsers(x.filter(u=>u.org===box.org))).catch(e=>setError(toError(e)));},[url]);
  async function change(input:object){try{setError('');await api(url,'PUT',input);await load();}catch(e){setError(toError(e));}}
  function submit(e:FormEvent<HTMLFormElement>,kind:'alias'|'grant'){
    e.preventDefault();const f=new FormData(e.currentTarget);
    void change(kind==='grant'?{kind,uid:Number(f.get('uid')),can_send:f.has('send'),can_calendar:f.has('calendar'),remove:false}:{kind,address:f.get('address'),send_as:f.has('send'),remove:false});
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Pristup sandučiću"><div className="reader-heading"><h2>Ovlasti i aliasi</h2><button className="icon secondary" aria-label="Zatvori" onClick={close}><X size={18}/></button></div><p className="muted">{box.address}</p>
    {data.grants.map(g=><div className="permission" key={String(g.uid)}><span>{g.email}<small>{['Čitanje',g.can_send?'Slanje':'',g.can_calendar?'Kalendar':''].filter(Boolean).join(' · ')}</small></span><button className="secondary" onClick={()=>change({...g,kind:'grant',remove:true})}>Ukloni</button></div>)}
    <form onSubmit={e=>submit(e,'grant')}><label>Korisnik<select name="uid" required><option value="">Odaberite korisnika</option>{users.map(u=><option key={String(u.id)} value={String(u.id)}>{u.email}</option>)}</select></label><label className="check"><input name="send" type="checkbox"/> Pošalji kao</label><label className="check"><input name="calendar" type="checkbox"/> Pristup kalendaru</label><button className="primary">Spremi ovlasti</button></form>
    {data.aliases.map(a=><div className="permission" key={String(a.address)}><span>{a.address}<small>{a.send_as?'Pošalji kao':'Dolazni alias'}</small></span><button className="secondary" onClick={()=>change({...a,kind:'alias',remove:true})}>Ukloni</button></div>)}
    <form onSubmit={e=>submit(e,'alias')}><label>Alias adresa<input name="address" type="email" required/></label><label className="check"><input name="send" type="checkbox"/> Pošalji kao</label><button className="primary">Spremi alias</button></form>
    {error&&<p className="error">{error}</p>}</section></div>;
}

import {useEffect,useState,type FormEvent} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight,Download,Mail,Pencil,Plus,Search,UsersRound,X} from 'lucide-react';
import {DateTime} from 'luxon';
import {api,initials,toError,type Box,type Contact} from './api';

const zone='Europe/Zagreb';
const today=()=>DateTime.now().setZone(zone).setLocale('hr');
type Event={id:number;box:number|null;title:string;starts:string;ends:string;attendees:string[]};
export function Calendar({boxes}:{boxes:Box[]}){
  const [day,setDay]=useState(today),[mode,setMode]=useState<'week'|'month'>('week'),[events,setEvents]=useState<Event[]>([]),[selected,setSelected]=useState<Event>(),[form,setForm]=useState<Partial<Event>>(),[error,setError]=useState('');
  const [hidden,setHidden]=useState<number[]>([]);
  const start=mode==='week'?day.startOf('week'):day.startOf('month').startOf('week');
  const end=mode==='week'?start.plus({days:7}):day.endOf('month').endOf('week').plus({milliseconds:1});
  const range=Array.from({length:Math.round(end.diff(start,'days').days)},(_,i)=>start.plus({days:i}));
  const calendars=boxes.filter(x=>x.can_calendar);
  async function load(){try{setEvents(await api<Event[]>('/events?'+new URLSearchParams({start:start.toISO()!,end:end.toISO()!})));}catch(e){setError(toError(e));}}
  useEffect(()=>{void load();setSelected(undefined);},[day,mode]);
  function newEvent(date=day){
    const value=date.set({hour:9,minute:0,second:0,millisecond:0});
    setForm({box:null,starts:value.toISO()!,ends:value.plus({hours:1}).toISO()!});setError('');
  }
  async function save(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');
    const data=new FormData(e.currentTarget);
    const local=(key:string)=>DateTime.fromISO(String(data.get(key)),{zone}).toISO();
    try{
      await api('/events'+(form?.id?'/'+form.id:''),form?.id?'PUT':'POST',{box:data.get('box')?Number(data.get('box')):null,title:data.get('title'),starts:local('starts'),ends:local('ends'),attendees:String(data.get('attendees')).split(/[,;]/).map(x=>x.trim()).filter(Boolean)});
      setForm(undefined);setSelected(undefined);await load();
    }catch(e){setError(toError(e));}
  }
  const localDate=(value?:string)=>value?DateTime.fromISO(value,{zone}).toFormat("yyyy-LL-dd'T'HH:mm"):'';
  const available=[{id:0,label:'Osobni'},...calendars];
  return <main className="workspace-layout"><aside className="sidebar">
    <button className="primary new-message" onClick={()=>newEvent()}><Plus size={19}/> Novi događaj</button>
    <p className="section-label">Moji kalendari</p>{available.map(x=><label key={x.id} className="check calendar-check"><input type="checkbox" checked={!hidden.includes(x.id)} onChange={()=>setHidden(hidden.includes(x.id)?hidden.filter(y=>x.id!==y):[...hidden,x.id])}/>{x.label}</label>)}
  </aside><section className="workspace-content calendar-content">
    <div className="page-heading"><div><p className="section-label">Kalendar</p><h1>{mode==='week'?`${start.toFormat('d. LLL')} – ${end.minus({days:1}).toFormat('d. LLL yyyy.')}`:day.toFormat('LLLL yyyy.')}</h1></div><div className="actions calendar-controls">
      <button className="icon secondary" aria-label="Prethodno" onClick={()=>setDay(day.minus(mode==='week'?{weeks:1}:{months:1}))}><ChevronLeft size={18}/></button>
      <button className="icon secondary" aria-label="Sljedeće" onClick={()=>setDay(day.plus(mode==='week'?{weeks:1}:{months:1}))}><ChevronRight size={18}/></button>
      <button className="secondary" onClick={()=>setDay(today())}>Danas</button><select aria-label="Prikaz" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="week">Tjedan</option><option value="month">Mjesec</option></select>
    </div></div>
    {error&&!form&&<p className="error">{error}</p>}
    <div className="calendar-scroll"><div className={'calendar-grid '+mode}>{range.map(x=>{
      const dayEvents=events.filter(event=>!hidden.includes(event.box??0)&&DateTime.fromISO(event.starts,{zone})<x.plus({days:1})&&DateTime.fromISO(event.ends,{zone})>x);
      return <div key={x.toISODate()} className={'calendar-cell '+(x.hasSame(today(),'day')?'today':'')+(x.month!==day.month?' other-month':'')}><button className="day-title" onClick={()=>newEvent(x)}>{mode==='week'?x.toFormat('ccc d.'):x.day}</button>
        {dayEvents.map(event=><button key={event.id} className={'calendar-event '+(event.box?'shared':'')} onClick={()=>{setSelected(event);setForm(undefined);}}><small>{DateTime.fromISO(event.starts,{zone}).toFormat('HH:mm')}</small> {event.title}</button>)}</div>;
    })}</div></div>
    {selected&&<div className="detail-card"><div className="reader-heading"><h2>{selected.title}</h2><button className="icon secondary" aria-label="Zatvori detalje" onClick={()=>setSelected(undefined)}><X size={17}/></button></div><p><CalendarDays size={17}/> {DateTime.fromISO(selected.starts,{zone}).setLocale('hr').toFormat('cccc, d. LLLL · HH:mm')} – {DateTime.fromISO(selected.ends,{zone}).toFormat('HH:mm')}</p><p><UsersRound size={17}/> {selected.attendees.join(', ')||'Nema sudionika'}</p><div className="actions"><button className="primary" onClick={()=>setForm(selected)}><Pencil size={16}/> Uredi događaj</button><a className="secondary" href={'/api/events/'+selected.id+'/ics'}><Download size={16}/> Pozivnica .ics</a></div></div>}
    {form&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Događaj"><div className="reader-heading"><h2>{form.id?'Uredi događaj':'Novi događaj'}</h2><button className="icon secondary" aria-label="Zatvori" onClick={()=>setForm(undefined)}><X size={18}/></button></div><form onSubmit={save}>
      <label>Naziv<input name="title" required defaultValue={form.title}/></label>
      <label>Kalendar<select name="box" defaultValue={form.box??''} disabled={!!form.id}><option value="">Osobni</option>{calendars.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select>{form.id&&<input type="hidden" name="box" value={form.box??''}/>}</label>
      <div className="form-grid"><label>Početak<input name="starts" type="datetime-local" required defaultValue={localDate(form.starts)}/></label><label>Završetak<input type="datetime-local" name="ends" required defaultValue={localDate(form.ends)}/></label></div>
      <label>Sudionici<input name="attendees" defaultValue={form.attendees?.join(', ')} placeholder="ana@primjer.test"/></label><small className="muted">Vremenska zona Europe/Zagreb</small>
      {error&&<p className="error" role="alert">{error}</p>}<button className="primary"><CalendarDays size={17}/> Spremi događaj</button>
    </form></section></div>}
  </section></main>;
}

export function Contacts({compose}:{compose:(address:string)=>void}){
  const [contacts,setContacts]=useState<Contact[]>([]),[search,setSearch]=useState(''),[editing,setEditing]=useState<Partial<Contact>>(),[error,setError]=useState('');
  async function load(){try{setContacts(await api<Contact[]>('/contacts?'+new URLSearchParams({q:search})));}catch(e){setError(toError(e));}}
  useEffect(()=>{const timer=setTimeout(()=>void load(),160);return ()=>clearTimeout(timer);},[search]);
  async function save(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');
    const data=new FormData(e.currentTarget);
    try{await api('/contacts'+(editing?.id?'/'+editing.id:''),editing?.id?'PUT':'POST',Object.fromEntries(data));setEditing(undefined);await load();}catch(e){setError(toError(e));}
  }
  return <main className="workspace-content wider"><div className="page-heading"><div><p className="section-label">Osobni adresar</p><h1>Kontakti</h1></div><button className="primary" onClick={()=>{setEditing({});setError('');}}><Plus size={18}/> Novi kontakt</button></div>
    <label className="search wide-search"><Search size={18}/><input aria-label="Pretraži kontakte" placeholder="Pretraži kontakte…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    {error&&!editing&&<p className="error">{error}</p>}
    <div className="contact-list">{contacts.map(x=><div className="contact-row" key={x.id}><span className="avatar">{initials(x.name)}</span><div><strong>{x.name}</strong><small>{x.email}</small></div><button className="icon secondary" aria-label={'Piši kontaktu '+x.name} onClick={()=>compose(x.email)}><Mail size={18}/></button><button className="icon secondary" aria-label={'Uredi '+x.name} onClick={()=>{setEditing(x);setError('');}}><Pencil size={17}/></button></div>)}
    {!contacts.length&&<div className="empty compact"><UsersRound size={25}/><p>Nema kontakata za prikaz.</p></div>}</div>
    {editing&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Kontakt"><div className="reader-heading"><h2>{editing.id?'Uredi kontakt':'Novi kontakt'}</h2><button className="icon secondary" aria-label="Zatvori" onClick={()=>setEditing(undefined)}><X size={18}/></button></div><form onSubmit={save}><label>Ime i prezime<input name="name" required defaultValue={editing.name}/></label><label>E-mail adresa<input type="email" name="email" required defaultValue={editing.email}/></label>{error&&<p className="error">{error}</p>}<button className="primary">Spremi kontakt</button></form></section></div>}
  </main>;
}

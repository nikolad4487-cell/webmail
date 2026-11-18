import {useEffect,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {CalendarDays,ChevronDown,Eye,EyeOff,LogOut,Mail,Settings,UsersRound,ArrowLeft,ShieldCheck} from 'lucide-react';
import {api,initials,toError,type Session} from './api';
import {Mailbox} from './mailbox';
import {Calendar,Contacts} from './organizer';
import {Admin} from './admin';
import {accountKinds,usesUsername,type AccountKind} from './account-kinds';
import './style.css';

function Brand(){return <span className="brand"><span className="brand-icon"><Mail size={22}/></span>Webmail<span>HR</span></span>}

function Login({onLogin,demo}:{onLogin:()=>Promise<void>;demo:boolean}){
  const reset=new URLSearchParams(location.search).get('reset');
  const [mode,setMode]=useState(reset?'reset':'login'),[visible,setVisible]=useState(false);
  const [kind,setKind]=useState<AccountKind>('staff');
  const username=usesUsername(kind);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const input=new FormData(event.currentTarget);
    setError('');setBusy(true);
    try{
      if(mode==='login'){
        await api('/login','POST',{kind,...(username?{username:input.get('username')}:{email:input.get('email')}),password:input.get('password'),remember:input.has('remember')});
        await onLogin();
      }else if(mode==='recover'){
        await api('/recover','POST',{email:input.get('email')});
        setNotice('Ako postoji potvrđena adresa za oporavak, primit ćete poveznicu.');
      }else{
        await api('/reset','POST',{key:reset,password:input.get('password')});
        history.replaceState(null,'','/');setMode('login');setKind('local');setNotice('Lozinka je promijenjena. Sada se možete prijaviti.');
      }
    }catch(e){setError(toError(e));}finally{setBusy(false);}
  }
  return <div className="login-page"><div className="login-shell"><Brand/><section className="login-card">
    <div className="login-symbol"><ShieldCheck size={24}/></div>
    <h1>{mode==='login'?'Prijava':mode==='recover'?'Oporavak lozinke':'Nova lozinka'}</h1>
    <p className="muted">{mode==='login'?'Pristupite svojim sandučićima i kalendaru.':mode==='recover'?'Unesite adresu svojeg računa.':'Odaberite lozinku od najmanje 12 znakova.'}</p>
    <form onSubmit={submit}>
      {mode==='login'&&<label>Vrsta računa<select value={kind} onChange={e=>{setKind(e.target.value as AccountKind);setVisible(false);setError('');setNotice('');}}>
        {[...accountKinds.slice(1),accountKinds[0]].map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>}
      {mode!=='reset'&&(mode==='login'&&username
        ? <label>Korisničko ime<input key={kind} name="username" autoComplete="username" maxLength={254} required/></label>
        : <label>E-mail adresa<input key={kind} type="email" name="email" placeholder="ime.prezime@skolehr.xyz" autoComplete="username" required/></label>)}
      {mode!=='recover'&&<label>{mode==='reset'?'Nova lozinka':'Lozinka'}<span className="password"><input key={mode+kind} type={visible?'text':'password'} name="password" placeholder="Unesite lozinku" autoComplete={mode==='reset'?'new-password':'current-password'} inputMode={mode==='login'&&kind==='staff'?'numeric':undefined} pattern={mode==='login'&&kind==='staff'?'[0-9]{8}':undefined} maxLength={mode==='login'&&kind==='staff'?8:512} minLength={mode==='reset'?12:1} required/><button type="button" className="icon ghost" aria-label={visible?'Sakrij lozinku':'Prikaži lozinku'} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button></span></label>}
      {mode==='login'&&<div className="login-options"><label className="check"><input type="checkbox" name="remember"/> Zapamti me</label>{kind==='local'&&<button type="button" className="link" onClick={()=>{setMode('recover');setError('');setNotice('');}}>Zaboravljena lozinka?</button>}</div>}
      {mode==='login'&&kind==='staff'&&<small>Osmeroznamenkastu lozinku izdaje administrator WebmailHR-a.</small>}
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="notice">{notice}</p>}
      <button className="primary" disabled={busy}>{busy?'Pričekajte…':mode==='login'?'Prijavi se':mode==='recover'?'Pošalji poveznicu':'Spremi lozinku'}</button>
    </form>
    {mode!=='login'&&<button className="link login-back" onClick={()=>{setMode('login');setError('');setNotice('');}}><ArrowLeft size={16}/> Povratak na prijavu</button>}
    {demo&&mode==='login'&&<button className="secondary demo-button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/login','POST',{kind:'local',email:'lena@formapoint.test',password:'Webmail-Test-2026'});await onLogin();}catch(e){setError(toError(e));}finally{setBusy(false);}}}>Otvori probni sandučić</button>}
  </section></div><div className="envelope-art" aria-hidden="true"><Mail strokeWidth={.45}/></div></div>;
}
const navigation=[{key:'mail',label:'Pošta',path:'/',icon:Mail},{key:'calendar',label:'Kalendar',path:'/kalendar',icon:CalendarDays},{key:'contacts',label:'Kontakti',path:'/kontakti',icon:UsersRound},{key:'admin',label:'Administracija',path:'/admin',icon:Settings}];
const getPage=()=>navigation.slice(1).find(x=>location.pathname.startsWith(x.path))?.key||'mail';
function App(){
  const [session,setSession]=useState<Session|null>(null),[loading,setLoading]=useState(true),[demo,setDemo]=useState(false),[page,setPage]=useState(getPage),[accountOpen,setAccountOpen]=useState(false),[recipient,setRecipient]=useState('');
  async function load(){setSession(await api<Session>('/me'));}
  useEffect(()=>{
    api<{demo:boolean}>('/health').then(x=>setDemo(x.demo)).catch(()=>{});
    load().catch(()=>{}).finally(()=>setLoading(false));
    const pop=()=>setPage(getPage());window.addEventListener('popstate',pop);return ()=>window.removeEventListener('popstate',pop);
  },[]);
  function open(key:string){
    history.pushState(null,'',navigation.find(x=>x.key===key)!.path);setPage(key);setAccountOpen(false);
  }
  if(loading)return <div className="loading"><Brand/></div>;
  if(!session)return <Login demo={demo} onLogin={load}/>;
  return <div className="application"><header className="topbar">
    <a href="/" onClick={e=>{e.preventDefault();open('mail');}}><Brand/></a>
    <nav aria-label="Glavna navigacija">{navigation.filter(x=>x.key!=='admin').map(({key,label,icon:Icon})=><button key={key} className={page===key?'active':''} onClick={()=>open(key)}><Icon size={18}/>{label}</button>)}</nav>
    <div className="account"><button className="account-button" onClick={()=>setAccountOpen(!accountOpen)} aria-expanded={accountOpen}><span className="avatar small">{initials(session.account.name)}</span><span className="account-name">{session.account.name}<small>{session.account.email}</small></span><ChevronDown size={15}/></button>
      {accountOpen&&<div className="account-menu">{session.account.role!=='user'&&<button onClick={()=>open('admin')}><Settings size={17}/> Administracija</button>}<button onClick={async()=>{await api('/logout','POST').catch(()=>{});setSession(null);setAccountOpen(false);history.replaceState(null,'','/');setPage('mail');}}><LogOut size={17}/> Odjavi se</button></div>}
    </div>
  </header>
  {page==='mail'&&<Mailbox session={session} recipient={recipient} clearRecipient={()=>setRecipient('')}/>}
  {page==='calendar'&&<Calendar boxes={session.boxes}/>}
  {page==='contacts'&&<Contacts compose={address=>{setRecipient(address);open('mail');}}/>}
  {page==='admin'&&session.account.role!=='user'&&<Admin session={session}/>}
  {page==='admin'&&session.account.role==='user'&&<p className="error">Nemate ovlast za administraciju.</p>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

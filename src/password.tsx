import {useState,type FormEvent} from 'react';
import {Eye,EyeOff,X} from 'lucide-react';
import {api,toError} from './api';

export function ChangePassword({close,changed,shared,student,staff}:{close:()=>void;changed:()=>void;shared:boolean;student:boolean;staff:boolean}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[visible,setVisible]=useState(false);
  async function save(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');
    const data=new FormData(e.currentTarget),password=String(data.get('newPassword'));
    if(password!==data.get('confirmation')){setError('Nove lozinke se ne podudaraju.');return;}
    setBusy(true);
    try{await api('/account/password','POST',{currentPassword:data.get('currentPassword'),newPassword:password});changed();}
    catch(e){setError(toError(e));}finally{setBusy(false);}
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
    <div className="reader-heading"><h2 id="change-password-title">Promijeni lozinku</h2><button type="button" className="icon secondary" aria-label="Zatvori" disabled={busy} onClick={close}><X size={18}/></button></div>
    <p>{student?'Nova lozinka vrijedi za e-Dnevnik i WebmailHR. Mora sadržavati malo i veliko slovo te broj.':shared?'Nova lozinka vrijedi za FormaPoint i WebmailHR i mora sadržavati malo i veliko slovo te broj.':staff?'Nova nastavnikova lozinka vrijedi samo za WebmailHR. PIN i autentifikator za e-Dnevnik ostaju nepromijenjeni.':'Odaberite novu lozinku za WebmailHR.'} Najmanje 8 znakova. Nakon spremanja prijavite se ponovno na svim uređajima.</p>
    <form onSubmit={save}>
      <label>Trenutna lozinka<input name="currentPassword" type="password" autoComplete="current-password" maxLength={512} required disabled={busy}/></label>
      <label>Nova lozinka<span className="password"><input name="newPassword" type={visible?'text':'password'} autoComplete="new-password" minLength={8} maxLength={512} required disabled={busy}/><button type="button" className="icon ghost" aria-label={visible?'Sakrij novu lozinku':'Prikaži novu lozinku'} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button></span></label>
      <label>Ponovite novu lozinku<input name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={512} required disabled={busy}/></label>
      {error&&<p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy?'Spremanje…':'Spremi novu lozinku'}</button>
    </form>
  </section></div>;
}

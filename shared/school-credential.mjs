import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {schoolAddress} from './school-address.mjs';
export async function schoolCredentialPdf(data,fonts){
 const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
 const regular=await pdf.embedFont(fonts.regular),bold=await pdf.embedFont(fonts.bold);
 const page=pdf.addPage([595.28,841.89]),ink=rgb(.12,.12,.12),gray=rgb(.94,.94,.94);
 page.drawEllipse({x:80,y:410,xScale:155,yScale:245,color:rgb(.97,.97,.97)});
 page.drawEllipse({x:585,y:645,xScale:220,yScale:205,color:gray});
 page.drawRectangle({x:33,y:754,width:529,height:60,color:rgb(.92,.92,.92)});
 const text=(value,x,y,size=10,font=regular)=>page.drawText(String(value??'—').replace(/[\r\n]+/g,' '),{x,y,size,font,color:ink,maxWidth:520});
 const fit=(value,max,font=regular,size=10)=>{let s=String(value??'—');while(s.length&&font.widthOfTextAtSize(s,size)>max)s=s.slice(0,-1);return s!==String(value??'—')?s.slice(0,-1)+'…':s;};
 text('ŠKOLEHR.XYZ',49,780,21,bold);
 text('PODACI O ELEKTRONIČKOM IDENTITETU',260,791,10,bold);
 text('U SUSTAVU ŠKOLEHR.XYZ',338,776,10,bold);
 const kind=data.kind==='student'?'Učenik':data.kind==='parent'?'Roditelj':'Nastavnik / djelatnik';
 text(kind.toUpperCase(),430,762,8);
 page.drawLine({start:{x:33,y:753},end:{x:562,y:753},thickness:2,color:ink});
 let y=714;
 function row(label,value){text(label,50,y,10,bold);text(fit(value,285),270,y,10);y-=23;}
 const address=data.address||data.email||'—';
 const date=value=>value&&/^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(8,10)+'.'+value.slice(5,7)+'.'+value.slice(0,4)+'.':value||'—';
 row('Ime i prezime',data.name);row('OIB',data.oib);row('Identifikator korisnika u ustanovi',address.split('@')[0]);row('Korisnička oznaka',address);
 row('Lozinka',data.password||'Postojeća lozinka e-Dnevnika');
 text(data.kind==='teacher'?'Samo za WebmailHR. PIN za e-Dnevnik je zaseban.':data.password?'Nova lozinka vrijedi za e-Dnevnik i WebmailHR.':'Postojeća lozinka se ne prikazuje i ne dohvaća.',270,y+7,8);y-=17;
 row('E-mail',address);row('Datum rođenja',date(data.dob));row('Spol',data.gender);
 y-=9;page.drawLine({start:{x:33,y},end:{x:562,y},thickness:.5,color:rgb(.65,.65,.65)});y-=29;
 row('Povezanost s ustanovom',kind);row('Temeljna povezanost s ustanovom',kind);row('Datum isteka povezanosti',date(data.validUntil));
 y-=14;page.drawLine({start:{x:33,y},end:{x:562,y},thickness:.5,color:rgb(.65,.65,.65)});y-=30;
 const school=data.school||{},location=schoolAddress(school);
 row('Naziv matične ustanove',school.name);row('Oznaka matične ustanove',school.code||school.sourceId||school.id);row('Poštanska adresa',location.address);row('Mjesto (lokalitet)',location.city?('HR-'+location.city):null);row('Poštanski broj',location.postal?('HR-'+location.postal):null);
 page.drawLine({start:{x:33,y:116},end:{x:562,y:116},thickness:.5,color:rgb(.65,.65,.65)});
 text('Podaci za prijavu',50,93,10,bold);text('WebmailHR: https://www.webmailhr.com/',50,76,9);
 text(data.kind==='teacher'?'Lozinku za mail možete promijeniti u postavkama WebmailHR profila.':data.kind==='parent'?'Za promjenu roditeljske lozinke obratite se administratoru ustanove.':'Nova učenička lozinka izdaje se u e-Matici. U WebmailHR-u se ne mijenja.',50,60,8);
 text('Podatke identiteta uređuje administrator Vaše ustanove.',50,44,8);
 pdf.setTitle('Podaci o elektroničkom identitetu — ŠkoleHR');pdf.setAuthor('ŠkoleHR');
 return pdf.save();
}

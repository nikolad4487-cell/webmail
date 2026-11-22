// Legacy school.address may contain contact metadata. Only these address fields
// belong in the credential document; never stringify the whole record.
const value=x=>typeof x==='string'?x.trim().normalize('NFC'):'';
export function schoolAddress(school={}){
 let raw=school.address,meta={};
 if(typeof raw==='string'&&/^[\s]*[\[{]/.test(raw)){
  try{raw=JSON.parse(raw);}catch{raw=null;}
 }
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)){meta=raw;raw=meta.address;}
 const street=value(raw),postal=value(school.postal_code||school.postalCode||meta.postal_code||meta.postalCode||meta.zip).replace(/^HR-/i,''),city=value(school.city||meta.city).replace(/^HR-/i,'');
 const locality=[postal,city].filter(Boolean).join(' ');
 const address=!street?'':!locality?street:street.includes(locality)?street:street.includes(postal)&&postal?street+(city&&!street.includes(city)?' '+city:''):street+', '+locality;
 return {address,city,postal};
}

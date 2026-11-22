// Some imports put a UI option label ("Name | email") in the name field.
// Strip only a complete, recognizable email suffix, never arbitrary name text.
export function schoolIdentityName(raw:string){
 const match=raw.trim().match(/^(.+?)\s*[|｜]\s*([a-z0-9.!#$%&'*+/=?^_`{}~-]+@[a-z0-9.-]+\.[a-z]{2,})\s*$/i);
 return (match?match[1]:raw).trim().replace(/\s+/g,' ');
}
const compact=(value:string)=>value.toLowerCase().replace(/đ/g,'d').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
export function malformedSchoolAddress(address:string,rawName:string){
 return schoolIdentityName(rawName)!==rawName.trim()&&address.endsWith('@skolehr.xyz')&&
  address.split('@')[0]===compact(rawName);
}

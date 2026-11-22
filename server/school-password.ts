import {randomInt} from 'node:crypto';
export function generateSchoolPassword(){
 const lower='abcdefghijklmnopqrstuvwxyz',upper=lower.toUpperCase(),digits='0123456789',all=lower+upper+digits;
 const value=[lower[randomInt(lower.length)],upper[randomInt(upper.length)],digits[randomInt(digits.length)],...Array.from({length:5},()=>all[randomInt(all.length)])];
 for(let i=value.length-1;i>0;i--){const j=randomInt(i+1);[value[i],value[j]]=[value[j],value[i]];}
 return value.join('');
}

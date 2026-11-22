import {test} from 'node:test';
import assert from 'node:assert/strict';
import {schoolAddress} from '../../shared/school-address.mjs';
test('Postal address prints only street, postcode and city from legacy metadata',()=>{
 const fields={address:'Palmotićeva 84',postal_code:'10000',city:'Zagreb',oib:'00000000000',phone:'private'};
 for(const address of [fields,JSON.stringify(fields)])assert.deepEqual(schoolAddress({address}),{address:'Palmotićeva 84, 10000 Zagreb',postal:'10000',city:'Zagreb'});
 assert.equal(schoolAddress({address:'Palmotićeva 84',postal_code:'10000',city:'Zagreb'}).address,'Palmotićeva 84, 10000 Zagreb');
 assert.equal(schoolAddress({address:'Palmotićeva 84, 10000 Zagreb',postal_code:'10000',city:'Zagreb'}).address,'Palmotićeva 84, 10000 Zagreb');
 for(const address of [null,undefined,'','  ',JSON.stringify({oib:'private',phone:'private'}),'{invalid}',[]])assert.equal(schoolAddress({address,city:'Zagreb',postal_code:'10000'}).address,'');
 assert.equal(schoolAddress({address:'Palmotićeva 84'}).address,'Palmotićeva 84');
});

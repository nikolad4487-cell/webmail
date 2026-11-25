import {test} from 'node:test';import assert from 'node:assert/strict';
import {imapBatch,imapEmpty} from '../../server/mail-actions.ts';
function fake(uidplus=true){let path;const changes=[];const client={capabilities:new Set(uidplus?['UIDPLUS']:[]),list:async()=>[{path:'Deleted Items',specialUse:'\\Trash'},{path:'Spam',specialUse:'\\Junk'}],getMailboxLock:async p=>{path=p;return {release(){}};},search:async search=>search.uid.split(',').map(Number),messageDelete:async(range,options)=>{changes.push({path,range,options});return true;},messageMove:async(range,destination,options)=>{changes.push({path,range,destination,options});return true;},messageFlagsAdd:async(range,flags,options)=>{changes.push({path,range,flags,options});return true;}};return {client,changes};}
test('IMAP permanent deletion uses precise UIDs grouped by the actual special folder',async()=>{
 const {client,changes}=fake();const result=await imapBatch(client,'delete',[{id:1,path:'Deleted Items'},{id:2,path:'Deleted Items'},{id:1,path:'Spam'}]);assert.equal(result.affected,3);assert.deepEqual(changes,[{path:'Deleted Items',range:'1,2',options:{uid:true}},{path:'Spam',range:'1',options:{uid:true}}]);
});
test('IMAP rejects a destructive mixed folder selection and unsafe expunge before changing flags',async()=>{
 for(const [client,items] of [[fake().client,[{id:1,path:'INBOX'}]],[fake(false).client,[{id:1,path:'Spam'}]]])await assert.rejects(imapBatch(client,'delete',items),error=>[403,409].includes(error.status));
 const {client,changes}=fake();client.search=async()=>[];await assert.rejects(imapBatch(client,'trash',[{id:1,path:'INBOX'}]),error=>error.status===404);assert.deepEqual(changes,[]);
});

test('IMAP empty resolves the Trash folder and deletes its complete UID snapshot with a compact range',async()=>{
 const {client,changes}=fake(false);client.search=async search=>{assert.equal(search.all,true);return [1,3,9];};
 const result=await imapEmpty(client,'trash');assert.equal(result.affected,3);assert.deepEqual(changes,[{path:'Deleted Items',range:'1:9',options:{uid:true}}]);
});

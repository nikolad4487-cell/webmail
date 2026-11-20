import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MigrationFailure,migrationFailureMessage,runMigrationQueries} from '../../scripts/migration-diagnostics.ts';
const denied=message=>Object.assign(new Error(message),{code:'42501'});
test('Distinguishes denied advisory lock, base schema and native schema without continuing',async()=>{
  for(const [failed,stage] of [[0,'lock'],[1,'schema'],[2,'native'],[3,'passwords'],[4,'provisioning']]){
    let calls=0;
    await assert.rejects(runMigrationQueries({query:async()=>{if(calls++===failed)throw denied('permission denied for schema public');}},'BASE','NATIVE','PASSWORDS','PROVISIONING'),error=>{
      assert.ok(error instanceof MigrationFailure);assert.equal(error.stage,stage);assert.equal(error.code,'42501');
      assert.match(migrationFailureMessage(error),/shema public/);return true;
    });
    assert.equal(calls,failed+1);
  }
});
test('Reports recognized permission targets and ownership with a suitable next step',()=>{
  assert.match(migrationFailureMessage(new MigrationFailure('native',denied('restricted superuser cannot grant or revoke privileges'))),/Servis zabranjuje GRANT\/REVOKE/);
  const lock=migrationFailureMessage(new MigrationFailure('lock',denied('permission denied for function pg_advisory_xact_lock')));
  assert.match(lock,/funkcija pg_advisory_xact_lock/);assert.match(lock,/Migracija nije pokrenuta/);
  const owner=migrationFailureMessage(new MigrationFailure('native',denied('must be owner of table mailboxes')));
  assert.match(owner,/vlasnik: tablica mailboxes/);assert.match(owner,/MIGRATION_DATABASE_URL/);
});
test('Does not expose unrecognized messages, SQL, credentials, error detail or context',()=>{
  const secret='postgresql://private:secret@db.example.test/webmail';
  const error=Object.assign(denied('permission denied for table '+secret),{detail:secret,where:secret,query:secret});
  const output=migrationFailureMessage(new MigrationFailure('schema',error));
  assert.ok(!output.includes(secret));assert.ok(!output.includes('private:secret'));assert.match(output,/42501/);
  const malformed=migrationFailureMessage({code:secret,message:secret});assert.ok(!malformed.includes(secret));
});
test('Successful migration preserves lock, base and native query order',async()=>{
  const calls=[];await runMigrationQueries({query:async sql=>{calls.push(sql);}},'BASE','NATIVE');
  assert.equal(calls.length,3);assert.match(calls[0],/pg_advisory_xact_lock/);assert.deepEqual(calls.slice(1),['BASE','NATIVE']);
});

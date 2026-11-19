import type {PoolClient} from 'pg';

export type MigrationStage='connection'|'lock'|'schema'|'native';
const stages:Record<MigrationStage,string>={connection:'spajanje na bazu',lock:'zaključavanje migracije',schema:'osnovna shema',native:'pohrana poruka i privitaka'};
const objects:Record<string,string>={schema:'shema',table:'tablica',sequence:'sekvenca',function:'funkcija',database:'baza',relation:'relacija'};

// Only recognize PostgreSQL permission messages with simple identifiers. Never log arbitrary
// driver messages, SQL text, connection strings, error detail or server context.
export function permissionDiagnostic(error:unknown){
  const message=error instanceof Error?error.message:'';
  const denied=/^permission denied for (schema|table|sequence|function|database|relation) ([a-zA-Z_][a-zA-Z0-9_.]*)(?:\(\))?$/.exec(message);
  if(denied)return `Nedostaje ovlast: ${objects[denied[1]]} ${denied[2]}.`;
  const owner=/^must be owner of (table|sequence|function|database|relation|schema) ([a-zA-Z_][a-zA-Z0-9_.]*)$/.exec(message);
  if(owner)return `Migraciju mora izvršiti vlasnik: ${objects[owner[1]]} ${owner[2]}.`;
  return '';
}
export class MigrationFailure extends Error{
  readonly code:string;
  readonly permission:string;
  constructor(readonly stage:MigrationStage,error:unknown){
    super('Migration failed');
    const code=(error as {code?:unknown}|null)?.code;
    this.code=typeof code==='string'&&/^[A-Z0-9_]{1,32}$/.test(code)?code:'';
    this.permission=this.code==='42501'?permissionDiagnostic(error):'';
  }
}
export function migrationFailureMessage(error:unknown){
  const failed=error instanceof MigrationFailure?error:new MigrationFailure('connection',error);
  const code=failed.code?` (${failed.code})`:'';
  const hint=failed.code==='42501'
    ? failed.stage==='lock'
      ? 'Provjerite dopušta li servis pg_advisory_xact_lock. Migracija nije pokrenuta.'
      : 'Za izmjene sheme koristite MIGRATION_DATABASE_URL s ovlastima vlasnika iste baze; DATABASE_URL aplikacije ne mijenjajte.'
    : 'Provjerite vezu i ovlasti PostgreSQL korisnika.';
  return `WebmailHR: migracija nije uspjela${code}. Korak: ${stages[failed.stage]}. ${failed.permission} ${hint}`.replace(/ +/g,' ');
}
export async function runMigrationQueries(client:Pick<PoolClient,'query'>,schema:string,native:string){
  const steps:[MigrationStage,string][]=[['lock',"select pg_advisory_xact_lock(hashtext('webmailhr.schema'))"],['schema',schema],['native',native]];
  for(const [stage,sql] of steps){
    try{await client.query(sql);}
    catch(error){throw new MigrationFailure(stage,error);}
  }
}

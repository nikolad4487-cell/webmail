import {migrationFailureMessage} from './migration-diagnostics.js';
if(process.env.WEBMAIL_MIGRATE_ON_BUILD==='1'){
  if(process.env.VERCEL_ENV!=='production'){
    console.log('WebmailHR: migracija je preskočena izvan produkcijske objave.');
  }else{
    const migrationUrl=process.env.MIGRATION_DATABASE_URL?.trim();
    if(migrationUrl) process.env.DATABASE_URL=migrationUrl;
    if(!process.env.DATABASE_URL?.trim()){
      console.error('WebmailHR: postavite DATABASE_URL ili MIGRATION_DATABASE_URL za migraciju.');
      process.exitCode=1;
    }else{
      try{
        await import('./database.js');
        console.log('WebmailHR: migracije su primijenjene.');
      }catch(error){
        console.error(migrationFailureMessage(error));
        process.exitCode=1;
      }
    }
  }
}

export {};

import {migrationFailureMessage} from './migration-diagnostics.js';
if(['1','identity'].includes(process.env.WEBMAIL_MIGRATE_ON_BUILD||'')){
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
        if(process.env.WEBMAIL_MIGRATE_ON_BUILD==='identity'){
          const {readFile}=await import('node:fs/promises');
          const {db}=await import('../server/db.js');
          try{await db.query(await readFile(new URL('../server/migrations/20261120-electronic-identity.sql',import.meta.url),'utf8'));}
          finally{await db.end();}
        }else await import('./database.js');
        console.log('WebmailHR: migracije su primijenjene.');
      }catch(error){
        console.error(migrationFailureMessage(error));
        process.exitCode=1;
      }
    }
  }
}

export {};

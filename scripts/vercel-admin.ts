import {AdministratorSetupError,createAdministrator,rotateAdministratorPassword} from './administrator.js';

if(process.env.WEBMAIL_ADMIN_SETUP==='1'){
  if(process.env.VERCEL_ENV!=='production'){
    console.log('WebmailHR: postavljanje administratora je preskočeno izvan produkcijske objave.');
  }else{
    const password=process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    if(!password || password.length<8 || password.length>512){
      console.error('WebmailHR: postavite novu tajnu ADMIN_PASSWORD od najmanje osam znakova.');
      process.exitCode=1;
    }else if(!process.env.DATABASE_URL?.trim()){
      console.error('WebmailHR: postavite produkcijski DATABASE_URL za postavljanje administratora.');
      process.exitCode=1;
    }else{
      const {db,hashPassword,transaction}=await import('../server/db.js');
      try{
        const email='admin@webmailhr.com';
        const passwordHash=await hashPassword(password);
        const action=await transaction(async client=>{
          await client.query('lock table users in share row exclusive mode');
          if((await client.query('select 1 from users where email=$1',[email])).rowCount){
            await rotateAdministratorPassword(client,email,passwordHash);
            return 'Administratorska lozinka je postavljena. Prethodne sesije su opozvane.';
          }
          const {rows:[domain]}=await client.query("select o.name from domains d join organizations o on o.id=d.org where d.name='webmailhr.com'");
          await createAdministrator(client,{email,name:'Glavni administrator',organization:domain?.name??'WebmailHR',passwordHash});
          return 'Glavni administrator je kreiran.';
        });
        console.log('WebmailHR: '+action);
      }catch(error){
        const message=error instanceof AdministratorSetupError?error.message:'Provjerite migracije i ovlasti PostgreSQL korisnika.';
        console.error('WebmailHR: postavljanje administratora nije uspjelo. '+message);
        process.exitCode=1;
      }finally{
        await db.end();
      }
    }
  }
}

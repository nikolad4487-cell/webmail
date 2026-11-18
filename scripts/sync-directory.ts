import {db} from '../server/db.js';
import {directoryConfig,directoryPeople,type DirectorySource} from '../server/directory-source.js';
import {DirectoryConflict,mailcowDirectoryConfig,provisionPersonalMailbox,syncDirectoryPerson} from '../server/directory-sync.js';

try{
  const source=process.argv[2];
  if(source!=='ednevnik' && source!=='formapoint')throw new Error('Koristite npm run directory:sync -- ednevnik ili formapoint.');
  if(!process.env.DATABASE_URL?.trim())throw new Error('DATABASE_URL nije postavljen.');
  const config=directoryConfig(source satisfies DirectorySource);
  const people=await directoryPeople(config);
  const collisions=new Map<string,number>();
  for(const person of people)collisions.set(person.address,(collisions.get(person.address)||0)+1);
  console.log(`WebmailHR: izvor ${source}, prihvatljivih korisnika ${people.length}.`);
  if(!process.argv.includes('--apply')){
    console.log('WebmailHR: pregled završen. Za primjenu dodajte --apply.');
  }else{
    const mail=mailcowDirectoryConfig();
    let activated=0,existing=0,failed=0;
    for(const person of people){
      try{
        if((collisions.get(person.address)??0)>1)throw new DirectoryConflict('Više izvornih korisnika traži istu adresu.');
        if(await syncDirectoryPerson(config,person,(address,name,password)=>provisionPersonalMailbox(mail,address,name,password)))activated++;
        else existing++;
      }catch(error){
        failed++;
        console.error(`WebmailHR: zapis ${person.subject}: ${error instanceof DirectoryConflict?error.message:'Sinkronizacija nije uspjela.'}`);
      }
    }
    console.log(`WebmailHR: novootvorenih ${activated}, postojećih ${existing}, neuspjelih ${failed}.`);
    if(failed)process.exitCode=1;
  }
}catch(error){
  console.error('WebmailHR: skupna sinkronizacija nije pokrenuta. Provjerite konfiguraciju i dostupnost izvora.');
  if(error instanceof Error && /^(Koristite|DATABASE_URL|e-Dnevnik i FormaPoint moraju|Poštanska domena|Potrebni su|Izvor nije)/.test(error.message)){
    console.error(error.message);
  }
  process.exitCode=1;
}finally{
  await db.end();
}

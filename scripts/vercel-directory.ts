import {spawnSync} from 'node:child_process';

const setting=process.env.WEBMAIL_DIRECTORY_SYNC;
if(setting && process.env.VERCEL_ENV==='production'){
  const sources=setting==='both'?['ednevnik','formapoint']:[setting];
  if(sources.some(source=>source!=='ednevnik' && source!=='formapoint')){
    console.error('WebmailHR: WEBMAIL_DIRECTORY_SYNC mora biti ednevnik, formapoint ili both.');
    process.exitCode=1;
  }else{
    for(const source of sources){
      const result=spawnSync(process.execPath,['--import','tsx','scripts/sync-directory.ts',source,'--apply'],{stdio:'inherit'});
      if(result.status!==0){
        process.exitCode=1;
        break;
      }
    }
  }
}

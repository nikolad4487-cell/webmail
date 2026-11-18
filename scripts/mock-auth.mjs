// Local protocol fixtures for integration tests. Both listeners bind to loopback.
import {createServer} from 'node:http';
const initialPassword='Source-Test-2026';
const userPattern=/^shared-[a-f0-9-]{36}$/;

for(const [kind,port] of [['ednevnik',3014],['formapoint',3015]]){
  const passwords=new Map(), ids=new Map();
  createServer(async (req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    try{
      if(req.method!=='POST')return send(405,{});
      const parts=[];
      for await(const chunk of req)parts.push(chunk);
      const input=JSON.parse(Buffer.concat(parts).toString());
      const valid=(username,password)=>userPattern.test(username) && password===(passwords.get(username)??initialPassword);
      const path=req.url;
      if(path==='/_test/change-password'){
        if(!valid(input.username,input.oldPassword))return send(401,{});
        passwords.set(input.username,input.newPassword);
        return send(200,{ok:true});
      }
      if(path==='/_test/set-auth-id'){
        if(!userPattern.test(input.username))return send(400,{});
        ids.set(input.username,input.id);
        return send(200,{ok:true});
      }
      if(kind==='ednevnik' && path==='/api/auth/webmail/student'){
        if(req.headers.authorization!=='Bearer ednevnik-test-bearer-token-only-local')return send(401,{});
        return valid(input.username,input.password)?send(200,{user_id:input.username}):send(401,{});
      }
      if(kind==='formapoint' && path==='/auth/v1/token?grant_type=password'){
        if(req.headers.apikey!=='formapoint-test-auth')return send(403,{});
        const username=input.email?.endsWith('@source.formapoint.test')?input.email.split('@')[0]:'';
        return valid(username,input.password)?send(200,{user:{id:ids.get(username)??username},access_token:'fixture-token'}):send(400,{});
      }
      return send(404,{});
    }catch{return send(400,{});}
  }).listen(port,'127.0.0.1');
}

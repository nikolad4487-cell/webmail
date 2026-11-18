import express from 'express';
import {createServer as createHttpServer} from 'node:http';
import {resolve} from 'node:path';
import app from './app';

const server=createHttpServer(app);
if(process.env.NODE_ENV==='production'){
  app.use(express.static(resolve('dist')));
  app.get(/.*/,(_req,res)=>res.sendFile(resolve('dist/index.html')));
}else{
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true,allowedHosts:true,ws:{server}},appType:'spa'});
  app.use(vite.middlewares);
}
server.listen(Number(process.env.PORT || 3000),'0.0.0.0');

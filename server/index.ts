import express from 'express';
import {createServer as createHttpServer} from 'node:http';
import {existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import app from './app.js';
import service from './service.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const production=process.env.NODE_ENV==='production';
// Built output (Prisma Compute and `prisma dev` run dist/index.js): the Vite
// SPA build sits beside this file, so serve it statically from there.
const built=existsSync(resolve(here,'index.html'));
const server=createHttpServer(app);
if(built){
  app.use(express.static(here));
  app.get(/.*/,(_req,res)=>res.sendFile(resolve(here,'index.html')));
}else if(production){
  app.use(express.static(resolve('dist')));
  app.get(/.*/,(_req,res)=>res.sendFile(resolve('dist/index.html')));
}else{
  // `npm run dev`: Vite middleware in front of the API. Loaded through a
  // variable so the deploy's dependency trace of the built output never
  // stages Vite.
  const viteSpecifier='vite';
  const {createServer}=await import(viteSpecifier);
  const vite=await createServer({server:{middlewareMode:true,allowedHosts:true,ws:{server}},appType:'spa'});
  app.use(vite.middlewares);
}
// The platform exports the service's reserved port as PORT; service.port()
// resolves the same reserved port when PORT is not set.
server.listen(Number(process.env.PORT || service.port()),'0.0.0.0');

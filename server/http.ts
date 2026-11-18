import {type Request} from 'express';
import {z} from 'zod';
import {HttpError} from './mail';
export const email=z.string().trim().toLowerCase().email().max(254);
export const id=z.coerce.number().int().positive();
export const text=z.string().trim().min(1).max(240);
export type User={id:number;org:number;name:string;email:string;role:string};
export const user=(req:Request)=> (req as Request & {account:User}).account;
export const deny=()=>{throw new HttpError(403,'Nemate ovlast za ovu radnju.');};

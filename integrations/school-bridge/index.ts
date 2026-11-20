import {schoolBridge} from './handler.ts';
const tokenHash='836444f71a6d1cbd641c716ab5a0aaf685f0a3db048d446b7525dfb6125f98f8';
Deno.serve(schoolBridge({url:Deno.env.get('SUPABASE_URL')!,key:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,tokenHash,
  origins:['https://ematica.skolehr.xyz','https://e-matica.skolehr.xyz','https://matica.skolehr.xyz']}));

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { invariant } from './errors';
import { digest } from './utils';

/** Source identity, not a claim that a hot-reloader has loaded exactly these bytes. */
export function localSourceRevision(projectRoot:string):string {
  const root=resolve(/* turbopackIgnore: true */ projectRoot),files:{path:string;sha256:string}[]=[];
  const read=(path:string)=>{
    const stat=lstatSync(path);
    invariant(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024,'CONFIGURATION','Local release source is invalid',503);
    files.push({path:relative(root,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(/* turbopackIgnore: true */ path)).digest('hex')});
  };
  const walk=(path:string)=>{
    const stat=lstatSync(path);
    invariant(stat.isDirectory()&&!stat.isSymbolicLink(),'CONFIGURATION','Local release source is invalid',503);
    for(const name of readdirSync(/* turbopackIgnore: true */ path).sort()){
      const entry=join(path,name),info=lstatSync(entry);
      invariant(!info.isSymbolicLink(),'CONFIGURATION','Local release source cannot contain symlinks',503);
      if(info.isDirectory())walk(entry);else if(name.endsWith('.ts'))read(entry);
      invariant(files.length<=1000,'CONFIGURATION','Local release source exceeds its bound',503);
    }
  };
  try{
    walk(join(root,'lib'));read(join(root,'package-lock.json'));
    const api=join(root,'app','api');if(existsSync(api))walk(api);
    for(const entry of ['middleware.ts','proxy.ts','src/middleware.ts','src/proxy.ts']){const path=join(/* turbopackIgnore: true */ root,entry);if(existsSync(/* turbopackIgnore: true */ path))read(path);}
  }
  catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='CONFIGURATION')throw error;invariant(false,'CONFIGURATION','Local release sources are unavailable',503);}
  return `local-sha256:${digest({files:files.sort((a,b)=>a.path.localeCompare(b.path)),epoch:process.env.BIZTANIA_RELEASE_REVISION?.trim()||undefined})}`;
}
export function releaseRevision():string {
  if(process.env.VERCEL==='1'){
    const sha=process.env.VERCEL_GIT_COMMIT_SHA?.trim();
    invariant(sha&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha),'CONFIGURATION','Deployment Git release identity is required',503);
    return `git:${sha.toLowerCase()}`;
  }
  return localSourceRevision(process.cwd());
}

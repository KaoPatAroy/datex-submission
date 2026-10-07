import { existsSync, lstatSync, realpathSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateDatabasePath(rawPath:string):string {
  const path=resolve(rawPath),rel=relative(resolve(tmpdir()),path);
  if(rel===''||rel==='..'||rel.startsWith(`..${sep}`)||rel.includes(sep)||!/^nexus-playwright-[0-9a-f-]{36}\.sqlite$/i.test(rel))throw new Error('E2E database must be a dedicated temporary UUID file.');
  if(existsSync(path)){
    const stat=lstatSync(path),realRel=relative(resolve(tmpdir()),realpathSync(path));
    if(!stat.isFile()||stat.isSymbolicLink()||realRel!==rel)throw new Error('E2E database must be a regular private file, never a symlink.');
  }
  return path;
}
export function selectDatabasePath(inheritedPath:string|undefined,workerIndex:string|undefined,hasRunnerIpc=false):string {
  if(workerIndex!==undefined){if(!hasRunnerIpc)throw new Error('Refusing spoofed E2E worker metadata.');if(!inheritedPath)throw new Error('E2E worker has no inherited private database.');return validateDatabasePath(inheritedPath);}
  if(inheritedPath)throw new Error('Refusing externally supplied E2E database before starting the server.');
  const path=validateDatabasePath(join(tmpdir(),`nexus-playwright-${randomUUID()}.sqlite`));
  if(existsSync(path))throw new Error('E2E database must be fresh.');
  closeSync(openSync(path,'wx'));
  return path;
}

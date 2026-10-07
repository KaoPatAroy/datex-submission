import { describe,it,expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { selectDatabasePath,validateDatabasePath } from './e2e/database-path';

describe('private E2E database boundary',()=>{
  it('rejects an external database before a server can open it',()=>{
    expect(()=>selectDatabasePath(join(process.cwd(),'.local','demo.sqlite'),undefined)).toThrow();
    expect(()=>validateDatabasePath(join(process.cwd(),'.local','demo.sqlite'))).toThrow();
  });
  it('creates a fresh parent path and permits only its dedicated temporary worker path',()=>{
    const path=selectDatabasePath(undefined,undefined);
    expect(selectDatabasePath(path,'0',true)).toBe(path);
    expect(()=>selectDatabasePath(path,'0')).toThrow('spoofed');
    expect(()=>selectDatabasePath(path,undefined)).toThrow();
    expect(()=>selectDatabasePath(join(tmpdir(),'ordinary.sqlite'),'0')).toThrow();
    expect(()=>selectDatabasePath(undefined,'0')).toThrow();
    rmSync(validateDatabasePath(path));
  });
});

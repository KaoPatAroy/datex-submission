import 'server-only';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SeedData, Store, Table } from '../contracts';
import { DomainError } from '../core/errors';
import { createSqliteStore } from './sqlite';
import { withCommitConflictRetry } from './conflict-retry';
import { createSupabaseStore } from './supabase';
import type { WorkflowStoreCapability } from './workflow-projections';
import type { WorkflowV2SeedResult } from '../seed/workflow-v2';
import { getStorageFailureMetadata } from './read-error';

let storePromise:Promise<Store>|undefined;
let workflowV2BootstrapResult:WorkflowV2SeedResult|null=null;

export function isWorkflowV2Enabled():boolean {
  return process.env.WORKFLOW_V2_ENABLED==='true';
}

function hasWorkflowStoreCapability(store:Store):store is Store&WorkflowStoreCapability {
  return 'workflowContractVersion' in store && store.workflowContractVersion===2 &&
    'workflowProjectionReader' in store && typeof store.workflowProjectionReader==='object' && store.workflowProjectionReader!==null &&
    'get' in store.workflowProjectionReader && typeof store.workflowProjectionReader.get==='function' &&
    'query' in store.workflowProjectionReader && typeof store.workflowProjectionReader.query==='function' &&
    'workflowTransaction' in store && typeof store.workflowTransaction==='function';
}

async function initializeWorkflowV2Bootstrap(store:Store,businessDate:string,seedData:SeedData):Promise<WorkflowV2SeedResult> {
  if(!hasWorkflowStoreCapability(store))throw new DomainError('WORKFLOW_UNAVAILABLE','Guarded workflow storage is unavailable',503);
  const workflowV2=await import('../seed/workflow-v2');
  const plan=workflowV2.prepareWorkflowV2SeedPlan(seedData,{seed:1,businessDate});
  // Demo Director queue: the seeded requests reach Director approval only through the REAL V2 manager approval path (injected advancer),
  // never by writing director-pending rows. Local demo data always; hosted only with the explicit WORKFLOW_V2_DEMO_QUEUE=true release opt-in.
  const demoQueue=process.env.USE_LOCAL_DEMO_DATA==='true'||process.env.WORKFLOW_V2_DEMO_QUEUE==='true';
  const server={store,...(demoQueue?{advanceManagerApprovals:(await import('../seed/workflow-v2-manager-advance')).createSeedManagerApprovalAdvancer(store)}:{})};
  let result:WorkflowV2SeedResult;
  try {
    result=await workflowV2.persistWorkflowV2SeedPlan(server,plan,demoQueue?{advanceManagerRequestIds:[plan.identities.onboardingRequestIds[0]]}:{});
  } catch(error) {
    console.error('Workflow V2 bootstrap failed',{phase:'seed_plan',code:error instanceof DomainError?error.code:'STORAGE',...getStorageFailureMetadata(error)});
    throw error;
  }
  if(result.state!=='source_ready'||!result.bootstrapReady) {
    const phase=plan.phases.find(phase=>phase.phase===result.failedPhase);
    const tables=result.blockedTables.length?result.blockedTables:[...new Set(phase?.rows.map(row=>row.table)??[])].sort();
    console.error('Workflow V2 bootstrap failed',{state:result.state,phase:result.failedPhase??'seed_preflight',tables,code:result.failureCode??'WORKFLOW_UNAVAILABLE',...result.failureMetadata});
    throw new DomainError('WORKFLOW_UNAVAILABLE','Workflow V2 bootstrap is not ready',503);
  }
  if(demoQueue) {
    try { await workflowV2.persistWorkflowV2DemoQueue(server,plan,{advance:true}); }
    catch(error) {
      console.error('Workflow V2 bootstrap failed',{phase:'demo_queue',code:error instanceof DomainError?error.code:'STORAGE',...getStorageFailureMetadata(error)});
      throw error;
    }
  }
  return result;
}

async function preflightEmptyLegacySeedTables(store:Store,seedData:SeedData):Promise<void> {
  if((await store.list('profiles')).length)return;
  const populatedTables:string[]=[];
  for(const table of Object.keys(seedData) as (keyof SeedData)[]) {
    if(table==='profiles')continue;
    if((await store.list(table)).length>0)populatedTables.push(table);
  }
  if(populatedTables.length)throw new DomainError('WORKFLOW_UNAVAILABLE',`Workflow V2 bootstrap found partial legacy seed data in ${populatedTables.join(', ')}`,503);
}

async function ensureDemoProfilesIfEnabled(store:Store,seedData?:SeedData):Promise<void> {
  const {demoProfileRepairEnabled,ensureMissingDemoProfiles,ENSURABLE_DEMO_PROFILE_IDS}=await import('../seed/ensure-demo-profiles');
  if(!demoProfileRepairEnabled())return;
  // Cheap presence check first: the seed fixture is only generated when a demo profile is actually missing.
  if((await Promise.all(ENSURABLE_DEMO_PROFILE_IDS.map(id=>store.get('profiles',id)))).every(Boolean))return;
  await ensureMissingDemoProfiles(store,seedData??await import('../seed/generate').then(({createSeedData})=>createSeedData(process.env.DEMO_BUSINESS_DATE??'2026-10-01')));
}

export async function seedStore(store:Store,businessDate:string,seedData?:SeedData):Promise<void> {
  if((await store.list('profiles')).length)return;
  const seed:SeedData=seedData??await import('../seed/generate').then(({createSeedData})=>createSeedData(businessDate));
  // Mark identities last, so an interrupted setup never looks completely seeded.
  for(const [name,records] of Object.entries(seed).filter(([name])=>name!=='profiles'))for(let offset=0;offset<records.length;offset+=500)await store.transaction(async tx=>{for(const row of records.slice(offset,offset+500))await tx.put(name as Table,row);});
  await store.transaction(async tx=>{for(const profile of seed.profiles)await tx.put('profiles',profile);});
}
export async function getStore():Promise<Store> {
  if(!storePromise) {
    let ownedSqliteStore:Store|undefined;
    storePromise=(async()=>{
      const local=process.env.USE_LOCAL_DEMO_DATA==='true';
      if(process.env.VERCEL&&local)throw new DomainError('CONFIGURATION','Deployment requires Supabase; local fallback is disabled on Vercel',503);
      let store:Store;
      if(local) {
        const path=resolve(/* turbopackIgnore: true */ process.env.DB_PATH??'.local/demo.sqlite');
        mkdirSync(dirname(path),{recursive:true});
        store=createSqliteStore(path);
        ownedSqliteStore=store;
      } else {
        const url=process.env.SUPABASE_URL??process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
        if(!url||!key)throw new DomainError('CONFIGURATION','Supabase environment is not configured',503);
        store=withCommitConflictRetry(createSupabaseStore(url,key));
      }
      const businessDate=process.env.DEMO_BUSINESS_DATE??'2026-10-01';
      workflowV2BootstrapResult=null;
      if(isWorkflowV2Enabled()) {
        const {createSeedData}=await import('../seed/generate');
        const seedData=createSeedData(businessDate);
        await preflightEmptyLegacySeedTables(store,seedData);
        await seedStore(store,businessDate,seedData);
        workflowV2BootstrapResult=await initializeWorkflowV2Bootstrap(store,businessDate,seedData);
      } else {
        await seedStore(store,businessDate);
        await ensureDemoProfilesIfEnabled(store);
      }
      return store;
    })().catch(error=>{
      if(ownedSqliteStore) {
        try { ownedSqliteStore.close?.(); } catch { /* Preserve the initialization failure. */ }
      }
      storePromise=undefined;
      workflowV2BootstrapResult=null;
      throw error;
    });
  }
  return storePromise;
}

export async function getWorkflowV2BootstrapResult():Promise<WorkflowV2SeedResult|null> {
  await getStore();
  if(!isWorkflowV2Enabled())return null;
  const result=workflowV2BootstrapResult;
  if(!result||result.state!=='source_ready'||!result.bootstrapReady)throw new DomainError('WORKFLOW_UNAVAILABLE','Workflow V2 bootstrap is not ready',503);
  return result;
}

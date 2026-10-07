import {z} from 'zod';
import type {ActionKind,Actor,PackPin,Reader} from '../contracts';
import type {ActionBinding,ToolBinding,TrustedPackRuntime} from './runtime-contracts';
import {branchSchema} from '../packs/shared';
import {registerPacks} from './packs';
import {canReadPolicy} from '../dynamic/catalog/policy';
import {invariant} from './errors';
import {digest} from './utils';
import {salesRuntime} from '../packs/sales-runtime';
import {operationsRuntime} from '../packs/operations-runtime';
import {hrRuntime} from '../packs/hr-runtime';
import { authorizeWorkflowScope, type WorkflowPrincipal } from '../workflows/authority';
import { DomainError } from './errors';
import type { WorkflowBrokerOptions, WorkflowToolBinding, WorkflowToolBroker } from './runtime-contracts';
export const actionPermissions:Record<ActionKind,string>={dashboard_create:'dashboard.create',dashboard_share:'dashboard.share',ticket_create:'ticket.create',badge_revoke:'badge.revoke',demo_update:'demo.update'};
const hrCitationIdSchema=z.string().min(1).max(160);
export const defaultRuntimes=[salesRuntime,operationsRuntime,hrRuntime];
export function readOnly(reader:Reader):Reader {return Object.freeze({list:<T>(table:Parameters<Reader['list']>[0],filters?:Parameters<Reader['list']>[1])=>reader.list<T>(table,filters),get:<T>(table:Parameters<Reader['get']>[0],id:string)=>reader.get<T>(table,id)});}
export class RuntimeCatalog {
  readonly manifests;readonly tools=new Map<string,ToolBinding>();readonly actions=new Map<ActionKind,ActionBinding>();
  constructor(readonly runtimes:TrustedPackRuntime[]) {
    this.manifests=registerPacks(runtimes.map(r=>r.manifest));
    for(const runtime of runtimes) {
      const expected=runtime.manifest.tools.filter(t=>t.audit==='read'||t.audit==='prepare');
      invariant(expected.length===runtime.tools.length,'INVALID_PACK','Manifest/runtime tool bindings do not match');
      for(const binding of runtime.tools){invariant(!this.tools.has(binding.name)&&expected.some(t=>t.name===binding.name&&t.audit===binding.audit),'INVALID_PACK','Missing/duplicate/mismatched tool binding');this.tools.set(binding.name,binding);}
      for(const binding of runtime.actions){invariant(binding.verificationContractVersion===1&&binding.kind in actionPermissions&&!this.actions.has(binding.kind)&&binding.packIds.includes(runtime.manifest.id)&&binding.packIds.every(id=>this.manifests.some(p=>p.id===id)),'INVALID_PACK','Missing/duplicate action owner or dependency');this.actions.set(binding.kind,binding);}
      for(const policy of runtime.sourcePolicies??[])invariant(policy.systems.length&&runtime.manifest.tools.some(t=>t.audit==='read'&&t.permission===policy.permission),'INVALID_PACK','Source policy has no authorized read tool');
    }
  }
  action(kind:ActionKind):ActionBinding {const binding=this.actions.get(kind);invariant(binding,'UNSUPPORTED_ACTION','Action pack is unavailable');return binding;}
  descriptor(name:string){return this.manifests.flatMap(p=>p.tools).find(t=>t.name===name);}
  readPermissions(ids:string[]):string[]{return [...new Set(this.runtimes.filter(r=>ids.includes(r.manifest.id)).flatMap(r=>(r.sourcePolicies??[]).map(p=>p.permission)))];}
  toolPermissions(name:string):string[]{const descriptor=this.descriptor(name);invariant(descriptor,'UNKNOWN_TOOL','Tool is unavailable');return [...new Set([descriptor.permission,...(this.tools.get(name)?.requiredPermissions??[])])];}
  allowsTool(actor:Actor,name:string):boolean{return actor.active&&this.toolPermissions(name).every(p=>actor.permissions.includes(p));}
  pins(ids:string[]):PackPin[] {return ids.map(id=>{const runtime=this.runtimes.find(r=>r.manifest.id===id);invariant(runtime,'INVALID_PACK','Required pack is unavailable');const p=runtime.manifest;const implementation=digest({tools:runtime.tools.map(t=>[t.name,t.audit,t.requiredPermissions,String(t.run)]),actions:runtime.actions.map(a=>({kind:a.kind,packIds:a.packIds,original:a.implementationDigest,callbacks:[a.validate,a.targetIds,a.overlaps,a.execute,a.verify,a.visible].map(String)}))});return{id:p.id,version:p.version,implementationRevision:`${p.implementationRevision}:${implementation}`,schemaDigest:digest({...p,sourcePolicies:runtime.sourcePolicies,tools:p.tools.map(t=>({...t,inputSchema:z.toJSONSchema(t.inputSchema),resultSchema:z.toJSONSchema(t.resultSchema)}))})};});}
  assertPins(expected:PackPin[]){invariant(expected.length&&expected.every(pin=>this.runtimes.some(r=>r.manifest.id===pin.id)&&digest(this.pins([pin.id])[0])===digest(pin)),'STALE_ACTION','Department Pack เปลี่ยน กรุณาสร้างตัวอย่างใหม่',409);}
  canCite(actor:Actor,sourceId:string,allowedBranches:Set<string>):boolean {
    const parts=sourceId.split(':');
    // Registered policy library Source: policy:<documentId>:<version>; readable exactly when the registry permission is held.
    if(parts[0]==='policy')return parts.length===3&&canReadPolicy(actor.permissions,parts[1])&&actor.active;
    // HR Director Workflow V2 reads: workflow:review_snapshot:<id> / workflow:director_approvals:<date>; citable while the Director read permission is held.
    if(parts[0]==='workflow')return parts.length===3&&['review_snapshot','director_approvals'].includes(parts[1])&&actor.active&&actor.permissions.includes('hr.onboarding.director_read');
    const policy=this.runtimes.flatMap(r=>r.sourcePolicies??[]).find(p=>p.systems.includes(parts[0]));
    if(!policy||!actor.permissions.includes(policy.permission))return false;
    if(parts[0]==='hr'){
      if(!hrCitationIdSchema.safeParse(sourceId).success)return false;
      if(parts.length===3&&parts[2]==='population'){
        // Router HR population source: hr:<branchId|__global__>:population. Global records and unknown shapes stay admin-only / rejected.
        if(parts[1]==='__global__')return actor.role==='hr_admin';
        if(!branchSchema.shape.id.safeParse(parts[1]).success)return false;
        return actor.role==='hr_admin'||allowedBranches.has(parts[1]);
      }
      const isLegacyEmployeeSource=parts.length===3&&parts[1]==='employees';
      const isScopedEmployeeSource=parts.length===4&&parts[2]==='employees';
      if(!isLegacyEmployeeSource&&!isScopedEmployeeSource)return false;
      const employeeId=isLegacyEmployeeSource?parts[2]:parts[3];
      const employeeInput=this.descriptor('hr.find_employee')?.inputSchema.safeParse({employeeId});
      if(!employeeInput?.success)return false;
      if(isLegacyEmployeeSource)return actor.role==='hr_admin';
      const branchId=parts[1];
      if(!branchSchema.shape.id.safeParse(branchId).success)return false;
      if(actor.role==='hr_admin')return true;
      return allowedBranches.has(branchId);
    }
    if(!policy.branchScoped)return true;
    return allowedBranches.has(parts[1]);
  }
  private assertWorkflowTools(bindings: readonly WorkflowToolBinding[]): void {
    const names = new Set<string>();
    for (const binding of bindings) {
      const descriptor = binding.descriptor;
      invariant(!names.has(descriptor.name) && !this.tools.has(descriptor.name) &&
        (descriptor.audit === 'read' || descriptor.audit === 'prepare') && descriptor.permission === binding.authority.permission &&
        descriptor.timeoutMs > 0 && !!descriptor.inputSchema && !!descriptor.resultSchema &&
        binding.packIds.length > 0 && new Set(binding.packIds).size === binding.packIds.length &&
        binding.packIds.every(id => this.manifests.some(pack => pack.id === id)),
      'INVALID_PACK', 'A trusted workflow tool registration is invalid');
      names.add(descriptor.name);
    }
  }
  private authorizeWorkflowTool(principal: WorkflowPrincipal, binding: WorkflowToolBinding): void {
    invariant(binding.readPermissions.every(permission => principal.actor.permissions.includes(permission)),
      'WORKFLOW_PERMISSION_DENIED', 'A required workflow read permission is absent', 403);
    authorizeWorkflowScope(principal, { ...binding.authority, targets: [] });
  }
  /** Same broker wire contract; only trusted read/prepare bindings may enter the model surface. */
  async workflowBroker(options: WorkflowBrokerOptions): Promise<WorkflowToolBroker> {
    this.assertWorkflowTools(options.bindings);
    const principal = await options.loadPrincipal(), visible = new Map<string, WorkflowToolBinding>();
    for (const binding of options.bindings) {
      try { this.authorizeWorkflowTool(principal, binding); visible.set(binding.descriptor.name, binding); }
      catch (error) { if (!(error instanceof DomainError) || error.status !== 403) throw error; }
    }
    return Object.freeze({ descriptors: [...visible.values()].map(binding => binding.descriptor),
      execute: async (name: string, args: unknown) => {
        const binding = visible.get(name);
        invariant(binding, 'UNKNOWN_TOOL', 'The workflow tool is unavailable', 404);
        this.authorizeWorkflowTool(await options.loadPrincipal(), binding);
        const parsed = binding.descriptor.inputSchema.parse(args);
        invariant(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_INPUT', 'Tool input must be an object');
        // Record schema validation, rather than a cast, keeps arbitrary model values out of callbacks.
        const input = z.record(z.string(), z.unknown()).parse(parsed);
        return binding.descriptor.resultSchema.parse(await binding.run(input));
      } });
  }
  workflowPins(ids: string[], bindings: readonly WorkflowToolBinding[]): PackPin[] {
    this.assertWorkflowTools(bindings);
    return this.pins(ids).map(pin => ({ ...pin, implementationRevision: `${pin.implementationRevision}:workflow-tools:${digest(
      bindings.filter(binding => binding.packIds.includes(pin.id)).map(binding => ({
        descriptor: { ...binding.descriptor, inputSchema: z.toJSONSchema(binding.descriptor.inputSchema), resultSchema: z.toJSONSchema(binding.descriptor.resultSchema) },
        authority: binding.authority, readPermissions: binding.readPermissions, run: String(binding.run),
      })))}` }));
  }
}

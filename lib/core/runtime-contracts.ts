import type { ActionKind, ActionPayload, Actor, ApprovalDisplay, Dashboard, DepartmentPack, Evidence, PackPin, PendingAction, Reader, Scope, Transaction } from '../contracts';
import { invariant } from './errors';
import { digest } from './utils';
import type { ToolDescriptor, ToolBroker } from '../contracts';
import type { WorkflowPrincipal, WorkflowScopeRequest } from '../workflows/authority';

/** Server-owned V2 tools extend the trusted broker without changing V1 payloads or roles. */
export interface WorkflowToolBinding {
  readonly descriptor: ToolDescriptor & { audit: 'read' | 'prepare' };
  readonly packIds: readonly string[];
  readonly authority: Pick<WorkflowScopeRequest, 'permission' | 'roles' | 'purpose'>;
  readonly readPermissions: readonly string[];
  run(args: Record<string, unknown>): Promise<unknown>;
}
export interface WorkflowBrokerOptions {
  readonly bindings: readonly WorkflowToolBinding[];
  /** Reloads the principal in guarded storage on creation and each invocation. */
  loadPrincipal(): Promise<WorkflowPrincipal>;
}
export type WorkflowToolBroker = ToolBroker;

export interface PackReadContext {
  reader:Reader;
  actor:Actor;
  businessDate:string;
  now:()=>Date;
  evidence:(scope:Scope)=>Promise<Evidence>;
  latestDashboard:()=>Promise<Dashboard|undefined>;
  assertPins:(pins:PackPin[])=>void;
}
export interface PackPrepareContext extends PackReadContext { prepare:(payload:ActionPayload)=>Promise<PendingAction> }
export type ToolBinding = ({ name:string; audit:'read'; run:(context:PackReadContext,args:Record<string,unknown>)=>Promise<unknown> } | { name:string; audit:'prepare'; run:(context:PackPrepareContext,args:Record<string,unknown>)=>Promise<unknown> }) & { requiredPermissions?:string[] };
export interface ValidationSnapshot { version:string|null; evidence?:Evidence; display?:ApprovalDisplay }
export interface TargetContext {
  reader:Reader;
  actor:Actor;
  businessDate:string;
  now:()=>Date;
  targetId:string;
  recordId:string;
  operationKey:string;
  executedAt?:string;
  conversationId:string;
  evidence?:Evidence;
  approvedPacks:PackPin[];
  assertPins:(pins:PackPin[])=>void;
}
export interface TargetWriteContext extends TargetContext { tx:Transaction }
export type PayloadOf<K extends ActionKind> = Extract<ActionPayload,{kind:K}>;
/**
 * Explicit per-action risk tier (policy, never inferred from text).
 * - private_reversible: owner-only, reversible creation; created directly, audited, and undoable.
 * - confirmation_required: reaches other people, assigns work, or is hard to undo; needs explicit user confirmation.
 */
export type ActionRiskTier='private_reversible'|'confirmation_required';
export interface TypedActionBinding<K extends ActionKind> {
  kind:K;
  /** Defaults to confirmation_required (fail closed) when a binding omits it. */
  riskTier?:ActionRiskTier;
  packIds:string[];
  validate:(context:PackReadContext,payload:PayloadOf<K>)=>Promise<ValidationSnapshot>;
  targetIds:(payload:PayloadOf<K>)=>string[];
  overlaps:(candidate:PayloadOf<K>,claimed:PayloadOf<K>)=>boolean;
  execute:(context:TargetWriteContext,payload:PayloadOf<K>)=>Promise<{recordId:string;dashboardId?:string;executedAt?:string}>;
  verify:(context:TargetContext,payload:PayloadOf<K>)=>Promise<boolean>;
  visible:(context:PackReadContext,payload:PayloadOf<K>)=>Promise<boolean>;
}
export interface ActionBinding extends Omit<TypedActionBinding<ActionKind>,'kind'|'riskTier'> {kind:ActionKind; riskTier:ActionRiskTier; implementationDigest?:string; verificationContractVersion:1}
export interface SourcePolicy { systems:string[]; permission:string; branchScoped:boolean }
export interface TrustedPackRuntime { manifest:DepartmentPack; tools:ToolBinding[]; actions:ActionBinding[]; sourcePolicies?:SourcePolicy[] }
/** The facade checks the discriminant before narrowing a trusted, closed V1 payload. */
export function defineAction<K extends ActionKind>(binding:TypedActionBinding<K>):ActionBinding {
  const narrow=(payload:ActionPayload):PayloadOf<K>=>{invariant(payload.kind===binding.kind,'INVALID_INPUT','Action binding mismatch');return payload as PayloadOf<K>;};
  const implementationDigest=digest({kind:binding.kind,packIds:binding.packIds,callbacks:[binding.validate,binding.targetIds,binding.overlaps,binding.execute,binding.verify,binding.visible].map(String)});
  return {...binding,riskTier:binding.riskTier??'confirmation_required',implementationDigest,verificationContractVersion:1,validate:(ctx,p)=>binding.validate(ctx,narrow(p)),targetIds:p=>binding.targetIds(narrow(p)),overlaps:(a,b)=>binding.overlaps(narrow(a),narrow(b)),execute:(ctx,p)=>binding.execute(ctx,narrow(p)),verify:(ctx,p)=>binding.verify(ctx,narrow(p)),visible:(ctx,p)=>binding.visible(ctx,narrow(p))};
}

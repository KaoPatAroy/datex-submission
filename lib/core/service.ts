import {z} from 'zod';
import {scopeSchema, dashboardSpecSchema, type Role, pendingActionRevisionDiffSchema, type Actor, type ActionCatalogEntry, type ActionCatalogStatus, type ActionPayload, type Analysis, type AuditEvent, type Badge, type Branch, type ConversationMessage, type Dashboard, type Employee, type Evidence, type Mode, type PendingAction, type PendingActionRevisionResult, type Profile, type Reader, type Receipt, type ReceiptView, type Scope, type SourceRef, type Store, type TargetResult, type Transaction, type TurnFailureReason, type TurnRequestIdentity, type TurnResponse, type Workspace} from '../contracts';
import {liveAIKillSwitchOn} from '../dynamic/config';
import {createSemanticCatalog} from '../dynamic/catalog/semantic';
import {authority as queryAuthority,cancelableEvidenceRead} from '../dynamic/runtime';
import type { ChatStreamStatusCode } from '../chat-stream-contracts';
import {canRegion,reloadActor,requirePermission} from './auth';
import {DomainError,invariant} from './errors';
import {readEvidence,deterministicAnalysis} from './evidence';
import {retailEvidenceCoverage} from '../packs/retail/coverage';
import {assertDashboardRendererSupport,unsupportedWidgetResult,unsupportedWidgetResultSchema} from './dashboard-renderer-support';
import {AIRuntimeError} from '../ai/errors';
import {buildWorkspaceActionCatalog} from './action-catalog';
import {actionRevisionRequestKeySchema,createDashboardRevision,revisionActionId} from './action-revision';
import {digest,id} from './utils';
import {ticketPlanLines} from './ticket-plan-text';
import {actionPayloadSchema} from './action-schema';
import {actionPermissions,defaultRuntimes,readOnly,RuntimeCatalog} from './runtime-catalog';
import type {PackPrepareContext,PackReadContext,TrustedPackRuntime,ValidationSnapshot} from './runtime-contracts';
import {roleShowcase,showcaseById,unsupportedDemoReply} from '../demo/showcase';
import {releaseRevision} from './release';
import {withChatCapability} from './chat-capability';
import {DEFAULT_CONVERSATION_TITLE,isDefaultConversationTitle,titleFromFirstMessage,type ConversationRecord} from './conversations';
import {defaultSalesDashboard} from '../packs/sales-runtime';
import {canReadHrEmployee,readBadgeSnapshot} from '../packs/hr-runtime';
import {pendingActionSchema} from '../packs/shared';
import {StorageReadUnavailableError} from '../storage/read-error';
import {matchesPreparationTarget,policyForPrepareTool,type PreparationPolicy,type PrepareToolName} from './preparation-policy';
import {assertCompletedActionTurn,finalAssistantContentDigest,normalizedFinalActionIds,readCompletedTurn,turnCompletionId,turnCompletionRecordSchema,turnCompletionTupleSchema,turnRequestCompletionProofSchema,type CompletedTurnRead,type TurnCompletionRecord,type TurnCompletionTuple} from './turn-completion-gate';
import { TURN_WORK_DEADLINE_MS } from '../ai/provider-options';
import {ACTION_DEFINITIONS,actionRegistry,createActionRegistry} from '../router/action-registry';
import {buildPlannerContext,CONTEXT_LIMITS,NO_RESULT_MARK} from '../router/context/build-context';
import {recipientDirectory} from '../router/context/recipients';
import {personLabels} from '../router/context/display';
import {bindWorkCatalogEntry} from '../router/demo-plans';
import {specRevision,type ActionPorts,type DashboardOrganizeOp,type DashboardWriteGuard,type DeferredWrite,type SavedDashboardInfo,type StagedProposal} from '../router/executors/action-ports';
import {confirmProposal,DASHBOARD_CHANGED_CODE,DASHBOARD_SHARED_CODE,type ConfirmResult} from '../router/executors/action';
import {approvedShareSourceIds,executeDashboardVizWidgets,WIDGET_CEILING_TEXT,type WidgetScopeCeiling} from '../router/executors/dashboard-widgets';
import type {PlannerContext,TurnMessages} from '../router/planner-context';
import {boundedPlannerConversation} from '../router/planner/input';
import {createActionPorts} from '../router/ports/service-ports';
import {createStagedStore} from '../router/storage/staged-store';
import {drillArtifact,listArtifactHistory,openArtifactVersion,openSharedArtifact,type ArtifactDrillInput} from '../router/executors/artifact-read';
import {createEffectBindings} from '../router/ports/effect-bindings';
import {buildDirectorPlannerContext,directorActionPermitted,NO_DIRECTOR_CAPABILITIES,resolveServerDirectorWorkflow} from '../router/ports/director-context';
import type {DirectorWorkflowPort} from '../router/ports/director-workflow';
import {assertUserTextSize,brandUserText,type UserText} from '../router/user-text';
import type {VizWidgetResult} from '../visualization/dashboard-data';
import {artifactVersionRowId} from '../artifacts/store';import {createArtifactReader,persistArtifactPreview,loadStoredArtifact,markArtifactSaved,isArtifactSaved,artifactCsv,artifactCsvFilename,type ArtifactPreview} from '../artifacts';
import {listCurrentArtifactShares,revokeArtifactShareInTx} from '../artifacts/shared-store';import {pinnedArtifactRef} from '../artifacts/ref';import {applyResultOp,archivedArtifactIds,displayTitles,listResultItems,listResultsPage,resultOpSchema,searchActiveResults} from '../artifacts/library';import {RESULT_KIND_LABEL} from '../artifacts/library-view';import {executeResourceLookupStep,fitLabel,parseLookupMoreChoiceId} from '../router/executors/resource-lookup';import {deriveResultWidgets} from '../artifacts/dashboard-widget';import {applyWidgetOp} from '../dashboards/widget-ops';import {candidateFamilyWidget,isWidgetFamilyOp,widgetFamilyOpSchema} from '../dashboards/widget-family';import {dashboardUiEditSchema,isUiProposalOrigin,stageDashboardUiProposal,uiEditLabel} from '../dashboards/ui-staging';
import {availabilityWindow,bindServerSelectors,CATALOG_ENTRY_UNAVAILABLE_TEXT,datasetLabel,latestPendingClarification,LIVE_AI_DISABLED_TEXT,PENDING_CLARIFICATION_TOOL,plannerCatalogDescriptors,previousPlanFor,runRouterTurn,unavailableStagedPorts,type PendingClarification,type PlanSource,type RouterTurnOutcome} from './router-turn';
export {actionPayloadSchema} from './action-schema';

// app/api/chat/stream/route.ts has maxDuration = 120 seconds; allow three more minutes for shutdown/clock margin.
export const TURN_STALE_AFTER_MS = 5 * 60_000;

function abortReason(signal:AbortSignal):unknown{
  return signal.reason??new DOMException('The response was stopped.','AbortError');
}

function awaitWithAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener('abort',onAbort);
    const onAbort=()=>{cleanup();reject(abortReason(signal));};
    signal.addEventListener('abort',onAbort,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}

interface Conversation extends ConversationRecord {lastScope?:Scope|null;lastDashboardId?:string|null;lastAnalysis?:Analysis}
interface TurnRequest extends TurnCompletionTuple {id:string;intentHash:string;clarification?:{choiceId:string;clarifiedTurnId:string};actionContractVersion?:1|2;status:'started'|'completed'|'failed';failureReason?:TurnFailureReason;name:'chat.turn_request';createdAt:string;finalContentDigest?:string;finalActionIds?:string[]}
interface Share {id:string;dashboardId:string;recipientId:string;actorId:string;active:boolean;operationKey:string;createdAt:string}
interface Inbox {id:string;recipientId:string;dashboardId:string;createdAt:string}
interface ToolValue {evidence?:Evidence;analysis?:Analysis;sources?:SourceRef[];pendingAction?:PendingAction;summary?:string}
interface DashboardShareCeiling {scope:Scope;sourceIds:ReadonlySet<string>}

function isKnownCatalogReadUnavailable(error: unknown): boolean {
  return error instanceof StorageReadUnavailableError ||
    (error instanceof DomainError && error.status === 503 && error.code === 'SOURCE_UNAVAILABLE');
}

function shareActionId(grant:Share):string|undefined{
  const prefix='execution_',suffix=`:${grant.recipientId}`;
  if(typeof grant.operationKey!=='string'||!grant.operationKey.startsWith(prefix)||!grant.operationKey.endsWith(suffix))return;
  const actionId=grant.operationKey.slice(prefix.length,-suffix.length);
  return actionId||undefined;
}

function chatRefinementRequestKey(requestId:string,baseActionId:string):string{
  return `chat_revision_${digest({requestId,baseActionId}).slice(0,40)}`;
}

/** Private dashboards are removed by soft delete so receipts and audit stay intact. */
const MAX_OWNED_DASHBOARDS=100;
function isDeletedDashboard(dashboard:Dashboard):boolean{return typeof (dashboard as Dashboard&{deletedAt?:unknown}).deletedAt==='string';}
/** A share grant is active in either storage format: legacy `active: true` or V2 `status: 'active'` (a revoked V2 row never is). */
function isActiveShareGrant(grant:{active?:unknown;status?:unknown}):boolean{return grant.status==='revoked'?false:grant.active===true||grant.status==='active';}
const CLARIFICATION_USED_TOOL='router.clarification_used';
const CLARIFICATION_USED_TEXT='ตัวเลือกนี้ถูกใช้ไปแล้ว — โปรดพิมพ์คำขอใหม่หรือเลือกจากตัวเลือกล่าสุด';
/** Business-reasonable horizon: proposals belong to the user and conversation, not the login session. */
const PENDING_ACTION_TTL_MS=24*60*60*1000;

const PRIVATE_CREATE_FAILED_TEXT='เตรียมรายการแล้วแต่ยังสร้างไม่สำเร็จ — โปรดตรวจตัวอย่างและยืนยันอีกครั้ง';
export interface TurnStarted {conversationId:string;turnId:string;assistantMessageId:string;mode:Mode;replayed:boolean}
export interface TurnStreamOptions {
  signal?:AbortSignal;
  onStarted?:(turn:TurnStarted)=>void|Promise<void>;
  onTextDelta?:(text:string)=>void|Promise<void>;
  onStatus?:(code:ChatStreamStatusCode)=>void|Promise<void>;
}
export interface RecoverTurnInput {contractVersion:2;actionContractVersion?:1|2;requestKey:string;message:string;conversationId?:string}
export type RecoverTurnResult=
  | {status:'completed';response:TurnResponse}
  | {status:'in_progress'|'failed';conversationId:string;turnId:string}
  | {status:'unavailable'};

const ACTION_PREVIEW_MAX_CHARS=2_000;
/** Actions compiled to an existing broker prepare tool. */
const ROUTER_PREPARE_TOOLS:Readonly<Record<string,PrepareToolName>>={'dashboard.create':'dashboard.prepare_create','dashboard.share':'dashboard.prepare_share','ticket.create':'ticket.prepare_create','badge.revoke':'badge.prepare_revoke'};
/** Demo and legacy review-step services: private creations stay behind preview -> confirm (registry tier change only). */
const reviewTierRegistry=createActionRegistry(ACTION_DEFINITIONS.map(definition=>definition.actionId==='dashboard.create'?{...definition,riskTier:'confirm' as const}:definition));
const STAGED_PROBE_RETRY_MS=5*60_000;
/** Bounded retries for re-runnable bookkeeping transactions after a definite no-commit conflict (concurrent confirms). */
export const BOOKKEEPING_MAX_RETRIES=3;
const TURN_EXTRAS_TOOL='router.turn_extras';
const INVALID_CLARIFICATION_TEXT='ตัวเลือกที่เลือกไม่ตรงกับคำถามล่าสุดในบทสนทนานี้ จึงยังไม่ได้ดำเนินการ — โปรดพิมพ์คำขอใหม่หรือเลือกจากตัวเลือกล่าสุด';
const turnExtrasId=(turnId:string)=>`turn-extras:${turnId}`;
const stagedProbe=new WeakMap<Store,{available:boolean;at:number}>();
/** Canonical preview text; must satisfy the pendingAction.preview contract (<=2000 chars) for any payload size. */
export function boundedActionPreview(payload:unknown):string{
  const pretty=JSON.stringify(payload,null,2);
  if(pretty.length<=ACTION_PREVIEW_MAX_CHARS)return pretty;
  const compact=JSON.stringify(payload);
  if(compact.length<=ACTION_PREVIEW_MAX_CHARS)return compact;
  return compact.slice(0,ACTION_PREVIEW_MAX_CHARS-1)+'…';
}
export class ConciergeService {
  readonly businessDate:string;readonly catalog:RuntimeCatalog;
  private readonly releaseRevision:string;
  private readonly clock:()=>Date;
  private readonly routeStartedAt?:number;
  private readonly reviewPrivateCreations:boolean;
  private readonly workspaceMessageProofs=new WeakMap<Workspace,Map<string,Promise<CompletedTurnRead>>>();
  constructor(readonly store:Store,options:{businessDate?:string;now?:()=>Date;runtimes?:TrustedPackRuntime[];routeStartedAt?:number;/** Legacy review step for private reversible creations (default off: they are created directly). */reviewPrivateCreations?:boolean;/** HR Director Workflow V2 bridge (default: the server V2 runtime when enabled). */directorWorkflow?:()=>Promise<DirectorWorkflowPort|undefined>}={}) {
    this.businessDate=options.businessDate??process.env.DEMO_BUSINESS_DATE??'2026-10-01';this.clock=options.now??(()=>new Date());this.catalog=new RuntimeCatalog(options.runtimes??defaultRuntimes);
    this.releaseRevision=releaseRevision();
    this.routeStartedAt=options.routeStartedAt;this.reviewPrivateCreations=options.reviewPrivateCreations===true;
    this.directorWorkflowSource=options.directorWorkflow??(()=>resolveServerDirectorWorkflow(this.store,()=>this.now()));
  }
  private readonly directorWorkflowSource:()=>Promise<DirectorWorkflowPort|undefined>;
  private now(){return this.clock();}
  private async audit(tx:Transaction,actor:Actor,category:string,summary:string,actionId?:string,region?:string){
    await tx.put('audit_events',{id:id('audit'),actorId:actor.id,category,summary,createdAt:this.now().toISOString(),...(actionId?{actionId}:{}),...(region?{region}:{})} satisfies AuditEvent);
  }
  async queryEvidence(actor:Actor,scope:Scope,signal?:AbortSignal):Promise<Evidence>{return this.store.transaction(async tx=>{
    const read=async()=>{const current=await reloadActor(tx,actor,this.now());signal?.throwIfAborted();return readEvidence(tx,current,scope,this.now());};
    return signal?cancelableEvidenceRead(read,signal):read();
  });}
  private async conversation(reader:Reader,actor:Actor,conversationId?:string):Promise<Conversation|undefined>{
    if(!conversationId)return undefined;const c=await reader.get<Conversation>('conversations',conversationId);invariant(c&&c.actorId===actor.id,'NOT_FOUND','ไม่พบการสนทนา',404);return c;
  }
  private activeConversation(c:Conversation|undefined):void {invariant(!c?.archivedAt,'ARCHIVED_CONVERSATION','บทสนทนานี้ถูกเก็บแล้ว กรุณาเปิดกลับก่อนส่งข้อความ',409);}
  private conversationUpdate(actor:Actor,conversationId:string,c?:Conversation,patch:Partial<Conversation>={}):Conversation {
    const now=this.now().toISOString(),version=c&&Number.isSafeInteger(c.rowVersion)&&(c.rowVersion??0)>=1?c.rowVersion!:1;
    return{title:DEFAULT_CONVERSATION_TITLE,pinned:false,pinnedAt:null,archivedAt:null,lastScope:null,lastDashboardId:null,...c,...patch,id:conversationId,actorId:actor.id,createdAt:c?.createdAt??now,updatedAt:now,rowVersion:c?version+1:1};
  }
  private context(reader:Reader,actor:Actor,conversationId?:string,transactional=false,signal?:AbortSignal):PackReadContext {
    const safe=readOnly(reader);const frozen=Object.freeze({...actor,permissions:Object.freeze([...actor.permissions]) as unknown as string[],regions:Object.freeze([...actor.regions]) as unknown as string[]});
    const wait=<T>(read:Promise<T>)=>signal?awaitWithAbort(read,signal):read;
    return Object.freeze({reader:safe,actor:frozen,businessDate:this.businessDate,now:()=>this.now(),assertPins:(pins:PendingAction['packs'])=>this.catalog.assertPins(pins),evidence:(scope:Scope)=>transactional?readEvidence(safe,frozen,scope,this.now()):this.queryEvidence(frozen,scope),latestDashboard:async()=>{
      signal?.throwIfAborted();
      const c=await wait(this.conversation(safe,frozen,conversationId));if(c?.lastDashboardId){const d=await wait(safe.get<Dashboard>('dashboards',c.lastDashboardId));if(d?.ownerId===frozen.id&&!isDeletedDashboard(d))return d;}
      return (await wait(safe.list<Dashboard>('dashboards'))).filter(d=>d.ownerId===frozen.id&&!isDeletedDashboard(d)&&!d.archivedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    }});
  }
  private approvalHash(a:Pick<PendingAction,'actorId'|'sessionId'|'mode'|'modeRevision'|'payload'|'evidenceVersion'|'packs'|'expiresAt'|'receiptAccess'|'releaseRevision'|'actionContractVersion'|'approvalScope'|'approvalDisplay'|'predecessorActionId'|'revisionDiff'>){
    const {actorId,sessionId,mode,modeRevision,payload,evidenceVersion,packs,expiresAt,receiptAccess,releaseRevision,actionContractVersion,approvalScope,approvalDisplay,predecessorActionId,revisionDiff}=a;
    const approval={actorId,sessionId,mode,modeRevision,payload,evidenceVersion,packs,expiresAt,receiptAccess,releaseRevision,actionContractVersion,approvalScope,approvalDisplay};
    return predecessorActionId===undefined&&revisionDiff===undefined?digest(approval):digest({...approval,predecessorActionId:predecessorActionId??null,revisionDiff:revisionDiff??[]});
  }
  private async assertNoDuplicateDashboardShare(tx:Transaction,actor:Actor,action:PendingAction):Promise<void>{
    if(action.payload.kind!=='dashboard_share')return;
    const {dashboardId,recipientId}=action.payload;
    invariant(!(await tx.list<Share>('dashboard_shares')).some(share=>share.dashboardId===dashboardId&&share.recipientId===recipientId&&share.active),
      'CONFLICT','Dashboard is already shared with this recipient',409);
    for(const other of await tx.list<PendingAction>('pending_actions')){
      if(other.id===action.id||other.actorId!==actor.id||other.status!=='claimed'||other.payload.kind!=='dashboard_share'||
        other.payload.dashboardId!==dashboardId||other.payload.recipientId!==recipientId)continue;
      const prior=await tx.get<Receipt>('action_executions',`execution_${other.id}`);
      const settledFailure=!!prior&&(prior.status==='failed'||prior.status==='denied')&&prior.results.every(result=>result.status==='failed'||result.status==='denied');
      invariant(settledFailure,'PENDING_EFFECT','An equivalent dashboard share is unresolved',409);
    }
  }
  private async dashboardShareCeiling(actor:Actor,dashboard:Dashboard):Promise<DashboardShareCeiling>{
    const grants=(await this.store.list<Share>('dashboard_shares')).filter(share=>share.dashboardId===dashboard.id&&share.recipientId===actor.id&&share.active);
    invariant(grants.length===1,'FORBIDDEN','Dashboard share approval is missing or ambiguous',403);
    const sender=await this.store.get<Profile>('profiles',dashboard.ownerId);invariant(!!sender&&sender.active&&sender.id===dashboard.ownerId,'FORBIDDEN','ผู้แชร์ไม่อยู่ในสถานะที่แชร์ Dashboard ได้แล้ว',403);
    const grant=grants[0],actionId=shareActionId(grant);
    invariant(!!actionId&&grant.actorId===dashboard.ownerId&&grant.id===`effect_${digest(grant.operationKey).slice(0,24)}`,
      'FORBIDDEN','Dashboard share approval provenance is invalid',403);
    const [action,receipt]=await Promise.all([
      this.store.get<PendingAction>('pending_actions',actionId),
      this.store.get<Receipt>('action_executions',`execution_${actionId}`)
    ]);
    invariant(!!action&&action.id===actionId&&action.actorId===dashboard.ownerId&&action.payload.kind==='dashboard_share'&&
      action.payload.dashboardId===dashboard.id&&action.payload.recipientId===actor.id&&action.status==='completed'&&
      action.evidenceVersion!==null&&action.evidenceVersion.length>0&&action.payloadHash===this.approvalHash(action),
      'FORBIDDEN','Dashboard share action approval is missing or invalid',403);
    invariant(!!receipt&&receipt.id===`execution_${action.id}`&&receipt.actionId===action.id&&receipt.actorId===dashboard.ownerId&&
      receipt.kind==='dashboard_share'&&receipt.status==='verified_success'&&receipt.verifiedAt!==null&&receipt.results.length===1&&
      receipt.results[0].targetId===actor.id&&receipt.results[0].id===grant.id&&receipt.results[0].status==='verified_success',
      'FORBIDDEN','Dashboard share effect receipt is missing or invalid',403);
    const parsedScope=scopeSchema.safeParse(action.approvalScope);
    invariant(parsedScope.success,'FORBIDDEN','Dashboard share approval scope is missing or invalid',403);
    const scope=parsedScope.data,branchIds=scope.branchIds??[],dashboardScope=dashboard.spec.scope;
    invariant(branchIds.length>0&&new Set(branchIds).size===branchIds.length&&scope.date===dashboardScope.date&&
      (dashboardScope.region.toLowerCase()==='all'||scope.region.toLowerCase()===dashboardScope.region.toLowerCase())&&
      (!dashboardScope.branchIds||branchIds.every(branchId=>dashboardScope.branchIds!.includes(branchId))),
      'FORBIDDEN','Dashboard share approval scope does not match the dashboard',403);
    // PC-01: the approved source set derives from the approval-hash-bound scope (exact date, approved branches); the Dashboard can only narrow it.
    return{scope:{...scope,branchIds},sourceIds:new Set(approvedShareSourceIds({date:scope.date,branchIds},dashboard.sourceMetadata.map(source=>source.id)))};
  }
  /** PC-01: the approved widget ceilings of every ACTIVE share of a Dashboard (write-time recheck). An active share whose approval cannot be read falls back to the Dashboard header at the exact date and header sources. */
  private async activeShareCeilings(dashboard:Dashboard):Promise<WidgetScopeCeiling[]>{
    const header=():WidgetScopeCeiling=>({region:dashboard.spec.scope.region,date:dashboard.spec.scope.date,...(dashboard.spec.scope.branchIds?{branchIds:dashboard.spec.scope.branchIds}:{}),
      sourceIds:dashboard.sourceMetadata.map(source=>source.id).filter(sourceId=>sourceId.endsWith(':'+dashboard.spec.scope.date))});
    const out=new Map<string,WidgetScopeCeiling>();
    for(const grant of (await this.store.list<Share>('dashboard_shares')).filter(row=>row.dashboardId===dashboard.id&&isActiveShareGrant(row))){
      const actionId=shareActionId(grant),action=actionId?await this.store.get<PendingAction>('pending_actions',actionId):undefined,scope=scopeSchema.safeParse(action?.approvalScope);
      const ceiling:WidgetScopeCeiling=scope.success&&scope.data.branchIds?.length?{region:scope.data.region,date:scope.data.date,branchIds:scope.data.branchIds,sourceIds:approvedShareSourceIds(scope.data,dashboard.sourceMetadata.map(source=>source.id))}:header();
      out.set(digest(ceiling),ceiling);
    }
    if(!out.size&&await this.dashboardHasActiveShare(this.store,dashboard.id))out.set('header',header());
    return[...out.values()];
  }
  private needsCurrentReadback(action:PendingAction):boolean {
    if(action.releaseRevision!==this.releaseRevision)return true;
    try{this.catalog.assertPins(action.packs);return false;}catch(error){if(error instanceof DomainError&&error.code==='STALE_ACTION')return true;throw error;}
  }
  private readbackToken(action:PendingAction,receipt:Receipt):string|undefined {
    const binding=this.catalog.actions.get(action.payload.kind);
    if(action.actionContractVersion!==1||binding?.verificationContractVersion!==1||!actionPayloadSchema.safeParse(action.payload).success)return undefined;
    return digest({receiptId:receipt.id,approvalHash:action.payloadHash,release:this.releaseRevision,packs:this.catalog.pins(binding.packIds),contract:1});
  }
  private async badgeHistoryVisible(reader:Reader,actor:Actor,action:PendingAction):Promise<boolean>{
    if(action.payload.kind!=='badge_revoke')return true;
    if(action.payloadHash!==this.approvalHash(action))return false;
    try{
      await readBadgeSnapshot(reader,actor,action.payload.employeeId,action.payload.badgeId);
      const display=action.approvalDisplay;
      if(!display?.badge)return true; // Legacy completed V1 history has no identity display.
      if(!pendingActionSchema.shape.approvalDisplay.safeParse(display).success)return false;
      const approved=display.badge;
      if(approved.employeeId!==action.payload.employeeId||approved.badgeId!==action.payload.badgeId)return false;
      const branch=approved.employeeBranchId?await reader.get<Branch>('branches',approved.employeeBranchId):undefined;
      const employee={id:approved.employeeId,name:approved.employeeName,branchId:approved.employeeBranchId,active:true};
      if(!canReadHrEmployee(actor,employee,branch))return false;
      return (action.receiptAccess?.regions??[]).every(region=>canReadHrEmployee(actor,employee,
        approved.employeeBranchId?{id:approved.employeeBranchId,name:branch?.name??'',region}:undefined));
    }catch(error){
      if(isKnownCatalogReadUnavailable(error)||(error instanceof DomainError&&[400,403,404,409].includes(error.status)))return false;
      throw error;
    }
  }
  private badgeDisplayMatches(action:PendingAction,snapshot:ValidationSnapshot):boolean{
    return !!action.approvalDisplay?.badge&&
      digest(action.approvalDisplay)===digest(snapshot.display);
  }
  private async badgeReview(actor:Actor,action:PendingAction):Promise<NonNullable<Workspace['badgeReviews']>[string]>{
    const base={payloadHash:action.payloadHash,checkedAt:this.now().toISOString()};
    if(action.payload.kind!=='badge_revoke'||!action.approvalDisplay?.badge||
      !pendingActionSchema.shape.approvalDisplay.safeParse(action.approvalDisplay).success)return{...base,status:'unavailable'};
    try{
      const snapshot=await readBadgeSnapshot(this.store,actor,action.payload.employeeId,action.payload.badgeId);
      const current={employeeName:snapshot.employee.name,badgeState:snapshot.badge.state,badgeVersion:snapshot.badge.version,updatedAt:snapshot.badge.updatedAt};
      const matches=action.payloadHash===this.approvalHash(action)&&action.status==='pending'&&
        action.sessionId===actor.sessionId&&action.mode===actor.mode&&action.modeRevision===actor.modeRevision&&
        new Date(action.expiresAt)>this.now()&&action.releaseRevision===this.releaseRevision&&releaseRevision()===this.releaseRevision&&
        snapshot.employee.active&&snapshot.badge.state==='active'&&
        (snapshot.employee.branchId===null||!!snapshot.branch)&&
        snapshot.version===action.evidenceVersion&&this.badgeDisplayMatches(action,snapshot);
      this.catalog.assertPins(action.packs);
      return{...base,status:matches?'current':'stale',current};
    }catch(error){
      if(error instanceof DomainError&&error.code==='STALE_ACTION')return{...base,status:'stale'};
      if(isKnownCatalogReadUnavailable(error)||(error instanceof DomainError&&[400,403,404].includes(error.status)))return{...base,status:'unavailable'};
      throw error;
    }
  }
  private async receiptView(actor:Actor,action:PendingAction|undefined,receipt:Receipt,reader:Reader=this.store):Promise<ReceiptView> {
    const access=action?.receiptAccess;
    const valid=action&&action.actorId===actor.id&&receipt.actionId===action.id&&receipt.kind===action.payload.kind&&action.payloadHash===this.approvalHash(action);
    if(valid&&access&&access.readPermissions.length>0&&access.readPermissions.every(p=>actor.permissions.includes(p))&&
      ((action.payload.kind==='badge_revoke'&&actor.role==='hr_admin')||access.regions.every(r=>actor.regions.includes('*')||actor.regions.includes(r)))&&
      await this.badgeHistoryVisible(reader,actor,action)){
      const token=receipt.status==='pending'&&this.needsCurrentReadback(action)?this.readbackToken(action,receipt):undefined;
      return {...receipt,visibility:'full',...(token?{readbackRevision:token}:{})};
    }
    return {visibility:'restricted',id:receipt.id,actionId:receipt.actionId,status:receipt.status,results:[],createdAt:receipt.createdAt,verifiedAt:null,detail:'สิทธิ์ปัจจุบันจำกัดการอ่านผลเดิม สถานะยังถูกเก็บไว้และไม่มีการเขียนซ้ำ'};
  }
  private async validate(reader:Reader,actor:Actor,payload:ActionPayload,conversationId?:string,transactional=false):Promise<ValidationSnapshot>{
    requirePermission(actor,actionPermissions[payload.kind]);return this.catalog.action(payload.kind).validate(this.context(reader,actor,conversationId,transactional),payload);
  }
  /**
   * Re-runnable transaction with a bounded retry (<=BOOKKEEPING_MAX_RETRIES) when the adapter reports a definite no-commit
   * conflict (SQLite write conflict, Postgres 40001 revision conflict mapped to CONFLICT). `work` must re-read its inputs
   * inside the transaction so every attempt is a fresh, independent decision. Ambiguous outcomes are never retried.
   */
  private async bookkeeping<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
    for(let attempt=0;;attempt++){
      try{return await this.store.transaction(work);}
      catch(error){
        if(attempt>=BOOKKEEPING_MAX_RETRIES||!this.knownNoCommit(error))throw error;
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,10*(attempt+1)+Math.floor(Math.random()*15));timer.unref?.();});
      }
    }
  }
  private knownNoCommit(error:unknown):boolean{return !!error&&typeof error==='object'&&'code'in error&&'definitelyNotCommitted'in error&&error.definitelyNotCommitted===true&&(error.code==='CONFLICT'||(error.code==='STORAGE'&&!(error instanceof DomainError)));}
  private assistantMessageId(actor:Actor,context:{conversationId:string;turnId:string}):string {
    return 'message_'+digest({actorId:actor.id,conversationId:context.conversationId,turnId:context.turnId,role:'assistant'});
  }
  private completionTuple(owner:Pick<TurnCompletionTuple,'actorId'|'sessionId'|'mode'|'modeRevision'>,context:{conversationId:string;turnId:string}):TurnCompletionTuple {
    return{actorId:owner.actorId,sessionId:owner.sessionId,conversationId:context.conversationId,turnId:context.turnId,mode:owner.mode,modeRevision:owner.modeRevision};
  }
  private exactCompletion(raw:unknown,tuple:TurnCompletionTuple):TurnCompletionRecord {
    const record=turnCompletionRecordSchema.parse(raw);
    invariant(record.actorId===tuple.actorId&&record.sessionId===tuple.sessionId&&record.conversationId===tuple.conversationId&&record.turnId===tuple.turnId&&record.mode===tuple.mode&&record.modeRevision===tuple.modeRevision,
      'TURN_COMPLETION_INVALID','The completion record does not match this exact turn',409);
    return record;
  }
  private async completedResponse(actor:Actor,request:TurnRequest,versionedReplay=true):Promise<TurnResponse> {
    const tuple=this.completionTuple(request,{conversationId:request.conversationId,turnId:request.turnId});
    const verified=await readCompletedTurn(this.store,tuple);
    invariant(verified.kind==='completed'&&verified.record.origin==='chat'&&verified.request?.id===request.id,
      'TURN_REQUEST_FAILED','The original turn has no verified completed response',409);
    const workspace=await this.getWorkspace(actor);
    const message=workspace.messages.find(item=>item.id===verified.assistant.id&&item.conversationId===request.conversationId&&item.turnId===request.turnId&&item.sessionId===actor.sessionId&&item.role==='assistant');
    invariant(message,'TURN_REQUEST_FAILED','The original response is unavailable under current permissions',409);
    const refs=new Set(normalizedFinalActionIds(verified.assistant));
    const actions=workspace.actions.filter(action=>refs.has(action.id)&&action.actorId===actor.id&&action.sessionId===actor.sessionId&&action.conversationId===request.conversationId&&action.turnId===request.turnId);
    const actionIds=new Set(actions.map(action=>action.id));
    const receipts=workspace.receipts.filter(receipt=>actionIds.has(receipt.actionId));
    return{conversationId:request.conversationId,turnId:request.turnId,assistantMessageId:message.id,message:message.text,mode:message.mode,...(versionedReplay?{contractVersion:2,replayed:true}:{}),
      ...(message.analysis?{analysis:message.analysis}:{}),...(message.evidence?{evidence:message.evidence}:{}),...(message.sources?{sources:message.sources}:{}),
      ...(message.artifacts?{artifacts:message.artifacts}:{}),...(message.choices?{choices:message.choices}:{}),...(message.hint?{hint:message.hint}:{}),...(message.receiptCards?{receiptCards:message.receiptCards}:{}),
      ...(actions.length?{pendingAction:actions[actions.length-1],pendingActions:actions}:{}),...(receipts.length?{receipt:receipts[receipts.length-1],receipts}:{})};
  }
  private async emitStreamDelta(options:TurnStreamOptions|undefined,text:string,signal?:AbortSignal):Promise<void> {
    const activeSignal=signal??options?.signal;
    if(activeSignal?.aborted)throw abortReason(activeSignal);
    if(text){
      const delivery=Promise.resolve(options?.onTextDelta?.(text));
      if(activeSignal)await awaitWithAbort(delivery,activeSignal);else await delivery;
    }
  }
  /** Explicit action-registry risk tier: owner-only reversible creations skip the confirmation step. */
  private isPrivateDirect(action:Pick<PendingAction,'payload'>):boolean {
    if(this.reviewPrivateCreations)return false;
    try{return this.catalog.action(action.payload.kind).riskTier==='private_reversible';}catch{return false;}
  }
  /** Creates private, reversible items directly after the prepared turn completes; the same validated confirm path runs (permission, scope, pins, audit). */
  private async createPrivateDirectly(actor:Actor,context:{conversationId:string;turnId:string},answer:TurnResponse,requestId:string):Promise<void>{
    const all=answer.pendingActions??(answer.pendingAction?[answer.pendingAction]:[]);
    const prepared=all.filter(action=>action.status==='pending'&&this.isPrivateDirect(action));
    if(!prepared.length||prepared.length!==all.length)return;
    const receipts:ReceiptView[]=[],completed=new Map<string,PendingAction>();
    for(const action of prepared){
      try{
        const receipt=await this.confirm(actor,action.id);receipts.push(receipt);
        const stored=await this.store.get<PendingAction>('pending_actions',action.id);if(stored)completed.set(action.id,stored);
      }catch(error){
        if(!(error instanceof DomainError))throw error;
      }
    }
    if(completed.size)answer.pendingActions=all.map(action=>completed.get(action.id)??action);
    if(answer.pendingAction&&completed.has(answer.pendingAction.id))answer.pendingAction=completed.get(answer.pendingAction.id);
    if(receipts.length){answer.receipts=receipts;answer.receipt=receipts[receipts.length-1];}
    if(completed.size===prepared.length)return;
    // Creation did not complete: tell the truth and leave the proposal available for manual confirmation.
    const text=PRIVATE_CREATE_FAILED_TEXT;
    answer.message=text;
    await this.bookkeeping(async tx=>{
      const finalRequest=turnRequestCompletionProofSchema.parse(await tx.get('tool_executions',requestId));
      const finalActor=await reloadActor(tx,actor,this.now());
      const tuple=this.completionTuple(finalRequest,context),completion=this.exactCompletion(await tx.get('tool_executions',turnCompletionId(tuple)),tuple);
      const linked=await this.linkAssistant(tx,finalActor,context,{text});
      const refs=normalizedFinalActionIds(linked.message),finalDigest=finalAssistantContentDigest(linked.message,refs);
      await tx.put('tool_executions',{...finalRequest,status:'completed',finalContentDigest:finalDigest,finalActionIds:refs});
      await tx.put('tool_executions',turnCompletionRecordSchema.parse({...completion,status:'completed',assistantMessageId:linked.message.id,finalContentDigest:finalDigest,finalActionIds:refs}));
    });
  }
  private async linkAssistant(tx:Transaction,actor:Actor,context:{conversationId:string;turnId:string},content?:Pick<ConversationMessage,'text'|'analysis'|'evidence'|'sources'|'receiptId'>):Promise<{message:ConversationMessage;actions:PendingAction[]}> {
    this.activeConversation(await this.conversation(tx,actor,context.conversationId));
    const actions=(await tx.list<PendingAction>('pending_actions',{actorId:actor.id})).filter(a=>a.sessionId===actor.sessionId&&a.conversationId===context.conversationId&&a.turnId===context.turnId);
    const actionIds=new Set(actions.map(a=>a.id));
    // Legacy repair uses an exact persisted action reference, never neighboring prose or timestamps.
    const candidates=(await tx.list<ConversationMessage>('conversation_messages',{actorId:actor.id})).filter(m=>m.conversationId===context.conversationId&&m.role==='assistant'&&
      ((m.turnId===context.turnId&&m.sessionId===actor.sessionId)||[...(m.pendingActionIds??[]),...(m.pendingActionId?[m.pendingActionId]:[])].some(actionId=>actionIds.has(actionId))));
    invariant(candidates.length<=1,'CONFLICT','ข้อความคำขอเดิมมีข้อมูลอ้างอิงไม่ตรงกัน',409);
    const messageId=candidates[0]?.id??this.assistantMessageId(actor,context),existing=candidates[0]??await tx.get<ConversationMessage>('conversation_messages',messageId);
    if(existing){
      invariant(existing.actorId===actor.id&&existing.conversationId===context.conversationId&&existing.role==='assistant'&&(!existing.turnId||existing.turnId===context.turnId)&&(!existing.sessionId||existing.sessionId===actor.sessionId),'CONFLICT','ข้อความคำขอเดิมมีข้อมูลอ้างอิงไม่ตรงกัน',409);
      invariant([...(existing.pendingActionIds??[]),...(existing.pendingActionId?[existing.pendingActionId]:[])].every(actionId=>actionIds.has(actionId)),'CONFLICT','ข้อความคำขอเดิมมีข้อมูลอ้างอิงไม่ตรงกัน',409);
    }
    const refs=actions.map(a=>a.id),message:ConversationMessage={...existing,id:messageId,...context,actorId:actor.id,sessionId:actor.sessionId,role:'assistant',text:existing?.text??'เตรียมคำขอแล้ว ยังไม่ได้ดำเนินการ — โปรดตรวจตัวอย่างและยืนยัน',mode:existing?.mode??actor.mode,modeRevision:existing?.modeRevision??actor.modeRevision,createdAt:existing?.createdAt??this.now().toISOString(),...content,...(refs.length?{pendingActionId:refs[refs.length-1],pendingActionIds:refs}:{})};
    await tx.put('conversation_messages',message);return{message,actions};
  }
  private async prepareInTransaction(tx:Transaction,actor:Actor,payload:ActionPayload,context:{conversationId?:string;turnId?:string}={},metadata?:{
    actionId?:string;predecessorActionId?:string;revisionDiff?:string[];
  }):Promise<PendingAction>{
    const current=await reloadActor(tx,actor,this.now());invariant(current.modeRevision===actor.modeRevision&&current.mode===actor.mode,'STALE_ACTION','โหมดเปลี่ยน กรุณาขอตัวอย่างใหม่',409);
    const snapshot=await this.validate(tx,current,payload,context.conversationId,true),binding=this.catalog.action(payload.kind);
    for(const permission of this.catalog.readPermissions(binding.packIds))requirePermission(current,permission);
    if(payload.kind==='dashboard_create')assertDashboardRendererSupport(payload.spec);
    for(const claimed of (await tx.list<PendingAction>('pending_actions')).filter(a=>a.actorId===current.id&&a.status==='claimed'&&a.payload.kind===payload.kind)){
      if(!binding.overlaps(payload,claimed.payload))continue;const prior=await tx.get<Receipt>('action_executions','execution_'+claimed.id);
      const unresolved=prior?.results.filter(r=>r.status==='pending').map(r=>r.targetId)??binding.targetIds(claimed.payload);
      invariant(!binding.targetIds(payload).some(target=>unresolved.includes(target)),'PENDING_EFFECT','มีผลเดิมที่ยังไม่ทราบสถานะ กรุณาตรวจผลก่อน',409);
    }
    const conversationId=context.conversationId??id('conversation'),turnId=context.turnId??id('turn'),turnContext={conversationId,turnId};
    const conversation=await this.conversation(tx,current,context.conversationId);this.activeConversation(conversation);if(!conversation)await tx.put('conversations',this.conversationUpdate(current,conversationId));
    const tuple=this.completionTuple({actorId:current.id,sessionId:current.sessionId,mode:current.mode,modeRevision:current.modeRevision},turnContext),completionId=turnCompletionId(tuple),rawCompletion=await tx.get('tool_executions',completionId);
    let completion:TurnCompletionRecord|undefined,standalone=false;
    if(rawCompletion!==undefined){
      completion=this.exactCompletion(rawCompletion,tuple);
      invariant(completion.origin==='chat'&&completion.status==='started'&&completion.requestLedgerId!==null,
        'TURN_NOT_COMPLETED','A chat action can only be prepared while its exact turn is started',409);
      const request=turnRequestCompletionProofSchema.safeParse(await tx.get('tool_executions',completion.requestLedgerId));
      invariant(request.success&&request.data.id===completion.requestLedgerId&&request.data.status==='started'&&request.data.actorId===tuple.actorId&&request.data.sessionId===tuple.sessionId&&request.data.conversationId===tuple.conversationId&&request.data.turnId===tuple.turnId&&request.data.mode===tuple.mode&&request.data.modeRevision===tuple.modeRevision,
        'TURN_NOT_COMPLETED','A chat action requires its exact started request ledger',409);
    }else{
      const priorUser=await tx.get<ConversationMessage>('conversation_messages',turnId);
      const priorAssistants=(await tx.list<ConversationMessage>('conversation_messages',{actorId:current.id})).some(item=>item.sessionId===current.sessionId&&item.conversationId===conversationId&&item.role==='assistant'&&item.turnId===turnId);
      const priorActions=(await tx.list<PendingAction>('pending_actions',{actorId:current.id})).some(item=>item.sessionId===current.sessionId&&item.conversationId===conversationId&&item.turnId===turnId);
      invariant(!priorUser&&!priorAssistants&&!priorActions,'TURN_NOT_COMPLETED','A missing chat completion marker cannot be recreated for an existing turn',409);
      standalone=true;
    }
    const revisionFields=metadata?.predecessorActionId===undefined?{}:{
      predecessorActionId:metadata.predecessorActionId,
      revisionDiff:pendingActionRevisionDiffSchema.parse(metadata.revisionDiff),
    };
    const actionId=metadata?.actionId??id('action');
    invariant(!await tx.get('pending_actions',actionId),'CONFLICT','The action identity is already in use',409);
    if(!metadata?.predecessorActionId){
      // Identical pending proposals (same canonical payload) collapse into one: older duplicates are superseded.
      const canonical=digest(payload);
      for(const old of await tx.list<PendingAction>('pending_actions',{actorId:current.id}))
        if(old.status==='pending'&&old.actorId===current.id&&old.payload.kind===payload.kind&&digest(old.payload)===canonical)
          await tx.put('pending_actions',{...old,status:'stale',staleReason:'superseded',supersededByActionId:actionId});
    }
    const badgeBranch=payload.kind==='badge_revoke'&&snapshot.display?.badge?.employeeBranchId
      ?await tx.get<Branch>('branches',snapshot.display.badge.employeeBranchId):undefined;
    const action:PendingAction={id:actionId,actorId:current.id,sessionId:current.sessionId,conversationId,turnId,mode:current.mode,modeRevision:current.modeRevision,payload,payloadHash:'',evidenceVersion:snapshot.version,packs:this.catalog.pins(binding.packIds),receiptAccess:{readPermissions:this.catalog.readPermissions(binding.packIds),regions:[...new Set(snapshot.evidence?.branches.map(b=>b.region)??(badgeBranch?[badgeBranch.region]:[]))]},releaseRevision:this.releaseRevision,actionContractVersion:1,approvalDisplay:{...snapshot.display,...(snapshot.evidence?{branches:snapshot.evidence.branches.map(b=>({id:b.branchId,name:b.branchName}))}:{})},...(snapshot.evidence?{approvalScope:{...snapshot.evidence.scope,branchIds:snapshot.evidence.branches.map(b=>b.branchId)}}:{}),...revisionFields,createdAt:this.now().toISOString(),expiresAt:new Date(this.now().getTime()+PENDING_ACTION_TTL_MS).toISOString(),status:'pending',preview:boundedActionPreview(payload)};
    action.payloadHash=this.approvalHash(action);await tx.put('pending_actions',action);
    // The durable proposal and its assistant anchor commit together, before final AI prose.
    const linked=await this.linkAssistant(tx,current,turnContext);
    if(standalone){
      const refs=normalizedFinalActionIds(linked.message),finalDigest=finalAssistantContentDigest(linked.message,refs);
      await tx.put('tool_executions',turnCompletionRecordSchema.parse({id:completionId,name:'chat.turn_completion',schemaVersion:1,origin:'standalone_prepare',requestLedgerId:null,...tuple,status:'completed',createdAt:this.now().toISOString(),assistantMessageId:linked.message.id,finalContentDigest:finalDigest,finalActionIds:refs}));
    }
    await this.audit(tx,current,'prepare','เตรียม '+payload.kind+' — ยังไม่ดำเนินการ',action.id,snapshot.evidence?.scope.region);return action;
  }
  async prepare(actor:Actor,input:ActionPayload,context:{conversationId?:string;turnId?:string}={}):Promise<PendingAction>{
    const payload=actionPayloadSchema.parse(input) as ActionPayload;
    return this.store.transaction(tx=>this.prepareInTransaction(tx,actor,payload,context));
  }
  async revisePendingAction(actor:Actor,baseActionId:string,strictPatch:unknown,requestKey:string):Promise<PendingActionRevisionResult>{
    const baseId=z.string().min(1).max(160).parse(baseActionId),key=actionRevisionRequestKeySchema.parse(requestKey);
    return this.bookkeeping(tx=>this.revisePendingActionInTransaction(tx,actor,baseId,strictPatch,key));
  }
  private async revisePendingActionInTransaction(tx:Transaction,actor:Actor,baseId:string,strictPatch:unknown,requestKey:string,
    chatContext?:{conversationId:string;turnId:string}):Promise<PendingActionRevisionResult>{
      const key=actionRevisionRequestKeySchema.parse(requestKey);
      const current=await reloadActor(tx,actor,this.now()),predecessor=await tx.get<PendingAction>('pending_actions',baseId);
      invariant(predecessor&&predecessor.actorId===current.id,
        'NOT_FOUND','ไม่พบรายการที่แก้ไขได้ในเซสชันนี้',404);
      const toolName='dashboard.prepare_create',descriptor=this.catalog.descriptor(toolName);
      invariant(descriptor&&this.catalog.tools.has(toolName)&&this.catalog.allowsTool(current,toolName),
        'FORBIDDEN','สิทธิ์ปัจจุบันไม่อนุญาตให้เตรียม Dashboard',403);
      const binding=this.catalog.action('dashboard_create');
      for(const permission of this.catalog.readPermissions(binding.packIds))requirePermission(current,permission);
      const parsedPayload=actionPayloadSchema.safeParse(predecessor.payload);
      invariant(parsedPayload.success&&parsedPayload.data.kind==='dashboard_create',
      'ACTION_REVISION_UNSUPPORTED','รองรับการแก้ไขเฉพาะข้อเสนอสร้าง Dashboard',409);
      this.activeConversation(await this.conversation(tx,current,predecessor.conversationId));
      const currentContext=this.context(tx,current,predecessor.conversationId,true);
      invariant(await binding.visible(currentContext,parsedPayload.data),
        'FORBIDDEN','ข้อเสนอเดิมอยู่นอกขอบเขตที่ได้รับอนุญาตในปัจจุบัน',403);
      invariant(!chatContext||predecessor.conversationId===chatContext.conversationId,
        'STALE_ACTION','ข้อเสนอเดิมไม่ได้อยู่ในบทสนทนาปัจจุบัน กรุณาโหลดสถานะใหม่',409);
      invariant(predecessor.actionContractVersion===undefined||predecessor.actionContractVersion===1,
        'ACTION_REVISION_UNSUPPORTED','รองรับการแก้ไขเฉพาะข้อเสนอสร้าง Dashboard',409);
      let replaySuccessor:PendingAction|undefined;
      if(predecessor.supersededByActionId){
        const successor=await tx.get<PendingAction>('pending_actions',predecessor.supersededByActionId);
        invariant(successor&&successor.actorId===current.id&&
          successor.conversationId===predecessor.conversationId&&successor.payload.kind==='dashboard_create',
        'ACTION_REVISION_STATE_INVALID','ไม่พบข้อเสนอฉบับใหม่ที่ตรวจสอบได้',409);
        invariant(await binding.visible(currentContext,successor.payload),
          'FORBIDDEN','ข้อเสนอฉบับใหม่อยู่นอกขอบเขตที่ได้รับอนุญาตในปัจจุบัน',403);
        replaySuccessor=successor;
      }
      const {spec,diff}=createDashboardRevision(parsedPayload.data.spec,strictPatch);
      const revisedPayload=actionPayloadSchema.parse({kind:'dashboard_create',spec});
      invariant(predecessor.payloadHash===this.approvalHash(predecessor),
        'STALE_ACTION','ข้อมูลของข้อเสนอเดิมถูกเปลี่ยน',409);
      await assertCompletedActionTurn(tx,{id:predecessor.id,...this.completionTuple(predecessor,{conversationId:predecessor.conversationId,turnId:predecessor.turnId})});

      if(predecessor.supersededByActionId){
        invariant(!chatContext,'STALE_ACTION','ข้อเสนอเดิมถูกแทนที่แล้ว กรุณาโหลดสถานะปัจจุบัน',409);
        invariant(predecessor.status==='stale'&&predecessor.staleReason==='superseded',
          'ACTION_REVISION_STATE_INVALID','สายการแก้ไขของข้อเสนอเดิมไม่สอดคล้องกัน',409);
        const successor=replaySuccessor;
        invariant(successor&&successor.predecessorActionId===predecessor.id&&
          successor.payloadHash===this.approvalHash(successor),
        'ACTION_REVISION_STATE_INVALID','ไม่พบข้อเสนอฉบับใหม่ที่ตรวจสอบได้',409);
        await assertCompletedActionTurn(tx,{id:successor.id,...this.completionTuple(successor,{conversationId:successor.conversationId,turnId:successor.turnId})});
        invariant(digest(successor.payload)===digest(revisedPayload),
          'ACTION_REVISION_CONFLICT','รายการนี้ถูกแก้ไขด้วยข้อมูลต่างกัน กรุณาโหลดสถานะใหม่',409);
        const storedDiff=pendingActionRevisionDiffSchema.parse(successor.revisionDiff);
        if(successor.status==='pending'){
          invariant(predecessor.mode===current.mode&&predecessor.modeRevision===current.modeRevision&&predecessor.releaseRevision===this.releaseRevision&&
            successor.mode===current.mode&&successor.modeRevision===current.modeRevision&&
            successor.releaseRevision===this.releaseRevision&&new Date(successor.expiresAt)>this.now(),
          'STALE_ACTION','ข้อเสนอฉบับใหม่เปลี่ยนโหมด รุ่น หรือหมดอายุ กรุณาโหลดสถานะใหม่',409);
          this.catalog.assertPins(successor.packs);
          const currentSnapshot=await this.validate(tx,current,successor.payload,successor.conversationId,true);
          invariant(currentSnapshot.version===successor.evidenceVersion,
            'STALE_ACTION','หลักฐานของข้อเสนอฉบับใหม่เปลี่ยน กรุณาโหลดสถานะใหม่',409);
        }
        return{predecessor,replacement:successor,diff:storedDiff};
      }

      const idForRequest=revisionActionId(current.id,current.sessionId,predecessor.id,key);
      invariant(!await tx.get('pending_actions',idForRequest),
        'ACTION_REVISION_STATE_INVALID','พบข้อเสนอฉบับใหม่ที่ไม่มีสายการแก้ไขสมบูรณ์',409);
      invariant(predecessor.status==='pending','STALE_ACTION','ข้อเสนอเดิมไม่อยู่ในสถานะรอการตรวจสอบ',409);
      invariant(predecessor.mode===current.mode&&predecessor.modeRevision===current.modeRevision,
        'STALE_ACTION','โหมดเปลี่ยน กรุณาสร้างข้อเสนอใหม่',409);
      invariant(new Date(predecessor.expiresAt)>this.now(),'EXPIRED_ACTION','ข้อเสนอเดิมหมดอายุแล้ว',409);
      invariant(predecessor.releaseRevision===this.releaseRevision,'STALE_ACTION','รุ่นบริการเปลี่ยน กรุณาสร้างข้อเสนอใหม่',409);
      this.catalog.assertPins(predecessor.packs);
      const baseSnapshot=await this.validate(tx,current,parsedPayload.data,predecessor.conversationId,true);
      invariant(baseSnapshot.version===predecessor.evidenceVersion,
        'STALE_ACTION','หลักฐานของข้อเสนอเดิมเปลี่ยน กรุณาสร้างข้อเสนอใหม่',409);
      const replacement=await this.prepareInTransaction(tx,current,revisedPayload,
        {conversationId:predecessor.conversationId,turnId:chatContext?.turnId??id('turn')},
        {actionId:idForRequest,predecessorActionId:predecessor.id,revisionDiff:diff});
      const finalActor=await reloadActor(tx,current,this.now());
      invariant(finalActor.sessionId===current.sessionId&&finalActor.mode===current.mode&&finalActor.modeRevision===current.modeRevision,
        'STALE_ACTION','เซสชันหรือโหมดเปลี่ยนระหว่างเตรียมข้อเสนอฉบับใหม่',409);
      requirePermission(finalActor,'dashboard.create');
      for(const permission of this.catalog.readPermissions(binding.packIds))requirePermission(finalActor,permission);
      invariant(releaseRevision()===this.releaseRevision,'STALE_ACTION','ซอร์สบริการเปลี่ยนระหว่างเตรียมข้อเสนอฉบับใหม่',409);
      const currentPredecessor=await tx.get<PendingAction>('pending_actions',predecessor.id);
      invariant(currentPredecessor&&currentPredecessor.actorId===finalActor.id&&
        currentPredecessor.conversationId===predecessor.conversationId&&currentPredecessor.status==='pending'&&
        currentPredecessor.mode===finalActor.mode&&currentPredecessor.modeRevision===finalActor.modeRevision&&
        currentPredecessor.releaseRevision===this.releaseRevision&&currentPredecessor.payloadHash===predecessor.payloadHash&&new Date(currentPredecessor.expiresAt)>this.now(),
      'ACTION_REVISION_CONFLICT','ข้อเสนอเดิมเปลี่ยนระหว่างเตรียมฉบับใหม่ กรุณาตรวจสถานะอีกครั้ง',409);
      this.catalog.assertPins(currentPredecessor.packs);
      this.activeConversation(await this.conversation(tx,finalActor,currentPredecessor.conversationId));
      const finalSnapshot=await this.validate(tx,finalActor,replacement.payload,currentPredecessor.conversationId,true);
      invariant(finalSnapshot.version===replacement.evidenceVersion,
        'STALE_ACTION','หลักฐานของข้อเสนอฉบับใหม่เปลี่ยนระหว่างเตรียม กรุณาขอตัวอย่างใหม่',409);
      const superseded:PendingAction={...currentPredecessor,status:'stale',supersededByActionId:replacement.id,staleReason:'superseded'};
      await tx.put('pending_actions',superseded);
      await this.audit(tx,finalActor,'revise','ข้อเสนอเดิมถูกแทนที่ด้วยฉบับใหม่',predecessor.id,predecessor.approvalScope?.region);
      return{predecessor:superseded,replacement,diff};
  }
  /** Undo for a directly created private dashboard: owner only, never while it is shared with someone else. */
  async deleteDashboard(actor:Actor,dashboardId:string,guard:{fence?:(tx:Transaction)=>Promise<void>}={}):Promise<{dashboardId:string;deletedAt:string}>{
    const parsedId=z.string().min(1).max(160).parse(dashboardId);
    return this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now()),dashboard=await tx.get<Dashboard>('dashboards',parsedId);
      invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard ที่ลบได้',404);
      await guard.fence?.(tx);
      invariant(!(await this.dashboardHasActiveShare(tx,parsedId)),'CONFLICT','Dashboard นี้ถูกแชร์ให้ผู้อื่นแล้ว ลบไม่ได้จากหน้านี้',409);
      const deletedAt=this.now().toISOString();
      await tx.put('dashboards',{...dashboard,updatedAt:deletedAt,deletedAt} as Dashboard);
      await this.audit(tx,current,'delete','ลบ Dashboard ส่วนตัว',parsedId,dashboard.spec.scope.region);
      return{dashboardId:parsedId,deletedAt};
    });
  }
  /**
   * Owner-only organization of one Dashboard (pin / unpin / archive / restore / duplicate). Private and reversible => direct (also when the Dashboard is shared:
   * these change only the owner's own library view, never what a recipient sees). Duplicate creates a NEW private Dashboard with the same declarative widgets,
   * re-checked under the owner's CURRENT authority; shares, pin and archive state are not copied.
   */
  async organizeDashboard(actor:Actor,dashboardId:string,input:{op:'pin'|'unpin'|'archive'|'restore'|'duplicate'}):Promise<{dashboardId:string;op:typeof input.op;pinnedAt?:string;archivedAt?:string}>{
    const op=z.enum(['pin','unpin','archive','restore','duplicate']).parse(input.op),parsedId=z.string().min(1).max(160).parse(dashboardId);
    await this.organizeDashboardPreflight(actor,parsedId,op);
    return this.bookkeeping(tx=>this.organizeDashboardInTx(tx,actor,parsedId,op));
  }
  /** Fresh authority and (duplicate) the widget scope re-check under the owner's CURRENT authority, before any write. */
  private async organizeDashboardPreflight(actor:Actor,parsedId:string,op:DashboardOrganizeOp):Promise<void>{
    const preflight=await reloadActor(this.store,actor,this.now());requirePermission(preflight,'sales.read');
    if(op==='duplicate'){requirePermission(preflight,'dashboard.create');const source=await this.store.get<Dashboard>('dashboards',parsedId);invariant(!!source&&source.ownerId===preflight.id&&!isDeletedDashboard(source),'NOT_FOUND','ไม่พบ Dashboard',404);await this.assertWidgetsFitScope(preflight,id('dash'),source!.spec);}
  }
  /** The organization rules (owner, permission, not deleted, no pin while archived, duplicate quota) over `reader`; returns the Dashboard and the fresh actor. */
  private async organizeDashboardRules(reader:Reader,actor:Actor,parsedId:string,op:DashboardOrganizeOp):Promise<{current:Actor;dashboard:Dashboard}>{
    const current=await reloadActor(reader,actor,this.now());requirePermission(current,'sales.read');
    const dashboard=await reader.get<Dashboard>('dashboards',parsedId);invariant(!!dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
    if(op==='duplicate'){
      requirePermission(current,'dashboard.create');
      invariant((await reader.list<Dashboard>('dashboards')).filter(d=>d.ownerId===current.id&&!isDeletedDashboard(d)).length<MAX_OWNED_DASHBOARDS,'INVALID_INPUT','มี Dashboard มากเกินไป กรุณาเก็บถาวรหรือลบบางรายการก่อนทำสำเนา',400);
    }
    invariant(!(op==='pin'&&dashboard!.archivedAt),'CONFLICT','นำ Dashboard ที่เก็บถาวรกลับมาก่อนจึงจะปักหมุดได้',409);
    return{current,dashboard:dashboard!};
  }
  /**
   * The organization write in ONE transaction (UI route via bookkeeping; chat turn via its completion transaction). `copyId` fixes the
   * duplicate's id when the turn announced it before the write.
   */
  private async organizeDashboardInTx(tx:Transaction,actor:Actor,parsedId:string,op:DashboardOrganizeOp,copyId:string=id('dash')):Promise<{dashboardId:string;op:DashboardOrganizeOp;pinnedAt?:string;archivedAt?:string}>{
      const{current,dashboard}=await this.organizeDashboardRules(tx,actor,parsedId,op);
      const at=this.now().toISOString();
      if(op==='duplicate'){
        const title=[...`สำเนา — ${dashboard.spec.title}`].slice(0,120).join('');
        const rest:Dashboard&{operationKey?:string}={...dashboard};delete rest.pinnedAt;delete rest.archivedAt;delete rest.operationKey;
        await tx.put('dashboards',{...rest,id:copyId,spec:{...dashboard.spec,title},createdAt:at,updatedAt:at,lastRefreshAt:at} satisfies Dashboard);
        await this.audit(tx,current,'create','ทำสำเนา Dashboard ส่วนตัว',copyId,dashboard.spec.scope.region);
        return{dashboardId:copyId,op};
      }
      const rest:Dashboard={...dashboard};delete rest.pinnedAt;delete rest.archivedAt;
      const next:Dashboard=op==='pin'?{...rest,pinnedAt:dashboard.pinnedAt??at,...(dashboard.archivedAt?{archivedAt:dashboard.archivedAt}:{})}
        :op==='unpin'?{...rest,...(dashboard.archivedAt?{archivedAt:dashboard.archivedAt}:{})}
        :op==='archive'?{...rest,archivedAt:dashboard.archivedAt??at}
        :{...rest,...(dashboard.pinnedAt?{pinnedAt:dashboard.pinnedAt}:{})};
      await tx.put('dashboards',next);// organization metadata only: the spec, its revision and updatedAt are untouched
      await this.audit(tx,current,'update',op==='pin'?'ปักหมุด Dashboard':op==='unpin'?'เลิกปักหมุด Dashboard':op==='archive'?'เก็บ Dashboard ถาวร':'นำ Dashboard กลับมาใช้',parsedId,dashboard.spec.scope.region);
      return{dashboardId:parsedId,op,...(next.pinnedAt?{pinnedAt:next.pinnedAt}:{}),...(next.archivedAt?{archivedAt:next.archivedAt}:{})};
  }
  /**
   * Chat-turn organization (dashboard.manage, direct tier): the SAME preflight + rules as the UI route, checked now so the reply is truthful,
   * then written by organizeDashboardInTx inside the turn's completion transaction (never before durable completion).
   */
  private async organizeDashboardForTurn(actor:Actor,dashboardId:string,op:DashboardOrganizeOp,defer:(write:DeferredWrite)=>void):Promise<{dashboardId:string;title:string;unchanged?:true}>{
    const parsedOp=z.enum(['pin','unpin','archive','restore','duplicate']).parse(op),parsedId=z.string().min(1).max(160).parse(dashboardId);
    await this.organizeDashboardPreflight(actor,parsedId,parsedOp);
    const{dashboard}=await this.organizeDashboardRules(this.store,actor,parsedId,parsedOp);
    // G5: an op that would change nothing (restore of a Dashboard that was never archived, ...) is reported as such, never as done.
    const unchanged=parsedOp==='restore'?!dashboard.archivedAt:parsedOp==='archive'?!!dashboard.archivedAt:parsedOp==='pin'?!!dashboard.pinnedAt:parsedOp==='unpin'?!dashboard.pinnedAt:false;
    if(unchanged)return{dashboardId:parsedId,title:dashboard.spec.title,unchanged:true};
    const copyId=parsedOp==='duplicate'?id('dash'):undefined;
    defer(async(tx,finalActor)=>{
      await this.organizeDashboardInTx(tx,finalActor,parsedId,parsedOp,copyId);
      // Read back inside the SAME transaction: the turn's "done" reply commits only if the postcondition holds (else the whole turn fails, nothing is claimed).
      const after=await tx.get<Dashboard>('dashboards',copyId??parsedId);
      const holds=!!after&&after.ownerId===finalActor.id&&!isDeletedDashboard(after)&&(parsedOp==='pin'?!!after.pinnedAt:parsedOp==='unpin'?!after.pinnedAt
        :parsedOp==='archive'?!!after.archivedAt:parsedOp==='restore'?!after.archivedAt:after.id===copyId);
      invariant(holds,'EXECUTION_FAILED','ยังยืนยันผลการจัดระเบียบ Dashboard ไม่ได้',500);
    });
    return{dashboardId:copyId??parsedId,title:dashboard.spec.title};
  }
  async cancelPendingAction(actor:Actor,actionId:string):Promise<PendingAction>{
    const parsedActionId=z.string().min(1).max(160).parse(actionId);
    return this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now()),action=await tx.get<PendingAction>('pending_actions',parsedActionId);
      invariant(action&&action.actorId===current.id,
        'NOT_FOUND','ไม่พบรายการที่ยกเลิกได้ในเซสชันนี้',404);
      invariant(action.payloadHash===this.approvalHash(action),'STALE_ACTION','ข้อมูลของข้อเสนอถูกเปลี่ยน',409);
      await this.conversation(tx,current,action.conversationId);
      await assertCompletedActionTurn(tx,{id:action.id,...this.completionTuple(action,{conversationId:action.conversationId,turnId:action.turnId})});
      if(action.status==='stale'&&action.staleReason==='user_cancelled')return action;
      invariant(action.status==='pending','ACTION_NOT_CANCELLABLE','ยกเลิกได้เฉพาะข้อเสนอที่ยังรอการตรวจสอบ',409);
      const cancelled:PendingAction={...action,status:'stale',staleReason:'user_cancelled'};
      await tx.put('pending_actions',cancelled);
      await this.audit(tx,current,'cancel','user_cancelled',action.id,action.approvalScope?.region);
      return cancelled;
    });
  }
  /** Router extras of this actor's assistant turns, keyed by turn id. */
  private async turnExtras(actor:Actor):Promise<Map<string,{assistantMessageId:string;requiredPermissions:string[];content:Pick<ConversationMessage,'artifacts'|'choices'|'hint'|'followUps'|'receiptCards'>}>>{
    const rows=(await this.store.list<{name:string;actorId:string;turnId:string;assistantMessageId:string;artifacts?:ConversationMessage['artifacts'];choices?:ConversationMessage['choices'];hint?:ConversationMessage['hint'];followUps?:unknown;receiptCards?:ConversationMessage['receiptCards'];requiredPermissions?:string[]}>('tool_executions',{actorId:actor.id,status:'completed'}))
      .filter(row=>row.name===TURN_EXTRAS_TOOL&&row.actorId===actor.id);
    return new Map(rows.map(row=>[row.turnId,{assistantMessageId:row.assistantMessageId,requiredPermissions:Array.isArray(row.requiredPermissions)?row.requiredPermissions.filter((p):p is string=>typeof p==='string'):[],content:{...(row.artifacts?{artifacts:row.artifacts}:{}),...(row.choices?{choices:row.choices}:{}),...(row.hint?{hint:row.hint}:{}),...(Array.isArray(row.followUps)&&row.followUps.every(t=>typeof t==='string')?{followUps:(row.followUps as string[]).slice(0,3)}:{}),...(Array.isArray(row.receiptCards)&&row.receiptCards.length?{receiptCards:row.receiptCards.slice(0,4)}:{})}}]));
  }
  private async savedDashboardInfo(dashboardId:string):Promise<SavedDashboardInfo|undefined>{
    const dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);
    if(!dashboard)return undefined;
    const shared=await this.dashboardHasActiveShare(this.store,dashboardId);
    return{id:dashboard.id,ownerId:dashboard.ownerId,title:dashboard.spec.title,shared,deleted:isDeletedDashboard(dashboard),spec:dashboard.spec,revision:specRevision(dashboard.spec)};
  }
  private async dashboardHasActiveShare(reader:Reader,dashboardId:string):Promise<boolean>{
    if((await reader.list<Share>('dashboard_shares')).some(grant=>grant.dashboardId===dashboardId&&isActiveShareGrant(grant)))return true;
    // Workflow V2 shares carry the contract marker and are hidden from the legacy list: read them through the projection reader.
    const projections=(this.store as {workflowProjectionReader?:{query:(query:{kind:'scoped';table:'dashboard_shares';equals:{dashboardId:string};status:string;limit:number})=>Promise<unknown[]>}}).workflowProjectionReader;
    // SQLite keeps V2 rows visible to the legacy list (and a second connection would block inside its writer); only Supabase hides them.
    return projections&&this.store.adapter==='supabase'?(await projections.query({kind:'scoped',table:'dashboard_shares',equals:{dashboardId},status:'active',limit:1})).length>0:false;
  }
  /** Owner write guards, re-run INSIDE the writing transaction: base revision (CAS) and no active share unless the owner confirmed. */
  private async assertDashboardWritable(reader:Reader,dashboard:Dashboard,guard:DashboardWriteGuard):Promise<void>{
    invariant(guard.expectedRevision===undefined||guard.expectedRevision===specRevision(dashboard.spec),DASHBOARD_CHANGED_CODE,'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่',409);
    invariant(guard.allowShared===true||!(await this.dashboardHasActiveShare(reader,dashboard.id)),DASHBOARD_SHARED_CODE,'Dashboard นี้ถูกแชร์ให้ผู้อื่นแล้ว การแก้ไขต้องได้รับการยืนยันก่อน — ขอแก้ไขผ่านแชทเพื่อรับรายการให้ตรวจและยืนยัน',409);
  }
  /**
   * Explicit user confirmation of a router-staged proposal (dashboard delete; Wave 4 effects once bound). confirmProposal
   * claims the row (CAS) so only one confirmer executes. Fails closed when the store has no router_proposals table.
   */
  async confirmStagedProposal(actor:Actor,proposalId:string):Promise<ConfirmResult>{
    const parsedId=z.string().min(1).max(200).parse(proposalId);
    if(!await this.stagedTableAvailable())return{outcome:'denied',actionId:'unknown',code:'staged_unavailable',text:'รายการประเภทนี้ยังไม่เปิดให้ใช้งานในระบบนี้'};
    const outsideTurn=async():Promise<never>=>{throw new DomainError('FORBIDDEN','This operation is only available inside a chat turn',403);};
    const ports=createActionPorts({
      reloadActor:a=>reloadActor(this.store,a,this.now()),prepareTool:outsideTurn,revisePending:outsideTurn,
      confirmPending:(a,id)=>this.confirm(a,id),cancelPending:(a,id)=>this.cancelPendingAction(a,id),
      listPending:async(a,conversationId)=>(await this.store.list<PendingAction>('pending_actions',{actorId:a.id})).filter(item=>item.actorId===a.id&&item.conversationId===conversationId),
      getDashboard:(_a,dashboardId)=>this.savedDashboardInfo(dashboardId),
      dashboardShares:(a,dashboardId)=>this.dashboardShares(a,dashboardId),
      revokeDashboardShare:(a,dashboardId,shareId,guard)=>this.revokeDashboardShare(a,dashboardId,shareId,guard),
      renameDashboard:async(a,dashboardId,input,guard)=>{const view=await this.renameDashboard(a,dashboardId,input,guard);return{id:dashboardId,title:view.dashboard.spec.title};},
      deleteDashboard:(a,dashboardId,guard)=>this.deleteDashboard(a,dashboardId,guard),
      updateDashboardSpec:(a,dashboardId,spec,guard)=>this.updateDashboardSpec(a,dashboardId,spec,guard),
      stagedTurnCompleted:(a,proposal)=>this.stagedTurnCompleted(a,proposal),
      recipientAllowed:(a,recipientId)=>this.recipientAllowed(a,recipientId),
      staged:createStagedStore(this.store,{now:()=>this.now().getTime()}),
      effects:{...this.effectBindings(),...await this.directorWorkflowSource().then(director=>director?{directorWorkflow:director}:{})},
    });
    return confirmProposal({ports,actor,proposalId:parsedId,now:()=>this.now()});
  }
  async confirm(actor:Actor,actionId:string):Promise<ReceiptView>{
    const operationId='execution_'+actionId;const existing=await this.store.get<Receipt>('action_executions',operationId);if(existing){invariant(existing.actorId===actor.id,'NOT_FOUND','ไม่พบผลการดำเนินงาน',404);return this.reconcile(actor,operationId);}
    const claimed=await this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now()),action=await tx.get<PendingAction>('pending_actions',actionId);invariant(action&&action.actorId===current.id,'NOT_FOUND','ไม่พบคำขอที่ยืนยันได้',404);
      const prior=await tx.get<Receipt>('action_executions',operationId);if(prior)return{action,prior:true};
      await assertCompletedActionTurn(tx,{id:action.id,...this.completionTuple(action,{conversationId:action.conversationId,turnId:action.turnId})});
      invariant(action.status==='pending'&&action.modeRevision===current.modeRevision&&action.mode===current.mode,'STALE_ACTION','ข้อเสนอนี้ยืนยันต่อไม่ได้ กรุณาตรวจสถานะและให้ระบบเตรียมข้อเสนอใหม่',409);
      invariant(new Date(action.expiresAt)>this.now(),'EXPIRED_ACTION','คำขอหมดอายุ',409);invariant(action.payloadHash===this.approvalHash(action),'STALE_ACTION','ข้อมูลที่ยืนยันถูกเปลี่ยน',409);this.catalog.assertPins(action.packs);
      invariant(action.releaseRevision===this.releaseRevision,'STALE_ACTION','ระบบมีการอัปเดต ข้อเสนอนี้ยืนยันต่อไม่ได้ กรุณาให้ระบบเตรียมข้อเสนอใหม่',409);
      invariant(releaseRevision()===this.releaseRevision,'STALE_ACTION','ระบบมีการอัปเดต ข้อเสนอนี้ยืนยันต่อไม่ได้ กรุณาให้ระบบเตรียมข้อเสนอใหม่',409);
      const snapshot=await this.validate(tx,current,action.payload,action.conversationId,true);invariant(snapshot.version===action.evidenceVersion,'STALE_ACTION','ข้อมูลที่ใช้เตรียมข้อเสนอเปลี่ยนแล้ว กรุณาให้ระบบเตรียมข้อเสนอใหม่',409);
      invariant(action.payload.kind!=='badge_revoke'||this.badgeDisplayMatches(action,snapshot),'STALE_ACTION','ข้อมูลบัตรที่ใช้ตรวจสอบยังไม่พร้อมหรือเปลี่ยนไป กรุณาให้ระบบเตรียมข้อเสนอใหม่',409);
      await this.assertNoDuplicateDashboardShare(tx,current,action);
      const receipt:Receipt={id:operationId,actionId,actorId:current.id,kind:action.payload.kind,status:'pending',createdAt:this.now().toISOString(),verifiedAt:null,results:this.catalog.action(action.payload.kind).targetIds(action.payload).map(targetId=>({targetId,id:null,status:'pending',detail:'รอตรวจผลจากระบบปลายทาง'}))};
      await tx.put('pending_actions',{...action,status:'claimed'});await tx.put('action_executions',receipt);await this.audit(tx,current,'confirm','ยืนยันข้อมูลตามตัวอย่างแล้ว',actionId,snapshot.evidence?.scope.region);return{action,prior:false};
    });
    if(!claimed.prior)for(const targetId of this.catalog.action(claimed.action.payload.kind).targetIds(claimed.action.payload)){
      try{await this.executeTarget(actor,claimed.action,operationId,targetId);}catch(error){
        if(error instanceof DomainError||this.knownNoCommit(error))await this.bookkeeping(async tx=>{
          const r=await tx.get<Receipt>('action_executions',operationId);if(r)await tx.put('action_executions',{...r,results:r.results.map(item=>item.targetId===targetId?{...item,status:'failed',detail:error instanceof DomainError?error.message:'การเปลี่ยนข้อมูลชนกัน ไม่มีผลปลายทางถูกเขียน กรุณาสร้างตัวอย่างใหม่'}:item)});
        });
        // Ambiguous transport outcomes stay pending; never replay target writes.
      }
    }
    return this.reconcile(actor,operationId);
  }
  private async executeTarget(actor:Actor,action:PendingAction,operationId:string,targetId:string):Promise<void>{
    // Re-runnable: every attempt re-validates evidence/pins/authority inside a fresh transaction; only a definite no-commit conflict is retried.
    await this.bookkeeping(async tx=>{
      invariant(releaseRevision()===this.releaseRevision,'STALE_ACTION','ซอร์สบริการเปลี่ยน ยังไม่ได้เขียนผลเป้าหมายนี้',409);
      const current=await reloadActor(tx,actor,this.now());this.catalog.assertPins(action.packs);
      const snapshot=await this.validate(tx,current,action.payload,action.conversationId,true);invariant(snapshot.version===action.evidenceVersion,'STALE_ACTION','หลักฐานเปลี่ยนระหว่างดำเนินงาน',409);
      invariant(action.payload.kind!=='badge_revoke'||this.badgeDisplayMatches(action,snapshot),'STALE_ACTION','Badge review changed before execution',409);
      const key=operationId+':'+targetId,recordId='effect_'+digest(key).slice(0,24),binding=this.catalog.action(action.payload.kind);
      const effect=await binding.execute({...this.context(tx,current,action.conversationId,true),tx,targetId,operationKey:key,recordId,conversationId:action.conversationId,evidence:snapshot.evidence,approvedPacks:action.packs},action.payload);
      z.object({recordId:z.string().min(1),dashboardId:z.string().min(1).optional()}).strict().parse(effect);
      const receipt=await tx.get<Receipt>('action_executions',operationId);invariant(receipt,'NOT_FOUND','ไม่พบการดำเนินงาน',404);
      await tx.put('action_executions',{...receipt,...(effect.dashboardId?{dashboardId:effect.dashboardId}:{}),results:receipt.results.map(r=>r.targetId===targetId?{...r,id:effect.recordId,detail:'ระบบปลายทางตอบรับ ยังต้องตรวจกลับ'}:r)});await this.audit(tx,current,'execute','ระบบ mock รับ '+action.payload.kind+' — รอ read-back',action.id,snapshot.evidence?.scope.region);
    });
  }
  async reconcile(actor:Actor,receiptId:string,readbackRevision?:string):Promise<ReceiptView>{
    return this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now()),receipt=await tx.get<Receipt>('action_executions',receiptId);invariant(receipt&&receipt.actorId===current.id,'NOT_FOUND','ไม่พบผลการดำเนินงาน',404);
      const action=await tx.get<PendingAction>('pending_actions',receipt.actionId);invariant(action,'NOT_FOUND','ไม่พบคำขอต้นทาง',404);invariant(action.payloadHash===this.approvalHash(action),'STALE_ACTION','ข้อมูลที่ยืนยันถูกเปลี่ยน',409);
      const view=await this.receiptView(current,action,receipt,tx);if(view.visibility==='restricted')return view;
      // Verification is a historical event; later destination changes never erase it.
      if(receipt.status!=='pending')return view;
      if(releaseRevision()!==this.releaseRevision)return view;
      if(this.needsCurrentReadback(action)){
        const token=this.readbackToken(action,receipt);
        if(!token||!readbackRevision)return view;
        invariant(readbackRevision===token,'STALE_ACTION','วิธีอ่านผลเปลี่ยน กรุณาโหลดสถานะใหม่',409);
        await this.audit(tx,current,'readback_revision',`อ่านผลสัญญา V1 เดิมด้วยรุ่นปัจจุบัน ${action.releaseRevision} → ${this.releaseRevision}`,action.id);
      }else if(readbackRevision)invariant(readbackRevision===this.readbackToken(action,receipt),'STALE_ACTION','วิธีอ่านผลเปลี่ยน กรุณาโหลดสถานะใหม่',409);
      const binding=this.catalog.action(action.payload.kind),readContext=this.context(tx,current,action.conversationId,true);
      const results:TargetResult[]=[];
      for(const old of receipt.results){
        const key=receipt.id+':'+old.targetId,recordId=old.id??'effect_'+digest(key).slice(0,24);
        const verified=await binding.verify({...readContext,evidence:undefined,targetId:old.targetId,recordId,operationKey:key,conversationId:action.conversationId,approvedPacks:action.packs},action.payload);
        results.push(verified?{...old,id:recordId,status:'verified_success',detail:'ตรวจข้อมูลปลายทางตรงกับข้อมูลที่ยืนยันแล้ว'+(action.payload.kind==='ticket_create'&&action.payload.plan?' · '+ticketPlanLines(action.payload.plan).join(' · '):'')}:old.status==='failed'?old:{...old,status:'pending',detail:'ยังยืนยันผลปลายทางไม่ได้ — ไม่เขียนซ้ำ'});
      }
      const pending=results.some(r=>r.status==='pending'),status=pending?'pending':results.every(r=>r.status==='verified_success')?'verified_success':'failed';
      const verified:Receipt={...receipt,results,status,verifiedAt:status==='verified_success'?(receipt.verifiedAt??this.now().toISOString()):null};
      if(digest(receipt)!==digest(verified)){await tx.put('action_executions',verified);if(!pending)await tx.put('pending_actions',{...action,status:'completed'});await this.audit(tx,current,'verify',action.payload.kind+': '+status,action.id);}
      return this.receiptView(current,action,verified,tx);
    });
  }
  async dashboard(actor:Actor,dashboardId:string,options:{vizData?:boolean}={}):Promise<{dashboard:Dashboard;revision:string;evidence:Evidence;analysisStale:boolean;sharedBy?:{name:string;role:Role};vizData?:VizWidgetResult[]}>{
    const current=await reloadActor(this.store,actor,this.now()),dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);invariant(dashboard&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);requirePermission(current,'sales.read');this.catalog.assertPins(dashboard.packs);
    const shareCeiling=dashboard.ownerId!==current.id?await this.dashboardShareCeiling(current,dashboard):undefined;
    let evidence=await this.queryEvidence(current,shareCeiling?.scope??dashboard.spec.scope);
    if(shareCeiling){
      const approvedBranchIds=new Set(shareCeiling.scope.branchIds??[]),approvedSourceIds=new Set(evidence.sources.filter(source=>shareCeiling.sourceIds.has(source.id)).map(source=>source.id));
      invariant(evidence.branches.length>0&&approvedSourceIds.size>0&&evidence.branches.every(branch=>approvedBranchIds.has(branch.branchId)&&branch.sourceIds.every(sourceId=>approvedSourceIds.has(sourceId)))&&
        evidence.sources.every(source=>approvedSourceIds.has(source.id)),'FORBIDDEN','No currently authorized evidence remains inside the approved dashboard share',403);
      evidence={...evidence,branches:evidence.branches.map(branch=>({...branch,sourceIds:branch.sourceIds.filter(sourceId=>approvedSourceIds.has(sourceId))})),sources:evidence.sources.filter(source=>approvedSourceIds.has(source.id))};
    }
    const sources=new Set(evidence.sources.map(s=>s.id));
    const shared=dashboard.ownerId!==current.id,sourcesReduced=dashboard.sourceMetadata.some(s=>!sources.has(s.id)),reduced=shared||sourcesReduced;
    // The sender's own title/description stay visible to a recipient unless the recipient's scope is narrower than the dashboard's
    // or sources were removed; only then does the generic scope-safe label replace them.
    const keepLabels=!sourcesReduced&&(!shared||dashboard.spec.scope.region.toLowerCase()===evidence.scope.region.toLowerCase());
    const widgets=keepLabels?dashboard.spec.widgets:dashboard.spec.widgets.map(w=>({...w,title:'metric'in w?w.metric:'ข้อมูลในขอบเขตที่ได้รับอนุญาต'}));
    const view:Dashboard={...dashboard,spec:{...dashboard.spec,scope:evidence.scope,...(keepLabels?{}:{title:'Dashboard ตามสิทธิ์ปัจจุบันของคุณ',description:'มุมมองเฉพาะภูมิภาคที่คุณได้รับอนุญาต'}),widgets},sourceMetadata:evidence.sources,lastRefreshAt:this.now().toISOString(),analysis:reduced?deterministicAnalysis(evidence,this.now()):dashboard.analysis};
    const owner=shared?await this.store.get<Profile>('profiles',dashboard.ownerId):undefined;
    // Evidence-bound viz widgets are re-queried on open under the VIEWER's fresh authority (never the owner's).
    const vizData=options.vizData!==false&&dashboard.spec.widgets.some(widget=>widget.type==='viz')
      ?await executeDashboardVizWidgets({store:this.store,viewer:current,now:()=>this.now(),businessDate:this.businessDate,read:(scope,signal)=>this.queryEvidence(current,scope,signal),diagnosticId:id('viz'),spec:dashboard.spec,
        // PC-01: a recipient's widgets can never read beyond the scope the owner's share approval covered (approved scope AND current authority).
        ...(shareCeiling?{ceiling:{region:shareCeiling.scope.region,date:shareCeiling.scope.date,branchIds:shareCeiling.scope.branchIds,sourceIds:[...shareCeiling.sourceIds]}}:{})}):undefined;
    return{dashboard:view,revision:specRevision(dashboard.spec),evidence,analysisStale:!reduced&&dashboard.evidenceVersion!==evidence.version,...(owner?{sharedBy:{name:owner.name,role:owner.role}}:{}),...(vizData?{vizData}:{})};
  }
  /** Direct, private edit of the owner's own UNSHARED dashboard label. A shared dashboard is only edited through a confirmed proposal (guard.allowShared). */
  async renameDashboard(actor:Actor,dashboardId:string,input:{title:string;description?:string},guard:DashboardWriteGuard={}){
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');
    const fields=this.parseRenameFields(input);
    await this.store.transaction(tx=>this.renameDashboardInTx(tx,current,dashboardId,fields,guard));
    return this.dashboard(current,dashboardId);
  }
  private parseRenameFields(input:{title:string;description?:string}){
    return{title:dashboardSpecSchema.shape.title.parse(input.title.trim()),description:input.description===undefined?undefined:dashboardSpecSchema.shape.description.parse(input.description.trim())};
  }
  private async renameDashboardInTx(tx:Transaction,current:Actor,dashboardId:string,fields:{title:string;description?:string},guard:DashboardWriteGuard):Promise<void>{
    const dashboard=await tx.get<Dashboard>('dashboards',dashboardId);invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
    await guard.fence?.(tx);
    await this.assertDashboardWritable(tx,dashboard,guard);
    await tx.put('dashboards',{...dashboard,spec:{...dashboard.spec,title:fields.title,...(fields.description===undefined?{}:{description:fields.description})},updatedAt:this.now().toISOString()} satisfies Dashboard);
    await this.audit(tx,current,'update','เปลี่ยนชื่อ Dashboard',dashboardId);
  }
  /** Owner-only replacement of a saved dashboard's widgets (scope unchanged). Specs come from the evidence-bound builder; renderer support is rechecked. */
  async updateDashboardSpec(actor:Actor,dashboardId:string,spec:unknown,guard:DashboardWriteGuard={}):Promise<{id:string;title:string}>{
    const next=dashboardSpecSchema.parse(spec);assertDashboardRendererSupport(next);
    await this.assertWidgetsFitScope(await reloadActor(this.store,actor,this.now()),dashboardId,next);
    return this.bookkeeping(async tx=>this.updateDashboardSpecInTx(tx,await reloadActor(tx,actor,this.now()),dashboardId,next,guard));
  }
  private async updateDashboardSpecInTx(tx:Transaction,current:Actor,dashboardId:string,next:z.infer<typeof dashboardSpecSchema>,guard:DashboardWriteGuard):Promise<{id:string;title:string}>{
    requirePermission(current,'sales.read');requirePermission(current,'dashboard.create');
    const dashboard=await tx.get<Dashboard>('dashboards',dashboardId);
    invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
    invariant(digest(dashboard.spec.scope)===digest(next.scope),'INVALID_INPUT','การปรับ Dashboard ต้องไม่เปลี่ยนขอบเขตข้อมูล',400);
    await guard.fence?.(tx);
    await this.assertDashboardWritable(tx,dashboard,guard);
    await tx.put('dashboards',{...dashboard,spec:next,updatedAt:this.now().toISOString()} satisfies Dashboard);
    await this.audit(tx,current,'update','ปรับ Widget  Dashboard',dashboardId);
    return{id:dashboardId,title:next.title};
  }
  private artifactAuthority(actor:Actor,catalogDigest:string){return{...queryAuthority(actor),catalogDigest};}
  /** Owner's explicit private save of an artifact version (reversible, owner-only => direct). Re-verifies digests + current authority. */
  async saveArtifact(actor:Actor,artifactId:string,options:{revision?:number;conversationId?:string}={}):Promise<{artifactId:string;revision:number;savedAt:string}>{
    const id_=z.string().min(1).max(200).parse(artifactId);
    const saved=await this.bookkeeping(async tx=>this.saveArtifactInTx(tx,await reloadActor(tx,actor,this.now()),id_,options));
    // Independent readback of the pointer after commit.
    const readback=await createArtifactReader(this.store,actor.id).head(id_);
    invariant(readback&&isArtifactSaved(readback)&&readback.savedAt,'ARTIFACT_READBACK_FAILED','ยังยืนยันไม่ได้ว่าบันทึกสำเร็จ',500);
    return{artifactId:id_,revision:saved.artifact.revision,savedAt:readback.savedAt!};
  }
  /** The shared save write (UI route and the AI result.manage action): authority + digests rechecked on load, then the saved pointer moves. */
  private async saveArtifactInTx(tx:Transaction,current:Actor,artifactId:string,options:{revision?:number;conversationId?:string}={}){
    requirePermission(current,'dashboard.create');
    const catalog=createSemanticCatalog(await tx.list<Branch>('branches'));
    const {artifact,head}=await loadStoredArtifact(tx,this.artifactAuthority(current,catalog.digest),artifactId,options.revision);
    invariant(!options.conversationId||head.conversationId===options.conversationId,'NOT_FOUND','ไม่พบผลลัพธ์ในบทสนทนานี้',404);
    const next=await markArtifactSaved(tx,{head,artifact,now:this.now().toISOString()});
    await this.audit(tx,current,'update','บันทึกผลลัพธ์ส่วนตัว');
    return{head:next,artifact};
  }
  /** CSV export of an owned artifact: authority + evidence/claim digests rechecked on load; formula-neutralized cells. */
  async exportArtifact(actor:Actor,artifactId:string,options:{revision?:number;conversationId?:string}={}):Promise<{filename:string;csv:string}>{
    const id_=z.string().min(1).max(200).parse(artifactId);
    return this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now());requirePermission(current,'dashboard.create');
      const catalog=createSemanticCatalog(await tx.list<Branch>('branches'));
      const {artifact,head}=await loadStoredArtifact(tx,this.artifactAuthority(current,catalog.digest),id_,options.revision);
      invariant(!options.conversationId||head.conversationId===options.conversationId,'NOT_FOUND','ไม่พบผลลัพธ์ในบทสนทนานี้',404);
      await this.audit(tx,current,'export','ส่งออก CSV ของผลลัพธ์ส่วนตัว');
      return{filename:artifactCsvFilename(artifact),csv:artifactCsv(artifact)};
    });
  }
  /** The actor's own artifacts (every conversation) with their immutable revisions: the reload list. */
  async artifactHistory(actor:Actor){return listArtifactHistory({store:this.store,actor,now:()=>this.now()});}
  /** The Results library: the owner's Results (revisions grouped, bounded) with display metadata. Owner-scoped; nothing of other owners is listed. */
  async resultsLibrary(actor:Actor){const current=await reloadActor(this.store,actor,this.now());return listResultItems(this.store,current.id);}
  /** One bounded page of the owner's Results: search/type/status are applied before the page boundary; `total` is the matching count (a lower bound only when `truncated`). */
  async resultsLibraryPage(actor:Actor,input:Parameters<typeof listResultsPage>[2]={}){const current=await reloadActor(this.store,actor,this.now());return listResultsPage(this.store,current.id,input);}
  /** Direct library operation (rename display title / pin / archive). Metadata only: the immutable versions, digests and shares are never touched. */
  async updateResult(actor:Actor,artifactId:string,input:unknown){
    const id_=z.string().min(1).max(200).parse(artifactId);
    return this.bookkeeping(async tx=>{const current=await reloadActor(tx,actor,this.now());const item=await applyResultOp(tx,current.id,id_,input,this.now().toISOString());await this.audit(tx,current,'update','จัดการคลังผลลัพธ์ส่วนตัว');return item;});
  }
  /** Owner write guard shared by every direct dashboard edit: the dashboard is the owner's, not deleted, still at the revision the client loaded, and not shared (shared edits stay confirm-tier in chat). */
  private async editableDashboard(current:Actor,dashboardId:string,baseRevision?:string):Promise<Dashboard>{
    const dashboard=await this.store.get<Dashboard>('dashboards',z.string().min(1).max(160).parse(dashboardId));
    invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
    invariant(baseRevision===undefined||specRevision(dashboard.spec)===baseRevision,DASHBOARD_CHANGED_CODE,'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่',409);
    return dashboard;
  }
  /** PC-10: the owner's CURRENT (active) shares of one Dashboard: exact grant ids with the recipient's display name. Owner only. */
  async dashboardShares(actor:Actor,dashboardId:string):Promise<{shareId:string;recipientId:string;recipientName:string;createdAt:string}[]>{
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');
    const dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);invariant(!!dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
    return (await this.dashboardShareRows(current,[dashboardId])).map(({dashboardId:_,...grant})=>{void _;return grant;});
  }
  /** One share list for all relevant dashboards; labels share the assignee directory formatter. */
  private async dashboardShareRows(current:Actor,dashboardIds:string[]){
    const ids=new Set(dashboardIds);
    const [grants,profiles]=await Promise.all([this.store.list<Share>('dashboard_shares'),this.store.list<Profile>('profiles')]);
    const labels=personLabels(profiles.filter(profile=>profile.id!==current.id));
    return grants.filter(grant=>ids.has(grant.dashboardId)&&grant.actorId===current.id&&isActiveShareGrant(grant))
      .map(grant=>({dashboardId:grant.dashboardId,shareId:grant.id,recipientId:grant.recipientId,recipientName:labels.get(grant.recipientId)??'ผู้ติดต่อ',createdAt:grant.createdAt}))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  private async dashboardShareContext(actor:Actor,dashboardIds:string[]){
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');
    const checks=await Promise.all(dashboardIds.map(async dashboardId=>{
      try{const d=await this.store.get<Dashboard>('dashboards',dashboardId);return!!d&&d.ownerId===current.id&&!isDeletedDashboard(d);}
      catch{return false;}
    }));
    const available=dashboardIds.filter((_,index)=>checks[index]);
    const unavailableDashboardIds=dashboardIds.filter((_,index)=>!checks[index]);
    try{return{shares:available.length?await this.dashboardShareRows(current,available):[],unavailableDashboardIds};}
    catch{return{shares:[],unavailableDashboardIds:dashboardIds};}
  }
  /**
   * PC-10: owner revokes ONE exact Dashboard share grant (direct tier: it only removes access). Idempotent, audited, and no other grant (other recipients,
   * other Dashboards, artifact shares) is touched. The recipient's next open fails because the current-share check no longer finds an active grant.
   */
  async revokeDashboardShare(actor:Actor,dashboardId:string,shareId:string,guard:Pick<DashboardWriteGuard,'fence'>={}):Promise<{shareId:string;alreadyRevoked:boolean}>{
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');
    const result=await this.bookkeeping(async tx=>{
      await guard.fence?.(tx);
      const live=await reloadActor(tx,current,this.now());requirePermission(live,'sales.read');
      const dashboard=await tx.get<Dashboard>('dashboards',dashboardId);invariant(!!dashboard&&dashboard.ownerId===live.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
      const grant=await tx.get<Share>('dashboard_shares',shareId);invariant(!!grant&&grant.dashboardId===dashboardId&&grant.actorId===live.id,'NOT_FOUND','ไม่พบการแชร์ที่ระบุ',404);
      if(!isActiveShareGrant(grant!))return{shareId,alreadyRevoked:true};
      await tx.put('dashboard_shares',{...grant!,active:false,revokedAt:this.now().toISOString(),revokedBy:live.id} as unknown as Share);
      await this.audit(tx,live,'revoke','เพิกถอนการแชร์ Dashboard ให้ผู้รับรายหนึ่ง',dashboardId);
      return{shareId,alreadyRevoked:false};
    });
    const after=await this.store.get<Share>('dashboard_shares',shareId);invariant(!!after&&!isActiveShareGrant(after),'SHARE_REVOKE_FAILED','ยังยืนยันไม่ได้ว่าเพิกถอนการแชร์สำเร็จ',500);
    return result;
  }
  /** PC-10: the owner's current shares of one Result (exact share ids + exact revision shared). */
  async artifactShares(actor:Actor,artifactId:string){
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'dashboard.create');
    const head=await createArtifactReader(this.store,current.id).head(z.string().min(1).max(200).parse(artifactId));invariant(!!head,'NOT_FOUND','ไม่พบผลลัพธ์ที่ระบุ',404);
    const rows=await listCurrentArtifactShares(this.store,current.id,artifactId),out=[];
    for(const row of rows){const recipient=await this.store.get<Profile>('profiles',row.recipientId);out.push({shareId:row.id,recipientId:row.recipientId,recipientName:recipient?.name??row.recipientId,revision:row.revision,createdAt:row.createdAt});}
    return out;
  }
  /** PC-10: owner revokes ONE exact Result share (tombstone row; idempotent; audited; unrelated shares untouched). */
  async revokeArtifactShare(actor:Actor,artifactId:string,shareId:string):Promise<{shareId:string;alreadyRevoked:boolean}>{
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'dashboard.create');
    const result=await this.bookkeeping(async tx=>{
      const live=await reloadActor(tx,current,this.now());requirePermission(live,'dashboard.create');
      const revoked=await revokeArtifactShareInTx(tx,live,z.string().min(1).max(200).parse(artifactId),z.string().min(1).max(260).parse(shareId),this.now());
      if(!revoked.alreadyRevoked)await this.audit(tx,live,'revoke','เพิกถอนการแชร์ผลลัพธ์ให้ผู้รับรายหนึ่ง',artifactId);
      return{shareId,alreadyRevoked:revoked.alreadyRevoked};
    });
    return result;
  }
  /** PC-01: every NEW or CHANGED viz widget must read only inside the Dashboard's own header scope (branch/region/date) under the owner's current authority; otherwise the write is refused (never silently widened, never re-scoped). */
  private async assertWidgetsFitScope(current:Actor,dashboardId:string,next:z.infer<typeof dashboardSpecSchema>):Promise<void>{
    const dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);
    const known=new Set((dashboard?.spec.widgets??[]).map(widget=>digest(widget)));
    const fresh=next.widgets.map((widget,index)=>({widget,index})).filter(({widget})=>widget.type==='viz'&&!known.has(digest(widget)));
    if(!fresh.length)return;
    const results=await executeDashboardVizWidgets({store:this.store,viewer:current,now:()=>this.now(),businessDate:this.businessDate,read:(scope,signal)=>this.queryEvidence(current,scope,signal),diagnosticId:id('viz'),
      spec:{...next,widgets:fresh.map(({widget})=>widget)},ceiling:{region:next.scope.region,date:next.scope.date,...(next.scope.branchIds?{branchIds:next.scope.branchIds}:{})}});
    if(results.some(result=>result.status==='denied'&&result.code==='scope_ceiling'))throw new DomainError('WIDGET_SCOPE_MISMATCH',WIDGET_CEILING_TEXT.replace('ที่ได้รับอนุมัติให้แชร์ Dashboard','ของ Dashboard นี้')+' — สร้าง Dashboard ใหม่สำหรับขอบเขตนั้นแทน',422);
    // PC-01: a shared Dashboard never widens past ANY active share's approved source/date/branch ceiling (refused; the owner revokes and re-shares to approve a wider scope).
    if(!dashboard)return;
    for(const ceiling of await this.activeShareCeilings(dashboard)){
      const shared=await executeDashboardVizWidgets({store:this.store,viewer:current,now:()=>this.now(),businessDate:this.businessDate,read:(scope,signal)=>this.queryEvidence(current,scope,signal),diagnosticId:id('viz'),spec:{...next,widgets:fresh.map(({widget})=>widget)},ceiling});
      if(shared.some(result=>result.status==='denied'&&result.code==='scope_ceiling'))throw new DomainError('WIDGET_SCOPE_MISMATCH',WIDGET_CEILING_TEXT.replace(' จึงไม่แสดง','')+' — ยกเลิกการแชร์แล้วแชร์ใหม่เพื่ออนุมัติขอบเขตที่กว้างขึ้น',422);
    }
  }
  /** Direct widget edit (reorder / remove / retitle) of the owner's own Dashboard through the same write path as router refinement (revision CAS + share guard inside the transaction). */
  async editDashboardWidgets(actor:Actor,dashboardId:string,input:{baseRevision:string;change:unknown}){
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');requirePermission(current,'dashboard.create');
    const dashboard=await this.editableDashboard(current,dashboardId,input.baseRevision);
    await this.updateDashboardSpec(current,dashboard.id,await this.widgetChangeSpec(current,dashboard.spec,input.change),{expectedRevision:input.baseRevision});
    return this.dashboard(current,dashboard.id);
  }
  /** The spec a direct widget change produces. Reorder/remove/retitle are pure; change_family (replace widget) re-validates the candidate against the widget's bound plan AND draws it from CURRENT evidence (shared chart-compiler suitability) before it can be written or staged. */
  private async widgetChangeSpec(current:Actor,spec:Dashboard["spec"],change:unknown):Promise<Dashboard["spec"]>{
    if(!isWidgetFamilyOp(change))return applyWidgetOp(spec,change);
    const op=widgetFamilyOpSchema.parse(change),widget=spec.widgets[op.index];
    const catalog=createSemanticCatalog(await this.store.list<Branch>('branches'));
    const candidate=candidateFamilyWidget(spec,op,{dataset:widget?.type==='viz'?catalog.datasets.find(dataset=>dataset.id===widget.binding.datasetId):undefined,actor:current});
    if(candidate.widget===widget)return spec;
    const drawn=(await executeDashboardVizWidgets({store:this.store,viewer:current,now:()=>this.now(),businessDate:this.businessDate,read:(scope,signal)=>this.queryEvidence(current,scope,signal),diagnosticId:id('viz'),spec:{...spec,widgets:[candidate.widget]}})).find(result=>result.index===0);
    if(drawn?.status!=='ready')throw new DomainError('WIDGET_UNSUITABLE',drawn?.text??'รูปแบบที่เลือกวาดจากข้อมูลปัจจุบันของ Widget นี้ไม่ได้',422);
    return candidate.spec;
  }
  /** Adds an owned Result to a Dashboard as DYNAMIC widgets (never a screenshot): derived from the Result's trusted QueryPlan + expression, re-authorized now, re-queried on every open. */
  async addResultToDashboard(actor:Actor,dashboardId:string,input:{baseRevision?:string;artifactId:string;revision?:number}){
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');requirePermission(current,'dashboard.create');
    const dashboard=await this.editableDashboard(current,dashboardId,input.baseRevision);
    const derived=await deriveResultWidgets(this.store,current,{artifactId:z.string().min(1).max(200).parse(input.artifactId),...(input.revision===undefined?{}:{revision:input.revision})});
    if(derived.outcome==='denied')throw new DomainError('RESULT_NOT_ADDABLE',derived.text,422);
    invariant(dashboard.spec.widgets.length+derived.widgets.length<=12,'INVALID_INPUT','Dashboard มี Widget ได้ไม่เกิน 12 รายการ',400);
    await this.updateDashboardSpec(current,dashboard.id,{...dashboard.spec,widgets:[...dashboard.spec.widgets,...derived.widgets]},{expectedRevision:input.baseRevision??specRevision(dashboard.spec)});
    return{...await this.dashboard(current,dashboard.id),...(derived.note?{note:derived.note}:{})};
  }
  /**
   * The ONE entry for direct UI edits of a Dashboard. Private + owner-only edits run directly through the same write path as AI refinement;
   * a Dashboard with an active share creates the SAME staged proposal chat creates (router_proposals: claim token, mode fence, base revision)
   * from this UI operation (server-generated origin, see lib/dashboards/ui-staging.ts) and the confirm executes through confirmStagedProposal.
   */
  async editDashboardUi(actor:Actor,dashboardId:string,rawEdit:unknown):Promise<{outcome:'updated';view:Awaited<ReturnType<ConciergeService['dashboard']>>}|{outcome:'staged';proposalId:string;preview:string;expiresAt:number}>{
    const edit=dashboardUiEditSchema.parse(rawEdit);
    const current=await reloadActor(this.store,actor,this.now());requirePermission(current,'sales.read');requirePermission(current,'dashboard.create');
    const dashboard=await this.editableDashboard(current,dashboardId,edit.baseRevision);
    const direct=async()=>{
      if(edit.kind==='rename')return this.renameDashboard(current,dashboard.id,{title:edit.title,...(edit.description===undefined?{}:{description:edit.description})},{expectedRevision:edit.baseRevision});
      if(edit.kind==='widgets')return this.editDashboardWidgets(current,dashboard.id,{baseRevision:edit.baseRevision,change:edit.change});
      return this.addResultToDashboard(current,dashboard.id,{...(edit.baseRevision===undefined?{}:{baseRevision:edit.baseRevision}),artifactId:edit.artifactId,...(edit.revision===undefined?{}:{revision:edit.revision})});
    };
    if(!await this.dashboardHasActiveShare(this.store,dashboard.id)){
      try{return{outcome:'updated',view:await direct()};}
      catch(error){if(!(error instanceof DomainError&&error.code===DASHBOARD_SHARED_CODE))throw error;}// a share appeared between the check and the write: stage instead
    }
    if(!await this.stagedTableAvailable())throw new DomainError('STAGED_UNAVAILABLE','รายการประเภทนี้ยังไม่เปิดให้ใช้งานในระบบนี้ จึงยังแก้ Dashboard ที่แชร์แล้วไม่ได้',503);
    const revision=specRevision(dashboard.spec);
    let change:Parameters<typeof stageDashboardUiProposal>[0]['change'];
    if(edit.kind==='rename'){
      const title=dashboardSpecSchema.shape.title.parse(edit.title.trim());
      change=edit.description===undefined?{kind:'rename',title}:{kind:'spec',spec:{...dashboard.spec,title,description:dashboardSpecSchema.shape.description.parse(edit.description.trim())},label:uiEditLabel(edit)};
    }else if(edit.kind==='widgets')change={kind:'spec',spec:await this.widgetChangeSpec(current,dashboard.spec,edit.change),label:uiEditLabel(edit)};
    else{
      // PC-04: pin the EXACT revision (the latest only when none was chosen) and name it with the owner's current display title in the confirmation.
      const head=await createArtifactReader(this.store,current.id).head(edit.artifactId);if(!head)throw new DomainError('RESULT_NOT_ADDABLE','ไม่พบผลลัพธ์ที่ระบุ',422);
      const resultRevision=edit.revision??head.revision,resultTitle=(await displayTitles(this.store,current.id)).get(head.artifactId)??head.title;
      const derived=await deriveResultWidgets(this.store,current,{artifactId:edit.artifactId,revision:resultRevision});
      if(derived.outcome==='denied')throw new DomainError('RESULT_NOT_ADDABLE',derived.text,422);
      invariant(dashboard.spec.widgets.length+derived.widgets.length<=12,'INVALID_INPUT','Dashboard มี Widget ได้ไม่เกิน 12 รายการ',400);
      change={kind:'spec',spec:{...dashboard.spec,widgets:[...dashboard.spec.widgets,...derived.widgets]},label:uiEditLabel(edit,{title:resultTitle,revision:resultRevision})};
    }
    if(change.kind==='spec'){const next=dashboardSpecSchema.parse(change.spec);assertDashboardRendererSupport(next);await this.assertWidgetsFitScope(current,dashboard.id,next);}
    const staged=await stageDashboardUiProposal({store:this.store,now:()=>this.now(),actor:current,dashboard:{id:dashboard.id,title:dashboard.spec.title,revision},change});
    await this.bookkeeping(async tx=>{await this.audit(tx,current,'prepare','เตรียมการแก้ Dashboard ที่แชร์แล้ว (รอยืนยัน)',dashboard.id);});
    return{outcome:'staged',proposalId:staged.proposalId,preview:staged.preview,expiresAt:staged.expiresAt};
  }
  /** Reloads one immutable version under CURRENT authority/catalog; compiled with the expression it was previewed with. */
  async openArtifact(actor:Actor,artifactId:string,revision?:number){return openArtifactVersion({store:this.store,actor,now:()=>this.now()},z.string().min(1).max(200).parse(artifactId),revision);}
  /** A recipient opens a shared artifact through their own inbox message; authorization is rechecked on every open. */
  async openSharedArtifact(actor:Actor,messageId:string){return openSharedArtifact({store:this.store,actor,now:()=>this.now()},z.string().min(1).max(200).parse(messageId));}
  /** Drilldown = linked read re-run through the registered query path under the viewer's current authority. */
  async drillArtifact(actor:Actor,input:ArtifactDrillInput,signal?:AbortSignal){return drillArtifact({store:this.store,actor,now:()=>this.now(),businessDate:this.businessDate,read:(scope,readSignal)=>this.queryEvidence(actor,scope,readSignal),...(signal?{signal}:{})},input);}
  private async workspaceActionCatalog(actor:Actor):Promise<{entries:ActionCatalogEntry[];status:ActionCatalogStatus}> {
    const hasTool=(name:string):boolean=>!!this.catalog.descriptor(name)&&this.catalog.tools.has(name)&&this.catalog.allowsTool(actor,name);
    const retailReadTools=['sales.query_metrics','operations.query_inventory','incidents.search','staffing.get_summary'];
    const salesReadAvailable=retailReadTools.every(hasTool);
    const dashboardToolAvailable=hasTool('dashboard.prepare_create')&&this.catalog.actions.has('dashboard_create');
    const employeeToolAvailable=hasTool('hr.find_employee');
    const badgeToolAvailable=hasTool('badge.prepare_revoke')&&this.catalog.actions.has('badge_revoke');
    // Catalog, greeting and starters are all derived from the same authorized tool list.
    const ticketToolAvailable=hasTool('ticket.prepare_create')&&this.catalog.actions.has('ticket_create');
    const shareToolAvailable=hasTool('dashboard.prepare_share')&&this.catalog.actions.has('dashboard_share');
    const authorizedFlowCount=Number(salesReadAvailable)+Number(dashboardToolAvailable)+Number(employeeToolAvailable)+Number(badgeToolAvailable)+Number(ticketToolAvailable)+Number(shareToolAvailable);
    const authorizedRegions=actor.regions.filter(region=>region!=='*');
    const hasSalesRegion=actor.regions.includes('*')||authorizedRegions.length>0;
    const scope=(salesReadAvailable||dashboardToolAvailable||ticketToolAvailable||shareToolAvailable)&&hasSalesRegion
      ?scopeSchema.parse({region:actor.regions.includes('*')||authorizedRegions.length!==1?'all':authorizedRegions[0],date:this.businessDate})
      :undefined;
    let dataUnavailable=false,targetUnavailable=false,evidence:Evidence|undefined;
    if(scope){
      try{evidence=await readEvidence(this.store,actor,scope,this.now());}
      catch(error){if(isKnownCatalogReadUnavailable(error))dataUnavailable=true;else throw error;}
      if(!evidence?.branches.length)targetUnavailable=true;
    }
    const coverage=evidence?retailEvidenceCoverage(evidence):undefined;
    const salesAnalysisAvailable=!!salesReadAvailable&&!!evidence?.branches.length&&!!coverage?.salesComplete&&!!coverage.targetComplete;
    if(salesReadAvailable&&!salesAnalysisAvailable)targetUnavailable=true;

    let dashboardCreateAvailable=false;
    if(dashboardToolAvailable){
      if(!evidence?.branches.length||!scope)targetUnavailable=true;
      else try{
        await this.validate(this.store,actor,{kind:'dashboard_create',spec:defaultSalesDashboard(evidence.scope)},undefined,true);
        dashboardCreateAvailable=true;
      }catch(error){
        if(isKnownCatalogReadUnavailable(error))dataUnavailable=true;
        else if(error instanceof DomainError&&[401,403].includes(error.status))throw error;
        else if(error instanceof DomainError||error instanceof z.ZodError)targetUnavailable=true;
        else throw error;
      }
    }

    let employees:Employee[]=[],employeeReadAvailable=true;
    if(employeeToolAvailable||badgeToolAvailable){
      try{
        const branches=new Map((await this.store.list<Branch>('branches')).map(branch=>[branch.id,branch]));
        employees=(await this.store.list<Employee>('employees')).filter(employee=>employee.active&&
          canReadHrEmployee(actor,employee,employee.branchId?branches.get(employee.branchId):undefined)).sort((left,right)=>left.id.localeCompare(right.id));
      }
      catch(error){if(isKnownCatalogReadUnavailable(error)){dataUnavailable=true;employeeReadAvailable=false;}else throw error;}
      if(employeeToolAvailable&&!employees.length)targetUnavailable=true;
    }
    const employeeIds=employeeToolAvailable?employees.map(employee=>employee.id):[];
    const badgeTargets:Array<{badgeId:string;employeeId:string}>=[];
    if(badgeToolAvailable&&employeeReadAvailable){
      const activeEmployees=new Set(employees.map(employee=>employee.id));
      let badges:Badge[]=[];
      try{badges=(await this.store.list<Badge>('mock_badges')).filter(badge=>badge.state==='active'&&activeEmployees.has(badge.employeeId)).sort((left,right)=>left.id.localeCompare(right.id));}
      catch(error){if(isKnownCatalogReadUnavailable(error))dataUnavailable=true;else throw error;}
      for(const badge of badges){
        try{
          await this.validate(this.store,actor,{kind:'badge_revoke',badgeId:badge.id,employeeId:badge.employeeId,reason:''},undefined,true);
          badgeTargets.push({badgeId:badge.id,employeeId:badge.employeeId});
        }catch(error){
          if(isKnownCatalogReadUnavailable(error)){dataUnavailable=true;break;}
          if(error instanceof DomainError&&[401,403].includes(error.status))throw error;
          if(error instanceof DomainError||error instanceof z.ZodError)targetUnavailable=true;
          else throw error;
        }
      }
      if(!badgeTargets.length)targetUnavailable=true;
    }else if(badgeToolAvailable){
      targetUnavailable=true;
    }

    return buildWorkspaceActionCatalog({
      actor,
      scope,
      salesAnalysisAvailable,
      dashboardCreateAvailable,
      ticketCreateAvailable:ticketToolAvailable&&!!evidence?.branches.length,
      dashboardShareAvailable:shareToolAvailable&&!!evidence?.branches.length,
      employeeIds,
      badgeTargets,
      authorizedFlowCount,
      dataUnavailable,
      targetUnavailable,
      director:await this.directorCatalogGrant(actor),
    });
  }
  /** HR Director catalog entries come from the V2 projection's runtime grant (same source as permitAction: decisions need staged proposals); no bridge = none. */
  private async directorCatalogGrant(actor:Actor){const port=await this.directorWorkflowSource();if(!port)return undefined;const grant=await port.capabilities(actor);return await this.stagedTableAvailable()?grant:{reads:grant.reads,decisions:[]};}
  async getWorkspace(actor:Actor):Promise<Workspace>{
    const current=await reloadActor(this.store,actor,this.now()),ctx=this.context(this.store,current),allowedBranches=new Set((await this.store.list<Branch>('branches')).filter(b=>current.regions.includes('*')||current.regions.includes(b.region)).map(b=>b.id));
    const actions:PendingAction[]=[];for(const a of await this.store.list<PendingAction>('pending_actions'))if(a.actorId===current.id&&current.permissions.includes(actionPermissions[a.payload.kind])){const binding=this.catalog.actions.get(a.payload.kind);if(binding){try{
      const completed=await readCompletedTurn(this.store,this.completionTuple(a,{conversationId:a.conversationId,turnId:a.turnId}),a.id);
      if(completed.kind==='completed'&&await this.badgeHistoryVisible(this.store,current,a)&&await binding.visible(ctx,a.payload))actions.push(a.status==='pending'&&a.releaseRevision!==this.releaseRevision?{...a,status:'stale'}:a);
    }catch(error){if(!(error instanceof DomainError)||![403,404,409].includes(error.status))throw error;}}}
    const badgeReviews:NonNullable<Workspace['badgeReviews']>={};
    for(const action of actions)if(action.payload.kind==='badge_revoke')badgeReviews[action.id]=await this.badgeReview(current,action);
    const allowedActions=new Set(actions.map(a=>a.id));const dashboards:Dashboard[]=[];
    if(current.permissions.includes('sales.read'))for(const d of await this.store.list<Dashboard>('dashboards'))if(d.ownerId===current.id){try{dashboards.push((await this.dashboard(current,d.id,{vizData:false})).dashboard);}catch(error){if(!(error instanceof DomainError))throw error;}}
    const inbox:Workspace['inbox']=[];for(const m of await this.store.list<Inbox>('mock_messages'))if(m.recipientId===current.id){try{const d=await this.dashboard(current,m.dashboardId,{vizData:false});inbox.push({id:m.id,dashboardId:d.dashboard.id,title:d.dashboard.spec.title,createdAt:m.createdAt,...(d.sharedBy?{sharedBy:d.sharedBy.name}:{})});}catch{/* revoked grants reveal no stored summaries */}}
    const messageProofs=new Map<string,Promise<CompletedTurnRead>>();
    const extras=await this.turnExtras(current);
    const answerPermissions=new Map<string,string[]>();
    const messageRows=(await this.store.list<ConversationMessage>('conversation_messages')).filter(m=>m.actorId===current.id).map(m=>{
      const extra=m.role==='assistant'&&m.turnId?extras.get(m.turnId):undefined;
      if(extra&&extra.assistantMessageId===m.id){
        if(extra.requiredPermissions.length)answerPermissions.set(m.id,extra.requiredPermissions);
        return{...m,...extra.content};
      }
      return m;
    });
    const messages=await Promise.all(messageRows.map(async m=>{
      const citations=m.analysis?[...m.analysis.facts,...m.analysis.relationships,...m.analysis.hypotheses,...m.analysis.missingEvidence].flatMap(c=>c.sourceIds):[];
      const sourceIds=new Set([...citations,...(m.evidence?.sources??[]).map(s=>s.id),...(m.sources??[]).map(s=>s.id)]);
      const tuple=m.turnId&&m.sessionId?{actorId:m.actorId,sessionId:m.sessionId,conversationId:m.conversationId,turnId:m.turnId,mode:m.mode,modeRevision:m.modeRevision}:undefined;
      let proof:CompletedTurnRead|undefined;
      if(tuple&&m.role==='assistant'){
        const key=digest(tuple);
        let proofRead=messageProofs.get(key);
        if(!proofRead){proofRead=readCompletedTurn(this.store,tuple);messageProofs.set(key,proofRead);}
        proof=await proofRead;
      }
      const completed=proof?.kind==='completed'&&proof.assistant.id===m.id;
      const denied=m.role==='assistant'&&(!completed||[...(m.pendingActionIds??[]),...(m.pendingActionId?[m.pendingActionId]:[])].some(actionId=>!allowedActions.has(actionId))||[...sourceIds].some(s=>!this.catalog.canCite(current,s,allowedBranches))||(answerPermissions.get(m.id)??[]).some(permission=>!current.permissions.includes(permission)));
      return denied?{...m,text:'ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน',analysis:undefined,evidence:undefined,sources:undefined,pendingActionId:undefined,pendingActionIds:undefined,receiptId:undefined,artifacts:undefined,choices:undefined,receiptCards:undefined}:m;
    }));const allowedManifests=this.catalog.manifests.filter(p=>p.tools.some(t=>t.audit==='read'&&current.permissions.includes(t.permission)));
    const actionCatalog=await this.workspaceActionCatalog(current);
    // HR Director (Workflow V2): the onboarding reads/decisions are not pack tools, so a Director has no pack capability; the V2 projection's own grant is what lets the actor use the assistant.
    const directorPort=await this.directorWorkflowSource(),directorGrant=directorPort?await directorPort.capabilities(current):NO_DIRECTOR_CAPABILITIES;
    const directorCapabilities=directorGrant.reads.length||directorGrant.decisions.length?[{id:'hr_director_onboarding',title:'อนุมัติ onboarding (HR Director)',allowed:true,tools:[],templates:[]}]:[];
    const workspace:Workspace={actor:current,csrfToken:'',businessDate:this.businessDate,storage:this.store.adapter,metrics:allowedManifests.flatMap(p=>p.metrics),dashboards,actions,badgeReviews,receipts:await Promise.all((await this.store.list<Receipt>('action_executions')).filter(r=>r.actorId===current.id&&(r as {contractVersion?:unknown}).contractVersion!==2).map(async r=>this.receiptView(current,await this.store.get<PendingAction>('pending_actions',r.actionId),r))),audit:(await this.store.list<AuditEvent>('audit_events')).filter(e=>e.actorId===current.id&&(!e.region||e.region==='all'||current.regions.includes(e.region))),messages,inbox,profiles:(await this.store.list<Profile>('profiles')).filter(p=>p.active).map(({id,name,role})=>({id,name,role})),capabilities:withChatCapability([...this.catalog.manifests.map(p=>({id:p.id,title:p.title,allowed:p.tools.some(t=>(t.audit==='read'||t.audit==='prepare')&&this.catalog.allowsTool(current,t.name)),tools:p.tools.filter(t=>(t.audit==='read'||t.audit==='prepare')&&this.catalog.allowsTool(current,t.name)).map(t=>t.name),templates:p.templates.filter(()=>current.permissions.includes('dashboard.create')&&this.catalog.readPermissions(this.catalog.action('dashboard_create').packIds).every(permission=>current.permissions.includes(permission))).map(t=>({id:t.id,title:t.title}))})),...directorCapabilities]),actionCatalog:actionCatalog.entries,actionCatalogStatus:actionCatalog.status};
    const taskAssignees=current.permissions.includes('ticket.create')
      ?await recipientDirectory(this.store,current,(a,id)=>this.recipientAllowed(a,id),CONTEXT_LIMITS.recipients):[];
    workspace.taskAssigneeOptions=taskAssignees.map(profile=>({id:profile.id,label:profile.name}));
    this.workspaceMessageProofs.set(workspace,messageProofs);
    return workspace;
  }
  private async failStartedTurn(tx:Transaction,actor:Actor,request:TurnRequest,failureReason:TurnFailureReason,expectedCompletion?:TurnCompletionRecord):Promise<boolean>{
    const parsed=turnRequestCompletionProofSchema.safeParse(await tx.get('tool_executions',request.id));
    const tuple=this.completionTuple(request,{conversationId:request.conversationId,turnId:request.turnId});
    const completion=turnCompletionRecordSchema.safeParse(await tx.get('tool_executions',turnCompletionId(tuple)));
    const exactRequest=parsed.success&&parsed.data.id===request.id&&parsed.data.actorId===tuple.actorId&&parsed.data.sessionId===tuple.sessionId&&
      parsed.data.conversationId===tuple.conversationId&&parsed.data.turnId===tuple.turnId&&parsed.data.mode===tuple.mode&&parsed.data.modeRevision===tuple.modeRevision;
    const exactCompletion=completion.success&&completion.data.id===turnCompletionId(tuple)&&completion.data.actorId===tuple.actorId&&completion.data.sessionId===tuple.sessionId&&
      completion.data.conversationId===tuple.conversationId&&completion.data.turnId===tuple.turnId&&completion.data.mode===tuple.mode&&completion.data.modeRevision===tuple.modeRevision;
    if(!exactRequest||parsed.data.status!=='started'||!exactCompletion||completion.data.status!=='started'||completion.data.origin!=='chat'||completion.data.requestLedgerId!==request.id)return false;
    if(expectedCompletion&&(digest(parsed.data)!==digest(request)||digest(completion.data)!==digest(expectedCompletion)))return false;
    const actions=(await tx.list<PendingAction>('pending_actions',{actorId:tuple.actorId})).filter(action=>action.actorId===tuple.actorId&&action.sessionId===tuple.sessionId&&
      action.conversationId===tuple.conversationId&&action.turnId===tuple.turnId&&action.mode===tuple.mode&&action.modeRevision===tuple.modeRevision&&action.status==='pending');
    for(const action of actions){
      await tx.put('pending_actions',{...action,status:'stale',staleReason:failureReason==='turn_cancelled'?'source_turn_cancelled':'source_turn_failed'});
      await this.audit(tx,actor,'turn_action_cleanup',failureReason,action.id,action.approvalScope?.region);
    }
    await this.staleStagedForTurn(tx,tuple);
    // A failed turn gives its clarification choice back (the user may pick it again).
    if(request.clarification){
      const usedId=`clarification_used:${request.clarification.clarifiedTurnId}`,used=await tx.get<{requestId?:string}>('tool_executions',usedId);
      if(used&&used.requestId===request.id)await tx.remove('tool_executions',usedId);
    }
    await tx.put('tool_executions',{...parsed.data,status:'failed',failureReason});
    await tx.put('tool_executions',turnCompletionRecordSchema.parse({...completion.data,status:'failed',failureReason}));
    return true;
  }
  /** Staged proposals created by a failed/cancelled turn are orphans: never confirmable. */
  private async staleStagedForTurn(tx:Transaction,tuple:TurnCompletionTuple):Promise<void>{
    // Cached probe only: never issue a store query from inside an open transaction. A turn that created staged rows has probed already.
    if(stagedProbe.get(this.store)?.available!==true)return;
    const rows=(await tx.list<{id:string;actorId:string;conversationId:string;turnId:string;status:string;revision:number}>('router_proposals',{actorId:tuple.actorId,status:'pending'}))
      .filter(row=>row.actorId===tuple.actorId&&row.conversationId===tuple.conversationId&&row.turnId===tuple.turnId&&row.status==='pending');
    for(const row of rows)await tx.put('router_proposals',{...row,status:'stale',updatedAt:this.now().getTime(),revision:row.revision+1});
  }
  /** A staged proposal is confirmable only when its creating chat turn has a verified completed-turn proof (same as pending actions). */
  private async stagedTurnCompleted(actor:Actor,proposal:StagedProposal):Promise<boolean>{
    // A shared-Dashboard edit staged from the UI has no chat turn: it is accepted ONLY with its explicit server-written UI origin (ui-staging.ts). Chat proposals keep the completed-chat-turn proof below.
    if(isUiProposalOrigin(actor,proposal))return true;
    if(proposal.actorId!==actor.id||!proposal.turnId||proposal.mode===undefined||proposal.modeRevision===undefined||!proposal.sessionId)return false;
    try{
      const proof=await readCompletedTurn(this.store,this.completionTuple({actorId:proposal.actorId,sessionId:proposal.sessionId,mode:proposal.mode,modeRevision:proposal.modeRevision},{conversationId:proposal.conversationId,turnId:proposal.turnId}));
      return proof.kind==='completed'&&proof.record.origin==='chat';
    }catch(error){if(isKnownCatalogReadUnavailable(error))return false;throw error;}
  }
  private async expireStaleTurn(actor:Actor,request:TurnRequest):Promise<TurnRequest>{
    if(request.status!=='started'||this.now().getTime()-new Date(request.createdAt).getTime()<=TURN_STALE_AFTER_MS)return request;
    const tuple=this.completionTuple(request,{conversationId:request.conversationId,turnId:request.turnId});
    const marker=turnCompletionRecordSchema.safeParse(await this.store.get('tool_executions',turnCompletionId(tuple)));
    if(!marker.success)return request;
    // SQLite holds BEGIN IMMEDIATE; Supabase nexus_commit CASes appmeta.revision for the whole batch.
    // Recheck both observed markers inside that transaction; a concurrent winner is read back below.
    await this.bookkeeping(async tx=>{
      const current=await reloadActor(tx,actor,this.now());
      if(await this.failStartedTurn(tx,current,request,'turn_failed',marker.data))await this.audit(tx,current,'error','turn_timed_out');
    });
    const latest=turnRequestCompletionProofSchema.parse(await this.store.get('tool_executions',request.id));
    invariant(latest.id===request.id&&latest.intentHash===request.intentHash&&latest.actorId===request.actorId&&latest.sessionId===request.sessionId&&latest.createdAt===request.createdAt&&
      latest.conversationId===request.conversationId&&latest.turnId===request.turnId&&latest.mode===request.mode&&latest.modeRevision===request.modeRevision,
      'TURN_REQUEST_FAILED','The original turn request changed during recovery',409);
    return latest as TurnRequest;
  }
  private async replayTurn(actor:Actor,request:TurnRequest):Promise<TurnResponse> {
    request=await this.expireStaleTurn(actor,request);
    if(request.status==='started')throw new DomainError('TURN_IN_PROGRESS','คำขอเดิมกำลังดำเนินการ กรุณาตรวจสถานะเดิมอีกครั้ง',409);
    invariant(request.status==='completed','TURN_REQUEST_FAILED','คำขอเดิมล้มเหลว ระบบจะไม่ส่งคำขอนี้ซ้ำโดยอัตโนมัติ',409);
    const response=await this.completedResponse(actor,request);
    // A crash between the durable completion and the private direct creation leaves a completed reply with a still-pending private proposal:
    // the replay completes the creation idempotently (confirm moves pending -> completed once). A reply that already told the user the
    // creation failed is left alone — that proposal is for manual confirmation.
    const owed=actor.mode==='live_ai'&&response.message!==PRIVATE_CREATE_FAILED_TEXT&&(response.pendingActions??[]).some(action=>action.status==='pending'&&this.isPrivateDirect(action));
    if(!owed)return response;
    await this.createPrivateDirectly(actor,{conversationId:request.conversationId,turnId:request.turnId},response,request.id);
    return this.completedResponse(actor,request);
  }
  async recoverTurn(actor:Actor,input:RecoverTurnInput):Promise<RecoverTurnResult>{
    invariant(input.contractVersion===2&&typeof input.requestKey==='string'&&/^[A-Za-z0-9_-]{16,120}$/.test(input.requestKey)&&typeof input.message==='string'&&input.message.trim().length>0&&input.message.length<=8000,
      'INVALID_INPUT','รหัสคำขอหรือข้อความไม่ถูกต้อง',400);
    if(input.actionContractVersion!==undefined&&input.actionContractVersion!==1)return{status:'unavailable'};
    const current=await reloadActor(this.store,actor,this.now());
    const requestId='turnrequest_'+digest({actorId:current.id,sessionId:current.sessionId,key:input.requestKey});
    const intentHash=digest({actorId:current.id,sessionId:current.sessionId,conversationId:input.conversationId??null,message:input.message});
    const parsed=turnRequestCompletionProofSchema.safeParse(await this.store.get('tool_executions',requestId));
    if(!parsed.success||parsed.data.id!==requestId||parsed.data.name!=='chat.turn_request'||parsed.data.actionContractVersion!==1||parsed.data.actorId!==current.id||parsed.data.sessionId!==current.sessionId||parsed.data.intentHash!==intentHash||
      (input.conversationId!==undefined&&parsed.data.conversationId!==input.conversationId))return{status:'unavailable'};
    const request=await this.expireStaleTurn(current,parsed.data as TurnRequest),tuple=this.completionTuple(request,{conversationId:request.conversationId,turnId:request.turnId});
    const marker=turnCompletionRecordSchema.safeParse(await this.store.get('tool_executions',turnCompletionId(tuple)));
    if(!marker.success||marker.data.origin!=='chat'||marker.data.requestLedgerId!==request.id||marker.data.actorId!==request.actorId||marker.data.sessionId!==request.sessionId||marker.data.conversationId!==request.conversationId||marker.data.turnId!==request.turnId||marker.data.mode!==request.mode||marker.data.modeRevision!==request.modeRevision||marker.data.status!==request.status||marker.data.failureReason!==request.failureReason)return{status:'unavailable'};
    if(request.status==='started')return{status:'in_progress',conversationId:request.conversationId,turnId:request.turnId};
    if(request.status==='failed')return{status:'failed',conversationId:request.conversationId,turnId:request.turnId};
    const verified=await readCompletedTurn(this.store,tuple);
    if(verified.kind!=='completed'||verified.record.origin!=='chat'||verified.request?.id!==request.id)return{status:'unavailable'};
    try{return{status:'completed',response:await this.completedResponse(current,request)};}
    catch(error){if(error instanceof DomainError&&error.code==='TURN_REQUEST_FAILED')return{status:'unavailable'};throw error;}
  }
  async turn(actor:Actor,message:string,conversationId?:string,recoveryOfTurnId?:string,requestIdentity?:TurnRequestIdentity,streamOptions?:TurnStreamOptions):Promise<TurnResponse>{
    const deadlineAt=Date.now()+TURN_WORK_DEADLINE_MS,controller=new AbortController(),callerSignal=streamOptions?.signal;
    const callerAborted=()=>controller.abort(callerSignal?abortReason(callerSignal):undefined);
    if(callerSignal?.aborted)callerAborted();else callerSignal?.addEventListener('abort',callerAborted,{once:true});
    const timer=setTimeout(()=>controller.abort(new AIRuntimeError('deadline_exceeded','The AI response took too long. Switch to Scripted Demo or try again.')),
      Math.max(1,Math.min(TURN_WORK_DEADLINE_MS,deadlineAt-Date.now())));
    timer.unref?.();
    try{return await this.turnWithinBudget(actor,message,conversationId,recoveryOfTurnId,requestIdentity,streamOptions,deadlineAt,controller.signal);}
    finally{clearTimeout(timer);callerSignal?.removeEventListener('abort',callerAborted);}
  }

  private async turnWithinBudget(actor:Actor,requestedMessage:string,conversationId:string|undefined,recoveryOfTurnId:string|undefined,requestIdentity:TurnRequestIdentity|undefined,
    streamOptions:TurnStreamOptions|undefined,turnDeadlineAt:number,turnSignal:AbortSignal):Promise<TurnResponse>{
    const userText=brandUserText(requestedMessage);
    try{assertUserTextSize(userText);}catch{throw new DomainError('INVALID_INPUT','ข้อความต้องยาว 1–8000 ตัวอักษร',400);}
    if(turnSignal.aborted)throw abortReason(turnSignal);
    const current=await awaitWithAbort(reloadActor(this.store,actor,this.now()),turnSignal);
    if(requestIdentity)invariant(requestIdentity.contractVersion===2&&typeof requestIdentity.requestKey==='string'&&/^[A-Za-z0-9_-]{16,120}$/.test(requestIdentity.requestKey)&&!recoveryOfTurnId,'INVALID_INPUT','ต้องระบุรหัสคำขอ V2 ที่ถูกต้องและใช้วิธีตรวจคำขอเดิมเพียงวิธีเดียว');
    let lastStatus:ChatStreamStatusCode|undefined;
    const emitStatus=async(code:ChatStreamStatusCode)=>{if(streamOptions&&lastStatus!==code){lastStatus=code;await awaitWithAbort(Promise.resolve(streamOptions.onStatus?.(code)),turnSignal);}if(turnSignal.aborted)throw abortReason(turnSignal);};
    if(recoveryOfTurnId){
      invariant(conversationId,'NOT_FOUND','ไม่พบการสนทนาต้นทางของคำขอเดิม',404);
      this.activeConversation(await this.conversation(this.store,current,conversationId));
      const original=await this.store.get<ConversationMessage>('conversation_messages',recoveryOfTurnId);
      invariant(original&&original.id===recoveryOfTurnId&&original.actorId===current.id&&original.conversationId===conversationId&&original.role==='user'&&original.turnId===recoveryOfTurnId&&original.sessionId===current.sessionId,'NOT_FOUND','ไม่พบคำขอเดิมในบทสนทนานี้',404);
      invariant(original.text===userText,'INVALID_INPUT','การตรวจคำขอเดิมต้องใช้ข้อความต้นทางเดิม',409);
      const tuple=this.completionTuple({actorId:original.actorId,sessionId:current.sessionId,mode:original.mode,modeRevision:original.modeRevision},{conversationId,turnId:recoveryOfTurnId});
      let verified=await readCompletedTurn(this.store,tuple);
      if(verified.kind!=='completed'||verified.record.origin!=='chat'||!verified.request){
        let marker=turnCompletionRecordSchema.safeParse(await this.store.get('tool_executions',turnCompletionId(tuple)));
        if(marker.success&&marker.data.status==='started'&&marker.data.origin==='chat'&&marker.data.requestLedgerId){
          const request=turnRequestCompletionProofSchema.safeParse(await this.store.get('tool_executions',marker.data.requestLedgerId));
          if(request.success&&request.data.id===marker.data.requestLedgerId&&request.data.actorId===tuple.actorId&&request.data.sessionId===tuple.sessionId&&
            request.data.conversationId===tuple.conversationId&&request.data.turnId===tuple.turnId&&request.data.mode===tuple.mode&&request.data.modeRevision===tuple.modeRevision){
            await this.expireStaleTurn(current,request.data as TurnRequest);
            marker=turnCompletionRecordSchema.safeParse(await this.store.get('tool_executions',turnCompletionId(tuple)));
            verified=await readCompletedTurn(this.store,tuple);
          }
        }
        if(marker.success&&marker.data.status==='started')throw new DomainError('TURN_IN_PROGRESS','คำขอเดิมกำลังดำเนินการ กรุณาตรวจสถานะเดิมอีกครั้ง',409);
        invariant(verified.kind==='completed'&&verified.record.origin==='chat'&&verified.request,'TURN_REQUEST_FAILED','คำขอเดิมไม่มีผลที่ตรวจสอบได้และจะไม่ถูกส่งซ้ำโดยอัตโนมัติ',409);
      }
      const response=await this.completedResponse(current,verified.request as TurnRequest,false);
      await awaitWithAbort(Promise.resolve(streamOptions?.onStarted?.({conversationId,turnId:recoveryOfTurnId,assistantMessageId:response.assistantMessageId,mode:response.mode,replayed:true})),turnSignal);
      return response;
    }
    const c=await awaitWithAbort(this.conversation(this.store,current,conversationId),turnSignal);this.activeConversation(c);
    const convoId=c?.id??id('conversation'),turnId=id('turn'),context={conversationId:convoId,turnId};
    const requestId=requestIdentity?'turnrequest_'+digest({actorId:current.id,sessionId:current.sessionId,key:requestIdentity.requestKey}):id('turnrequest');
    const clarificationKey=(requestIdentity as (TurnRequestIdentity&{clarification?:{choiceId:string;clarifiedTurnId:string}})|undefined)?.clarification;
    const intentHash=digest({actorId:current.id,sessionId:current.sessionId,conversationId:conversationId??null,message:userText,...(clarificationKey?{clarification:clarificationKey}:{})});
    let admittedActor=current,clarificationReused=false;
    const previousRequest=await this.bookkeeping(async tx=>{
      clarificationReused=false;
      admittedActor=await reloadActor(tx,current,this.now());
      if(turnSignal.aborted)throw abortReason(turnSignal);
      if(requestIdentity){
        const raw=await tx.get('tool_executions',requestId);
        if(raw){
          const previous=turnRequestCompletionProofSchema.safeParse(raw);
          invariant(previous.success&&previous.data.id===requestId&&previous.data.name==='chat.turn_request'&&previous.data.actionContractVersion===1&&previous.data.actorId===admittedActor.id&&previous.data.sessionId===admittedActor.sessionId&&previous.data.intentHash===intentHash,
            'IDEMPOTENCY_CONFLICT','รหัสคำขอเดิมถูกใช้กับข้อความหรือบทสนทนาที่ต่างออกไป',409);
          if(turnSignal.aborted)throw abortReason(turnSignal);
          return previous.data as TurnRequest;
        }
      }
      const latest=await this.conversation(tx,admittedActor,conversationId);this.activeConversation(latest);
      const actualConversationId=latest?.id??convoId,actualContext={conversationId:actualConversationId,turnId},tuple=this.completionTuple({actorId:admittedActor.id,sessionId:admittedActor.sessionId,mode:admittedActor.mode,modeRevision:admittedActor.modeRevision},actualContext),timestamp=this.now().toISOString();
      // One clarification offer is consumed exactly once (claim row written in THIS admission transaction).
      if(clarificationKey){
        const offered=await tx.get<{name?:string;actorId?:string;conversationId?:string}>('tool_executions',`clarification:${clarificationKey.clarifiedTurnId}`);
        const offeredChoices=await tx.get<{name?:string;actorId?:string;choices?:{id:string}[]}>('tool_executions',turnExtrasId(clarificationKey.clarifiedTurnId));
        // Only a VALID pick (one of the server-saved choices of that clarification) consumes it.
        if(offered&&offered.name===PENDING_CLARIFICATION_TOOL&&offered.actorId===admittedActor.id&&offered.conversationId===actualConversationId&&
          offeredChoices?.name===TURN_EXTRAS_TOOL&&offeredChoices.actorId===admittedActor.id&&(offeredChoices.choices??[]).some(choice=>choice.id===clarificationKey.choiceId)){
          const usedId=`clarification_used:${clarificationKey.clarifiedTurnId}`;
          if(await tx.get('tool_executions',usedId))clarificationReused=true;
          else await tx.put('tool_executions',{id:usedId,name:CLARIFICATION_USED_TOOL,status:'completed',actorId:admittedActor.id,sessionId:admittedActor.sessionId,
            conversationId:actualConversationId,turnId:clarificationKey.clarifiedTurnId,requestId,choiceId:clarificationKey.choiceId,createdAt:timestamp});
        }
      }
      const request:TurnRequest={id:requestId,name:'chat.turn_request',actionContractVersion:1,actorId:admittedActor.id,sessionId:admittedActor.sessionId,...actualContext,
        mode:admittedActor.mode,modeRevision:admittedActor.modeRevision,intentHash,...(clarificationKey?{clarification:clarificationKey}:{}),status:'started',createdAt:timestamp};
      const completion=turnCompletionRecordSchema.parse({id:turnCompletionId(tuple),name:'chat.turn_completion',schemaVersion:1,origin:'chat',requestLedgerId:requestId,
        ...tuple,status:'started',createdAt:timestamp});
      if(turnSignal.aborted)throw abortReason(turnSignal);
      {const derived=isDefaultConversationTitle(latest?.title)?titleFromFirstMessage(userText):undefined;await tx.put('conversations',this.conversationUpdate(admittedActor,actualConversationId,latest,derived?{title:derived}:{}));}
      await tx.put('conversation_messages',{id:turnId,...actualContext,actorId:admittedActor.id,sessionId:admittedActor.sessionId,role:'user',text:userText,mode:admittedActor.mode,modeRevision:admittedActor.modeRevision,createdAt:timestamp} satisfies ConversationMessage);
      await tx.put('tool_executions',request);await tx.put('tool_executions',completion);
      context.conversationId=actualConversationId;
      return undefined;
    });
    if(previousRequest){
      await awaitWithAbort(Promise.resolve(streamOptions?.onStarted?.({conversationId:previousRequest.conversationId,turnId:previousRequest.turnId,assistantMessageId:this.assistantMessageId(admittedActor,previousRequest),mode:previousRequest.mode,replayed:true})),turnSignal);
      return this.replayTurn(admittedActor,previousRequest);
    }
    const request:TurnRequest={id:requestId,name:'chat.turn_request',actionContractVersion:1,actorId:admittedActor.id,sessionId:admittedActor.sessionId,...context,
      mode:admittedActor.mode,modeRevision:admittedActor.modeRevision,intentHash,...(clarificationKey?{clarification:clarificationKey}:{}),status:'started',createdAt:this.now().toISOString()};
    const answer:TurnResponse={...context,assistantMessageId:this.assistantMessageId(admittedActor,context),message:'',mode:admittedActor.mode,...(requestIdentity?{contractVersion:2 as const,replayed:false}:{})};
    try{
      if(turnSignal.aborted)throw abortReason(turnSignal);
      await awaitWithAbort(Promise.resolve(streamOptions?.onStarted?.({conversationId:context.conversationId,turnId,assistantMessageId:answer.assistantMessageId,mode:admittedActor.mode,replayed:false})),turnSignal);
      await emitStatus('validating');
      const outcome=await this.routeTurn(admittedActor,userText,context,requestId,requestIdentity,emitStatus,turnSignal,clarificationReused,turnDeadlineAt);
      answer.message=outcome.text;
      if(outcome.clarification)answer.clarification=true;
      if(outcome.sources?.length)answer.sources=outcome.sources;
      if(outcome.analysis)answer.analysis=outcome.analysis;
      if(outcome.choices?.length)answer.choices=outcome.choices;
      if(outcome.artifacts?.length)answer.artifacts=outcome.artifacts;
      if(outcome.hint)answer.hint=outcome.hint;
      // G5: verified-at is the completion transaction's clock: the cards are persisted in the SAME transaction as the effect write + read-back.
      const receiptCards=outcome.receiptCards?.length?outcome.receiptCards.slice(0,4).map(card=>({...card,verifiedAt:this.now().toISOString()})):undefined;
      await emitStatus('saving');
      const linked=await this.bookkeeping(async tx=>{
        const finalRequest=turnRequestCompletionProofSchema.parse(await tx.get('tool_executions',requestId));
        const tuple=this.completionTuple(finalRequest,{conversationId:context.conversationId,turnId}),completion=this.exactCompletion(await tx.get('tool_executions',turnCompletionId(tuple)),tuple);
        invariant(finalRequest.status==='started'&&completion.status==='started'&&completion.origin==='chat'&&completion.requestLedgerId===requestId,
          'TURN_COMPLETION_INVALID','The turn was closed before final response persistence',409);
        const finalActor=await reloadActor(tx,admittedActor,this.now());
        invariant(finalActor.mode===finalRequest.mode&&finalActor.modeRevision===finalRequest.modeRevision,'STALE_ACTION','โหมดเปลี่ยนก่อนบันทึกคำตอบ กรุณาส่งคำขอใหม่',409);
        // Answers carrying permission-gated text (policy_read) are re-authorized here: nothing is persisted or returned once a required permission is gone.
        invariant((outcome.requiredPermissions??[]).every(permission=>finalActor.permissions.includes(permission)),'FORBIDDEN','สิทธิ์ของคุณเปลี่ยนก่อนบันทึกคำตอบ กรุณาส่งคำขอใหม่',403);
        // Accepted query/HR states re-check authority, catalog and the parent state (CAS) inside this transaction.
        for(const persist of outcome.persists)await persist(tx,finalActor,context.conversationId);
        // Every typed denial leaves a metadata-only audit line (kind + code; never the user's wording).
        for(const denial of (outcome.denials??[]).slice(0,5))await this.audit(tx,finalActor,'denied',`ปฏิเสธ ${denial.kind}: ${denial.code}`.slice(0,200));
        if(outcome.pendingClarification)await tx.put('tool_executions',{id:`clarification:${turnId}`,name:PENDING_CLARIFICATION_TOOL,status:'completed',
          actorId:finalActor.id,sessionId:finalActor.sessionId,conversationId:context.conversationId,turnId,about:outcome.pendingClarification.about,
          missing:outcome.pendingClarification.missing,...(outcome.pendingClarification.parentTurnId?{parentTurnId:outcome.pendingClarification.parentTurnId}:{}),createdAt:this.now().toISOString()});
        // V1 evidence snapshot of an accepted single-date answer, read under the FINAL authority inside this transaction (best effort: no snapshot when unreadable).
        let evidenceSnapshot:Evidence|undefined;
        if(outcome.evidenceScope){try{evidenceSnapshot=await readEvidence(tx,finalActor,outcome.evidenceScope,this.now());}catch(error){if(!(error instanceof DomainError)&&!isKnownCatalogReadUnavailable(error))throw error;}}
        const linked=await this.linkAssistant(tx,finalActor,context,{text:answer.message,...(answer.analysis?{analysis:answer.analysis}:{}),...(evidenceSnapshot?{evidence:evidenceSnapshot}:{}),...(answer.sources?{sources:answer.sources}:{})});
        // Router extras (artifact previews, clarification choices, demo hint) live beside the message: the persisted message
        // row keeps its strict storage schema on every adapter.
        // `clarification` marks a turn that produced no accepted result: the planner context labels that assistant message so a
        // refused turn never reads as a state a follow-up could continue from.
        // G5: Dashboards this turn organized / renamed / duplicated (the "this Dashboard" reference of later turns in this conversation).
        const dashboardIds=[...new Set(outcome.actions.flatMap(a=>(a.outcome==='updated'||a.outcome==='created')&&a.ids.dashboardId?[a.ids.dashboardId]:[]))];
        if(answer.artifacts||answer.choices||answer.hint||outcome.followUps?.length||outcome.requiredPermissions?.length||outcome.clarification||dashboardIds.length||receiptCards)await tx.put('tool_executions',{id:turnExtrasId(turnId),name:TURN_EXTRAS_TOOL,status:'completed',...(dashboardIds.length?{dashboardIds}:{}),...(receiptCards?{receiptCards}:{}),
          actorId:finalActor.id,sessionId:finalActor.sessionId,conversationId:context.conversationId,turnId,assistantMessageId:linked.message.id,...(outcome.clarification?{clarification:true}:{}),
          ...(outcome.requiredPermissions?.length?{requiredPermissions:outcome.requiredPermissions}:{}),...(answer.artifacts?{artifacts:answer.artifacts}:{}),...(answer.choices?{choices:answer.choices}:{}),...(answer.hint?{hint:answer.hint}:{}),...(outcome.followUps?.length?{followUps:outcome.followUps}:{}),createdAt:this.now().toISOString()});
        // AI-suggested title: replaces only the title still auto-derived from this turn's message (a rename or later title is never touched).
        if(outcome.suggestedConversationTitle){const storedConversation=await this.conversation(tx,finalActor,context.conversationId);if(storedConversation&&storedConversation.title===titleFromFirstMessage(userText))await tx.put('conversations',this.conversationUpdate(finalActor,context.conversationId,storedConversation,{title:outcome.suggestedConversationTitle}));}
        const refs=normalizedFinalActionIds(linked.message),finalDigest=finalAssistantContentDigest(linked.message,refs);
        await tx.put('tool_executions',{...finalRequest,status:'completed',finalContentDigest:finalDigest,finalActionIds:refs});
        await tx.put('tool_executions',turnCompletionRecordSchema.parse({...completion,status:'completed',assistantMessageId:linked.message.id,finalContentDigest:finalDigest,finalActionIds:refs}));
        return linked;
      });answer.assistantMessageId=linked.message.id;if(linked.message.evidence)answer.evidence=linked.message.evidence;
      if(receiptCards)answer.receiptCards=receiptCards;
      if(linked.actions.length){answer.pendingActions=linked.actions;answer.pendingAction=linked.actions[linked.actions.length-1];}
      if(admittedActor.mode==='live_ai'&&answer.pendingActions?.length){await this.createPrivateDirectly(admittedActor,context,answer,requestId);if(answer.message!==linked.message.text)linked.message.text=answer.message;}
      await this.emitStreamDelta(streamOptions,linked.message.text,turnSignal);
      return answer;
    }catch(error){const failureReason:TurnFailureReason=streamOptions?.signal?.aborted?'turn_cancelled':'turn_failed';await this.bookkeeping(async tx=>{
      await this.failStartedTurn(tx,admittedActor,request,failureReason);
      await this.audit(tx,admittedActor,error instanceof Error&&'code'in error&&error.code==='FORBIDDEN'&&'status'in error&&error.status===403?'denied':'error',error instanceof DomainError?error.message:'AI ไม่พร้อมใช้งาน — เลือก Scripted Demo ได้');
    });throw error;}
  }
  /** Probe (cached per store) whether the router_proposals table exists; hosted stores may not have the migration yet. */
  private async stagedTableAvailable():Promise<boolean>{
    const cached=stagedProbe.get(this.store);
    if(cached&&(cached.available||Date.now()-cached.at<STAGED_PROBE_RETRY_MS))return cached.available;
    let available=false;
    try{await this.store.list('router_proposals',{actorId:'__probe__'});available=true;}catch{available=false;}
    stagedProbe.set(this.store,{available,at:Date.now()});
    return available;
  }
  /** Registered action availability for this actor: registry permissions plus a currently bound tool / store capability. */
  private routerActionAvailable(actor:Actor,actionId:string,stagedAvailable:boolean):boolean{
    const tool=ROUTER_PREPARE_TOOLS[actionId];
    if(tool)return !!this.catalog.descriptor(tool)&&this.catalog.tools.has(tool)&&this.catalog.allowsTool(actor,tool);
    if(actionId==='dashboard.rename')return actor.permissions.includes('sales.read');
    if(actionId==='dashboard.manage')return actor.permissions.includes('sales.read');
    if(actionId==='result.manage'||actionId==='result.unarchive')return actor.permissions.includes('dashboard.create');
    if(actionId==='dashboard.delete'||actionId==='dashboard.revoke_share')return stagedAvailable;
    // Wave 4 effects (communication.send, monitor.create/manage) persist through router_proposals + the effect store.
    if(actionId==='communication.send'||actionId==='monitor.create'||actionId==='monitor.manage'||actionId==='artifact.share'||actionId==='task.create'||actionId==='policy.acknowledge')return stagedAvailable;
    return false;
  }
  private effectBindingsCache?:ReturnType<typeof createEffectBindings>;
  /** Wave 4 snapshot loaders + commits (simulated inbox, monitors), bound to this service's recipient policy. */
  private effectBindings(){
    return this.effectBindingsCache??=createEffectBindings({store:this.store,now:()=>this.now(),businessDate:this.businessDate,recipientAllowed:(a,recipientId,reader)=>this.recipientAllowed(a,recipientId,reader)});
  }
  /** A pending action is chat-bound only when its originating turn has a verified completed chat proof for this actor/session/conversation. */
  private async proposalBound(actor:Actor,action:PendingAction):Promise<boolean>{
    if(action.actorId!==actor.id||!action.conversationId||!action.turnId)return false;
    try{
      const proof=await readCompletedTurn(this.store,this.completionTuple(action,{conversationId:action.conversationId,turnId:action.turnId}));
      return proof.kind==='completed'&&proof.record.origin==='chat';
    }catch(error){if(isKnownCatalogReadUnavailable(error))return false;throw error;}
  }
  private async recipientAllowed(actor:Actor,recipientId:string,reader:Reader=this.store):Promise<boolean>{
    if(recipientId===actor.id)return false;
    const profile=await reader.get<Profile>('profiles',recipientId),share=this.catalog.actions.get('dashboard_share');
    const required=share?this.catalog.readPermissions(share.packIds):[];
    return !!profile&&profile.active&&profile.id===recipientId&&required.every(permission=>profile.permissions.includes(permission));
  }
  /** Proven, still-citable completed turns of this conversation, as inert planner context. */
  private async plannerHistory(actor:Actor,conversationId:string,currentTurnId:string):Promise<PlannerContext['conversation']>{
    const rows=(await this.store.list<ConversationMessage>('conversation_messages',{actorId:actor.id})).filter(m=>m.actorId===actor.id&&m.conversationId===conversationId&&
      m.sessionId===actor.sessionId&&!!m.turnId&&m.turnId!==currentTurnId);
    const allowedBranches=new Set((await this.store.list<Branch>('branches')).filter(b=>actor.regions.includes('*')||actor.regions.includes(b.region)).map(b=>b.id));
    const assistants=rows.filter(m=>m.role==='assistant').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-6);
    const history:PlannerContext['conversation']=[];
    for(const assistant of assistants){
      const user=rows.find(m=>m.role==='user'&&m.turnId===assistant.turnId);
      const tuple=turnCompletionTupleSchema.safeParse({actorId:assistant.actorId,sessionId:assistant.sessionId,conversationId,turnId:assistant.turnId,mode:assistant.mode,modeRevision:assistant.modeRevision});
      if(!user||!tuple.success)continue;
      const proof=await readCompletedTurn(this.store,tuple.data);
      if(proof.kind!=='completed'||proof.assistant.id!==assistant.id)continue;
      const cited=[...(assistant.sources??[]).map(source=>source.id),...(assistant.analysis?[...assistant.analysis.facts,...assistant.analysis.relationships,...assistant.analysis.hypotheses,...assistant.analysis.missingEvidence].flatMap(claim=>claim.sourceIds):[])];
      if(cited.some(sourceId=>!this.catalog.canCite(actor,sourceId,allowedBranches)))continue;
      const recorded=await this.store.get<{name?:string;actorId?:string;requiredPermissions?:unknown;clarification?:unknown}>('tool_executions',turnExtrasId(assistant.turnId!));
      if(recorded?.name===TURN_EXTRAS_TOOL&&recorded.actorId===actor.id&&Array.isArray(recorded.requiredPermissions)&&recorded.requiredPermissions.some(p=>typeof p!=='string'||!actor.permissions.includes(p)))continue;
      // A turn that produced no accepted result (refusal / clarification) is labeled, so a follow-up never continues from it.
      const noResult=recorded?.name===TURN_EXTRAS_TOOL&&recorded.actorId===actor.id&&recorded.clarification===true;
      history.push({role:'user',text:user.text},{role:'assistant',text:noResult?`${NO_RESULT_MARK}${assistant.text}`:assistant.text});
    }
    return boundedPlannerConversation(history);
  }
  /**
   * The unified TurnPlan router. Plan source: a server-owned plan (demo card / work-catalog id) or ONE planner call.
   * The server never derives anything from the user's wording: the text is stored, hashed, sent to the planner and
   * used only to locate the plan's evidence spans.
   */
  private async routeTurn(actor:Actor,userText:UserText,context:{conversationId:string;turnId:string},requestId:string,requestIdentity:TurnRequestIdentity|undefined,
    emitStatus:(code:ChatStreamStatusCode)=>Promise<void>,signal:AbortSignal,clarificationReused=false,turnDeadlineAt?:number):Promise<RouterTurnOutcome>{
    const live=actor.mode==='live_ai';
    // Kill switch first: NO live-mode path (typed text, catalogEntryId, clarification) may plan or execute while AI is off.
    if(live&&liveAIKillSwitchOn())return{text:LIVE_AI_DISABLED_TEXT,clarification:true,persists:[],actions:[],hint:'switch_to_demo'};
    if(clarificationReused)return{text:CLARIFICATION_USED_TEXT,clarification:true,persists:[],actions:[]};
    let source:PlanSource|undefined,grounding:string=userText;
    if(!live){
      const card=showcaseById(actor.role,requestIdentity?.demoShowcaseId);
      if(card){source={kind:'server',plan:card.plan};grounding=card.prompt;}
    }
    if(!source&&requestIdentity?.catalogEntryId){
      const entry=(await this.workspaceActionCatalog(actor)).entries.find(item=>item.id===requestIdentity.catalogEntryId);
      const bound=entry?bindWorkCatalogEntry(entry):undefined;
      if(!bound)return{text:CATALOG_ENTRY_UNAVAILABLE_TEXT,clarification:true,persists:[],actions:[]};
      source={kind:'server',plan:bound.plan};grounding=bound.prompt;
    }
    if(!source){
      if(!live)return{text:unsupportedDemoReply(actor.role),clarification:true,persists:[],actions:[],choices:roleShowcase(actor.role).map(card=>({id:card.id,label:card.title}))};
      source={kind:'planner'};
    }
    const stagedAvailable=await this.stagedTableAvailable();
    // Demo and review-step services keep private creations behind the normal preview -> confirm step.
    const registry=live&&!this.reviewPrivateCreations?actionRegistry:reviewTierRegistry;
    const branches=await this.store.list<Branch>('branches'),catalog=createSemanticCatalog(branches);
    const pending=source.kind==='planner'?await latestPendingClarification(this.store,actor,context.conversationId,context.turnId):undefined;
    const selectionRequest=(requestIdentity as (TurnRequestIdentity&{clarification?:{choiceId:string;clarifiedTurnId:string}})|undefined)?.clarification;
    let selection:{id:string;label:string}|undefined;
    if(selectionRequest&&source.kind==='planner'){
      selection=await this.resolveClarificationSelection(actor,context.conversationId,pending,selectionRequest);
      if(!selection)return{text:INVALID_CLARIFICATION_TEXT,clarification:true,persists:[],actions:[]};
      // PC-03: a tapped server-built "next page" lookup choice is answered by the server (the same owner-scoped search, next window); no planner call.
      const more=pending?.about.startsWith('lookup:')?parseLookupMoreChoiceId(selection.id):undefined;
      if(more){
        const found=await executeResourceLookupStep({ports:{search:(a,lookup)=>this.lookupOwnedResources(a,lookup)},actor,step:{kind:'resource_lookup',resource:more.resource,query:more.query},offset:more.offset});
        return{text:found.text,clarification:true,persists:[],actions:[],...(found.outcome==='choices'?{choices:found.choices}:{}),...(found.outcome==='denied'?{}:{pendingClarification:{about:found.about,missing:found.missing}})};
      }
    }
    // UI-selected / tapped targets: owner + current permission verified here; they join the planner context even when older than its recent window.
    const selected=source.kind==='planner'?await this.verifySelectedTargets(actor,[...(requestIdentity?.targets??[]),...(selection?[{kind:'any' as const,id:selection.id}]:[])]):undefined;
    // HR Director bridge: the Workflow V2 projection decides which onboarding.* actions/reads exist for this actor.
    const director=await this.directorWorkflowSource(),directorCaps=director?await director.capabilities(actor):NO_DIRECTOR_CAPABILITIES;
    const permitAction=(actionId:string)=>directorActionPermitted(actionId,directorCaps)===undefined?this.routerActionAvailable(actor,actionId,stagedAvailable):stagedAvailable&&directorActionPermitted(actionId,directorCaps)===true;
    const packIds=new Set(this.catalog.manifests.map(manifest=>manifest.id));
    const datasetEnabled=(datasetId:string)=>datasetId==='hr_employees'?packIds.has('hr'):datasetId==='branch_performance'?packIds.has('sales')&&packIds.has('operations'):packIds.has(catalog.datasets.find(dataset=>dataset.id===datasetId)?.table?.ownerPackId??'');
    const base=await buildPlannerContext({store:this.store,actor,conversationId:context.conversationId,businessDate:this.businessDate,catalog,registry,
      recipientAllowed:(a,id)=>this.recipientAllowed(a,id),availability:await availabilityWindow(this.store,actor,catalog),
      dashboardShareGroups:(a,dashboardIds)=>this.dashboardShareContext(a,dashboardIds),
      pendingClarification:pending?{about:pending.about,missing:pending.missing,...(selection?{selection}:{})}:null,stagedAvailable,
      pendingBound:(a,action)=>this.proposalBound(a,action),
      ...(selected?{selected:selected.context}:{}),
      monitors:a=>this.effectBindings().listMonitors!(a),
      ...(director?{workflow:(a:Actor,conversationId:string)=>buildDirectorPlannerContext({port:director,capabilities:directorCaps,store:this.store,staged:createStagedStore(this.store,{now:()=>this.now().getTime()}),actor:a,conversationId})}:{}),
      archivedArtifacts:async a=>{const archived=await archivedArtifactIds(this.store,a.id),titles=await displayTitles(this.store,a.id);return (await createArtifactReader(this.store,a.id).listAll()).filter(head=>archived.has(head.artifactId)).slice(0,5).map(head=>({id:head.artifactId,typeId:head.kind,title:titles.get(head.artifactId)??head.title}));},
      artifacts:async(a,conversationId)=>{const archived=await archivedArtifactIds(this.store,a.id),titles=await displayTitles(this.store,a.id);return (await createArtifactReader(this.store,a.id).listHeads(conversationId)).filter(head=>!archived.has(head.artifactId)).map(head=>({id:head.artifactId,typeId:head.kind,title:titles.get(head.artifactId)??head.title,revision:head.revision}));},now:()=>this.now().getTime()});
    const previousPlan=base.previousState?await previousPlanFor(this.store,actor,context.conversationId,base.previousState.stateId):undefined;
    const plannerContext:PlannerContext={...base,
      actions:base.actions.filter(action=>permitAction(action.actionId)),
      catalog:{...base.catalog,datasets:base.catalog.datasets.filter(dataset=>datasetEnabled(dataset.id)).map(dataset=>({...dataset,label:datasetLabel(dataset.id,dataset.label)})),descriptors:plannerCatalogDescriptors(catalog,actor,datasetEnabled)},
      conversation:await this.plannerHistory(actor,context.conversationId,context.turnId),
      previousState:base.previousState?{...base.previousState,...(previousPlan?{plan:previousPlan}:{})}:null};
    if(source.kind==='server'){
      const latest=await this.context(this.store,actor,context.conversationId,false,signal).latestDashboard();
      source={kind:'server',plan:bindServerSelectors(source.plan,{latestOwnedDashboardId:latest?.id,newestReviewedQueueId:plannerContext.workflow?.reviewedQueues[0]?.id,latestVerifiedApprovalId:plannerContext.workflow?.verifiedApprovals[0]?.id})};
    }
    const staged=stagedAvailable?createStagedStore(this.store,{now:()=>this.now().getTime()}):unavailableStagedPorts();
    const effects=this.effectBindings();
    // Direct private writes run INSIDE the turn's completion transaction (never before durable completion): a failed turn leaves nothing changed.
    const deferred:DeferredWrite[]=[];
    const ports:ActionPorts={...createActionPorts({
      reloadActor:a=>reloadActor(this.store,a,this.now()),
      prepareTool:async(a,tool,args,ref)=>{
        const value=await this.broker(a,{conversationId:ref.conversationId,turnId:ref.turnId},emitStatus,signal,policyForPrepareTool(tool,args)).execute(tool,args) as ToolValue|undefined;
        if(!value?.pendingAction)throw new DomainError('UNSUPPORTED_WIDGET','Dashboard ไม่รองรับองค์ประกอบที่ขอ จึงยังไม่ได้เตรียมรายการ',400);
        return value.pendingAction;
      },
      confirmPending:(a,actionId)=>this.confirm(a,actionId),
      cancelPending:(a,actionId)=>this.cancelPendingAction(a,actionId),
      revisePending:(a,actionId,patch)=>this.bookkeeping(tx=>this.revisePendingActionInTransaction(tx,a,actionId,patch,chatRefinementRequestKey(requestId,actionId),context)),
      listPending:async(a,conversationId)=>(await this.store.list<PendingAction>('pending_actions',{actorId:a.id})).filter(item=>item.actorId===a.id&&item.conversationId===conversationId),
      getDashboard:(_a,dashboardId)=>this.savedDashboardInfo(dashboardId),
      dashboardShares:(a,dashboardId)=>this.dashboardShares(a,dashboardId),
      revokeDashboardShare:(a,dashboardId,shareId,guard)=>this.revokeDashboardShare(a,dashboardId,shareId,guard),
      renameDashboard:async(a,dashboardId,input,guard={})=>{
        const current=await reloadActor(this.store,a,this.now());requirePermission(current,'sales.read');
        const fields=this.parseRenameFields(input),dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);
        invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
        await this.assertDashboardWritable(this.store,dashboard,guard);
        deferred.push((tx,finalActor)=>this.renameDashboardInTx(tx,finalActor,dashboardId,fields,guard));
        return{id:dashboardId,title:fields.title};
      },
      deleteDashboard:(a,dashboardId)=>this.deleteDashboard(a,dashboardId),
      updateDashboardSpec:async(a,dashboardId,spec,guard={})=>{
        const next=dashboardSpecSchema.parse(spec);assertDashboardRendererSupport(next);
        const current=await reloadActor(this.store,a,this.now());requirePermission(current,'sales.read');requirePermission(current,'dashboard.create');
        const dashboard=await this.store.get<Dashboard>('dashboards',dashboardId);
        invariant(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard),'NOT_FOUND','ไม่พบ Dashboard',404);
        invariant(digest(dashboard.spec.scope)===digest(next.scope),'INVALID_INPUT','การปรับ Dashboard ต้องไม่เปลี่ยนขอบเขตข้อมูล',400);
        await this.assertDashboardWritable(this.store,dashboard,guard);
        await this.assertWidgetsFitScope(current,dashboardId,next);
        deferred.push(async(tx,finalActor)=>{await this.updateDashboardSpecInTx(tx,finalActor,dashboardId,next,guard);});
        return{id:dashboardId,title:next.title};
      },
      proposalBound:(a,action)=>this.proposalBound(a,action),
      recipientAllowed:(a,recipientId)=>this.recipientAllowed(a,recipientId),
      branchesAllowed:async(a,branchIds)=>{const all=new Map(branches.map(branch=>[branch.id,branch]));return branchIds.every(branchId=>{const branch=all.get(branchId);return !!branch&&canRegion(a,branch.region);});},
      audit:async(_a,event)=>{deferred.push((tx,finalActor)=>this.audit(tx,finalActor,event.kind,event.detail,event.refId));},
      // Results library (direct, owner-private): resolved by server id and written by the SAME library/save functions the Results page uses, inside the turn's completion transaction.
      results:{apply:async(a,input)=>{
        const current=await reloadActor(this.store,a,this.now());requirePermission(current,'dashboard.create');
        const head=await createArtifactReader(this.store,current.id).head(input.artifactId);
        if(!head)return{ok:false,code:'result_not_found',text:'ไม่พบผลลัพธ์ของคุณตามที่ระบุ จึงไม่ได้ดำเนินการ'};
        const archived=(await archivedArtifactIds(this.store,current.id)).has(input.artifactId);
        if(input.op==='unarchive'){
          if(!archived)return{ok:true,text:'ผลลัพธ์ “'+head.title+'” อยู่ในคลังอยู่แล้ว'};
        }else{
          if(archived)return{ok:false,code:'result_archived',text:'ผลลัพธ์นี้เก็บถาวรอยู่ — นำกลับมาก่อนจึงจะจัดการต่อได้'};
          if(input.conversationId&&head.conversationId!==input.conversationId&&!selected?.artifactIds.has(input.artifactId))return{ok:false,code:'result_not_found',text:'ไม่พบผลลัพธ์ในบทสนทนานี้ จึงไม่ได้ดำเนินการ'};
        }
        const artifactId=input.artifactId,at=this.now().toISOString();
        if(input.op==='save'){
          if(input.revision!==undefined&&input.revision!==head.revision)return{ok:false,code:'save_latest_only',text:'บันทึกได้เฉพาะฉบับล่าสุด (ฉบับที่ '+head.revision+') — ฉบับที่ '+input.revision+' เก็บไว้ตามเดิม ไม่ได้บันทึก'};
          if(isArtifactSaved(head))return{ok:true,text:'ผลลัพธ์ “'+head.title+'” บันทึกไว้แล้ว'};
          deferred.push(async(tx,finalActor)=>{await this.saveArtifactInTx(tx,finalActor,artifactId,{conversationId:head.conversationId});});
          return{ok:true,text:'บันทึกผลลัพธ์ “'+head.title+'” แล้ว'};
        }
        const op=input.op==='rename'?{op:'rename' as const,title:input.title??''}:{op:input.op};
        resultOpSchema.parse(op);
        deferred.push(async(tx,finalActor)=>{await applyResultOp(tx,finalActor.id,artifactId,op,at);await this.audit(tx,finalActor,'update','จัดการคลังผลลัพธ์ส่วนตัว');});
        const done:Record<string,string>={rename:'เปลี่ยนชื่อที่แสดงของผลลัพธ์เป็น “'+input.title+'” แล้ว — ข้อมูลและหลักฐานไม่เปลี่ยน',pin:'ปักหมุดผลลัพธ์ “'+head.title+'” แล้ว',unpin:'เลิกปักหมุดผลลัพธ์ “'+head.title+'” แล้ว',archive:'เก็บผลลัพธ์ “'+head.title+'” ถาวรแล้ว — นำกลับมาได้ทุกเมื่อ',unarchive:'นำผลลัพธ์ “'+head.title+'” กลับมาแล้ว'};
        return{ok:true,text:done[input.op]};
      }},
      staged,
      // Dashboard organization (direct, owner-private): the SAME rules as the Dashboard page, written inside the turn's completion transaction.
      organizeDashboard:(a,dashboardId,op)=>this.organizeDashboardForTurn(a,dashboardId,op,write=>{deferred.push(write);}),
      ...(stagedAvailable?{effects:{...effects,...(director?{directorWorkflow:director}:{}),...(effects.manageMonitor?{manageMonitor:(a:Actor,input:Parameters<NonNullable<typeof effects.manageMonitor>>[1])=>effects.manageMonitor!(a,input,{defer:{push:write=>{deferred.push(write);}}})}:{}),
        ...(effects.renameMonitor?{renameMonitor:(a:Actor,input:Parameters<NonNullable<typeof effects.renameMonitor>>[1])=>effects.renameMonitor!(a,input,{defer:{push:write=>{deferred.push(write);}}})}:{})}}:{}),
    }),deferDirectConfirm:true};
    const messages:TurnMessages={current:grounding,...(pending?{clarifiedTurn:pending.clarifiedTurnText,clarifiedTurns:pending.clarifiedTurns}:{})};
    const outcome=await runRouterTurn({store:this.store,actor,conversationId:context.conversationId,turnId:context.turnId,businessDate:this.businessDate,
      now:()=>this.now(),signal,...(turnDeadlineAt?{deadlineAt:turnDeadlineAt}:{}),live,source,context:plannerContext,messages,registry,ports,allRegionIds:[...new Set(branches.map(branch=>branch.region))],
      read:(scope,readSignal)=>this.queryEvidence(actor,scope,readSignal),permitAction,emitStatus,newArtifactId:()=>id('artifact'),datasetEnabled,
      artifacts:createArtifactReader(this.store,actor.id),...(director?{directorWorkflow:director}:{}),resourceLookup:{search:(a,lookup)=>this.lookupOwnedResources(a,lookup)},
      persistArtifact:(preview:ArtifactPreview)=>async(tx,finalActor,conversationId)=>{
        const catalogNow=createSemanticCatalog(await tx.list<Branch>('branches'));
        await persistArtifactPreview(tx,{preview,authority:this.artifactAuthority(finalActor,catalogNow.digest),conversationId,turnId:context.turnId,now:this.now().toISOString()});
      }});
    if(pending&&outcome.pendingClarification?.about===pending.about)outcome.pendingClarification.parentTurnId=pending.turnId;
    for(const write of deferred)outcome.persists.push(async(tx,finalActor)=>write(tx,finalActor));
    return outcome;
  }
  /**
   * Verifies UI-selected targets and a tapped lookup choice (the clarification id): owner-scoped and under CURRENT permissions, never trusted from the
   * request. An artifact picked at an older revision is listed as the server-built pinned id `id:vN` (the exact version); archived Results are not offered.
   */
  private async verifySelectedTargets(actor:Actor,targets:readonly ({kind:'artifact';id:string;revision?:number}|{kind:'dashboard';id:string}|{kind:'monitor';id:string}|{kind:'any';id:string})[]):Promise<{context:{artifacts:{id:string;typeId:string;title:string;revision?:number}[];dashboards:{id:string;title:string}[];monitors:{id:string;title:string;status:string}[]};artifactIds:Set<string>}|undefined>{
    if(!targets.length)return undefined;
    const current=await reloadActor(this.store,actor,this.now()),context={artifacts:[] as {id:string;typeId:string;title:string;revision?:number}[],dashboards:[] as {id:string;title:string}[],monitors:[] as {id:string;title:string;status:string}[]},artifactIds=new Set<string>(),seen=new Set<string>();
    let archived:Set<string>|undefined,titles:Map<string,string>|undefined;
    for(const target of targets.slice(0,4)){
      if(seen.has(target.id))continue;seen.add(target.id);
      const kinds=target.kind==='any'?['artifact','dashboard','monitor']:[target.kind];
      for(const kind of kinds){
        if(kind==='artifact'&&current.permissions.includes('dashboard.create')){
          const head=await createArtifactReader(this.store,current.id).head(target.id);if(!head)continue;
          archived??=await archivedArtifactIds(this.store,current.id);titles??=await displayTitles(this.store,current.id);if(archived.has(head.artifactId))continue;
          const revision='revision' in target&&target.revision!==undefined?target.revision:undefined;
          if(revision!==undefined&&revision>head.revision)continue;
          if(revision!==undefined&&revision!==head.revision){
            const row=await this.store.get<{actorId?:string;artifactId?:string;revision?:number}>('tool_executions',artifactVersionRowId(head.artifactId,revision));
            if(!row||row.actorId!==current.id||row.artifactId!==head.artifactId||row.revision!==revision)continue;
          }
          const pinned=revision!==undefined&&revision!==head.revision;
          context.artifacts.push({id:pinned?pinnedArtifactRef(head.artifactId,revision!):head.artifactId,typeId:head.kind,title:titles.get(head.artifactId)??head.title,revision:revision??head.revision});artifactIds.add(head.artifactId);break;
        }
        if(kind==='dashboard'&&current.permissions.includes('sales.read')){
          const dashboard=await this.store.get<Dashboard>('dashboards',target.id);
          if(dashboard&&dashboard.ownerId===current.id&&!isDeletedDashboard(dashboard)){context.dashboards.push({id:dashboard.id,title:dashboard.spec.title});break;}
        }
        if(kind==='monitor'){
          // B-P1: an exact owned, retained Monitor of ANY age (not only the newest listing window).
          const bindings=this.effectBindings(),monitor=bindings.findMonitor?await bindings.findMonitor(current,target.id):(await bindings.listMonitors?.(current)??[]).find(item=>item.id===target.id);
          if(monitor){context.monitors.push({id:monitor.id,title:monitor.title,status:monitor.status});break;}
        }
      }
    }
    return context.artifacts.length||context.dashboards.length||context.monitors.length?{context,artifactIds}:undefined;
  }
  /** resource_lookup: the actor's OWN resources whose current title contains the planner's name fragment (plain case-insensitive match; owner-scoped; bounded). */
  private async lookupOwnedResources(actor:Actor,input:{resource:'dashboard'|'result'|'monitor';query:string;limit:number;offset?:number}):Promise<{items:{id:string;label:string}[];total:number;truncated?:boolean}>{
    const current=await reloadActor(this.store,actor,this.now()),needle=input.query.trim().toLocaleLowerCase('th-TH'),has=(text:string)=>text.toLocaleLowerCase('th-TH').includes(needle);
    // PC-03: a cursor window over EVERY owned match (truthful total) with server-built disambiguators (type / revision / Bangkok date-time).
    const offset=Math.max(0,Math.trunc(input.offset??0)),limit=Math.max(1,Math.min(input.limit,20));
    const windowOf=<T,>(rows:readonly T[]):T[]=>rows.slice(offset,offset+limit);
    const at=(iso:string)=>{const time=Date.parse(iso);return Number.isFinite(time)?new Date(time+7*3_600_000).toISOString().slice(0,16).replace('T',' '):iso.slice(0,10);};
    if(input.resource==='dashboard'){
      if(!current.permissions.includes('sales.read'))return{items:[],total:0};
      const rows=(await this.store.list<Dashboard>('dashboards')).filter(d=>d.ownerId===current.id&&!isDeletedDashboard(d)&&(has(d.spec.title)||d.id===input.query.trim())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id));
      return{total:rows.length,items:windowOf(rows).map(d=>({id:d.id,label:fitLabel(d.spec.title,' · อัปเดต '+at(d.updatedAt))}))};
    }
    if(input.resource==='result'){
      if(!current.permissions.includes('dashboard.create'))return{items:[],total:0};
      const found=await searchActiveResults(this.store,current.id,input.query);
      return{total:found.items.length,...(found.truncated?{truncated:true}:{}),items:windowOf(found.items).map(item=>({id:item.id,label:fitLabel(item.title,' · '+(RESULT_KIND_LABEL[item.kind]??item.kind)+' · ฉบับล่าสุดที่ '+item.latestRevision+' · '+at(item.updatedAt))}))};
    }
    const bindings=this.effectBindings();
    if(bindings.searchMonitors){
      const found=await bindings.searchMonitors(current,{needle:input.query,offset,limit});
      return{total:found.total,items:found.items.map(m=>({id:m.id,label:fitLabel(m.title,' · '+m.status+' · สร้าง '+at(m.createdAt))}))};
    }
    const rows=(await bindings.listMonitors?.(current)??[]).filter(m=>has(m.title));
    return{total:rows.length,items:windowOf(rows).map(m=>({id:m.id,label:fitLabel(m.title,' · '+m.status)}))};
  }
  /**
   * A clarification chip tap: the choice must be one of the server-validated choices saved for the actor's LATEST clarified
   * turn of this conversation. The label comes from the stored (server-labelled) choice, never from the request.
   */
  private async resolveClarificationSelection(actor:Actor,conversationId:string,pending:PendingClarification|undefined,request:{choiceId:string;clarifiedTurnId:string}):Promise<{id:string;label:string}|undefined>{
    if(!pending||pending.turnId!==request.clarifiedTurnId)return undefined;
    const extras=await this.store.get<{name:string;actorId:string;conversationId:string;turnId:string;choices?:{id:string;label:string}[]}>('tool_executions',turnExtrasId(request.clarifiedTurnId));
    if(!extras||extras.name!==TURN_EXTRAS_TOOL||extras.actorId!==actor.id||extras.conversationId!==conversationId||extras.turnId!==request.clarifiedTurnId)return undefined;
    const choice=(extras.choices??[]).find(item=>item.id===request.choiceId);
    return choice?{id:choice.id,label:choice.label}:undefined;
  }
  private broker(actor:Actor,context:{conversationId:string;turnId:string},onStatus?:(code:ChatStreamStatusCode)=>Promise<void>,signal?:AbortSignal,policy:PreparationPolicy={allowedPrepareToolNames:[]}){
    const allowedPrepare=new Set(policy.allowedPrepareToolNames);
    const allDescriptors=this.catalog.manifests.flatMap(p=>p.tools).filter(t=>t.audit==='read'||(t.audit==='prepare'&&allowedPrepare.has(t.name as PrepareToolName))),descriptors=allDescriptors.filter(t=>this.catalog.allowsTool(actor,t.name)).map(t=>actor.mode==='live_ai'&&t.name==='dashboard.prepare_create'
      ?{...t,resultSchema:z.union([t.resultSchema,unsupportedWidgetResultSchema])}:t);let boundScope:string|undefined;
    let prepareAttempt:{key:string;toolName:string;promise:Promise<unknown>}|undefined;
    return{descriptors,execute:async(name:string,args:unknown):Promise<unknown>=>{
      const registered=this.catalog.descriptor(name);
      if(registered?.audit==='prepare'&&prepareAttempt&&prepareAttempt.toolName!==name)
        throw new DomainError('CONFLICT','อนุญาตให้เตรียมคำขอเดียวในหนึ่งข้อความ',409);
      if(registered?.audit==='prepare'&&!allowedPrepare.has(name as PrepareToolName))throw new DomainError('FORBIDDEN','คำขอนี้ไม่ได้อนุญาตให้เตรียมการดำเนินงานนี้',403);
      const descriptor=allDescriptors.find(t=>t.name===name),binding=this.catalog.tools.get(name);invariant(descriptor&&binding,'UNKNOWN_TOOL','เครื่องมือไม่อยู่ในรายการที่อนุญาต');
      const latest=await reloadActor(this.store,actor,this.now());for(const permission of this.catalog.toolPermissions(name))requirePermission(latest,permission);
      if(binding.audit==='prepare')invariant(latest.mode===actor.mode&&latest.modeRevision===actor.modeRevision,'STALE_ACTION','โหมดเปลี่ยน กรุณาส่งคำขอใหม่',409);
      if(signal?.aborted)throw signal.reason??new DOMException('The response was stopped.','AbortError');
      const parsed=descriptor.inputSchema.parse(args) as Record<string,unknown>;
      const base=this.context(this.store,{...latest,mode:actor.mode,modeRevision:actor.modeRevision},context.conversationId);
      if(binding.audit==='prepare')invariant(matchesPreparationTarget(policy,name,parsed),
        'FORBIDDEN','กลุ่มเป้าหมายของเครื่องมือต้องตรงกับคำขอที่ระบุ',403);
      // A rejected renderer spec must not reserve the turn's successful prepare attempt.
      if(actor.mode==='live_ai'&&name==='dashboard.prepare_create'){
        const payload=actionPayloadSchema.parse({kind:'dashboard_create',spec:parsed.spec});
        if(payload.kind==='dashboard_create'){
          try{assertDashboardRendererSupport(payload.spec);}
          catch(error){
            if(!(error instanceof DomainError)||error.code!=='UNSUPPORTED_WIDGET')throw error;
            await base.evidence(payload.spec.scope);
            return unsupportedWidgetResult;
          }
        }
      }
      const memoArgs=name==='ticket.prepare_create'
        ?(()=>{
          const scope=parsed.scope&&typeof parsed.scope==='object'&&!Array.isArray(parsed.scope)?parsed.scope as Record<string,unknown>:undefined;
          return{...parsed,...(Array.isArray(parsed.branchIds)?{branchIds:[...(parsed.branchIds as string[])].sort()}:{}),
            ...(scope?{scope:{...scope,...(Array.isArray(scope.branchIds)?{branchIds:[...(scope.branchIds as string[])].sort()}: {})}}:{})};
        })()
        :parsed;
      const key=binding.audit==='prepare'?digest({name,args:memoArgs}):undefined;
      if(key&&prepareAttempt){
        invariant(prepareAttempt.key===key,'CONFLICT','อนุญาตให้เตรียมคำขอเดียวในหนึ่งข้อความ',409);
        const memoized=await prepareAttempt.promise as ToolValue;
        const pending=memoized.pendingAction;
        invariant(binding.audit==='prepare'&&pending,'INVALID_PACK','เครื่องมือเตรียมคำขอไม่ได้คืนตัวอย่างที่บันทึกไว้จริง',500);
        return this.store.transaction(async tx=>{
          const current=await reloadActor(tx,actor,this.now());
          for(const permission of this.catalog.toolPermissions(name))requirePermission(current,permission);
          invariant(current.mode===actor.mode&&current.modeRevision===actor.modeRevision,
            'STALE_ACTION','โหมดเปลี่ยน กรุณาส่งคำขอใหม่',409);
          const stored=await tx.get<PendingAction>('pending_actions',pending.id);
          invariant(stored&&stored.status==='pending'&&stored.actorId===current.id&&stored.sessionId===current.sessionId&&
            stored.conversationId===context.conversationId&&stored.turnId===context.turnId&&stored.mode===current.mode&&
            stored.modeRevision===current.modeRevision&&stored.payloadHash===this.approvalHash(stored)&&digest(stored)===digest(pending),
            'STALE_ACTION','ตัวอย่างคำขอเดิมไม่อยู่ในสถานะปัจจุบัน กรุณาส่งคำขอใหม่',409);
          await this.validate(tx,current,stored.payload,context.conversationId,true);
          return memoized;
        });
      }
      const executeBinding=async():Promise<unknown>=>{
        await onStatus?.(binding.audit==='prepare'?'preparing':'reading');
        if(signal?.aborted)throw signal.reason??new DOMException('The response was stopped.','AbortError');
        const value=descriptor.resultSchema.parse(await(binding.audit==='read'?binding.run(base,parsed):binding.run(Object.freeze({...base,prepare:(payload:ActionPayload)=>this.prepare({...latest,mode:actor.mode,modeRevision:actor.modeRevision},payload,context)}) as PackPrepareContext,parsed))) as ToolValue;
        if(signal?.aborted)throw signal.reason??new DOMException('The response was stopped.','AbortError');
        if(value.pendingAction){
          const stored=await this.store.get<PendingAction>('pending_actions',value.pendingAction.id);
          invariant(binding.audit==='prepare'&&stored&&stored.actorId===actor.id&&stored.sessionId===actor.sessionId&&stored.turnId===context.turnId&&digest(stored)===digest(value.pendingAction),'INVALID_PACK','เครื่องมือไม่ได้คืนตัวอย่างคำขอที่บันทึกไว้จริง',500);
        }
        if(value.evidence){const scopeKey=digest(value.evidence.scope);invariant(!boundScope||boundScope===scopeKey,'EVIDENCE_SCOPE_CONFLICT','โปรดเปรียบเทียบสาขาภายในขอบเขตเดียวกันในหนึ่งคำขอ',400);boundScope=scopeKey;}
        await this.bookkeeping(async tx=>{
          if(value.evidence){const c=await this.conversation(tx,latest,context.conversationId);this.activeConversation(c);await tx.put('conversations',this.conversationUpdate(latest,context.conversationId,c,{lastScope:value.evidence.scope,lastAnalysis:value.analysis}));}
          await tx.put('tool_executions',{id:id('tool'),actorId:actor.id,turnId:context.turnId,name,status:'completed',mode:actor.mode,createdAt:this.now().toISOString()});await this.audit(tx,latest,binding.audit,name+' สำเร็จ',value.pendingAction?.id,value.evidence?.scope.region);
        });return value;
      };
      if(!key)return executeBinding();
      let resolveAttempt!:(value:unknown)=>void,rejectAttempt!:(reason?:unknown)=>void;
      const promise=new Promise<unknown>((resolve,reject)=>{resolveAttempt=resolve;rejectAttempt=reject;});
      prepareAttempt={key,toolName:name,promise};
      void (async()=>{try{resolveAttempt(await executeBinding());}catch(error){rejectAttempt(error);}})();
      return promise;
    }};
  }
}

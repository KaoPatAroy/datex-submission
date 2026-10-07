import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  workflowProjectionManifest,
  legacyPendingActionBodyFields,
  type WorkflowProjectionDefinition,
  type WorkflowProjectionColumn,
  type WorkflowForeignKey,
  type WorkflowBodyGuard,
  isMarkerlessV2WorkflowBody,
} from './workflow-projections';
import {
  WORKFLOW_BASE_MIGRATION, WORKFLOW_SCOPE_MIGRATION, WORKFLOW_BASE_DIGEST, WORKFLOW_SCOPE_DIGEST,
  WORKFLOW_COMPLETENESS_MIGRATION, WORKFLOW_COMPLETENESS_DIGEST,
  WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION, WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST,
  historicalWorkflowBaseDefinitions, historicalWorkflowScopeDefinitions, historicalWorkflowCompletenessDefinitions,
  historicalWorkflowConversationPersistenceDefinitions,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION, WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST,
  historicalWorkflowSnapshotProofReferenceDefinitions,
} from './workflow-schema-history';
import { MAX_WORKFLOW_REASON_CHARS, persistedConversationSchema, persistedConversationMessageSchema, dashboardShareRevokeEventSchema, dashboardShareV2Schema, instantSchema, refSchema, pendingActionV2Schema } from '../workflows/contracts';

export { WORKFLOW_COMPLETENESS_MIGRATION, WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION, WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION } from './workflow-schema-history';
export const WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION = '202610040003_workflow_action_target_provenance';
export const WORKFLOW_PENDING_ACTION_REVISION_MIGRATION = '202610050001_workflow_pending_action_revision';
export const WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION = '202610050002_workflow_pending_action_v2_body_guard';
export const WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION = '202610050003_workflow_pending_action_delete_fence';
export const WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION = '202610050004_workflow_pending_action_insert_identity_fence';
export const WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION = '202610050005_workflow_pending_action_fresh_v1_insert';
export const WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION = '202610050006_workflow_pending_action_fresh_v1_status_projection';
const WORKFLOW_PENDING_ACTION_REVISION_LEGACY_DIGEST = '4ad1e3fc649d63e6c9c73c42645f6df46310c482fac2e6dc6153ef236aeb799a';
const WORKFLOW_PENDING_ACTION_REVISION_REUSED_ID_DIGEST = '42ef4db17800ecb84a75b408c64840e2c38152c39bec57aece119ddfb3377f10';
export interface WorkflowMigrationDefinition extends Omit<WorkflowProjectionDefinition, 'bodySchema'> {
  appendOnly: boolean;
  bodyFields: readonly string[];
}
const appendOnly = new Set(['review_snapshots', 'review_snapshot_targets', 'action_confirmations',
  'onboarding_approval_events', 'incident_escalation_events', 'badge_effect_events', 'audit_events',
  'dashboard_versions', 'share_scope_branches', 'simulated_deliveries', 'share_access_events','semantic_effects','workflow_policies','dashboard_share_revoke_events']);
const revokeQuarantine = 'pre_migration_revoke_quarantined';
const revokePointers = ['workflow_revoke_share_id','workflow_revoke_share_row_version','workflow_revoke_creation_execution_id'] as const;
function revokePointerSql(d:WorkflowMigrationDefinition):string[] {
  const condition=`workflow_contract_version=2 AND status='revoked' AND ${safeName(d.legacyQuarantineColumn!)}=0`;
  return revokePointers.map((name,index)=>`${safeName(name)} ${index===1?'INTEGER':'TEXT'} GENERATED ALWAYS AS (CASE WHEN ${condition} THEN ${['id','row_version','execution_id'][index]} ELSE NULL END) VIRTUAL`);
}
const safeName = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid workflow SQL identifier');
  return `"${value}"`;
};
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const snake = (value: string): string => value.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (value: string): string => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const path = (value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(value)) throw new Error('Invalid workflow body field');
  return literal(`$.${value}`);
};
const extract = (body: string, field: string): string => `json_extract(${body}, ${path(field)})`;
const protectedRow = (d: WorkflowMigrationDefinition, prefix = ''): string => d.storage === 'mixed'
  ? `${prefix}workflow_contract_version = 2` : '1';

function referenceMarker(f:WorkflowForeignKey):string{return f.column.replace(/_id$/,'')+'_contract_version';}
function contractReferences(d:WorkflowMigrationDefinition):WorkflowForeignKey[]{return d.foreignKeys.filter(f=>Reflect.get(f,'requiredContractVersion')===2);}
function referenceMarkerSql(d:WorkflowMigrationDefinition,f:WorkflowForeignKey):string{
  const protectedReference=`${d.storage==='mixed'?`${safeName(d.markerColumn!)}=2 AND `:''}${safeName(f.column)} IS NOT NULL`;
  return `${safeName(referenceMarker(f))} INTEGER GENERATED ALWAYS AS (CASE WHEN ${protectedReference} THEN 2 ELSE NULL END) VIRTUAL`;
}
function referenceFkSql(f:WorkflowForeignKey,definitions:readonly WorkflowMigrationDefinition[]):string{
  const target=definitions.find(d=>d.table===f.target);
  if(!target?.markerColumn)throw new Error('Workflow migration invalid contract reference');
  return `FOREIGN KEY(${safeName(f.column)},${safeName(referenceMarker(f))}) REFERENCES ${safeName(f.target)}(id,${safeName(target.markerColumn)}) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`;
}

/** Serialization source for the checked-in PostgreSQL SQL twin and parity tests. */
export function workflowMigrationDefinitions(): WorkflowMigrationDefinition[] {
  return [...workflowProjectionManifest.values()].map(({bodySchema,...d})=>({
    ...d, columns:columns(d).map(c=>{
      const f=d.foreignKeys.find(f=>f.column===c.column);
      return f ? {...c,bodyField:f.bodyField??c.bodyField,...(f.tagField?{tagField:f.tagField,tagValue:f.tagValue??f.target}:{})}:c;
    }), appendOnly:appendOnly.has(d.table),
    // strictBodySchema accepts legacy scenario annotations on reads/writes. Shared SQL
    // already permits extra payload fields; preserve the sealed SQL descriptor bytes.
    bodyFields:schemaFields(bodySchema).filter(field=>field!=='operationKey'||(d.table!=='inventory_snapshots'&&d.table!=='incidents')),
  }));
}
function schemaFields(schema:object):string[]{
  const shape=Reflect.get(schema,'shape');
  if(shape&&typeof shape==='object')return Object.keys(shape);
  const options=Reflect.get(schema,'options');
  return Array.isArray(options)?[...new Set(options.filter(s=>typeof s==='object'&&s!==null).flatMap(schemaFields))]:[];
}

function columns(d: Omit<WorkflowProjectionDefinition,'bodySchema'>): WorkflowProjectionColumn[] {
  const result = new Map(d.columns.filter(c => c.column !== 'row_version').map(c => [c.column, c]));
  for (const f of d.foreignKeys) if (!result.has(f.column)) result.set(f.column, {
    column: f.column, bodyField: f.bodyField ?? camel(f.column), type: 'text', nullable: f.nullable,
  });
  for (const u of d.unique) for (const field of u.fields) {
    if (field === 'id' || field === 'rowVersion') continue;
    if([...result.values()].some(c=>c.bodyField===field))continue;
    const name = snake(field);
    if (!result.has(name)) result.set(name, { column: name, bodyField: field, type: 'text', nullable: true });
  }
  if (d.stateField && !result.has(snake(d.stateField))) result.set(snake(d.stateField), {
    column: snake(d.stateField), bodyField: d.stateField, type: d.stateField === 'active' ? 'boolean' : 'text', nullable: true,
  });
  return [...result.values()];
}

function projected(d: WorkflowMigrationDefinition, c: WorkflowProjectionColumn, body: string): string {
  const f = d.foreignKeys.find(f => f.column === c.column);
  const value = extract(body, f?.bodyField ?? c.bodyField);
  if(f?.tagField)return `CASE WHEN ${extract(body, f.tagField)} = ${literal(f.tagValue ?? f.target)} THEN ${value} ELSE NULL END`;
  return c.type==='json'?`CASE WHEN ${value} IS NULL THEN NULL ELSE json_quote(${value}) END`:value;
}
const sqlType = (c: WorkflowProjectionColumn): string => ({ text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'TEXT' })[c.type];
function columnSql(d: WorkflowMigrationDefinition, c: WorkflowProjectionColumn): string {
  const f = d.foreignKeys.find(f => f.column === c.column);
  return `${safeName(c.column)} ${sqlType(c)}${f ? ` REFERENCES ${safeName(f.target)}(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED` : ''}`;
}
function state(d: WorkflowMigrationDefinition, body: string): string {
  if (!d.stateField) return 'NULL';
  const value = extract(body, d.stateField);
  return d.stateField === 'active' ? `CASE ${value} WHEN 1 THEN 'active' WHEN 0 THEN 'inactive' ELSE ${value} END` : value;
}

function bodyGuardChecks(guard:WorkflowBodyGuard,body:string,allowLegacy=false):string[]{
  const value=extract(body,guard.field),type=`json_type(${body},${path(guard.field)})`;
  const id=(field:string)=>`json_type(${body},${path(field)})='text' AND length(${extract(body,field)}) BETWEEN 1 AND 160 AND ${extract(body,field)} GLOB '[A-Za-z0-9]*' AND ${extract(body,field)} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
  let rule:string;
  switch(guard.kind){
    case 'business_date':rule=`${type}='text' AND length(${value})=10 AND ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(${value},1,4)<>'0000' AND date(${value},'+0 days') IS ${value}`;break;
    case 'priority':rule=`${type}='text' AND ${value} IN ('normal','high')`;break;
    case 'identifier':rule=id(guard.field);break;
    case 'nonnegative_integer':rule=`${type}='integer' AND ${value} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}`;break;
    case 'reason':rule=`${type}='text' AND workflow_utf16_length(${value}) BETWEEN 1 AND ${MAX_WORKFLOW_REASON_CHARS} AND length(trim(${value},${literal('\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')}))>0`;break;
    case 'escalation_stage':rule=`${type}='text' AND ${value} IN ('un_escalated','team_requested')`;break;
    case 'document_status':rule=`${type}='text' AND ${value} IN (${(allowLegacy?['accepted','withdrawn','replaced','missing','received','waived']:['accepted','withdrawn','replaced']).map(literal).join(',')})`;break;
    case 'id_array':rule=`${type}='array' AND json_array_length(${body},${path(guard.field)}) BETWEEN ${guard.minimum??0} AND ${guard.maximum??100}
      AND NOT EXISTS(SELECT 1 FROM json_each(${body},${path(guard.field)}) a WHERE a.type<>'text' OR length(a.value) NOT BETWEEN 1 AND 160 OR a.value NOT GLOB '[A-Za-z0-9]*' OR a.value GLOB '*[^A-Za-z0-9._:-]*')
      AND (SELECT count(*) FROM json_each(${body},${path(guard.field)}))=(SELECT count(DISTINCT value) FROM json_each(${body},${path(guard.field)}))`;break;
    case 'employee_snapshot':rule=`${type}='object' AND (SELECT count(*) FROM json_each(${body},${path(guard.field)}))=5
      AND NOT EXISTS(SELECT 1 FROM json_each(${body},${path(guard.field)}) p WHERE p.key NOT IN ('id','name','branchId','active','rowVersion'))
      AND ${id(guard.field+'.id')} AND json_type(${body},${path(guard.field+'.name')})='text' AND length(${extract(body,guard.field+'.name')})>0
      AND (json_type(${body},${path(guard.field+'.branchId')})='null' OR (${id(guard.field+'.branchId')}))
      AND json_type(${body},${path(guard.field+'.active')}) IN ('true','false')
      AND json_type(${body},${path(guard.field+'.rowVersion')})='integer' AND ${extract(body,guard.field+'.rowVersion')}>0`;break;
  }
  return [`(${type} IS NULL OR ${type}='null' OR (${rule}))`];
}

function requiredWriteChecks(d:WorkflowMigrationDefinition,body:string):string[]{
  return (d.requiredWriteFields??[]).map(field=>`json_type(${body},${path(field)}) IS NOT NULL AND json_type(${body},${path(field)})<>'null'`);
}

function legacyReadOnly(d:WorkflowMigrationDefinition,body:string):string {
  const missing=requiredWriteChecks(d,body).map(check=>`COALESCE((${check}),0)=0`);
  const invalid=(d.bodyGuards??[]).flatMap(guard=>bodyGuardChecks(guard,body,true)).map(check=>`COALESCE((${check}),0)=0`);
  const states=d.legacyReadOnlyStates?.length?[`${state(d,body)} IN (${d.legacyReadOnlyStates.map(literal).join(',')})`]:[];
  return [...missing,...invalid,...states].join(' OR ')||'0';
}

function validation(d: WorkflowMigrationDefinition, prefix: string,allowLegacy=false): string[] {
  const body = `${prefix}${safeName(d.bodyColumn)}`;
  const checks = [`json_valid(${body}) = 1`, `json_type(${body}) = 'object'`,
    `${extract(body, 'id')} IS ${prefix}id`,
    `(${extract(body, 'rowVersion')} IS NULL OR ${extract(body, 'rowVersion')} = ${prefix}row_version)`];
  if(d.storage!=='shared'){
    const allowedBodyFields = d.table==='pending_actions' ? schemaFields(pendingActionV2Schema) : d.bodyFields;
    checks.push(`NOT EXISTS(SELECT 1 FROM json_each(${body}) p WHERE p.key NOT IN (${allowedBodyFields.map(literal).join(',')}))`);
  }
  if ((d.table === 'conversations' && d.bodyFields.includes('lastAnalysis'))
    || (d.table === 'conversation_messages' && d.bodyFields.includes('turnId'))) {
    checks.push(`workflow_conversation_body_valid(${literal(d.table)},${body})=1`);
  }
  if(d.table==='dashboard_shares'&&d.legacyQuarantineColumn===revokeQuarantine)checks.push(`workflow_share_body_valid(${body},${prefix}workflow_contract_version)=1`);
  if(d.table==='dashboard_share_revoke_events')checks.push(`workflow_share_revoke_body_valid(${body})=1`);
  if(d.table==='pending_actions'||d.table==='action_executions')checks.push(`${extract(body,'contractVersion')}=2`);
  if(d.table==='pending_actions')for(const field of ['policy.id','policy.version','policy.digest'])checks.push(`${extract(body,field)} IS NOT NULL`);
  for(const equal of d.projectionEqualities)checks.push(`${extract(body,equal.leftPath)} IS ${extract(body,equal.rightPath)}`);
  for(const child of d.normalizedChildren){
    checks.push(child.immutable?`(json_type(${body},${path(child.arrayBodyField)}) IS NULL OR json_type(${body},${path(child.arrayBodyField)})='array')`:`json_type(${body},${path(child.arrayBodyField)})='array'`);
    checks.push(`NOT EXISTS(SELECT 1 FROM json_each(${body},${path(child.arrayBodyField)}) p WHERE p.type<>'text')`);
    checks.push(`(SELECT count(*) FROM json_each(${body},${path(child.arrayBodyField)}))=(SELECT count(DISTINCT value) FROM json_each(${body},${path(child.arrayBodyField)}))`);
  }
  for (const c of columns(d)) {
    if(c.legacyOnly)continue;
    if(c.external){checks.push(`(${prefix}${safeName(c.column)} IS NOT NULL AND ${c.type==='integer'?`typeof(${prefix}${safeName(c.column)})='integer' AND ${prefix}${safeName(c.column)}>0`:`typeof(${prefix}${safeName(c.column)})='text'`})`);continue;}
    const value = projected(d, c, body);
    const type = `json_type(${body}, ${path(c.bodyField)})`;
    const tagged = d.foreignKeys.some(f => f.column === c.column && f.tagField);
    if (!c.nullable && !tagged) checks.push(`${value} IS NOT NULL`);
    if(tagged)checks.push(`(${value} IS NULL OR ${type}='text')`);
    if (!tagged) {
      const allowed = { text: "'text'", integer: "'integer'", real: "'integer','real'", boolean: "'true','false'", json: "'object','array','text','integer','real','true','false'" }[c.type];
      checks.push(`(${value} IS NULL OR ${type} IN (${allowed}))`);
    }
    if (c.type === 'integer') checks.push(`(${value} IS NULL OR ${value} >= ${/(?:version|attempt|quantity)$/.test(c.column) ? 1 : 0})`);
  }
  for(const guard of d.bodyGuards??[])checks.push(...bodyGuardChecks(guard,body,allowLegacy));
  const states = [...Object.keys(d.permittedTransitions),...(allowLegacy?d.legacyReadOnlyStates??[]:[])];
  if (states.length) checks.push(`${state(d, body)} IN (${states.map(literal).join(',')})`);
  const tagged = d.foreignKeys.filter(f => f.tagField);
  if (tagged.length) {
    checks.push(`(${tagged.map(f => `(CASE WHEN ${projected(d, columns(d).find(c => c.column === f.column)!, body)} IS NOT NULL THEN 1 ELSE 0 END)`).join('+')}) = 1`);
    checks.push(`${extract(body, 'entityType')} IS ${extract(body, tagged[0].tagField!)}`);
  }
  return checks;
}

function assertBody(db: Database.Database, d: WorkflowMigrationDefinition): void {
  const conditions = validation(d, '').map(c => `COALESCE((${c}), 0) = 0`).join(' OR ');
  const bad = db.prepare(`SELECT id FROM ${safeName(d.table)} WHERE ${protectedRow(d)} AND (${conditions}) LIMIT 1`).get();
  if (bad) throw new Error(`Workflow migration incompatible table: ${d.table}`);
}

function shareRevokeRelationship(body:string):string {
  return `EXISTS(SELECT 1 FROM dashboard_shares s JOIN action_executions x ON x.id=${extract(body,'executionId')} JOIN action_executions c ON c.id=${extract(body,'shareCreationExecutionId')} JOIN pending_actions a ON a.id=x.action_id JOIN pending_actions ca ON ca.id=c.action_id JOIN directory_identities sender ON sender.id=s.sender_identity_id WHERE s.id=${extract(body,'shareId')} AND s.workflow_contract_version=2 AND s.${safeName(revokeQuarantine)}=0 AND s.status='revoked' AND s.row_version=${extract(body,'revokedShareRowVersion')} AND ${extract(body,'revokedShareRowVersion')}=${extract(body,'priorShareRowVersion')}+1 AND s.execution_id=c.id AND c.workflow_contract_version=2 AND json_type(c.payload,'$.contractVersion')='integer' AND ${extract('c.payload','contractVersion')}=2 AND json_type(c.payload,'$.actorId')='text' AND c.outcome='verified_success' AND ${extract('c.payload','outcome')}='verified_success' AND ${extract('c.payload','kind')}='dashboard_share' AND ca.workflow_contract_version=2 AND json_type(ca.payload,'$.contractVersion')='integer' AND ${extract('ca.payload','contractVersion')}=2 AND ca.actor_id=${extract('c.payload','actorId')} AND sender.profile_id=ca.actor_id AND ${extract('ca.payload','payload.kind')}='dashboard_share' AND json_type(ca.payload,'$.payload.dashboardId')='text' AND ${extract('ca.payload','payload.dashboardId')}=s.dashboard_id AND json_type(ca.payload,'$.payload.recipientIdentityId')='text' AND ${extract('ca.payload','payload.recipientIdentityId')}=s.recipient_identity_id AND ${extract('ca.payload','payload.channel')}=${extract('s.payload','channel')} AND ${extract('c.payload','createdAt')}=${extract('s.payload','createdAt')} AND workflow_instant_valid(${extract('c.payload','verifiedAt')})=1 AND json_type(ca.payload,'$.targets')='array' AND json_type(c.payload,'$.proofs')='array' AND EXISTS(SELECT 1 FROM json_each(c.payload,'$.proofs') p JOIN json_each(ca.payload,'$.targets') t ON json_extract(p.value,'$.targetId')=json_extract(t.value,'$.targetId') WHERE p.type='object' AND t.type='object' AND json_type(t.value,'$.targetId')='text' AND json_type(t.value,'$.expectedEffectRef.id')='text' AND json_extract(t.value,'$.expectedEffectRef.table')='dashboard_shares' AND json_extract(t.value,'$.expectedEffectRef.id')=s.id AND (SELECT count(*) FROM json_each(p.value))=7 AND json_type(p.value,'$.ref')='object' AND (SELECT count(*) FROM json_each(p.value,'$.ref'))=2 AND json_extract(p.value,'$.ref.table')='dashboard_shares' AND json_type(p.value,'$.ref.id')='text' AND json_extract(p.value,'$.ref.id')=s.id AND json_type(p.value,'$.executionId')='text' AND json_extract(p.value,'$.executionId')=c.id AND json_extract(p.value,'$.outcome')='verified_success' AND json_type(p.value,'$.observedRowVersion')='integer' AND json_extract(p.value,'$.observedRowVersion')=1 AND workflow_identifier_valid(json_extract(p.value,'$.targetId'))=1 AND workflow_instant_valid(json_extract(p.value,'$.checkedAt'))=1 AND json_type(p.value,'$.mismatchCodes')='array' AND json_array_length(p.value,'$.mismatchCodes')=0) AND x.workflow_contract_version=2 AND json_type(x.payload,'$.contractVersion')='integer' AND ${extract('x.payload','contractVersion')}=2 AND json_type(x.payload,'$.actorId')='text' AND ${extract('x.payload','actorId')}=${extract(body,'actorId')} AND a.actor_id=${extract(body,'actorId')} AND ${extract('x.payload','kind')}='dashboard_share_revoke' AND a.workflow_contract_version=2 AND json_type(a.payload,'$.contractVersion')='integer' AND ${extract('a.payload','contractVersion')}=2 AND ${extract('a.payload','payload.kind')}='dashboard_share_revoke' AND json_type(a.payload,'$.payload.shareId')='text' AND ${extract('a.payload','payload.shareId')}=s.id AND ${extract('s.payload','revokedAt')}=${extract(body,'createdAt')})`;
}

function relationalChecks(d:WorkflowMigrationDefinition,body:string,event:'insert'|'update'='update'):string {
  const fail=(test:string)=>`SELECT CASE WHEN COALESCE((${test}),0)=0 THEN RAISE(ABORT,'Invalid workflow relationship') END;`;
  if(d.table==='dashboard_share_revoke_events')return fail(shareRevokeRelationship(body));
  if(d.table==='share_scope_branches')return fail(`EXISTS(SELECT 1 FROM dashboard_shares s,json_each(s.payload,'$.approvedBranchIds') b WHERE s.id=${extract(body,'shareId')} AND s.workflow_contract_version=2 AND b.value=${extract(body,'branchId')})`);
  if(d.table==='onboarding_requests')return ['manager','director'].map(stage=>{
    const pointer=extract(body,stage+'ApprovalEventId');
    const needed=stage==='manager'?"'director_approval_pending','director_approved','onboarding_in_progress','completed'":"'director_approved','onboarding_in_progress','completed'";
    return fail(`(${pointer} IS NULL AND ${extract(body,'state')} NOT IN (${needed})) OR EXISTS(SELECT 1 FROM onboarding_approval_events e WHERE e.id=${pointer} AND e.request_id=NEW.id AND e.stage=${literal(stage)} AND e.lifecycle_id=${extract(body,'lifecycleId')} AND e.actor_identity_id=${extract(body,stage+'IdentityId')})`);
  }).join('\n');
  if(d.table==='action_idempotency_roots')return fail(`NOT EXISTS(SELECT 1 FROM action_executions e WHERE e.id=${extract(body,'activeExecutionId')} AND e.workflow_contract_version=2 AND e.root_id<>NEW.id)`);
  if(d.table==='action_executions')return fail(`NOT EXISTS(SELECT 1 FROM action_idempotency_roots r WHERE r.active_execution_id=NEW.id AND r.id<>NEW.root_id)`);
  if(d.table==='policy_acknowledgement_tasks')return fail(`EXISTS(SELECT 1 FROM policy_documents p WHERE p.id=${extract(body,'policyDocumentId')} AND p.version=${extract(body,'policyVersion')})`);
  if(d.table==='simulated_deliveries')return fail(`EXISTS(SELECT 1 FROM dashboard_shares s WHERE s.id=${extract(body,'shareId')} AND s.workflow_contract_version=2 AND s.recipient_identity_id=${extract(body,'recipientIdentityId')} AND ${extract('s.payload','channel')}=${extract(body,'channel')} AND s.execution_id=${extract(body,'executionId')})`);
  if(d.table==='incidents'&&d.columns.some(c=>c.column==='escalation_stage'))return fail(`
    (${extract(body,'escalationStage')} IS NULL AND ${extract(body,'escalationLifecycleId')} IS NULL AND ${extract(body,'escalationEventId')} IS NULL)
    OR (${extract(body,'escalationStage')}='un_escalated' AND json_type(${body},'$.escalationLifecycleId')='text' AND length(${extract(body,'escalationLifecycleId')}) BETWEEN 1 AND 160 AND ${extract(body,'escalationEventId')} IS NULL)
    OR (${extract(body,'escalationStage')}='team_requested' AND EXISTS(SELECT 1 FROM incident_escalation_events e JOIN workflow_teams t ON t.id=e.team_id JOIN action_executions x ON x.id=e.execution_id WHERE e.id=${extract(body,'escalationEventId')} AND e.incident_id=NEW.id AND e.lifecycle_id=${extract(body,'escalationLifecycleId')} AND e.stage='team_requested' AND e.team_id='demo_operations' AND x.workflow_contract_version=2 AND ${extract('x.payload','kind')}='incident_escalate'))`);
  if(d.table==='incident_escalation_events'&&d.requiredWriteFields?.includes('evidenceIds'))return fail(`EXISTS(SELECT 1 FROM incidents i JOIN workflow_teams t ON t.id=${extract(body,'teamId')} JOIN action_executions x ON x.id=${extract(body,'executionId')} WHERE i.id=${extract(body,'incidentId')} AND i.escalation_lifecycle_id=${extract(body,'lifecycleId')} AND i.escalation_stage IN ('un_escalated','team_requested') AND ${extract(body,'stage')}='team_requested' AND t.id='demo_operations' AND t.active=1 AND x.workflow_contract_version=2 AND ${extract('x.payload','kind')}='incident_escalate')`);
  if(d.table==='offboarding_plans'&&d.requiredWriteFields?.includes('employeeSnapshot')){
    const snapshot=extract(body,'employeeSnapshot.id');
    const ownership=fail(`EXISTS(SELECT 1 FROM offboarding_cases c WHERE c.id=${extract(body,'caseId')} AND c.employee_id=${snapshot})`);
    if(event==='update')return ownership;
    return ownership+fail(`EXISTS(SELECT 1 FROM employees e WHERE e.id=${snapshot} AND e.row_version=${extract(body,'employeeSnapshot.rowVersion')} AND e.name IS ${extract(body,'employeeSnapshot.name')} AND e.branch_id IS ${extract(body,'employeeSnapshot.branchId')} AND e.active IS ${extract(body,'employeeSnapshot.active')})`);
  }
  return '';
}

const LEGACY_PENDING_ACTION_BODY_FIELDS = legacyPendingActionBodyFields;

function legacyPendingActionBodyCheck(body: string): string {
  const safeBody = `CASE WHEN json_valid(${body})=1 THEN ${body} ELSE '{}' END`;
  const path = (field: string) => literal('$.'.concat(field));
  const value = (field: string) => `json_extract(${safeBody},${path(field)})`;
  const type = (field: string) => `json_type(${safeBody},${path(field)})`;
  const stringRule = (field: string, minimum: number, maximum?: number) =>
    `${type(field)}='text' AND workflow_utf16_length(${value(field)}) BETWEEN ${minimum} AND ${maximum ?? '9007199254740991'}`;
  const optionalIdRule = (field: string) => `(${type(field)} IS NULL OR ${stringRule(field, 1, 300)})`;
  const optionalField = (field: string) => `${type(field)} IS NULL`;
  const allowedKeys = LEGACY_PENDING_ACTION_BODY_FIELDS.map(literal).join(',');
  const trimCharacters = [
    9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
    8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
  ].map(codePoint => `char(${codePoint})`).join('||');
  const revisionDiffValid = `(
    ${type('revisionDiff')}='array'
    AND json_array_length(${safeBody},'$.revisionDiff') BETWEEN 1 AND 32
    AND NOT EXISTS(
      SELECT 1 FROM json_each(${safeBody},'$.revisionDiff') line
      WHERE line.type<>'text'
        OR workflow_utf16_length(line.value) NOT BETWEEN 1 AND 600
        OR length(trim(line.value,${trimCharacters}))=0
    )
  )`;
  const predecessorPairValid = `(
    (${optionalField('predecessorActionId')} AND ${optionalField('revisionDiff')})
    OR (${stringRule('predecessorActionId', 1, 300)} AND ${revisionDiffValid})
  )`;
  const supersededIdValid = stringRule('supersededByActionId', 1, 300);
  const staleReasonType = type('staleReason');
  const staleReasonValid = `(
    ${staleReasonType} IS NULL
    OR (${staleReasonType}='text' AND ${value('staleReason')} IN (
      'superseded','user_cancelled','expired','mode_changed','release_changed',
      'evidence_changed','source_turn_failed','source_turn_cancelled'
    ))
  )`;
  const stalePairValid = `(
    (${optionalField('supersededByActionId')} AND ${optionalField('staleReason')})
    OR (${supersededIdValid} AND ${value('staleReason')}='superseded')
    OR (
      ${optionalField('supersededByActionId')}
      AND ${staleReasonType}='text'
      AND ${value('staleReason')} IN (
        'user_cancelled','expired','mode_changed','release_changed','evidence_changed',
        'source_turn_failed','source_turn_cancelled'
      )
    )
  )`;
  const staleStatusValid = `(${value('status')}='stale' OR (${optionalField('supersededByActionId')} AND ${optionalField('staleReason')}))`;
  return `(
    json_valid(${body})=1
    AND json_type(${safeBody})='object'
    AND NOT EXISTS(SELECT 1 FROM json_each(${safeBody}) field WHERE field.key NOT IN (${allowedKeys}))
    AND ${stringRule('id', 1, 300)}
    AND ${stringRule('actorId', 1, 300)}
    AND ${stringRule('sessionId', 1, 300)}
    AND ${stringRule('conversationId', 1, 300)}
    AND ${stringRule('turnId', 1, 300)}
    AND ${type('mode')}='text' AND ${value('mode')} IN ('live_ai','scripted_demo')
    AND ${type('modeRevision')}='integer' AND ${value('modeRevision')} BETWEEN 0 AND 9007199254740991
    AND ${type('payloadHash')}='text' AND workflow_utf16_length(${value('payloadHash')})>=1
    AND ${type('packs')}='array'
    AND (${type('evidenceVersion')} IS NULL OR ${type('evidenceVersion')} IN ('null','text'))
    AND (${type('releaseRevision')} IS NULL OR ${type('releaseRevision')}='text')
    AND (${type('actionContractVersion')} IS NULL OR (${type('actionContractVersion')}='integer' AND ${value('actionContractVersion')}=1))
    AND ${optionalIdRule('predecessorActionId')}
    AND ${optionalIdRule('supersededByActionId')}
    AND ${predecessorPairValid}
    AND ${staleReasonValid}
    AND ${stalePairValid}
    AND ${staleStatusValid}
    AND (${value('status')} IN ('pending','claimed','completed','stale') AND ${type('status')}='text')
    AND ${type('createdAt')}='text'
    AND ${type('expiresAt')}='text'
    AND ${type('preview')}='text'
  )`;
}

function pendingActionV1InsertGuardStatement(
  d: WorkflowMigrationDefinition,
  table: string,
  body: string,
): string | null {
  if (d.table !== 'pending_actions') return null;

  const abort = (test: string, reason: string) =>
    `SELECT CASE WHEN COALESCE((${test}),0)=0 THEN RAISE(ABORT,${literal(reason)}) END;`;
  const sameLineageUpsert = `EXISTS(
    SELECT 1 FROM pending_actions old
    WHERE old.id=NEW.id AND old.workflow_contract_version IS NULL
      AND json_type(old.payload,'$.predecessorActionId') IS json_type(NEW.payload,'$.predecessorActionId')
      AND json_extract(old.payload,'$.predecessorActionId') IS json_extract(NEW.payload,'$.predecessorActionId')
      AND json_type(old.payload,'$.revisionDiff') IS json_type(NEW.payload,'$.revisionDiff')
      AND json_extract(old.payload,'$.revisionDiff') IS json_extract(NEW.payload,'$.revisionDiff')
  )`;
  const lineageOnInsert = `${extract(body, 'predecessorActionId')} IS NULL OR ${state(d, body)}='pending' OR ${sameLineageUpsert}`;
  const hasLifecycleMetadata = `(
    json_type(${body},'$.predecessorActionId') IS NOT NULL
    OR json_type(${body},'$.revisionDiff') IS NOT NULL
    OR json_type(${body},'$.supersededByActionId') IS NOT NULL
    OR json_type(${body},'$.staleReason') IS NOT NULL
  )`;
  const validWhenMetadataPresent = `(NOT ${hasLifecycleMetadata} OR ${legacyPendingActionBodyCheck(body)})`;
  const noStaleMetadata = `json_type(${body},'$.supersededByActionId') IS NULL AND json_type(${body},'$.staleReason') IS NULL`;
  const pendingToStaleUpsert = `(${state(d, body)}='stale' AND EXISTS(
    SELECT 1 FROM pending_actions old
    WHERE old.id=NEW.id AND old.workflow_contract_version IS NULL AND json_extract(old.payload,'$.status')='pending'
  ))`;
  const sameStaleUpsert = `(${state(d, body)}='stale' AND EXISTS(
    SELECT 1 FROM pending_actions old
    WHERE old.id=NEW.id AND old.workflow_contract_version IS NULL AND old.payload=NEW.payload
  ))`;
  return `CREATE TRIGGER ${safeName('workflow_pending_actions_v1_insert_guard')} BEFORE INSERT ON ${table}
    WHEN NEW.workflow_contract_version IS NULL AND workflow_migration_active()=0 BEGIN
      ${abort('NEW.row_version IS NULL AND NEW.workflow_contract_version IS NULL AND json_extract(NEW.payload,\'$.id\') IS NEW.id', 'Invalid legacy pending action identity')}
      ${abort(validWhenMetadataPresent, 'Invalid legacy pending action body')}
      ${abort(`${noStaleMetadata} OR ${pendingToStaleUpsert} OR ${sameStaleUpsert}`, 'Stale metadata requires a pending-to-stale transition')}
      ${abort(lineageOnInsert, 'Revision lineage must be prepared as pending')}
    END`;
}

function pendingActionV1UpdateGuardStatement(
  d: WorkflowMigrationDefinition,
  table: string,
  body: string,
  oldBody: string,
  allowedTransitions: readonly string[],
): string | null {
  if (d.table !== 'pending_actions') return null;

  const abort = (test: string, reason: string) =>
    `SELECT CASE WHEN COALESCE((${test}),0)=0 THEN RAISE(ABORT,${literal(reason)}) END;`;
  const oldState = state(d, oldBody);
  const nextState = state(d, body);
  const isRevisionTransition = `(${oldState}='pending' AND ${nextState}='stale')`;
  const transitionAllowed = `${oldState} IS ${nextState}${allowedTransitions.length ? ' OR ' + allowedTransitions.join(' OR ') : ''}`;
  const unchangedEnvelope = `json_remove(${body},'$.status','$.rowVersion') IS json_remove(${oldBody},'$.status','$.rowVersion')`;
  const revisionEnvelope = `json_remove(${body},'$.status','$.rowVersion','$.supersededByActionId','$.staleReason') IS json_remove(${oldBody},'$.status','$.rowVersion','$.supersededByActionId','$.staleReason')`;

  return `CREATE TRIGGER ${safeName('workflow_pending_actions_v1_update_guard')} BEFORE UPDATE ON ${table}
    WHEN OLD.workflow_contract_version IS NULL AND workflow_migration_active()=0 BEGIN
      ${abort('NEW.id IS OLD.id AND NEW.row_version IS OLD.row_version AND NEW.workflow_contract_version IS OLD.workflow_contract_version', 'Immutable legacy pending action identity')}
      ${abort(`(${legacyPendingActionBodyCheck(oldBody)}) AND (${legacyPendingActionBodyCheck(body)})`, 'Invalid legacy pending action body')}
      ${abort(transitionAllowed, 'Invalid legacy pending action transition')}
      ${abort(`(${isRevisionTransition} AND ${revisionEnvelope}) OR (NOT ${isRevisionTransition} AND ${unchangedEnvelope})`, 'Immutable legacy pending action approval')}
    END`;
}

function workflowTriggerStatements(d: WorkflowMigrationDefinition): string[] {
  const statements: string[] = [];
  const table = safeName(d.table), body = `NEW.${safeName(d.bodyColumn)}`, oldBody = `OLD.${safeName(d.bodyColumn)}`;
  const name = (suffix: string) => safeName(`workflow_${d.table}_${suffix}`);
  const abort = (test: string, reason: string) => `SELECT CASE WHEN COALESCE((${test}),0)=0 THEN RAISE(ABORT,${literal(reason)}) END;`;
  const valid = [...validation(d, 'NEW.'),...requiredWriteChecks(d,body)].map(c => abort(c, 'Invalid workflow projection')).join('\n');
  const protectedNew = protectedRow(d, 'NEW.');
  const versionInsert = d.storage === 'shared' ? '(NEW.row_version IS NULL OR NEW.row_version = 1)' : 'NEW.row_version = 1';
  const immutable = [...new Set([...d.immutableFields, ...d.columns.filter(c => c.immutable&&!c.external).map(c => c.bodyField),...(d.foreignKeys.some(f=>f.tagField)?['ref']:[])])]
    .map(f => {
      const enrichment = d.table === 'conversations' && d.bodyFields.includes('lastAnalysis') && f === 'createdAt'
        ? ` OR (${extract(oldBody,f)} IS NULL AND json_type(${body},${path(f)})='text')` : '';
      // The forward conversation body validator checks the first supplied instant;
      // every later non-null timestamp keeps the original immutable equality rule.
      return abort(`${extract(body,f)} IS ${extract(oldBody,f)}${enrichment}`, 'Immutable workflow field');
    }).join('\n');
  const externalImmutable=columns(d).filter(c=>c.external).map(c=>abort(`NEW.${safeName(c.column)} IS OLD.${safeName(c.column)}`,'Immutable workflow key projection')).join('\n');
  const terminalFields=Object.entries(d.terminalImmutableFields).flatMap(([oldState,fields])=>fields.map(f=>abort(`${state(d,oldBody)}<>${literal(oldState)} OR ${extract(body,f)} IS ${extract(oldBody,f)}`,'Immutable terminal workflow field'))).join('\n');
  const allowed = Object.entries(d.permittedTransitions).flatMap(([from, to]) => to.map(t => `(${state(d, oldBody)}=${literal(from)} AND ${state(d, body)}=${literal(t)})`));
  const baseline=d.table==='incidents'?` OR EXISTS(SELECT 1 FROM action_executions r JOIN pending_actions a ON a.id=${extract('r.payload','actionId')} JOIN profiles p ON p.id=${extract('a.payload','actorId')} JOIN sessions s ON s.id=${extract('a.payload','sessionId')} WHERE r.workflow_contract_version IS NULL AND a.workflow_contract_version IS NULL AND ${extract(body,'operationKey')}=r.id||':artifact' AND ${extract('r.payload','kind')}='demo_update' AND ${extract('r.payload','status')}='pending' AND ${extract('a.payload','payload.scenario')}='baseline' AND ${extract('a.payload','status')}='claimed' AND ${extract('p.payload','active')}=1 AND s.profile_id=p.id AND EXISTS(SELECT 1 FROM json_each(p.payload,'$.permissions') g WHERE g.value='demo.update'))`:'';
  const transition = allowed.length ? abort(`${state(d, oldBody)} IS ${state(d, body)} OR ${allowed.join(' OR ')}${baseline}`, 'Invalid workflow transition')
    : d.table==='onboarding_documents'&&d.insertStates!==undefined ? abort(`${state(d, oldBody)} IS ${state(d, body)}`,'Document status requires an authorized lifecycle action') : '';
  const pendingEnvelope=d.table==='pending_actions'?abort(`json_remove(${body},'$.status','$.rowVersion') IS json_remove(${oldBody},'$.status','$.rowVersion')`,'Immutable workflow approval'):'';
  const terminalReceipt=d.table==='action_executions'?`SELECT CASE WHEN ${state(d,oldBody)} IN ('verified_success','already_completed','failed','denied','stale') AND ${body} IS NOT ${oldBody} THEN RAISE(ABORT,'Immutable historical receipt') END;`:'';
  const terminalTarget=d.table==='action_targets'?`SELECT CASE WHEN ${state(d,oldBody)} IN ('verified','failed') AND ${body} IS NOT ${oldBody} THEN RAISE(ABORT,'Immutable target proof') END;`:'';
  const versionUpdate = d.storage === 'shared'
    ? '(NEW.row_version = OLD.row_version OR NEW.row_version = OLD.row_version + 1 OR (OLD.row_version IS NULL AND NEW.row_version=1))'
    : 'NEW.row_version = OLD.row_version + 1';
  const consistency = columns(d).filter(c=>!c.external&&!c.legacyOnly).map(c => abort(
    d.storage === 'shared' ? `(NEW.${safeName(c.column)} IS ${projected(d, c, body)} OR (NEW.row_version=OLD.row_version AND NEW.${safeName(c.column)} IS OLD.${safeName(c.column)}))`
      : `NEW.${safeName(c.column)} IS ${projected(d, c, body)}`, 'Inconsistent workflow column')).join('\n');
  const insertConsistency = d.storage === 'shared' ? '' : columns(d).filter(c=>!c.external&&!c.legacyOnly).map(c => abort(`NEW.${safeName(c.column)} IS ${projected(d, c, body)}`, 'Inconsistent workflow column')).join('\n');
  const incidentProof=d.table==='incidents'&&d.columns.some(c=>c.column==='escalation_stage')?[
    abort(`${extract(body,'escalationLifecycleId')} IS ${extract(oldBody,'escalationLifecycleId')}`,'Immutable incident lifecycle'),
    abort(`(${extract(oldBody,'escalationStage')} IS NULL AND ${extract(body,'escalationStage')} IS NULL) OR ${extract(body,'escalationStage')} IS ${extract(oldBody,'escalationStage')} OR (${extract(oldBody,'escalationStage')}='un_escalated' AND ${extract(body,'escalationStage')}='team_requested' AND NEW.row_version=OLD.row_version+1)`,'Invalid incident escalation transition'),
    abort(`${extract(oldBody,'escalationStage')} IS NOT 'team_requested' OR ${extract(body,'escalationEventId')} IS ${extract(oldBody,'escalationEventId')}`,'Immutable incident terminal pointer'),
  ].join('\n'):'';
  for (const suffix of ['insert_guard', 'update_guard', ...(d.table === 'pending_actions' ? ['v1_insert_guard', 'v1_update_guard'] : []), 'delete_guard', 'sync_insert', 'sync_update', 'revision_insert', 'revision_update', 'revision_delete']) statements.push(`DROP TRIGGER IF EXISTS ${name(suffix)}`);
  statements.push(`CREATE TRIGGER ${name('insert_guard')} BEFORE INSERT ON ${table} WHEN (${protectedNew}) AND workflow_migration_active()=0 BEGIN
    ${abort(versionInsert, 'Invalid workflow insertion version')}
    ${d.insertStates!==undefined?abort(d.insertStates.length?`${state(d,body)} IN (${d.insertStates.map(literal).join(',')})`:'0','Invalid workflow creation state'):''}
    ${valid}${insertConsistency}${relationalChecks(d,body,'insert')}
    END`);
  statements.push(`CREATE TRIGGER ${name('update_guard')} BEFORE UPDATE ON ${table} WHEN (${protectedRow(d, 'OLD.')}) AND workflow_migration_active()=0 BEGIN
    ${d.table==='dashboard_share_revoke_events'?"SELECT RAISE(ABORT,'Append-only dashboard share revoke event');":''}
    ${d.storage === 'mixed' ? abort('NEW.workflow_contract_version=2', 'Immutable workflow marker') : ''}
    ${abort(`NOT (${legacyReadOnly(d,oldBody)})`,'Legacy workflow data is read-only')}
    ${abort(versionUpdate, 'Invalid workflow version')}${valid}${consistency}${immutable}${externalImmutable}${terminalFields}${transition}${incidentProof}
    ${pendingEnvelope}${terminalReceipt}${terminalTarget}${relationalChecks(d,body)}${d.appendOnly ? abort(`${body} IS ${oldBody} AND NEW.row_version IS OLD.row_version`, 'Append-only workflow history') : ''}
    END`);
  const v1PendingActionInsertGuard = pendingActionV1InsertGuardStatement(d, table, body);
  if (v1PendingActionInsertGuard) statements.push(v1PendingActionInsertGuard);
  const v1PendingActionGuard = pendingActionV1UpdateGuardStatement(d, table, body, oldBody, allowed);
  if (v1PendingActionGuard) statements.push(v1PendingActionGuard);
  if (d.storage === 'mixed') {statements.push(`DROP TRIGGER IF EXISTS ${safeName(`workflow_${d.table}_marker_guard`)}`);statements.push(`CREATE TRIGGER ${safeName(`workflow_${d.table}_marker_guard`)} BEFORE UPDATE ON ${table}
    WHEN OLD.workflow_contract_version IS NULL AND NEW.workflow_contract_version IS NOT NULL BEGIN SELECT RAISE(ABORT,'Legacy workflow marker cannot change'); END`);}
  if(d.storage==='mixed'){
    const creation=safeName(`workflow_${d.table}_marker_creation_guard`);statements.push(`DROP TRIGGER IF EXISTS ${creation}`);
    const v2=d.markerlessV2Discriminators.map(f=>Reflect.get(f,'presence')===true?`json_type(${body},${path(f.path)}) IS NOT NULL`:f.equals===undefined?`${extract(body,f.path)} IS NOT NULL`:
      `${extract(body,f.path)} IS ${typeof f.equals==='string'?literal(f.equals):typeof f.equals==='boolean'?Number(f.equals):f.equals}`).join(' OR ')||'0';
    statements.push(`CREATE TRIGGER ${creation} BEFORE INSERT ON ${table} WHEN NEW.workflow_contract_version IS NULL AND (${v2}) BEGIN SELECT RAISE(ABORT,'V2 body requires protected marker'); END`);
    const updateCreation=safeName(`workflow_${d.table}_marker_creation_update_guard`);statements.push(`DROP TRIGGER IF EXISTS ${updateCreation}`);
    statements.push(`CREATE TRIGGER ${updateCreation} BEFORE UPDATE ON ${table} WHEN workflow_migration_active()=0 AND NEW.workflow_contract_version IS NULL AND NEW.${safeName(d.bodyColumn)} IS NOT OLD.${safeName(d.bodyColumn)} AND (${v2}) BEGIN SELECT RAISE(ABORT,'V2 body requires protected marker'); END`);
  }
  if (d.storage !== 'shared') statements.push(`CREATE TRIGGER ${name('delete_guard')} BEFORE DELETE ON ${table} WHEN ${protectedRow(d, 'OLD.')}
    BEGIN SELECT RAISE(ABORT,'Workflow history cannot be deleted'); END`);
  if(d.table==='action_executions'||d.table==='audit_events')for(const event of ['UPDATE','DELETE']){
    const suffix=`legacy_history_${event.toLowerCase()}`;statements.push(`DROP TRIGGER IF EXISTS ${name(suffix)}`);
    statements.push(`CREATE TRIGGER ${name(suffix)} BEFORE ${event} ON ${table} WHEN OLD.workflow_contract_version IS NULL${d.table==='action_executions'?` AND ${extract(oldBody,'status')} IN ('verified_success','failed','denied')`:''} BEGIN SELECT RAISE(ABORT,'Immutable legacy history'); END`);
  }
  if (d.storage === 'shared') {
    const assignments = columns(d).filter(c=>!c.legacyOnly).map(c => `${safeName(c.column)}=${projected(d, c, body)}`).join(',');
    statements.push(`CREATE TRIGGER ${name('sync_insert')} AFTER INSERT ON ${table} WHEN workflow_migration_active()=0 BEGIN UPDATE ${table} SET row_version=COALESCE(NEW.row_version,1)${assignments ? ',' + assignments : ''} WHERE id=NEW.id; END`);
    statements.push(`CREATE TRIGGER ${name('sync_update')} AFTER UPDATE OF ${safeName(d.bodyColumn)} ON ${table}
      WHEN NEW.row_version=OLD.row_version AND workflow_migration_active()=0 BEGIN UPDATE ${table} SET row_version=OLD.row_version+1${assignments ? ',' + assignments : ''} WHERE id=NEW.id; END`);
  }
  for (const event of ['insert', 'update', 'delete']) statements.push(`CREATE TRIGGER ${name(`revision_${event}`)} AFTER ${event.toUpperCase()} ON ${table}
    WHEN workflow_migration_active()=0 AND (SELECT workflow_adapter_write FROM appmeta WHERE singleton=1)=0
    BEGIN UPDATE appmeta SET revision=revision+1 WHERE singleton=1; END`);
  if(d.table==='dashboard_shares'&&d.legacyQuarantineColumn===revokeQuarantine){
    for(const event of ['insert','update']){
      const trigger=name('revoke_quarantine_'+event);
      statements.push(`DROP TRIGGER IF EXISTS ${trigger}`);
      statements.push(`CREATE TRIGGER ${trigger} BEFORE ${event.toUpperCase()} ON ${table} WHEN workflow_migration_active()=0 BEGIN ${abort(event==='insert'?`NEW.${safeName(revokeQuarantine)}=0`:`NEW.${safeName(revokeQuarantine)} IS OLD.${safeName(revokeQuarantine)}`,'Immutable historical revoke quarantine')} END`);
    }
  }
  if(d.table==='mock_tickets'&&d.columns.some(c=>c.column==='employee_assignee_id')){
    for(const event of ['insert','update','delete','sync_insert','sync_update'])statements.push(`DROP TRIGGER IF EXISTS ${name('legacy_employee_'+event)}`);
    statements.push(`CREATE TRIGGER ${name('legacy_employee_insert')} BEFORE INSERT ON ${table} WHEN workflow_migration_active()=0 BEGIN
      ${abort(`NEW.${safeName(d.legacyQuarantineColumn!)}=0`,'Legacy ticket quarantine cannot be inserted')}
      ${abort('NEW.assignee_id IS NULL','Legacy profile assignee cannot be inserted')}
      ${abort(`NEW.employee_assignee_id IS NULL OR NEW.employee_assignee_id IS ${extract(body,'assigneeId')}`,'Inconsistent ticket employee assignee')}
      ${abort(`EXISTS(SELECT 1 FROM employees e WHERE e.id=${extract(body,'assigneeId')})`,'Ticket assignee must be an employee')}
      END`);
    for(const event of ['UPDATE','DELETE'])statements.push(`CREATE TRIGGER ${name('legacy_employee_'+event.toLowerCase())} BEFORE ${event} ON ${table} WHEN OLD.workflow_contract_version IS NULL AND workflow_migration_active()=0 BEGIN
      ${abort(`OLD.${safeName(d.legacyQuarantineColumn!)}=0`,'Legacy profile ticket is quarantined')}
      ${abort(`OLD.assignee_id IS NULL AND (OLD.employee_assignee_id IS NOT NULL${event==='UPDATE'?` OR (OLD.row_version IS NULL AND NEW.row_version=1 AND NEW.employee_assignee_id IS ${extract(oldBody,'assigneeId')} AND EXISTS(SELECT 1 FROM employees e WHERE e.id=NEW.employee_assignee_id))`:''})`,'Legacy profile ticket is quarantined')}
      ${event==='UPDATE'?abort(`NEW.assignee_id IS NULL AND ${extract(body,'assigneeId')} IS COALESCE(OLD.employee_assignee_id,${extract(oldBody,'assigneeId')})`,'Immutable ticket employee assignee'):''}
      ${event==='UPDATE'?validation(d,'NEW.').map(check=>abort(check,'Invalid ticket projection')).join('\n')+consistency:''}
      END`);
    statements.push(`CREATE TRIGGER ${name('legacy_employee_quarantine')} BEFORE UPDATE ON ${table} WHEN workflow_migration_active()=0 BEGIN ${abort(`NEW.${safeName(d.legacyQuarantineColumn!)} IS OLD.${safeName(d.legacyQuarantineColumn!)}`,'Immutable ticket quarantine')} END`);
    const assignments=columns(d).filter(c=>!c.legacyOnly&&!c.external).map(c=>`${safeName(c.column)}=${projected(d,c,body)}`).join(',');
    statements.push(`CREATE TRIGGER ${name('legacy_employee_sync_insert')} AFTER INSERT ON ${table} WHEN NEW.workflow_contract_version IS NULL AND workflow_migration_active()=0 BEGIN UPDATE ${table} SET row_version=COALESCE(NEW.row_version,1),${assignments} WHERE id=NEW.id; END`);
    statements.push(`CREATE TRIGGER ${name('legacy_employee_sync_update')} AFTER UPDATE OF payload ON ${table} WHEN NEW.workflow_contract_version IS NULL AND NEW.row_version=OLD.row_version AND workflow_migration_active()=0 BEGIN UPDATE ${table} SET row_version=OLD.row_version+1,${assignments} WHERE id=NEW.id; END`);
  }
  return statements;
}

function installTriggers(db: Database.Database, d: WorkflowMigrationDefinition): void {
  for (const sql of workflowTriggerStatements(d)) db.exec(sql);
}

/** Attestation reads native definitions; an installed step never repairs a missing guard. */
function assertWorkflowTriggers(db: Database.Database, d: WorkflowMigrationDefinition): void {
  const lookup = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?");
  for (const sql of workflowTriggerStatements(d).filter(statement => statement.startsWith('CREATE TRIGGER '))) {
    const name = /^CREATE TRIGGER "([a-z][a-z0-9_]*)"/.exec(sql)?.[1];
    if (!name) throw new Error('Workflow migration cannot attest an unnamed trigger');
    const actual = lookup.get(name) as {name:string;tbl_name:string;sql:string}|undefined;
    if (!actual || actual.name !== name || actual.tbl_name !== d.table || actual.sql !== sql) {
      const label=d.table==='review_snapshot_targets'?'snapshot proof':d.table==='conversations'||d.table==='conversation_messages'?'conversation':'action provenance';
      throw new Error('Workflow migration contains incompatible ' + label + ' trigger: ' + name);
    }
  }
}

function installNormalizedChildren(db:Database.Database,d:WorkflowMigrationDefinition):void{
  for(const child of d.normalizedChildren){
    const table=safeName(child.table),parent=safeName(child.parentIdColumn),target=safeName(child.childIdColumn);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${parent} TEXT NOT NULL REFERENCES ${safeName(d.table)}(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      ${target} TEXT NOT NULL REFERENCES ${safeName(child.target)}(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(${parent},${target}))`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${safeName(child.uniqueName)} ON ${table}(${parent},${target})`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${safeName(child.table+'_target_lookup')} ON ${table}(${target},${parent})`);
    for(const event of ['INSERT','UPDATE']){
      const name=safeName(child.table+'_'+event.toLowerCase()+'_guard');db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${safeName(d.table)} p,json_each(p.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}) a WHERE p.id=NEW.${parent} AND a.value=NEW.${target} AND a.type='text') THEN RAISE(ABORT,'Invalid normalized workflow scope') END;
        ${event==='UPDATE'?`SELECT CASE WHEN (NEW.${parent} IS NOT OLD.${parent} OR NEW.${target} IS NOT OLD.${target}) AND EXISTS(SELECT 1 FROM ${safeName(d.table)} p,json_each(p.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}) a WHERE p.id=OLD.${parent} AND a.value=OLD.${target}) THEN RAISE(ABORT,'Scope projection must follow parent') END;`:''}END`);
    }
    const deletion=safeName(child.table+'_delete_guard');db.exec(`DROP TRIGGER IF EXISTS ${deletion}`);
    db.exec(`CREATE TRIGGER ${deletion} BEFORE DELETE ON ${table} WHEN EXISTS(SELECT 1 FROM ${safeName(d.table)} p,json_each(p.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}) a WHERE p.id=OLD.${parent} AND a.value=OLD.${target}) BEGIN SELECT RAISE(ABORT,'Scope projection must follow parent'); END`);
    for(const event of ['INSERT','UPDATE','DELETE']){
      const name=safeName(child.table+'_'+event.toLowerCase()+'_revision');db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER ${name} AFTER ${event} ON ${table} WHEN workflow_migration_active()=0 AND (SELECT workflow_adapter_write FROM appmeta WHERE singleton=1)=0 BEGIN UPDATE appmeta SET revision=revision+1 WHERE singleton=1; END`);
    }
    for(const event of ['INSERT','UPDATE']){
      const name=safeName(child.table+'_sync_'+event.toLowerCase());db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER ${name} AFTER ${event} ON ${safeName(d.table)} WHEN workflow_migration_active()=0 BEGIN
        DELETE FROM ${table} WHERE ${parent}=NEW.id AND ${target} NOT IN (SELECT value FROM json_each(NEW.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}));
        INSERT OR IGNORE INTO ${table}(${parent},${target}) SELECT NEW.id,value FROM json_each(NEW.${safeName(d.bodyColumn)},${path(child.arrayBodyField)});
      END`);
    }
    if(child.ownership){
      const ownership=child.ownership;
      const condition=`EXISTS(SELECT 1 FROM ${safeName(d.table)} p JOIN ${safeName(ownership.parentTable)} c ON c.id=${extract(`p.${safeName(d.bodyColumn)}`,ownership.parentReferenceField)} JOIN ${safeName(child.target)} a ON a.id=NEW.${target} WHERE p.id=NEW.${parent} AND a.${safeName(snake(ownership.targetOwnerField))}=c.${safeName(snake(ownership.ownerField))} AND EXISTS(SELECT 1 FROM json_each(p.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}) x WHERE x.value=NEW.${target}))`;
      for(const event of ['INSERT','UPDATE','DELETE']){
        const name=safeName(child.table+'_guard_'+event.toLowerCase());db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        db.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} WHEN workflow_migration_active()=0 BEGIN ${event==='INSERT'?`SELECT CASE WHEN COALESCE((${condition}),0)=0 THEN RAISE(ABORT,'Invalid workflow assignment ownership') END;`:`SELECT RAISE(ABORT,'Immutable workflow assignment snapshot');`} END`);
      }
    }
    db.exec(`INSERT INTO ${table}(${parent},${target}) SELECT p.id,a.value FROM ${safeName(d.table)} p,json_each(p.${safeName(d.bodyColumn)},${path(child.arrayBodyField)}) a WHERE NOT EXISTS(SELECT 1 FROM ${table} c WHERE c.${parent}=p.id AND c.${target}=a.value)`);
  }
}

function uniqueIndexSql(d:WorkflowMigrationDefinition,u:WorkflowProjectionDefinition['unique'][number],ifNotExists=true):string{
  const fields=u.fields.map(f=>f==='id'?'id':f==='rowVersion'?'row_version':columns(d).find(c=>c.bodyField===f)?.column??snake(f));
  const conditions=d.storage==='mixed'&&!u.referenceKey?[protectedRow(d)]:[];
  if(u.openOnly){if(!u.openStates?.length)throw new Error('Workflow migration invalid open constraint');conditions.push(`${state(d,safeName(d.bodyColumn))} IN (${u.openStates.map(literal).join(',')})`);}
  return `CREATE UNIQUE INDEX ${ifNotExists?'IF NOT EXISTS ':''}${safeName(u.name)} ON ${safeName(d.table)} (${fields.map(safeName).join(',')})${conditions.length?' WHERE '+conditions.join(' AND '):''}`;
}

function normalizeIndexSql(sql:string):string{return sql.replace(/\bIF\s+NOT\s+EXISTS\b/ig,'').replace(/["`]/g,'').replace(/\s+/g,' ').trim().toLowerCase();}

function upgradeBranchReviewAssignmentOpenIndex(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void{
  if(!db.inTransaction)throw new Error('Workflow migration index upgrade must run in a transaction');
  const table='branch_review_assignments',name='branch_review_assignments_open_case_unique';
  const current=definitions.find(d=>d.table===table),historical=historicalWorkflowBaseDefinitions.find(d=>d.table===table);
  const constraint=current?.unique.find(u=>u.name===name),oldConstraint=historical?.unique.find(u=>u.name===name);
  if(!current||!historical||!constraint||!oldConstraint||!constraint.openOnly||!oldConstraint.openOnly||!constraint.openStates||!oldConstraint.openStates||
    JSON.stringify(constraint.fields)!==JSON.stringify(['caseId'])||JSON.stringify(oldConstraint.fields)!==JSON.stringify(['caseId'])||
    JSON.stringify(constraint.openStates)!==JSON.stringify(['open','assigned'])||JSON.stringify(oldConstraint.openStates)!==JSON.stringify(['assigned']))
    throw new Error('Workflow migration invalid branch review assignment index upgrade');

  const key=columns(current).find(c=>c.bodyField==='caseId')?.column;
  if(!key)throw new Error('Workflow migration invalid branch review assignment key');
  const where=[...(current.storage==='mixed'?[protectedRow(current)]:[]),`${state(current,safeName(current.bodyColumn))} IN (${constraint.openStates.map(literal).join(',')})`];
  if(db.prepare(`SELECT 1 FROM ${safeName(table)} WHERE ${where.join(' AND ')} GROUP BY ${safeName(key)} HAVING count(*)>1 LIMIT 1`).get())
    throw new Error('Workflow migration contains duplicate open branch review assignments');

  const installed=db.prepare('SELECT tbl_name,sql FROM sqlite_master WHERE type=\'index\' AND name=?').get(name) as {tbl_name:string;sql:string|null}|undefined;
  if(!installed)return;
  if(installed.tbl_name!==table||typeof installed.sql!=='string')throw new Error('Workflow migration found incompatible branch review assignment index');
  const actual=normalizeIndexSql(installed.sql);
  if(actual===normalizeIndexSql(uniqueIndexSql(current,constraint,false)))return;
  if(actual!==normalizeIndexSql(uniqueIndexSql(historical,oldConstraint,false)))throw new Error('Workflow migration found incompatible branch review assignment index');
  db.exec(`DROP INDEX ${safeName(name)}`);
  db.exec(uniqueIndexSql(current,constraint,false));
}

function upgradeContractReminderUniqueIndex(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void{
  if(!db.inTransaction)throw new Error('Workflow migration index upgrade must run in a transaction');
  const table='contract_reminders',name='contract_reminders_contract_milestone_unique';
  const current=definitions.find(d=>d.table===table),historical=historicalWorkflowBaseDefinitions.find(d=>d.table===table);
  const constraint=current?.unique.find(u=>u.name===name),oldConstraint=historical?.unique.find(u=>u.name===name);
  if(!current||!historical||!constraint||!oldConstraint||constraint.openOnly||oldConstraint.openOnly||
    JSON.stringify(constraint.fields)!==JSON.stringify(['contractId','expiresAt','milestone'])||
    JSON.stringify(oldConstraint.fields)!==JSON.stringify(['contractId','milestone']))
    throw new Error('Workflow migration invalid contract reminder index upgrade');

  const fields=constraint.fields.map(field=>columns(current).find(c=>c.bodyField===field)?.column??snake(field));
  if(fields.some(field=>!columns(current).some(c=>c.column===field)))throw new Error('Workflow migration invalid contract reminder index key');
  if(db.prepare(`SELECT 1 FROM ${safeName(table)} GROUP BY ${fields.map(safeName).join(',')} HAVING count(*)>1 LIMIT 1`).get())
    throw new Error('Workflow migration contains duplicate contract reminders');

  const installed=db.prepare('SELECT tbl_name,sql FROM sqlite_master WHERE type=\'index\' AND name=?').get(name) as {tbl_name:string;sql:string|null}|undefined;
  if(!installed)return;
  if(installed.tbl_name!==table||typeof installed.sql!=='string')throw new Error('Workflow migration found incompatible contract reminder index');
  const actual=normalizeIndexSql(installed.sql);
  if(actual===normalizeIndexSql(uniqueIndexSql(current,constraint,false)))return;
  if(actual!==normalizeIndexSql(uniqueIndexSql(historical,oldConstraint,false)))throw new Error('Workflow migration found incompatible contract reminder index');
  db.exec(`DROP INDEX ${safeName(name)}`);
  db.exec(uniqueIndexSql(current,constraint,false));
}

function upgradeOnboardingRequestOpenEmployeeLifecycleIndex(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void{
  if(!db.inTransaction)throw new Error('Workflow migration index upgrade must run in a transaction');
  const table='onboarding_requests',name='onboarding_requests_open_employee_lifecycle_unique';
  const current=definitions.find(d=>d.table===table),base=historicalWorkflowBaseDefinitions.find(d=>d.table===table),scope=historicalWorkflowScopeDefinitions.find(d=>d.table===table);
  const constraint=current?.unique.find(u=>u.name===name),oldConstraint=scope?.unique.find(u=>u.name===name),baseConstraint=base?.unique.find(u=>u.name===name);
  if(!current||!base||!scope||!constraint||!oldConstraint||!baseConstraint||!constraint.openOnly||!oldConstraint.openOnly||!baseConstraint.openOnly||!constraint.openStates||!oldConstraint.openStates||!baseConstraint.openStates||
    JSON.stringify(oldConstraint)!==JSON.stringify(baseConstraint)||
    JSON.stringify(constraint.fields)!==JSON.stringify(['employeeId','lifecycleId'])||JSON.stringify(oldConstraint.fields)!==JSON.stringify(['employeeId','lifecycleId'])||
    JSON.stringify(constraint.openStates)!==JSON.stringify(['draft','manager_review_pending','director_approval_pending','director_approved','onboarding_in_progress'])||
    JSON.stringify(oldConstraint.openStates)!==JSON.stringify(['draft','returned_for_revision','manager_review_pending','director_approval_pending','director_approved','onboarding_in_progress']))
    throw new Error('Workflow migration invalid onboarding request index upgrade');

  const fields=constraint.fields.map(field=>columns(current).find(c=>c.bodyField===field)?.column??snake(field));
  if(fields.some(field=>!columns(current).some(c=>c.column===field)))throw new Error('Workflow migration invalid onboarding request index key');
  const where=[...(current.storage==='mixed'?[protectedRow(current)]:[]),`${state(current,safeName(current.bodyColumn))} IN (${constraint.openStates.map(literal).join(',')})`];
  if(db.prepare(`SELECT 1 FROM ${safeName(table)} WHERE ${where.join(' AND ')} GROUP BY ${fields.map(safeName).join(',')} HAVING count(*)>1 LIMIT 1`).get())
    throw new Error('Workflow migration contains duplicate open onboarding requests');

  const installed=db.prepare('SELECT tbl_name,sql FROM sqlite_master WHERE type=\'index\' AND name=?').get(name) as {tbl_name:string;sql:string|null}|undefined;
  if(!installed)return;
  if(installed.tbl_name!==table||typeof installed.sql!=='string')throw new Error('Workflow migration found incompatible onboarding request index');
  const actual=normalizeIndexSql(installed.sql);
  if(actual===normalizeIndexSql(uniqueIndexSql(current,constraint,false)))return;
  if(actual!==normalizeIndexSql(uniqueIndexSql(scope,oldConstraint,false)))throw new Error('Workflow migration found incompatible onboarding request index');
  db.exec(`DROP INDEX ${safeName(name)}`);
  db.exec(uniqueIndexSql(current,constraint,false));
}

function installIndexes(db:Database.Database,d:WorkflowMigrationDefinition):void{
  for(const u of d.unique)db.exec(uniqueIndexSql(d,u));
  for(const field of d.queryFields){const name=columns(d).find(c=>c.bodyField===field&&!c.legacyOnly)?.column;if(name)db.exec(`CREATE INDEX IF NOT EXISTS ${safeName(`workflow_${d.table}_${name}_lookup`)} ON ${safeName(d.table)} (${safeName(name)},id)`);}
  if(d.table==='conversation_messages'&&d.columns.some(c=>c.column==='turn_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS workflow_conversation_messages_identity_lookup ON conversation_messages(actor_id,conversation_id,session_id,turn_id,id)');
  }
}

function upgradeResponsibilityScopeIndex(db:Database.Database):void{
  const definition=historicalWorkflowScopeDefinitions.find(d=>d.table==='responsibilities')!;
  const constraint=definition.unique.find(u=>u.name==='responsibilities_open_identity_purpose_unique');
  if(!constraint||JSON.stringify(constraint.fields)!==JSON.stringify(['identityId','purpose','orgUnitId'])||!constraint.openOnly||JSON.stringify(constraint.openStates)!==JSON.stringify(['active']))throw new Error('Workflow migration invalid responsibility scope upgrade');
  db.exec(`DROP INDEX IF EXISTS ${safeName(constraint.name)}`);
  installIndexes(db,definition);
}

function projectedTableSql(d:WorkflowMigrationDefinition,name:string,definitions:readonly WorkflowMigrationDefinition[],ifMissing=false):string{
  const version=d.storage==='mixed'?`row_version INTEGER CHECK(row_version IS NULL OR (typeof(row_version)='integer' AND row_version>0))`:
    `row_version INTEGER NOT NULL CHECK(typeof(row_version)='integer' AND row_version>0)`;
  const marker=d.storage==='mixed'?['workflow_contract_version INTEGER CHECK(workflow_contract_version IS NULL OR workflow_contract_version=2)']:[];
  const fields=[`id TEXT PRIMARY KEY NOT NULL`,`${safeName(d.bodyColumn)} TEXT NOT NULL`,version,...marker,
    ...columns(d).map(c=>columnSql(d,c)),...(d.legacyQuarantineColumn?[`${safeName(d.legacyQuarantineColumn)} INTEGER NOT NULL DEFAULT 0 CHECK(${safeName(d.legacyQuarantineColumn)} IN(0,1))`]:[]),...contractReferences(d).map(f=>referenceMarkerSql(d,f)),...contractReferences(d).map(f=>referenceFkSql(f,definitions)),
    ...d.compositeForeignKeys.map(f=>`FOREIGN KEY(${f.columns.map(safeName).join(',')}) REFERENCES ${safeName(f.target)}(${f.targetColumns.map(safeName).join(',')}) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`)];
  if(d.table==='dashboard_shares'&&d.legacyQuarantineColumn===revokeQuarantine){
    const beforeConstraint=fields.findIndex(field=>field.startsWith('FOREIGN KEY'));
    fields.splice(beforeConstraint<0?fields.length:beforeConstraint,0,...revokePointerSql(d));
  }
  if(d.table==='incident_escalation_events'&&d.requiredWriteFields?.includes('evidenceIds')){
    const beforeConstraint=fields.findIndex(field=>field.startsWith('FOREIGN KEY'));
    fields.splice(beforeConstraint<0?fields.length:beforeConstraint,0,`workflow_incident_proof_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(body,'$.reason')='text' AND json_type(body,'$.evidenceIds')='array' THEN incident_id ELSE NULL END) VIRTUAL`);
    fields.push(`FOREIGN KEY(workflow_incident_proof_id,lifecycle_id,id) REFERENCES incidents(id,escalation_lifecycle_id,escalation_event_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`);
  }
  return `CREATE TABLE ${ifMissing?'IF NOT EXISTS ':''}${safeName(name)}(${fields.join(',')})`;
}

function rebuildMixedCompositeTable(db:Database.Database,d:WorkflowMigrationDefinition,definitions:readonly WorkflowMigrationDefinition[]):void{
  if(d.storage!=='mixed'||(!d.compositeForeignKeys.length&&!contractReferences(d).length))return;
  const temporary=safeName(`${d.table}__workflow_upgrade`),original=safeName(d.table);
  const expected=['id','payload','row_version','workflow_contract_version',...columns(d).map(c=>c.column)];
  if((db.prepare(`PRAGMA table_xinfo(${original})`).all() as {name:string;hidden:number}[]).some(c=>!c.hidden&&!expected.includes(c.name)))throw new Error(`Workflow migration cannot preserve unknown columns: ${d.table}`);
  db.exec(projectedTableSql(d,`${d.table}__workflow_upgrade`,definitions));
  const names=['id','payload','row_version','workflow_contract_version',...columns(d).map(c=>c.column)].map(safeName).join(',');
  const before=db.prepare(`SELECT count(*) n FROM ${original}`).get() as {n:number};
  db.exec(`INSERT INTO ${temporary}(${names}) SELECT ${names} FROM ${original} ORDER BY rowid`);
  const after=db.prepare(`SELECT count(*) n FROM ${temporary}`).get() as {n:number};
  if(before.n!==after.n)throw new Error('Workflow migration row preservation failed');
  db.exec(`DROP TABLE ${original}`);db.exec(`ALTER TABLE ${temporary} RENAME TO ${original}`);
}

function assertForeignKeys(db:Database.Database):void{
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Workflow migration contains incompatible references');
}

function installReferenceIndexes(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void{
  for(const d of definitions)for(const f of contractReferences(d)){
    const target=definitions.find(candidate=>candidate.table===f.target)!;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${safeName(`workflow_${f.target}_contract_reference_unique`)} ON ${safeName(f.target)}(id,${safeName(target.markerColumn!)})`);
  }
}

function installHistoricalBase(db:Database.Database):void{
  const definitions=historicalWorkflowBaseDefinitions;
  for(const d of definitions){
    const table=safeName(d.table);
    if(d.storage==='new')db.exec(projectedTableSql(d,d.table,definitions,true));
    else{
      const existing=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));
      if(!existing.has('row_version'))db.exec(`ALTER TABLE ${table} ADD COLUMN row_version INTEGER CHECK(row_version IS NULL OR (typeof(row_version)='integer' AND row_version>0))`);
      if(d.storage==='mixed'&&!existing.has('workflow_contract_version'))db.exec(`ALTER TABLE ${table} ADD COLUMN workflow_contract_version INTEGER CHECK(workflow_contract_version IS NULL OR workflow_contract_version=2)`);
      for(const c of columns(d))if(!existing.has(c.column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql(d,c)}`);
      rebuildMixedCompositeTable(db,d,definitions);
    }
  }
  for(const d of definitions)installIndexes(db,d);
  installReferenceIndexes(db,definitions);
  for(const d of definitions){
    if(d.storage==='shared')db.exec(`UPDATE ${safeName(d.table)} SET row_version=COALESCE(row_version,1)${columns(d).map(c=>`,${safeName(c.column)}=${projected(d,c,safeName(d.bodyColumn))}`).join('')}`);
    assertBody(db,d);
    installTriggers(db,d);
    installNormalizedChildren(db,d);
  }
  assertForeignKeys(db);
}

function preservedRowsDigest(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):string{
  const digest=createHash('sha256');
  for(const d of definitions){
    digest.update(d.table+'\n');
    for(const row of db.prepare(`SELECT id,${safeName(d.bodyColumn)},row_version${d.storage==='mixed'?',workflow_contract_version':''} FROM ${safeName(d.table)} ORDER BY id`).iterate())digest.update(JSON.stringify(row)+'\n');
  }
  return digest.digest('hex');
}

function rebuildForCompleteness(db:Database.Database,d:WorkflowMigrationDefinition,definitions:readonly WorkflowMigrationDefinition[]):void{
  const original=safeName(d.table),temporary=safeName(d.table+'__workflow_completeness');
  const expected=['id',d.bodyColumn,'row_version',...(d.storage==='mixed'?['workflow_contract_version']:[]),...columns(d).map(c=>c.column),...(d.legacyQuarantineColumn?[d.legacyQuarantineColumn]:[])];
  const actual=db.prepare(`PRAGMA table_xinfo(${original})`).all() as {name:string;hidden:number}[];
  if(actual.some(c=>!c.hidden&&!expected.includes(c.name)))throw new Error(`Workflow migration cannot preserve unknown columns: ${d.table}`);
  const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(d.table) as {sql:string}[];
  db.exec(projectedTableSql(d,d.table+'__workflow_completeness',definitions));
  const names=expected.map(safeName).join(',');
  db.exec(`INSERT INTO ${temporary}(${names}) SELECT ${names} FROM ${original} ORDER BY rowid`);
  const unchanged=db.prepare(`SELECT NOT EXISTS(SELECT ${names} FROM ${original} EXCEPT SELECT ${names} FROM ${temporary}) AND NOT EXISTS(SELECT ${names} FROM ${temporary} EXCEPT SELECT ${names} FROM ${original}) AS same`).get() as {same:number};
  if(!unchanged.same)throw new Error('Workflow migration row preservation failed');
  db.exec(`DROP TABLE ${original}`);db.exec(`ALTER TABLE ${temporary} RENAME TO ${original}`);
  for(const index of indexes)db.exec(index.sql);
}

function installCompleteness(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void{
  const before=preservedRowsDigest(db,definitions);
  // These keys were unprotected extension JSON before this step. Adopting them
  // would invent reviewed incident proof; preserve the database by failing closed.
  if(db.prepare("SELECT 1 FROM incidents WHERE json_extract(payload,'$.escalationStage') IS NOT NULL OR json_extract(payload,'$.escalationLifecycleId') IS NOT NULL OR json_extract(payload,'$.escalationEventId') IS NOT NULL LIMIT 1").get())throw new Error('Workflow migration contains unprotected legacy incident proof');
  const ownedTables=new Set(definitions.map(d=>d.table as string));
  const triggers=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;tbl_name:string;sql:string}[];
  const foreignTriggers=triggers.filter(trigger=>ownedTables.has(trigger.tbl_name)&&!trigger.name.startsWith('workflow_'));
  // Suspend generated guards while filling projections; application adapters
  // cannot enable the connection-local migration closure.
  for(const trigger of triggers)if(ownedTables.has(trigger.tbl_name))db.exec(`DROP TRIGGER ${safeName(trigger.name)}`);
  for(const d of definitions){
    const existing=new Set((db.prepare(`PRAGMA table_info(${safeName(d.table)})`).all() as {name:string}[]).map(c=>c.name));
    const added=columns(d).filter(c=>!existing.has(c.column));
    for(const c of added)db.exec(`ALTER TABLE ${safeName(d.table)} ADD COLUMN ${columnSql(d,c)}`);
    if(d.legacyQuarantineColumn&&!existing.has(d.legacyQuarantineColumn))db.exec(`ALTER TABLE ${safeName(d.table)} ADD COLUMN ${safeName(d.legacyQuarantineColumn)} INTEGER NOT NULL DEFAULT 0 CHECK(${safeName(d.legacyQuarantineColumn)} IN(0,1))`);
    const backfill=added.filter(c=>!c.legacyOnly&&!(d.table==='incidents'&&c.bodyField.startsWith('escalation')));
    if(backfill.length)db.exec(`UPDATE ${safeName(d.table)} SET ${backfill.map(c=>`${safeName(c.column)}=${d.table==='mock_tickets'&&c.column==='employee_assignee_id'?`CASE WHEN assignee_id IS NULL AND EXISTS(SELECT 1 FROM employees e WHERE e.id=${extract('payload','assigneeId')}) THEN ${extract('payload','assigneeId')} ELSE NULL END`:projected(d,c,safeName(d.bodyColumn))}`).join(',')}`);
    if(d.legacyQuarantineColumn)db.exec(`UPDATE ${safeName(d.table)} SET ${safeName(d.legacyQuarantineColumn)}=CASE WHEN assignee_id IS NOT NULL OR employee_assignee_id IS NULL THEN 1 ELSE 0 END`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workflow_incidents_escalation_pointer_unique ON incidents(id,escalation_lifecycle_id,escalation_event_id)');
  for(const d of definitions){
    const historical=historicalWorkflowScopeDefinitions.find(old=>old.table===d.table)!;
    if(d.storage!=='shared'&&JSON.stringify(d.foreignKeys)!==JSON.stringify(historical.foreignKeys))rebuildForCompleteness(db,d,definitions);
    // The event's deferred reverse reference makes event+incident CAS one unit.
    else if(d.table==='incident_escalation_events')rebuildForCompleteness(db,d,definitions);
  }
  installReferenceIndexes(db,definitions);
  upgradeBranchReviewAssignmentOpenIndex(db,definitions);
  upgradeContractReminderUniqueIndex(db,definitions);
  upgradeOnboardingRequestOpenEmployeeLifecycleIndex(db,definitions);
  for(const d of definitions){installIndexes(db,d);installTriggers(db,d);installNormalizedChildren(db,d);}
  for(const trigger of foreignTriggers)db.exec(trigger.sql);
  for(const d of definitions)for(const child of d.normalizedChildren)if(child.ownership){
    const owner=child.ownership;
    const bad=db.prepare(`SELECT 1 FROM ${safeName(child.table)} s JOIN ${safeName(d.table)} p ON p.id=s.${safeName(child.parentIdColumn)} JOIN ${safeName(owner.parentTable)} c ON c.id=${extract(`p.${safeName(d.bodyColumn)}`,owner.parentReferenceField)} JOIN ${safeName(child.target)} a ON a.id=s.${safeName(child.childIdColumn)} WHERE a.${safeName(snake(owner.targetOwnerField))} IS NOT c.${safeName(snake(owner.ownerField))} LIMIT 1`).get();
    if(bad)throw new Error('Workflow migration contains incompatible assignment ownership');
  }
  if(before!==preservedRowsDigest(db,definitions))throw new Error('Workflow migration changed historical bodies or versions');
  assertForeignKeys(db);
}

/** The forward step owns only these two shared-table descriptors. */
export function workflowConversationPersistenceDefinitions(): WorkflowMigrationDefinition[] {
  return historicalWorkflowConversationPersistenceDefinitions.map(d => structuredClone(d));
}

/** Only snapshot children change after the frozen conversation-persistence step. */
export function workflowSnapshotProofReferenceDefinitions(): WorkflowMigrationDefinition[] {
  return historicalWorkflowSnapshotProofReferenceDefinitions.map(d=>structuredClone(d));
}

function pendingActionRevisionOnlyMatches(
  current: WorkflowMigrationDefinition,
  predecessor: WorkflowMigrationDefinition,
): boolean {
  const addedFields = current.bodyFields.filter(field => !predecessor.bodyFields.includes(field));
  const expectedBodyAdditions = ['predecessorActionId', 'supersededByActionId', 'staleReason', 'revisionDiff'];
  if (
    predecessor.bodyFields.some(field => !current.bodyFields.includes(field))
    || addedFields.length !== expectedBodyAdditions.length
    || expectedBodyAdditions.some(field => !addedFields.includes(field))
  ) return false;

  const expectedImmutableFields = [...predecessor.immutableFields, 'predecessorActionId', 'revisionDiff'];
  if (JSON.stringify(current.immutableFields) !== JSON.stringify(expectedImmutableFields)) return false;

  const expectedTerminalFields = {
    ...predecessor.terminalImmutableFields,
    claimed: ['supersededByActionId', 'staleReason'],
    stale: ['supersededByActionId', 'staleReason'],
  };
  if (JSON.stringify(current.terminalImmutableFields) !== JSON.stringify(expectedTerminalFields)) return false;

  const normalized = {
    ...current,
    bodyFields: predecessor.bodyFields,
    immutableFields: predecessor.immutableFields,
    terminalImmutableFields: predecessor.terminalImmutableFields,
  };
  return JSON.stringify(normalized) === JSON.stringify(predecessor);
}

export function workflowActionTargetProvenanceDefinitions(): WorkflowMigrationDefinition[] {
  const current = workflowMigrationDefinitions();
  const affected=current.filter(d=>d.table==='action_targets'||d.table==='dashboard_shares'||d.table==='dashboard_share_revoke_events').sort((a,b)=>a.table.localeCompare(b.table));
  const predecessor=historicalWorkflowCompletenessDefinitions.map(old=>historicalWorkflowConversationPersistenceDefinitions.find(d=>d.table===old.table)??historicalWorkflowSnapshotProofReferenceDefinitions.find(d=>d.table===old.table)??old);
  if(affected.length!==3||current.length!==predecessor.length+1||current.some(d=>d.table==='pending_actions'? !pendingActionRevisionOnlyMatches(d,predecessor.find(p=>p.table===d.table)!):JSON.stringify(d)!==JSON.stringify(affected.find(a=>a.table===d.table)??predecessor.find(p=>p.table===d.table)))) {
    throw new Error('Workflow migration contains unrelated action-provenance changes');
  }
  return affected;
}

function installConversationPersistence(db: Database.Database, definitions: readonly WorkflowMigrationDefinition[]): void {
  const before = preservedRowsDigest(db, definitions);
  for (const d of definitions) assertBody(db, d);
  const triggers = db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('conversations','conversation_messages')").all() as {name:string;tbl_name:string;sql:string}[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${safeName(trigger.name)}`);
  const message = definitions.find(d => d.table === 'conversation_messages')!;
  const existing = db.prepare('PRAGMA table_info(conversation_messages)').all() as {name:string;type:string;notnull:number}[];
  for (const c of columns(message).filter(c => c.column === 'turn_id' || c.column === 'session_id')) {
    const prior = existing.find(column => column.name === c.column);
    if (prior) {
      if (prior.type.toUpperCase() !== 'TEXT' || prior.notnull
        || db.prepare(`SELECT 1 FROM conversation_messages WHERE ${safeName(c.column)} IS NOT ${projected(message,c,'payload')} LIMIT 1`).get()) {
        throw new Error('Workflow migration contains contradictory conversation identity');
      }
    } else {
      db.exec(`ALTER TABLE conversation_messages ADD COLUMN ${columnSql(message,c)}`);
      db.exec(`UPDATE conversation_messages SET ${safeName(c.column)}=${projected(message,c,'payload')}`);
    }
  }
  for (const d of definitions) { installIndexes(db,d); installTriggers(db,d); }
  const generated = new Set(definitions.flatMap(d => ['insert_guard','update_guard','sync_insert','sync_update','revision_insert','revision_update','revision_delete'].map(suffix => `workflow_${d.table}_${suffix}`)));
  for (const trigger of triggers.filter(trigger => !generated.has(trigger.name))) db.exec(trigger.sql);
  if (before !== preservedRowsDigest(db, definitions)) throw new Error('Workflow migration changed conversation bodies or versions');
  assertForeignKeys(db);
}

function assertConversationPersistence(db: Database.Database, definitions: readonly WorkflowMigrationDefinition[]): void {
  for (const d of definitions) { assertBody(db,d); assertWorkflowTriggers(db,d); }
  const message = definitions.find(d => d.table === 'conversation_messages')!;
  const native = db.prepare('PRAGMA table_xinfo(conversation_messages)').all() as {name:string;type:string;notnull:number;hidden:number;dflt_value:unknown}[];
  for (const c of columns(message).filter(c => c.column === 'turn_id' || c.column === 'session_id')) {
    const stored = native.find(column => column.name === c.column);
    if (!stored || stored.type.toUpperCase() !== 'TEXT' || stored.notnull || stored.hidden || stored.dflt_value !== null
      || db.prepare(`SELECT 1 FROM conversation_messages WHERE ${safeName(c.column)} IS NOT ${projected(message,c,'payload')} LIMIT 1`).get()) {
      throw new Error('Workflow migration contains incompatible conversation identity projection');
    }
  }
  const indexes: Record<string, readonly string[]> = {
    workflow_conversation_messages_turn_id_lookup: ['turn_id','id'],
    workflow_conversation_messages_session_id_lookup: ['session_id','id'],
    workflow_conversation_messages_identity_lookup: ['actor_id','conversation_id','session_id','turn_id','id'],
  };
  for (const [index,expected] of Object.entries(indexes)) {
    const definition = (db.prepare('PRAGMA index_list(conversation_messages)').all() as {name:string;unique:number;partial:number}[]).find(item => item.name === index);
    const fields = (db.prepare(`PRAGMA index_info(${safeName(index)})`).all() as {name:string}[]).map(field => field.name);
    if (!definition || definition.unique || definition.partial || JSON.stringify(fields) !== JSON.stringify(expected)) throw new Error('Workflow migration contains incompatible conversation lookup');
  }
}

function installSnapshotProofReferences(db: Database.Database, definitions: readonly WorkflowMigrationDefinition[]): void {
  const d = definitions[0];
  const before = preservedRowsDigest(db, definitions);
  assertBody(db, d);
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='review_snapshot_targets'").all() as {name:string;sql:string}[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${safeName(trigger.name)}`);
  const existing = db.prepare('PRAGMA table_xinfo(review_snapshot_targets)').all() as {name:string;type:string;notnull:number;hidden:number;dflt_value:unknown}[];
  for (const c of columns(d).filter(c => ['directory_identity_id','responsibility_id','action_execution_id'].includes(c.column))) {
    const prior = existing.find(column => column.name === c.column);
    if (prior) {
      if (prior.type.toUpperCase() !== 'TEXT' || prior.notnull || prior.hidden || prior.dflt_value !== null
        || db.prepare(`SELECT 1 FROM review_snapshot_targets WHERE ${safeName(c.column)} IS NOT ${projected(d,c,'body')} LIMIT 1`).get()) {
        throw new Error('Workflow migration contains contradictory snapshot proof');
      }
    } else {
      db.exec(`ALTER TABLE review_snapshot_targets ADD COLUMN ${columnSql(d,c)}`);
      db.exec(`UPDATE review_snapshot_targets SET ${safeName(c.column)}=${projected(d,c,'body')}`);
    }
  }
  // A table rebuild installs the generated V2 marker and its composite native FK.
  const current = workflowMigrationDefinitions();
  installReferenceIndexes(db, current);
  rebuildForCompleteness(db, d, current);
  installIndexes(db, d);
  installTriggers(db, d);
  const generated = new Set(['insert_guard','update_guard','delete_guard','sync_insert','sync_update','revision_insert','revision_update','revision_delete'].map(suffix => `workflow_${d.table}_${suffix}`));
  for (const trigger of triggers.filter(trigger => !generated.has(trigger.name))) db.exec(trigger.sql);
  if (before !== preservedRowsDigest(db, definitions)) throw new Error('Workflow migration changed snapshot bodies or versions');
  assertForeignKeys(db);
}

function assertSnapshotProofReferences(db: Database.Database, definitions: readonly WorkflowMigrationDefinition[]): void {
  const d = definitions[0];
  assertBody(db, d);
  const native = db.prepare('PRAGMA table_xinfo(review_snapshot_targets)').all() as {name:string;type:string;notnull:number;hidden:number;dflt_value:unknown}[];
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(review_snapshot_targets)').all() as {id:number;seq:number;table:string;from:string;to:string;on_delete:string}[];
  for (const f of d.foreignKeys.filter(f => ['directory_identity_id','responsibility_id','action_execution_id'].includes(f.column))) {
    const c = columns(d).find(c => c.column === f.column)!;
    const stored = native.find(column => column.name === c.column);
    if (!stored || stored.type.toUpperCase() !== 'TEXT' || stored.notnull || stored.hidden || stored.dflt_value !== null
      || db.prepare(`SELECT 1 FROM review_snapshot_targets WHERE ${safeName(c.column)} IS NOT ${projected(d,c,'body')} LIMIT 1`).get()
      || !foreignKeys.some(key => key.from === f.column && key.to === 'id' && key.table === f.target && key.on_delete === 'NO ACTION'
        && foreignKeys.filter(part => part.id === key.id).length === 1)) {
      throw new Error('Workflow migration contains incompatible snapshot proof projection');
    }
  }
  const execution = d.foreignKeys.find(f => f.column === 'action_execution_id')!;
  const marker = native.find(column => column.name === referenceMarker(execution));
  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_snapshot_targets'").get() as {sql:string}).sql;
  const composite = foreignKeys.find(key => key.from === execution.column && key.to === 'id' && key.table === 'action_executions'
    && foreignKeys.some(part => part.id === key.id && part.from === referenceMarker(execution) && part.to === 'workflow_contract_version' && part.on_delete === 'NO ACTION'));
  if (!marker || marker.type.toUpperCase() !== 'INTEGER' || marker.hidden !== 2 || !tableSql.includes(referenceMarkerSql(d, execution))
    || !composite || foreignKeys.filter(part => part.id === composite.id).length !== 2) {
    throw new Error('Workflow migration contains incompatible snapshot execution provenance');
  }
  assertWorkflowTriggers(db, d);
}

function assertActionProvenanceShares(db:Database.Database,d:WorkflowMigrationDefinition):void {
  if(db.prepare("SELECT 1 FROM dashboard_shares WHERE workflow_share_body_valid(payload,workflow_contract_version)<>1 OR json_extract(payload,'$.id') IS NOT id LIMIT 1").get())throw new Error('Workflow action provenance contains incompatible historical share');
  for(const c of columns(d))if(db.prepare(`SELECT 1 FROM dashboard_shares WHERE workflow_contract_version=2 AND ${safeName(c.column)} IS NOT ${projected(d,c,'payload')} LIMIT 1`).get())throw new Error('Workflow action provenance contains contradictory share projection');
  assertBody(db,d);
}

function installActionTargetProvenance(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void {
  const current=workflowMigrationDefinitions();
  const share=definitions.find(d=>d.table==='dashboard_shares')!;
  const target=definitions.find(d=>d.table==='action_targets')!;
  const event=definitions.find(d=>d.table==='dashboard_share_revoke_events')!;
  const prior=definitions.filter(d=>d.table!=='dashboard_share_revoke_events');
  const before=preservedRowsDigest(db,prior);
  assertActionProvenanceShares(db,share);
  const priorTarget=historicalWorkflowCompletenessDefinitions.find(d=>d.table==='action_targets')!;
  assertBody(db,priorTarget);
  for(const c of columns(priorTarget))if(db.prepare(`SELECT 1 FROM action_targets WHERE ${safeName(c.column)} IS NOT ${projected(priorTarget,c,'body')} LIMIT 1`).get())throw new Error('Workflow action provenance contains contradictory historical action target');
  if(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='dashboard_share_revoke_events'").get())throw new Error('Workflow action provenance cannot adopt an unledgered revoke-event table');
  if((db.prepare('PRAGMA table_xinfo(dashboard_shares)').all() as {name:string}[]).some(c=>c.name===revokeQuarantine))throw new Error('Workflow action provenance cannot adopt an unledgered quarantine');
  // SQLite reparses every trigger during table rename, including reverse consumers.
  // Suspend and restore all main-schema trigger SQL verbatim under BEGIN IMMEDIATE.
  const triggers=db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger'").all() as {name:string;tbl_name:string;sql:string}[];
  const generated=new Map(definitions.flatMap(d=>workflowTriggerStatements(d).filter(sql=>sql.startsWith('CREATE TRIGGER ')).map(sql=>[/^CREATE TRIGGER "([a-z][a-z0-9_]*)"/.exec(sql)![1],d.table] as const)));
  for(const trigger of triggers)if(generated.has(trigger.name)&&generated.get(trigger.name)!==trigger.tbl_name)throw new Error('Workflow action provenance contains a cross-table generated trigger collision');
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${safeName(trigger.name)}`);
  db.exec(`ALTER TABLE dashboard_shares ADD COLUMN ${safeName(revokeQuarantine)} INTEGER NOT NULL DEFAULT 0 CHECK(${safeName(revokeQuarantine)} IN(0,1))`);
  db.exec(`UPDATE dashboard_shares SET ${safeName(revokeQuarantine)}=CASE WHEN workflow_contract_version=2 AND status='revoked' THEN 1 ELSE 0 END`);
  const existing=new Set((db.prepare('PRAGMA table_xinfo(action_targets)').all() as {name:string}[]).map(c=>c.name));
  for(const c of columns(target).filter(c=>c.column==='investigation_case_id'||c.column==='dashboard_share_id')){
    if(existing.has(c.column))throw new Error('Workflow action provenance cannot adopt an unledgered source projection');
    db.exec(`ALTER TABLE action_targets ADD COLUMN ${columnSql(target,c)}`);
    db.exec(`UPDATE action_targets SET ${safeName(c.column)}=${projected(target,c,'body')}`);
  }
  installReferenceIndexes(db,current);
  installIndexes(db,share);
  db.exec(projectedTableSql(event,event.table,current));
  installIndexes(db,event);
  rebuildForCompleteness(db,target,current);
  rebuildForCompleteness(db,share,current);
  for(const d of definitions){installIndexes(db,d);installTriggers(db,d);}
  for(const trigger of triggers.filter(trigger=>generated.get(trigger.name)!==trigger.tbl_name))db.exec(trigger.sql);
  if(before!==preservedRowsDigest(db,prior))throw new Error('Workflow action provenance changed historical bodies or versions');
  assertForeignKeys(db);
}

function assertActionTargetProvenance(db:Database.Database,definitions:readonly WorkflowMigrationDefinition[]):void {
  const current=workflowMigrationDefinitions();
  for(const d of definitions){
    const actual=(db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(d.table) as {sql:string}|undefined)?.sql;
    if(actual!==projectedTableSql(d,d.table,current))throw new Error('Workflow action provenance contains incompatible native table: '+d.table);
    assertBody(db,d);assertWorkflowTriggers(db,d);
    for(const u of d.unique){
      const index=(db.prepare(`PRAGMA index_list(${safeName(d.table)})`).all() as {name:string;unique:number;partial:number}[]).find(index=>index.name===u.name);
      const fields=(db.prepare(`PRAGMA index_info(${safeName(u.name)})`).all() as {name:string}[]).map(c=>c.name);
      const expected=u.fields.map(field=>field==='id'?'id':field==='rowVersion'?'row_version':columns(d).find(c=>c.bodyField===field)!.column);
      const native=db.prepare("SELECT tbl_name,sql FROM main.sqlite_master WHERE type='index' AND name=?").get(u.name) as {tbl_name:string;sql:string}|undefined;
      const partial=d.storage==='mixed'&&!u.referenceKey?1:0;
      if(!index?.unique||index.partial!==partial||JSON.stringify(fields)!==JSON.stringify(expected)||native?.tbl_name!==d.table||typeof native.sql!=='string'||normalizeIndexSql(native.sql)!==normalizeIndexSql(uniqueIndexSql(d,u,false)))throw new Error('Workflow action provenance contains incompatible unique key');
    }
  }
  const share=definitions.find(d=>d.table==='dashboard_shares')!;
  assertActionProvenanceShares(db,share);
  if(db.prepare(`SELECT 1 FROM dashboard_shares WHERE ${safeName(revokeQuarantine)}=1 AND (workflow_contract_version IS NOT 2 OR status IS NOT 'revoked') LIMIT 1`).get())throw new Error('Workflow action provenance contains invalid historical quarantine');
  if(db.prepare(`SELECT 1 FROM dashboard_share_revoke_events e WHERE NOT (${shareRevokeRelationship('e.body')}) LIMIT 1`).get())throw new Error('Workflow action provenance contains incompatible revoke-event provenance');
  assertForeignKeys(db);
}

function pendingActionRevisionDefinition(): WorkflowMigrationDefinition {
  const definition = workflowMigrationDefinitions().find(candidate => candidate.table === 'pending_actions');
  if (!definition) throw new Error('Workflow migration is missing the pending action projection');
  return definition;
}

function pendingActionRevisionFingerprint(definition: WorkflowMigrationDefinition): string {
  const triggers = workflowTriggerStatements(definition).filter(statement => statement.startsWith('CREATE TRIGGER '));
  return createHash('sha256').update(JSON.stringify({ definition, triggers })).digest('hex');
}

function pendingActionDeleteFenceStatement(): string {
  return `CREATE TRIGGER ${safeName('workflow_pending_actions_delete_fence')} BEFORE DELETE ON ${safeName('pending_actions')}
    BEGIN
      SELECT RAISE(ABORT,'Pending workflow action history cannot be deleted');
    END`;
}

function pendingActionDeleteFenceFingerprint(): string {
  return createHash('sha256').update(pendingActionDeleteFenceStatement()).digest('hex');
}

function assertPendingActionDeleteFence(db: Database.Database): void {
  const statement = pendingActionDeleteFenceStatement();
  const name = 'workflow_pending_actions_delete_fence';
  const actual = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get(name) as { name: string; tbl_name: string; sql: string } | undefined;
  if (!actual || actual.name !== name || actual.tbl_name !== 'pending_actions' || actual.sql !== statement) {
    throw new Error('Workflow migration contains incompatible pending-action delete fence trigger');
  }
}

function installPendingActionDeleteFence(db: Database.Database, definition: WorkflowMigrationDefinition): void {
  const before = preservedRowsDigest(db, [definition]);
  const existing = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get('workflow_pending_actions_delete_fence') as { name: string; tbl_name: string; sql: string } | undefined;
  if (existing) {
    assertPendingActionDeleteFence(db);
  } else {
    db.exec(pendingActionDeleteFenceStatement());
    assertPendingActionDeleteFence(db);
  }
  if (before !== preservedRowsDigest(db, [definition])) {
    throw new Error('Workflow migration changed pending action bodies or versions');
  }
}

function pendingActionInsertIdentityFenceStatement(): string {
  return `CREATE TRIGGER ${safeName('workflow_pending_actions_insert_identity_fence')} BEFORE INSERT ON ${safeName('pending_actions')}
    WHEN EXISTS(SELECT 1 FROM ${safeName('pending_actions')} existing WHERE existing.id=NEW.id) BEGIN
      SELECT RAISE(ABORT,'Pending workflow action identity already exists');
    END`;
}

function pendingActionInsertIdentityFenceFingerprint(): string {
  return createHash('sha256').update(pendingActionInsertIdentityFenceStatement()).digest('hex');
}

function assertPendingActionInsertIdentityFence(db: Database.Database): void {
  const statement = pendingActionInsertIdentityFenceStatement();
  const name = 'workflow_pending_actions_insert_identity_fence';
  const actual = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get(name) as { name: string; tbl_name: string; sql: string } | undefined;
  if (!actual || actual.name !== name || actual.tbl_name !== 'pending_actions' || actual.sql !== statement) {
    throw new Error('Workflow migration contains incompatible pending-action insert identity fence trigger');
  }
}

function installPendingActionInsertIdentityFence(db: Database.Database, definition: WorkflowMigrationDefinition): void {
  const before = preservedRowsDigest(db, [definition]);
  const existing = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get('workflow_pending_actions_insert_identity_fence') as { name: string; tbl_name: string; sql: string } | undefined;
  if (existing) {
    assertPendingActionInsertIdentityFence(db);
  } else {
    db.exec(pendingActionInsertIdentityFenceStatement());
    assertPendingActionInsertIdentityFence(db);
  }
  if (before !== preservedRowsDigest(db, [definition])) {
    throw new Error('Workflow migration changed pending action bodies or versions');
  }
}

function pendingActionFreshV1InsertStatement(): string {
  const bodyValid = legacyPendingActionBodyCheck('NEW.payload');
  const startsPending = `json_type(NEW.payload,'$.status')='text' AND json_extract(NEW.payload,'$.status')='pending'`;
  return `CREATE TRIGGER ${safeName('workflow_pending_actions_fresh_v1_insert_guard')} BEFORE INSERT ON ${safeName('pending_actions')}
    WHEN NEW.workflow_contract_version IS NULL AND workflow_migration_active()=0
      AND NOT EXISTS(SELECT 1 FROM ${safeName('pending_actions')} existing WHERE existing.id=NEW.id) BEGIN
      SELECT CASE WHEN COALESCE((${bodyValid}),0)=0 THEN RAISE(ABORT,'Invalid legacy pending action body') END;
      SELECT CASE WHEN COALESCE((${startsPending}),0)=0 THEN RAISE(ABORT,'New legacy pending action must start pending') END;
    END`;
}

function pendingActionFreshV1InsertFingerprint(): string {
  return createHash('sha256').update(pendingActionFreshV1InsertStatement()).digest('hex');
}

function assertPendingActionFreshV1Insert(db: Database.Database): void {
  const statement = pendingActionFreshV1InsertStatement();
  const name = 'workflow_pending_actions_fresh_v1_insert_guard';
  const actual = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get(name) as { name: string; tbl_name: string; sql: string } | undefined;
  if (!actual || actual.name !== name || actual.tbl_name !== 'pending_actions' || actual.sql !== statement) {
    throw new Error('Workflow migration contains incompatible fresh V1 pending-action insert trigger');
  }
}

function installPendingActionFreshV1Insert(db: Database.Database, definition: WorkflowMigrationDefinition): void {
  const before = preservedRowsDigest(db, [definition]);
  const existing = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get('workflow_pending_actions_fresh_v1_insert_guard') as { name: string; tbl_name: string; sql: string } | undefined;
  if (existing) {
    assertPendingActionFreshV1Insert(db);
  } else {
    db.exec(pendingActionFreshV1InsertStatement());
    assertPendingActionFreshV1Insert(db);
  }
  if (before !== preservedRowsDigest(db, [definition])) {
    throw new Error('Workflow migration changed pending action bodies or versions');
  }
}

function pendingActionFreshV1StatusProjectionStatement(): string {
  const statusMatches = `json_type(NEW.payload,'$.status')='text'
    AND json_extract(NEW.payload,'$.status')='pending'
    AND (NEW.status IS NULL OR (NEW.status='pending' AND NEW.status IS json_extract(NEW.payload,'$.status')))`;
  return `CREATE TRIGGER ${safeName('workflow_pending_actions_fresh_v1_status_projection_guard')} BEFORE INSERT ON ${safeName('pending_actions')}
    WHEN NEW.workflow_contract_version IS NULL AND workflow_migration_active()=0
      AND NOT EXISTS(SELECT 1 FROM ${safeName('pending_actions')} existing WHERE existing.id=NEW.id) BEGIN
      SELECT CASE WHEN COALESCE((${statusMatches}),0)=0 THEN RAISE(ABORT,'Fresh V1 pending action status projection is inconsistent') END;
    END`;
}

function pendingActionFreshV1StatusProjectionFingerprint(): string {
  return createHash('sha256').update(pendingActionFreshV1StatusProjectionStatement()).digest('hex');
}

function assertPendingActionFreshV1StatusProjection(db: Database.Database): void {
  const statement = pendingActionFreshV1StatusProjectionStatement();
  const name = 'workflow_pending_actions_fresh_v1_status_projection_guard';
  const actual = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get(name) as { name: string; tbl_name: string; sql: string } | undefined;
  if (!actual || actual.name !== name || actual.tbl_name !== 'pending_actions' || actual.sql !== statement) {
    throw new Error('Workflow migration contains incompatible fresh V1 status projection trigger');
  }
}

function installPendingActionFreshV1StatusProjection(db: Database.Database, definition: WorkflowMigrationDefinition): void {
  const before = preservedRowsDigest(db, [definition]);
  assertPendingActionFreshV1Insert(db);
  const existing = db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_master WHERE type='trigger' AND name=?")
    .get('workflow_pending_actions_fresh_v1_status_projection_guard') as { name: string; tbl_name: string; sql: string } | undefined;
  if (existing) {
    assertPendingActionFreshV1StatusProjection(db);
  } else {
    db.exec(pendingActionFreshV1StatusProjectionStatement());
    assertPendingActionFreshV1StatusProjection(db);
  }
  if (before !== preservedRowsDigest(db, [definition])) {
    throw new Error('Workflow migration changed pending action bodies or versions');
  }
}

function installPendingActionRevision(db: Database.Database, definition: WorkflowMigrationDefinition): void {
  const before = preservedRowsDigest(db, [definition]);
  installTriggers(db, definition);
  assertBody(db, definition);
  assertWorkflowTriggers(db, definition);
  if (before !== preservedRowsDigest(db, [definition])) {
    throw new Error('Workflow migration changed legacy pending action bodies or versions');
  }
}

/** Appended schema steps preserve every existing ledger digest, body and version. */
export function applyWorkflowSqliteMigrations(db: Database.Database): void {
  if(db.inTransaction)throw new Error('Workflow migration must run outside application transactions');
  const definitions=workflowConversationPersistenceDefinitions();
  const snapshotDefinitions=workflowSnapshotProofReferenceDefinitions();
  const actionDefinitions=workflowActionTargetProvenanceDefinitions();
  const fingerprint=createHash('sha256').update(JSON.stringify(actionDefinitions)).digest('hex');
  const pendingRevisionDefinition=pendingActionRevisionDefinition();
  const pendingRevisionFingerprint=pendingActionRevisionFingerprint(pendingRevisionDefinition);
  for(const [history,digest] of [[historicalWorkflowBaseDefinitions,WORKFLOW_BASE_DIGEST],[historicalWorkflowScopeDefinitions,WORKFLOW_SCOPE_DIGEST],[historicalWorkflowCompletenessDefinitions,WORKFLOW_COMPLETENESS_DIGEST],[historicalWorkflowConversationPersistenceDefinitions,WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST],[historicalWorkflowSnapshotProofReferenceDefinitions,WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST]] as const){
    if(createHash('sha256').update(JSON.stringify(history)).digest('hex')!==digest)throw new Error('Workflow migration historical descriptor changed');
  }
  let migrationActive=false;
  db.function('workflow_migration_active',()=>migrationActive?1:0);
  db.function('workflow_utf16_length',(value:unknown)=>typeof value==='string'?value.length:null);
  db.function('workflow_conversation_body_valid',(table:unknown,body:unknown)=>{
    if (typeof body !== 'string') return 0;
    try {
      const schema = table === 'conversations' ? persistedConversationSchema : table === 'conversation_messages' ? persistedConversationMessageSchema : undefined;
      return schema?.safeParse(JSON.parse(body)).success ? 1 : 0;
    } catch { return 0; }
  });
  db.function('workflow_instant_valid',(value:unknown)=>instantSchema.safeParse(value).success?1:0);
  db.function('workflow_identifier_valid',(value:unknown)=>refSchema.shape.id.safeParse(value).success?1:0);
  db.function('workflow_share_body_valid',(body:unknown,marker:unknown)=>{
    if(typeof body!=='string')return 0;
    try{
      const parsed:unknown=JSON.parse(body);
      if(marker!==2&&isMarkerlessV2WorkflowBody('dashboard_shares',parsed))return 0;
      return (marker===2?dashboardShareV2Schema:workflowProjectionManifest.get('dashboard_shares')!.bodySchema).safeParse(parsed).success?1:0;
    }catch{return 0;}
  });
  db.function('workflow_share_revoke_body_valid',(body:unknown)=>{
    if(typeof body!=='string')return 0;
    try{return dashboardShareRevokeEventSchema.safeParse(JSON.parse(body)).success?1:0;}catch{return 0;}
  });
  db.pragma('foreign_keys = OFF');
  try{
    db.exec('BEGIN IMMEDIATE');migrationActive=true;
    const revision=(db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as {revision:number}).revision;
    db.exec('CREATE TABLE IF NOT EXISTS workflow_schema_migrations (id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
    if(!(db.prepare('PRAGMA table_info(appmeta)').all() as {name:string}[]).some(c=>c.name==='workflow_adapter_write'))db.exec('ALTER TABLE appmeta ADD COLUMN workflow_adapter_write INTEGER NOT NULL DEFAULT 0 CHECK(workflow_adapter_write IN(0,1))');
    if((db.prepare('SELECT workflow_adapter_write flag FROM appmeta WHERE singleton=1').get() as {flag:number}).flag!==0)throw new Error('Workflow migration found an active adapter write');
    const ledger=(id:string)=>(db.prepare('SELECT digest FROM workflow_schema_migrations WHERE id=?').get(id) as {digest:string}|undefined)?.digest;
    const base=ledger(WORKFLOW_BASE_MIGRATION),scope=ledger(WORKFLOW_SCOPE_MIGRATION),complete=ledger(WORKFLOW_COMPLETENESS_MIGRATION),conversation=ledger(WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION),snapshot=ledger(WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION),action=ledger(WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION),pendingRevision=ledger(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION),pendingActionV2BodyGuard=ledger(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION),pendingActionDeleteFence=ledger(WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION),pendingActionInsertIdentityFence=ledger(WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION),pendingActionFreshV1Insert=ledger(WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION),pendingActionFreshV1StatusProjection=ledger(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION);
    const historicalPendingRevisionDigests=[WORKFLOW_PENDING_ACTION_REVISION_LEGACY_DIGEST,WORKFLOW_PENDING_ACTION_REVISION_REUSED_ID_DIGEST];
    const pendingActionDeleteFenceDigest = pendingActionDeleteFenceFingerprint();
    const pendingActionInsertIdentityFenceDigest = pendingActionInsertIdentityFenceFingerprint();
    const pendingActionFreshV1InsertDigest = pendingActionFreshV1InsertFingerprint();
    const pendingActionFreshV1StatusProjectionDigest = pendingActionFreshV1StatusProjectionFingerprint();
    if((base!==undefined&&base!==WORKFLOW_BASE_DIGEST&&base!==WORKFLOW_SCOPE_DIGEST)||(scope!==undefined&&(!base||scope!==WORKFLOW_SCOPE_DIGEST))||(complete!==undefined&&(!scope||complete!==WORKFLOW_COMPLETENESS_DIGEST))||(conversation!==undefined&&(!complete||conversation!==WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST))||(snapshot!==undefined&&(!conversation||snapshot!==WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST))||(action!==undefined&&(!snapshot||action!==fingerprint))||(pendingRevision!==undefined&&(!action||!historicalPendingRevisionDigests.includes(pendingRevision)))||(pendingActionV2BodyGuard!==undefined&&(!pendingRevision||pendingActionV2BodyGuard!==pendingRevisionFingerprint))||(pendingActionDeleteFence!==undefined&&(!pendingActionV2BodyGuard||pendingActionDeleteFence!==pendingActionDeleteFenceDigest))||(pendingActionInsertIdentityFence!==undefined&&(!pendingActionDeleteFence||pendingActionInsertIdentityFence!==pendingActionInsertIdentityFenceDigest))||(pendingActionFreshV1Insert!==undefined&&(!pendingActionInsertIdentityFence||pendingActionFreshV1Insert!==pendingActionFreshV1InsertDigest))||(pendingActionFreshV1StatusProjection!==undefined&&(!pendingActionFreshV1Insert||pendingActionFreshV1StatusProjection!==pendingActionFreshV1StatusProjectionDigest)))throw new Error('Workflow migration manifest changed without a new schema version');
    const record=(id:string,digest:string)=>db.prepare('INSERT INTO workflow_schema_migrations(id,digest) VALUES(?,?)').run(id,digest);
    if(!base){installHistoricalBase(db);record(WORKFLOW_BASE_MIGRATION,WORKFLOW_BASE_DIGEST);}
    if(!scope){upgradeResponsibilityScopeIndex(db);assertForeignKeys(db);record(WORKFLOW_SCOPE_MIGRATION,WORKFLOW_SCOPE_DIGEST);}
    if(!complete){installCompleteness(db,historicalWorkflowCompletenessDefinitions);record(WORKFLOW_COMPLETENESS_MIGRATION,WORKFLOW_COMPLETENESS_DIGEST);}
    if(!conversation){installConversationPersistence(db,definitions);record(WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION,WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST);}
    assertConversationPersistence(db,definitions);
    if(!snapshot){installSnapshotProofReferences(db,snapshotDefinitions);record(WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST);}
    assertSnapshotProofReferences(db,snapshotDefinitions);
    if(!action){installActionTargetProvenance(db,actionDefinitions);record(WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION,fingerprint);}
    assertActionTargetProvenance(db,actionDefinitions);
    if(!pendingRevision)record(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION,WORKFLOW_PENDING_ACTION_REVISION_LEGACY_DIGEST);
    if(!pendingActionV2BodyGuard){
      installPendingActionRevision(db,pendingRevisionDefinition);
      record(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION,pendingRevisionFingerprint);
    }else {assertBody(db,pendingRevisionDefinition);assertWorkflowTriggers(db,pendingRevisionDefinition);}
    if(!pendingActionDeleteFence){
      installPendingActionDeleteFence(db,pendingRevisionDefinition);
      record(WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION,pendingActionDeleteFenceDigest);
    }
    assertPendingActionDeleteFence(db);
    if(!pendingActionInsertIdentityFence){
      installPendingActionInsertIdentityFence(db,pendingRevisionDefinition);
      record(WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION,pendingActionInsertIdentityFenceDigest);
    }
    assertPendingActionInsertIdentityFence(db);
    if(!pendingActionFreshV1Insert){
      installPendingActionFreshV1Insert(db,pendingRevisionDefinition);
      record(WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION,pendingActionFreshV1InsertDigest);
    }
    assertPendingActionFreshV1Insert(db);
    if(!pendingActionFreshV1StatusProjection){
      installPendingActionFreshV1StatusProjection(db,pendingRevisionDefinition);
      record(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION,pendingActionFreshV1StatusProjectionDigest);
    }
    assertPendingActionFreshV1StatusProjection(db);
    if((db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as {revision:number}).revision!==revision)throw new Error('Workflow migration changed application revision');
    assertForeignKeys(db);
    db.exec('COMMIT');
  }catch(error){
    if(db.inTransaction)db.exec('ROLLBACK');
    if(error instanceof Error&&error.message.startsWith('Workflow migration'))throw error;
    throw new Error('Workflow migration rejected incompatible schema or data',{cause:error});
  }finally{
    migrationActive=false;
    db.pragma('foreign_keys = ON');
  }
}

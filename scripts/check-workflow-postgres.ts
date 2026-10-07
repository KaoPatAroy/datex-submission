import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_MIGRATION = 'supabase/migrations/202610010001_concierge.sql';
const WORKFLOW_MIGRATION = 'supabase/migrations/202610020002_workflow_v2.sql';
const CONFORMANCE_SQL = 'tests/sql/workflow-v2-conformance.sql';
const COMPLETENESS_MIGRATION = 'supabase/migrations/202610030002_workflow_projection_completeness.sql';
const COMPLETENESS_SQL = 'tests/sql/workflow-v2-completeness.sql';
const COMPLETENESS_CHILD_TABLE = 'workflow_offboarding_plan_assignments';
const CONVERSATION_MIGRATION = 'supabase/migrations/202610040001_workflow_conversation_persistence.sql';
const CONVERSATION_SQL = 'tests/sql/workflow-v2-conversation-persistence.sql';
const CONVERSATION_MIGRATION_SHA256 = 'C3A2DA42A7873C96FED5E5B4E8346370CA8CE5C289EE5731BBB8CB1D65D6A0AF';
const CONVERSATION_MIGRATION_ID = '202610040001_workflow_conversation_persistence';
const SNAPSHOT_PROOF_MIGRATION = 'supabase/migrations/202610040002_workflow_snapshot_proof_references.sql';
const SNAPSHOT_PROOF_SQL = 'tests/sql/workflow-v2-snapshot-proof-references.sql';
const SNAPSHOT_PROOF_MIGRATION_SHA256 = '3FDC491792D1141DFE40B18E8FED7EF673E5E797668467D4601F37C2BE1DD60A';
const SNAPSHOT_PROOF_MIGRATION_ID = '202610040002_workflow_snapshot_proof_references';
const ACTION_TARGET_PROVENANCE_MIGRATION = 'supabase/migrations/202610040003_workflow_action_target_provenance.sql';
const ACTION_TARGET_PROVENANCE_SQL = 'tests/sql/workflow-v2-action-target-provenance.sql';
const ACTION_TARGET_PROVENANCE_MIGRATION_SHA256 = '68A25F9DCF4A5B1A1A016A1F3794A04BD1698CB7A23B53745319DBA11D8F6BD5';
const ACTION_TARGET_PROVENANCE_MIGRATION_ID = '202610040003_workflow_action_target_provenance';
const PENDING_ACTION_V1_STANDALONE_MIGRATION = 'supabase/migrations/202610010002_workflow_pending_action_v1_guard.sql';
const PENDING_ACTION_V1_STANDALONE_SQL = 'tests/sql/workflow-v1-pending-action-revision.sql';
const PENDING_ACTION_V1_STANDALONE_MIGRATION_SHA256 = '893AAC7DE121AB816F5F154D88CAD212041D200CD4126AA6CED30A9243E132C0';
const PENDING_ACTION_V1_STANDALONE_SQL_SHA256 = '1ED5E18A6140280BB1EC7E17F0DC268C2904524DFE4767BEBC17A75E7084CB59';
const PENDING_ACTION_V1_STANDALONE_SEED_BODY_MD5 = 'dc2c5cca4cd75a4d83021ba8927cb335';
const PENDING_ACTION_V1_STANDALONE_SEED_ROW_IMAGE_MD5 = '4503d2159ffdb8ff09015f631942a02f';
const PENDING_ACTION_V1_STANDALONE_LEDGER_DIGEST = 'a6b602b989af97760e2311cbbe79f78a';
const PENDING_ACTION_V1_STANDALONE_MIGRATION_ID = '202610010002_workflow_pending_action_v1_guard';
const PENDING_ACTION_V1_STANDALONE_CASE_NAMES = [
  'nine pre-existing V1 actions preserve their identities and historical statuses',
  'V1 accepts a valid pending insert and atomically supersedes A with B',
  'V1 child upserts allow claim/completion and idempotent cancellation replay',
  'V1 rejects malformed lineage presence/nulls, fresh nonpending inserts, and V1-to-V2 promotion',
  'V1 rejects invalid status changes and immutable approval-envelope writes',
  'V1 DELETE and TRUNCATE attempts roll back without rows or advancing revision',
  'V1 nexus_commit batch rejection rolls back prior writes and appmeta revision',
  'all nine historical V1 action rows remain unchanged after conformance writes'
] as const;
const PENDING_ACTION_V1_STANDALONE_HISTORICAL_ACTIONS = [
  { id: 'workflow-pg-v1-historical-completed-01', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-02', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-03', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-04', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-05', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-06', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-07', status: 'completed' },
  { id: 'workflow-pg-v1-historical-completed-08', status: 'completed' },
  { id: 'workflow-pg-v1-historical-pending-01', status: 'pending' }
] as const;
const PENDING_ACTION_V1_STANDALONE_FIXTURE_SQL = [
  '\\set ON_ERROR_STOP 1',
  'BEGIN;',
  'INSERT INTO public.pending_actions(id,payload) VALUES',
  ...PENDING_ACTION_V1_STANDALONE_HISTORICAL_ACTIONS.map((action, index) => [
    `  ('${action.id}',jsonb_build_object(`,
    `    'id','${action.id}','actorId','workflow-pg-v1-historical-actor',`,
    `    'sessionId','workflow-pg-v1-historical-session','conversationId','workflow-pg-v1-historical-conversation',`,
    `    'turnId','workflow-pg-v1-historical-turn-${String(index + 1).padStart(2, '0')}',`,
    "    'mode','live_ai','modeRevision',0,",
    "    'payload',jsonb_build_object('kind','dashboard_create'),",
    `    'payloadHash','workflow-pg-v1-historical-hash-${String(index + 1).padStart(2, '0')}',`,
    "    'packs',jsonb_build_array(),'actionContractVersion',1,",
    "    'createdAt','2026-10-04T00:00:00.000Z','expiresAt','2099-01-01T00:00:00.000Z',",
    `    'status','${action.status}','preview','Synthetic historical V1 action ${String(index + 1).padStart(2, '0')}'))${index + 1 === PENDING_ACTION_V1_STANDALONE_HISTORICAL_ACTIONS.length ? ';' : ','}`
  ].join('\n')),
  'COMMIT;'
].join('\n');
const RUN_PREFIX = 'workflow_test_';
const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const MAX_INLINE_SQL_COMMAND_CHARS = 16_000;
const EXPECTED_CASE_COUNT = 30;
const EXPECTED_COMPLETENESS_CASE_COUNT = 7;
const EXPECTED_CONVERSATION_CASE_COUNT = 7;
const EXPECTED_SNAPSHOT_PROOF_CASE_COUNT = 10;
const EXPECTED_ACTION_TARGET_PROVENANCE_CASE_COUNT = 8;
const ACTION_TARGET_PROVENANCE_MANIFEST_TABLE_COUNT = 63;
const RESPONSIBILITIES_ACTIVE_UNIQUE_INDEX = 'responsibilities_open_identity_purpose_unique';
const MIGRATION_STATE_SQL = [
  'SELECT concat_ws(chr(9),',
  "(SELECT revision::text FROM public.appmeta WHERE singleton=1),",
  "(SELECT workflow_adapter_write::text FROM public.appmeta WHERE singleton=1),",
  "(SELECT md5(coalesce(string_agg(c.relname || ':' || a.attnum::text || ':' || a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin,d.adrelid),''), E'\\n' ORDER BY c.relname,a.attnum),'')) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace IN ('public'::regnamespace,'nexus_private'::regnamespace) AND a.attnum>0 AND NOT a.attisdropped),",
  "(SELECT md5(coalesce(string_agg(table_name || '=' || definition::text, E'\\n' ORDER BY table_name),'')) FROM nexus_private.workflow_manifest),",
  "(SELECT md5(coalesce(string_agg(indexname || '=' || indexdef, E'\\n' ORDER BY schemaname,tablename,indexname),'')) FROM pg_catalog.pg_indexes WHERE schemaname IN ('public','nexus_private')),",
  "(SELECT md5(coalesce(string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), E'\\n' ORDER BY conrelid::regclass::text,conname),'')) FROM pg_catalog.pg_constraint WHERE connamespace IN ('public'::regnamespace,'nexus_private'::regnamespace) AND conrelid<>0),",
  "(SELECT md5(concat_ws(E'\\t',",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid), E'\\n' ORDER BY n.nspname,c.relname,t.tgname),'')) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','nexus_private')),",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text,''), E'\\n' ORDER BY n.nspname,c.relname),'')) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','nexus_private') AND c.relkind IN ('r','p','v','m','f')),",
  "(SELECT md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || permissive || ':' || roles::text || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''), E'\\n' ORDER BY schemaname,tablename,policyname),'')) FROM pg_catalog.pg_policies WHERE schemaname IN ('public','nexus_private')),",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text,''), E'\\n' ORDER BY n.nspname,p.proname,p.oid),'')) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','nexus_private') AND p.prokind='f')",
  ")))",
  ')'
].join(' ');

const STANDALONE_V1_CATALOG_STATE_SQL = [
  'SELECT concat_ws(chr(9),',
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || a.attnum::text || ':' || a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin,d.adrelid),''), E'\\n' ORDER BY n.nspname,c.relname,a.attnum),'')) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname IN ('public','nexus_private') AND a.attnum>0 AND NOT a.attisdropped),",
  "(SELECT md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || indexname || '=' || indexdef,E'\\n' ORDER BY schemaname,tablename,indexname),'')) FROM pg_catalog.pg_indexes WHERE schemaname IN ('public','nexus_private')) ,",
  "(SELECT md5(coalesce(string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), E'\\n' ORDER BY conrelid::regclass::text,conname),'')) FROM pg_catalog.pg_constraint WHERE connamespace IN ('public'::regnamespace,'nexus_private'::regnamespace) AND conrelid<>0),",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid), E'\\n' ORDER BY n.nspname,c.relname,t.tgname),'')) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','nexus_private')) ,",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text,''), E'\\n' ORDER BY n.nspname,c.relname),'')) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','nexus_private') AND c.relkind IN ('r','p','v','m','f')) ,",
  "(SELECT md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || permissive || ':' || roles::text || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''), E'\\n' ORDER BY schemaname,tablename,policyname),'')) FROM pg_catalog.pg_policies WHERE schemaname IN ('public','nexus_private')) ,",
  "(SELECT md5(coalesce(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_functiondef(p.oid) || ':owner=' || p.proowner::regrole::text || ':acl=' || coalesce(p.proacl::text,'') || ':effective=' || coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.grantor::regrole::text || ':' || a.privilege_type || ':' || a.is_grantable::text, ',' ORDER BY a.grantee,a.privilege_type,a.grantor) FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),''), E'\\n' ORDER BY n.nspname,p.proname,p.oid),'')) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','nexus_private') AND p.prokind='f') ,",
  "(SELECT md5(coalesce(string_agg(nspname || ':' || nspowner::regrole::text || ':' || coalesce(nspacl::text,''), E'\\n' ORDER BY nspname),'')) FROM pg_catalog.pg_namespace WHERE nspname IN ('public','nexus_private'))",
  ')'
].join(' ');

interface MigrationState {
  revision: bigint;
  adapterWrite: string;
  catalogFingerprint: string;
  tableCounts: Map<string, bigint>;
  tableRowFingerprints: Map<string, string>;
  tableColumns: Map<string, string[]>;
  publicTableNames: Set<string>;
  completenessChildCount: bigint | null;
  completenessChildFingerprint: string | null;
  completenessLedgerCount: bigint | null;
  completenessLedgerFingerprint: string | null;
  appmetaCount: bigint;
  appmetaContentFingerprint: string;
  workflowLedger: WorkflowLedgerSnapshot | null;
  responsibilitiesIndexMetadata: string;
}

interface WorkflowLedgerSnapshot {
  count: bigint;
  fingerprint: string;
  historyCount: bigint;
  historyFingerprint: string;
  snapshotProofHistoryCount: bigint;
  snapshotProofHistoryFingerprint: string;
  actionTargetProvenanceHistoryCount: bigint;
  actionTargetProvenanceHistoryFingerprint: string;
}

interface StandalonePendingActionV1State {
  catalogFingerprint: string;
  pendingCount: bigint;
  pendingFullRowFingerprint: string;
  pendingBodyFingerprint: string;
  completedCount: bigint;
  pendingStatusCount: bigint;
  actionContractVersionOneCount: bigint;
  historicalSeedCount: bigint;
  historicalSeedBodyFingerprint: string;
  historicalSeedRowImageFingerprint: string;
  pendingColumns: string[];
  publicTableNames: Set<string>;
  appmetaCount: bigint;
  appmetaRevision: bigint;
  appmetaFingerprint: string;
  v2SurfaceAbsent: boolean;
  baseV1SurfaceReady: boolean;
  guardTriggersActive: boolean;
  guardSecurity: 'not-installed' | 'private' | 'exposed';
  guardLedgerPresent: boolean;
  guardLedgerCount: bigint;
  guardLedgerFingerprint: string;
  guardLedgerEntryCount: bigint;
  guardLedgerDigest: string | null;
}

function extractExpectedCases(sql: Buffer): string[] {
  const names = [...sql.toString('utf8').matchAll(/^\\echo CASE PASS: (.+)$/gm)].map((match) => match[1]);
  if (names.length !== EXPECTED_CASE_COUNT || new Set(names).size !== names.length) {
    throw new Error(`Expected ${EXPECTED_CASE_COUNT} unique CASE PASS markers in the conformance SQL; observed ${names.length}.`);
  }
  return names;
}

function extractExpectedCaseCount(sql: Buffer, expectedCount: number, label: string): string[] {
  const names = [...sql.toString('utf8').matchAll(/^\\echo CASE PASS: (.+)$/gm)].map((match) => match[1]);
  if (names.length !== expectedCount || new Set(names).size !== names.length) {
    throw new Error('Expected ' + expectedCount + ' unique CASE PASS markers in ' + label + '; observed ' + names.length + '.');
  }
  return names;
}

function extractExpectedNamedCases(sql: Buffer, expectedNames: readonly string[], label: string): string[] {
  const names = [...sql.toString('utf8').matchAll(/^\\echo CASE PASS: (.+)$/gm)].map((match) => match[1]);
  if (names.length !== expectedNames.length || expectedNames.some((name, index) => names[index] !== name)) {
    throw new Error('Expected ' + expectedNames.length + ' named CASE PASS markers in order in ' + label
      + '; observed ' + names.length + '.');
  }
  return names;
}

const COMPLETENESS_LEGACY_FIXTURE_SQL = [
  '\\set ON_ERROR_STOP 1',
  'BEGIN;',
  'SET CONSTRAINTS ALL DEFERRED;',
  "INSERT INTO public.onboarding_requests(id,row_version,body) VALUES (",
  "  'workflow-pg-completeness-legacy-request',1,jsonb_build_object(",
  "    'id','workflow-pg-completeness-legacy-request','rowVersion',1,",
  "    'employeeId','workflow-pg-assigned-employee','orgUnitId','workflow-pg-org',",
  "    'managerIdentityId','workflow-pg-sender','directorIdentityId','workflow-pg-recipient-identity',",
  "    'startDate','2026-10-04','state','manager_review_pending',",
  "    'lifecycleId','workflow-pg-completeness-legacy-request-life',",
  "    'managerApprovalEventId',NULL,'managerApprovedBy',NULL,'managerApprovedAt',NULL,",
  "    'directorApprovalEventId',NULL,'directorApprovedBy',NULL,'directorApprovedAt',NULL,",
  "    'createdAt','2026-10-03T00:40:00.000Z','updatedAt','2026-10-03T00:40:00.000Z'));",
  'INSERT INTO public.onboarding_documents(id,row_version,body) VALUES',
  "  ('workflow-pg-completeness-legacy-received',1,jsonb_build_object(",
  "    'id','workflow-pg-completeness-legacy-received','rowVersion',1,",
  "    'requestId','workflow-pg-completeness-legacy-request','employeeId','workflow-pg-assigned-employee',",
  "    'documentType','identity_document','status','received','policyVersion','1.0',",
  "    'classification','internal','contentDigest',repeat('d',64),'createdAt','2026-10-03T00:40:30.000Z')),",
  "  ('workflow-pg-completeness-legacy-waived',1,jsonb_build_object(",
  "    'id','workflow-pg-completeness-legacy-waived','rowVersion',1,",
  "    'requestId','workflow-pg-completeness-legacy-request','employeeId','workflow-pg-assigned-employee',",
  "    'documentType','signed_offer','status','waived','policyVersion','1.0',",
  "    'classification','internal','contentDigest',repeat('e',64),'createdAt','2026-10-03T00:41:00.000Z'));",
  'INSERT INTO public.mock_tickets(id,payload) VALUES (',
  "  'workflow-pg-completeness-legacy-profile-ticket',jsonb_build_object(",
  "    'id','workflow-pg-completeness-legacy-profile-ticket',",
  "    'branchId','workflow-pg-ordered-cas-branch','assigneeId','workflow-pg-actor',",
  "    'title','Legacy profile-assignee ticket','reason','Preserve the original profile reference.',",
  "    'unansweredQuestion','Which employee owns the legacy work?','sourceIds',jsonb_build_array(),",
  "    'status','open','operationKey','workflow-pg-completeness-legacy-profile-ticket-op',",
  "    'createdAt','2026-10-03T00:41:30.000Z'));",
  'INSERT INTO public.investigation_cases(id,row_version,body) VALUES (',
  "  'workflow-pg-case',1,jsonb_build_object(",
  "    'id','workflow-pg-case','rowVersion',1,",
  "    'branchId','workflow-pg-ordered-cas-branch','ownerIdentityId','workflow-pg-sender',",
  "    'status','open','businessDate','2026-10-27','dueDate','2026-10-28',",
  "    'reason','Seed the synthetic case required by ticket projections.','priority','normal',",
  "    'sourceIds',jsonb_build_array(),",
  "    'unansweredQuestion','Validate the synthetic investigation case relationship.',",
  "    'executionId',NULL,'lifecycleId','workflow-pg-completeness-case-lifecycle'));",
  'INSERT INTO public.branch_review_assignments(id,row_version,body) VALUES (',
  "  'workflow-pg-completeness-branch-review-historical-assigned',1,jsonb_build_object(",
  "    'id','workflow-pg-completeness-branch-review-historical-assigned','rowVersion',1,",
  "    'branchId','workflow-pg-ordered-cas-branch','caseId','workflow-pg-case',",
  "    'ownerIdentityId','workflow-pg-sender','status','assigned',",
  "    'reason','Preserve the synthetic historical assigned review.','executionId',NULL,",
  "    'createdAt','2026-10-03T00:54:30.000Z'));",
  'SET CONSTRAINTS ALL IMMEDIATE;',
  'COMMIT;'
].join('\n');

const CONVERSATION_LEGACY_FIXTURE_SQL = [
  '\\set ON_ERROR_STOP 1',
  'BEGIN;',
  "INSERT INTO public.profiles(id,payload) VALUES ('workflow-pg-conversation-actor',jsonb_build_object(",
  "  'id','workflow-pg-conversation-actor','name','Synthetic conversation actor','role','hr_admin',",
  "  'active',true,'permissions',jsonb_build_array(),'regions',jsonb_build_array()));",
  "INSERT INTO public.conversations(id,row_version,payload) VALUES (",
  "  'workflow-pg-conversation-legacy-root',1,jsonb_build_object(",
  "    'id','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',",
  "    'rowVersion',1,'title','Legacy root conversation','pinned',false,",
  "    'updatedAt','2026-10-04T02:00:00.000Z','lastScope',jsonb_build_object('region','east','date','2026-10-04')));",
  'INSERT INTO public.conversation_messages(id,row_version,payload) VALUES',
  "  ('workflow-pg-conversation-legacy-user',1,jsonb_build_object(",
  "    'id','workflow-pg-conversation-legacy-user','rowVersion',1,",
  "    'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',",
  "    'role','user','text','Historical user message with explicit turn and session identity.',",
  "    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:01:00.000Z',",
  "    'turnId','workflow-pg-conversation-legacy-turn','sessionId','workflow-pg-conversation-legacy-session')),",
  "  ('workflow-pg-conversation-legacy-assistant',1,jsonb_build_object(",
  "    'id','workflow-pg-conversation-legacy-assistant','rowVersion',1,",
  "    'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',",
  "    'role','assistant','text','Historical assistant message without recoverable identity.',",
  "    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:01:01.000Z'));",
  'COMMIT;'
].join('\n');

const SNAPSHOT_PROOF_LEGACY_FIXTURE_SQL = [
  '\\set ON_ERROR_STOP 1',
  'BEGIN;',
  'SET CONSTRAINTS ALL DEFERRED;',
  'DO $fixture$',
  'DECLARE branch_version bigint; target_body jsonb;',
  'BEGIN',
  "  SELECT row_version INTO STRICT branch_version FROM public.branches WHERE id='workflow-pg-ordered-cas-branch';",
  "  target_body:=jsonb_build_object('id','workflow-pg-snapshot-proof-legacy-branch','rowVersion',1,",
  "    'snapshotId','workflow-pg-logical-policy-snapshot','entityType','branches',",
  "    'targetId','workflow-pg-ordered-cas-branch','expectedRowVersion',branch_version,'expectedState',NULL,",
  "    'ref',jsonb_build_object('table','branches','id','workflow-pg-ordered-cas-branch'));",
  '  INSERT INTO public.review_snapshot_targets(id,row_version,body)',
  "  VALUES ('workflow-pg-snapshot-proof-legacy-branch',1,target_body);",
  'END $fixture$;',
  'SET CONSTRAINTS ALL IMMEDIATE;',
  'COMMIT;'
].join('\n');

const ACTION_TARGET_PROVENANCE_LEGACY_FIXTURE_SQL = [
  '\\set ON_ERROR_STOP 1',
  'BEGIN;',
  'SET CONSTRAINTS ALL DEFERRED;',
  'DO $fixture$',
  'DECLARE base_share jsonb; forged_share jsonb; target_body jsonb; branch_version bigint;',
  'BEGIN',
  "  SELECT payload INTO STRICT base_share FROM public.dashboard_shares WHERE id='workflow-pg-share';",
  "  base_share:=base_share||jsonb_build_object('id','workflow-pg-provenance-legacy-revoked-share',",
  "    'rowVersion',1,'semanticKey','workflow-pg-provenance-legacy-revoked-share-semantic');",
  '  INSERT INTO public.dashboard_shares(id,row_version,workflow_contract_version,payload)',
  "  VALUES ('workflow-pg-provenance-legacy-revoked-share',1,2,base_share);",
  "  UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(",
  "    'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:32:00.000Z')",
  "  WHERE id='workflow-pg-provenance-legacy-revoked-share';",
  "  SELECT payload INTO STRICT forged_share FROM public.dashboard_shares WHERE id='workflow-pg-share';",
  "  forged_share:=forged_share||jsonb_build_object('id','workflow-pg-provenance-forged-share',",
  "    'rowVersion',1,'semanticKey','workflow-pg-provenance-forged-share-semantic',",
  "    'executionId','workflow-pg-snapshot-proof-execution','createdAt','2026-10-04T02:30:01.000Z');",
  '  INSERT INTO public.dashboard_shares(id,row_version,workflow_contract_version,payload)',
  "  VALUES ('workflow-pg-provenance-forged-share',1,2,forged_share);",
  "  SELECT row_version INTO STRICT branch_version FROM public.branches WHERE id='workflow-pg-ordered-cas-branch';",
  "  target_body:=jsonb_build_object('id','workflow-pg-provenance-legacy-branch-target','rowVersion',1,",
  "    'executionId','workflow-pg-snapshot-proof-execution','targetId','workflow-pg-ordered-cas-branch',",
  "    'entityType','branches','expectedRowVersion',branch_version,'expectedState',NULL,",
  "    'targetStatus','pending','ref',jsonb_build_object('table','branches','id','workflow-pg-ordered-cas-branch'));",
  '  INSERT INTO public.action_targets(id,row_version,body)',
  "  VALUES ('workflow-pg-provenance-legacy-branch-target',1,target_body);",
  'END $fixture$;',
  'SET CONSTRAINTS ALL IMMEDIATE;',
  'COMMIT;'
].join('\n');

interface Options {
  psql: string;
  host: string;
  port: number;
  user: string;
  passfile: string;
  expectedDataDirectory: string;
  expectedV2Sha256: string;
  expectedPendingActionV1StandaloneSha256: string | undefined;
  expectedCompletenessSha256: string | undefined;
  expectedConversationSha256: string | undefined;
  expectedSnapshotProofSha256: string | undefined;
  expectedActionTargetProvenanceSha256: string | undefined;
  deadlineMs: number;
  queryTimeoutMs: number;
  probeOnly: boolean;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  logPath: string;
}

function usage(): string {
  return [
    'Usage: node_modules/.bin/tsx scripts/check-workflow-postgres.ts',
    '  --psql <explicit executable path>',
    '  --host <loopback only> --port <port> --user <database superuser>',
    '  --passfile <private PGPASSFILE path>',
    '  --expected-data-directory <private cluster data directory>',
    '  Standalone SQL SHA-256 normalizes CRLF to LF; existing V2 hashes retain raw-byte verification.',
    '  [--expected-v2-sha256 <frozen workflow migration raw SHA-256; required unless standalone V1 is selected>]',
    '  [--expected-pending-action-v1-standalone-sha256 <pinned standalone 010002 V1 guard; excludes the V2 chain>]',
    '  [--expected-completeness-sha256 <frozen additive migration SHA-256>]',
    '  [--expected-conversation-sha256 <pinned forward migration SHA-256; requires completeness opt-in>]',
    '  [--expected-snapshot-proof-sha256 <pinned forward migration SHA-256; requires conversation opt-in>]',
    '  [--expected-action-target-provenance-sha256 <pinned forward migration SHA-256; requires snapshot proof opt-in>]',
    `  [--deadline-ms <1000..600000; default ${DEFAULT_DEADLINE_MS}>]`,
    `  [--query-timeout-ms <1000..120000; default ${DEFAULT_QUERY_TIMEOUT_MS}>]`,
    '  [--probe-only] (apply migrations once, snapshot catalog and empty table counts, then clean up)'
  ].join('\n');
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  let probeOnly = false;
  const valueFlags = new Set([
    '--psql', '--host', '--port', '--user', '--passfile', '--expected-data-directory',
    '--expected-v2-sha256', '--expected-pending-action-v1-standalone-sha256',
    '--expected-completeness-sha256', '--expected-conversation-sha256',
    '--expected-snapshot-proof-sha256', '--expected-action-target-provenance-sha256',
    '--deadline-ms', '--query-timeout-ms'
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (flag === '--probe-only') {
      if (probeOnly) throw new Error('Duplicate argument: --probe-only');
      probeOnly = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}\n${usage()}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag, value);
    index += 1;
  }

  const required = [
    '--psql', '--host', '--port', '--user', '--passfile', '--expected-data-directory'
  ];
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new Error(`Required arguments missing: ${missing.join(', ')}\n${usage()}`);
  const expectedPendingActionV1StandaloneSha256 = values.get('--expected-pending-action-v1-standalone-sha256')?.toLowerCase();
  if (expectedPendingActionV1StandaloneSha256 && !/^[a-f0-9]{64}$/.test(expectedPendingActionV1StandaloneSha256)) {
    throw new Error('--expected-pending-action-v1-standalone-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  if (expectedPendingActionV1StandaloneSha256
    && expectedPendingActionV1StandaloneSha256.toUpperCase() !== PENDING_ACTION_V1_STANDALONE_MIGRATION_SHA256) {
    throw new Error('--expected-pending-action-v1-standalone-sha256 must equal the pinned standalone V1 migration SHA-256.');
  }
  if (expectedPendingActionV1StandaloneSha256 && values.has('--expected-v2-sha256')) {
    throw new Error('--expected-pending-action-v1-standalone-sha256 cannot be combined with --expected-v2-sha256.');
  }
  if (!expectedPendingActionV1StandaloneSha256 && !values.has('--expected-v2-sha256')) {
    throw new Error('--expected-v2-sha256 is required unless --expected-pending-action-v1-standalone-sha256 is selected.');
  }
  if (expectedPendingActionV1StandaloneSha256 && [
    '--expected-completeness-sha256', '--expected-conversation-sha256', '--expected-snapshot-proof-sha256',
    '--expected-action-target-provenance-sha256', '--expected-pending-action-v1-guard-sha256'
  ].some((flag) => values.has(flag))) {
    throw new Error('The standalone pending-action V1 path cannot be combined with any V2 migration opt-in.');
  }
  if (probeOnly && expectedPendingActionV1StandaloneSha256) {
    throw new Error('--expected-pending-action-v1-standalone-sha256 cannot be combined with --probe-only.');
  }

  const host = values.get('--host')!;
  const ipv = isIP(host);
  const isLoopback = host.toLowerCase() === 'localhost'
    || (ipv === 4 && host.split('.')[0] === '127')
    || (ipv === 6 && host.toLowerCase() === '::1');
  if (!isLoopback) throw new Error('Refusing PostgreSQL host outside IPv4/IPv6 loopback.');

  const port = parseInteger(values.get('--port')!, '--port', 1, 65_535);
  const deadlineMs = parseInteger(values.get('--deadline-ms') ?? String(DEFAULT_DEADLINE_MS), '--deadline-ms', 1_000, 600_000);
  const queryTimeoutMs = parseInteger(values.get('--query-timeout-ms') ?? String(DEFAULT_QUERY_TIMEOUT_MS), '--query-timeout-ms', 1_000, 120_000);
  const expectedV2Sha256 = values.get('--expected-v2-sha256')?.toLowerCase() ?? '';
  if (expectedV2Sha256 && !/^[a-f0-9]{64}$/.test(expectedV2Sha256)) {
    throw new Error('--expected-v2-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  const expectedCompletenessSha256 = values.get('--expected-completeness-sha256')?.toLowerCase();
  if (expectedCompletenessSha256 && !/^[a-f0-9]{64}$/.test(expectedCompletenessSha256)) {
    throw new Error('--expected-completeness-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  const expectedConversationSha256 = values.get('--expected-conversation-sha256')?.toLowerCase();
  if (expectedConversationSha256 && !/^[a-f0-9]{64}$/.test(expectedConversationSha256)) {
    throw new Error('--expected-conversation-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  if (expectedConversationSha256 && !expectedCompletenessSha256) {
    throw new Error('--expected-conversation-sha256 requires --expected-completeness-sha256 so the frozen predecessor checks run first.');
  }
  if (expectedConversationSha256 && expectedConversationSha256.toUpperCase() !== CONVERSATION_MIGRATION_SHA256) {
    throw new Error('--expected-conversation-sha256 must equal the pinned conversation migration SHA-256.');
  }
  const expectedSnapshotProofSha256 = values.get('--expected-snapshot-proof-sha256')?.toLowerCase();
  if (expectedSnapshotProofSha256 && !/^[a-f0-9]{64}$/.test(expectedSnapshotProofSha256)) {
    throw new Error('--expected-snapshot-proof-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  if (expectedSnapshotProofSha256 && !expectedConversationSha256) {
    throw new Error('--expected-snapshot-proof-sha256 requires --expected-conversation-sha256 so all frozen predecessor checks run first.');
  }
  if (expectedSnapshotProofSha256 && expectedSnapshotProofSha256.toUpperCase() !== SNAPSHOT_PROOF_MIGRATION_SHA256) {
    throw new Error('--expected-snapshot-proof-sha256 must equal the pinned snapshot proof migration SHA-256.');
  }
  const expectedActionTargetProvenanceSha256 = values.get('--expected-action-target-provenance-sha256')?.toLowerCase();
  if (expectedActionTargetProvenanceSha256 && !/^[a-f0-9]{64}$/.test(expectedActionTargetProvenanceSha256)) {
    throw new Error('--expected-action-target-provenance-sha256 must be a 64-character hexadecimal SHA-256.');
  }
  if (expectedActionTargetProvenanceSha256 && !expectedSnapshotProofSha256) {
    throw new Error('--expected-action-target-provenance-sha256 requires --expected-snapshot-proof-sha256 so every frozen predecessor runs first.');
  }
  if (expectedActionTargetProvenanceSha256 && !ACTION_TARGET_PROVENANCE_MIGRATION_SHA256) {
    throw new Error('--expected-action-target-provenance-sha256 cannot run until the 040003 migration SHA-256 is frozen and pinned.');
  }
  if (expectedActionTargetProvenanceSha256
    && expectedActionTargetProvenanceSha256.toUpperCase() !== ACTION_TARGET_PROVENANCE_MIGRATION_SHA256) {
    throw new Error('--expected-action-target-provenance-sha256 must equal the pinned action target provenance migration SHA-256.');
  }
  if (probeOnly && expectedCompletenessSha256) {
    throw new Error('--expected-completeness-sha256 cannot be combined with --probe-only because the opt-in path requires its conformance cases.');
  }
  if (probeOnly && expectedConversationSha256) {
    throw new Error('--expected-conversation-sha256 cannot be combined with --probe-only.');
  }
  if (probeOnly && expectedSnapshotProofSha256) {
    throw new Error('--expected-snapshot-proof-sha256 cannot be combined with --probe-only.');
  }
  if (probeOnly && expectedActionTargetProvenanceSha256) {
    throw new Error('--expected-action-target-provenance-sha256 cannot be combined with --probe-only.');
  }

  const executableInput = values.get('--psql')!;
  const psql = isAbsolute(executableInput)
    ? executableInput
    : executableInput.includes('/') || executableInput.includes('\\')
      ? resolve(process.cwd(), executableInput)
      : executableInput;

  return {
    psql,
    host,
    port,
    user: values.get('--user')!,
    passfile: resolve(process.cwd(), values.get('--passfile')!),
    expectedDataDirectory: resolve(process.cwd(), values.get('--expected-data-directory')!),
    expectedV2Sha256,
    expectedPendingActionV1StandaloneSha256,
    expectedCompletenessSha256,
    expectedConversationSha256,
    expectedSnapshotProofSha256,
    expectedActionTargetProvenanceSha256,
    deadlineMs,
    queryTimeoutMs,
    probeOnly
  };
}

function parseInteger(value: string, flag: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${flag} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

const sha256Raw = sha256;
function sha256SqlSource(value: Buffer): string {
  return sha256(Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function normaliseWindowsPath(value: string): string {
  return win32.normalize(value.trim().replaceAll('/', '\\')).replace(/[\\/]+$/, '').toLowerCase();
}

function derivePrimaryRepositoryRoot(): string {
  const commonDirectory = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (!commonDirectory) throw new Error('Could not derive the primary repository Git directory.');
  const resolvedCommonDirectory = resolve(REPOSITORY_ROOT, commonDirectory);
  if (basename(resolvedCommonDirectory).toLowerCase() !== '.git') {
    throw new Error('The primary repository Git common directory did not resolve to its .git directory.');
  }
  return dirname(resolvedCommonDirectory);
}

function readPostgresSystemIdentifier(psqlPath: string, dataDirectory: string): string {
  const controlExecutable = join(dirname(psqlPath), process.platform === 'win32' ? 'pg_controldata.exe' : 'pg_controldata');
  let output: string;
  try {
    output = execFileSync(controlExecutable, [dataDirectory], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    throw new Error('Could not read the local PostgreSQL control-file identity with the matching pg_controldata executable.');
  }
  const systemIdentifier = /^Database system identifier:\s*([0-9]+)\s*$/m.exec(output)?.[1];
  if (!systemIdentifier) throw new Error('The local PostgreSQL control-file identity was missing or malformed.');
  return systemIdentifier;
}

// Preserve only the Windows runtime, user-profile, path, and locale variables psql needs.
const PSQL_CHILD_ENVIRONMENT_KEYS = [
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
] as const;

export function safeChildEnvironment(
  passfile: string,
  statementTimeoutMs: number,
  connectTimeoutSeconds: number,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: sourceEnvironment.NODE_ENV ?? 'production' };
  for (const key of PSQL_CHILD_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (value !== undefined) env[key] = value;
  }
  env.PGPASSFILE = passfile;
  env.PGOPTIONS = [
    `-c statement_timeout=${statementTimeoutMs}`,
    `-c lock_timeout=${Math.min(5_000, statementTimeoutMs)}`,
    `-c idle_in_transaction_session_timeout=${statementTimeoutMs}`
  ].join(' ');
  env.PGCONNECT_TIMEOUT = String(connectTimeoutSeconds);
  return env;
}

async function runPsql(
  options: Options,
  runDirectory: string,
  phase: string,
  database: string,
  args: string[],
  deadlineAt: number,
  timeoutOverrideMs?: number,
  allowFailure = false
): Promise<ProcessResult> {
  const remainingMs = timeoutOverrideMs ?? Math.floor(deadlineAt - Date.now());
  if (remainingMs < 1_000) throw new Error(`Runner deadline elapsed before ${phase}.`);
  const statementTimeoutMs = Math.max(1_000, Math.min(options.queryTimeoutMs, remainingMs - 250));
  const logPath = join(runDirectory, `${phase.replace(/[^A-Za-z0-9_-]/g, '_')}.log`);
  const commandArgs = [
    '-X', '--no-password',
    '--host', options.host,
    '--port', String(options.port),
    '--username', options.user,
    '--dbname', database,
    '--set=ON_ERROR_STOP=1',
    ...args
  ];

  const result = await new Promise<Omit<ProcessResult, 'logPath'>>((resolveResult) => {
    const child = spawn(options.psql, commandArgs, {
      cwd: REPOSITORY_ROOT,
      env: safeChildEnvironment(
        options.passfile,
        statementTimeoutMs,
        Math.max(1, Math.min(30, Math.floor(remainingMs / 1_000)))
      ),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let finished = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, remainingMs);

    const settle = (value: Omit<ProcessResult, 'logPath'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveResult(value);
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      stderr.push(Buffer.from(`\nspawn error: ${error.message}\n`));
      settle({ code: null, signal: null, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.once('close', (code, signal) => {
      settle({ code, signal, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });

  const log = [
    `phase=${phase}`,
    `host=${options.host}`,
    `port=${options.port}`,
    `database=${database}`,
    `exitCode=${String(result.code)}`,
    `signal=${String(result.signal)}`,
    `timedOut=${result.timedOut}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr
  ].join('\n');
  await writeFile(logPath, log, { encoding: 'utf8', flag: 'wx' });

  if (!allowFailure && (result.code !== 0 || result.timedOut)) {
    throw new Error(`${phase} failed (exit ${String(result.code)}, timeout ${result.timedOut}). Log: ${logPath}`);
  }
  return { ...result, logPath };
}

async function runPsqlWithGeneratedSql(
  options: Options,
  runDirectory: string,
  phase: string,
  databaseName: string,
  argsBeforeSql: string[],
  sql: string,
  deadlineAt: number,
  timeoutOverrideMs?: number
): Promise<ProcessResult> {
  if (sql.length <= MAX_INLINE_SQL_COMMAND_CHARS) {
    return runPsql(
      options, runDirectory, phase, databaseName,
      [...argsBeforeSql, '--command', sql],
      deadlineAt,
      timeoutOverrideMs
    );
  }
  const fileName = phase.replace(/[^A-Za-z0-9_-]/g, '_') + '.sql';
  const sqlPath = join(runDirectory, fileName);
  await writeFile(sqlPath, sql, { encoding: 'utf8', flag: 'wx' });
  return runPsql(
    options, runDirectory, phase, databaseName,
    [...argsBeforeSql, '--file', sqlPath],
    deadlineAt,
    timeoutOverrideMs
  );
}

interface CaptureMigrationStateOptions {
  includeCompletenessChild?: boolean;
  preserveTableColumnsFrom?: MigrationState;
  expectedManifestTableCount?: number;
}

async function captureMigrationState(
  options: Options,
  runDirectory: string,
  label: string,
  databaseName: string,
  deadlineAt: number,
  captureOptions: CaptureMigrationStateOptions = {}
): Promise<MigrationState> {
  const stateResult = await runPsql(
    options, runDirectory, `${label}-catalog-state`, databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', MIGRATION_STATE_SQL],
    deadlineAt
  );
  const stateFields = stateResult.stdout.trim().split('\t');
  const revisionText = stateFields[0] ?? '';
  if (!/^[0-9]+$/.test(revisionText) || stateFields.length !== 7) {
    throw new Error(`Could not parse the ${label} migration-state snapshot. See ${stateResult.logPath}`);
  }
  const revision = BigInt(revisionText);
  const adapterWrite = stateFields[1] ?? '';
  const catalogFingerprint = stateFields.slice(2).join('\t');
  if (adapterWrite !== '0') throw new Error(`workflow_adapter_write was not reset after ${label}.`);

  const tableList = await runPsql(
    options, runDirectory, `${label}-manifest-table-list`, databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', 'SELECT table_name FROM nexus_private.workflow_manifest ORDER BY table_name;'],
    deadlineAt
  );
  const tableNames = tableList.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const expectedManifestTableCount = captureOptions.expectedManifestTableCount ?? 62;
  if (tableNames.length !== expectedManifestTableCount || tableNames.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error('Expected ' + expectedManifestTableCount + ' safe manifest table names in ' + label
      + '; observed ' + tableNames.length + '. See ' + tableList.logPath);
  }
  const publicTables = await runPsql(
    options, runDirectory, label + '-public-table-list', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      'SELECT c.relname',
      'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace',
      "WHERE n.nspname='public' AND c.relkind IN ('r','p')",
      'ORDER BY c.relname;'
    ].join(' ')],
    deadlineAt
  );
  const publicTableNames = new Set(publicTables.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean));
  if ([...publicTableNames].some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error('The ' + label + ' public-table snapshot contains an unsafe identifier. See ' + publicTables.logPath);
  }
  const columnTableList = tableNames.map((name) => "'" + name + "'").join(',');
  const columnState = await runPsqlWithGeneratedSql(
    options, runDirectory, label + '-manifest-columns', databaseName,
    ['--tuples-only', '--no-align', '--quiet'], [
      'SELECT table_name || chr(9) || column_name',
      'FROM information_schema.columns',
      "WHERE table_schema='public' AND table_name IN (" + columnTableList + ')',
      'ORDER BY table_name,ordinal_position;'
    ].join(' '),
    deadlineAt
  );
  const tableColumns = new Map<string, string[]>();
  for (const line of columnState.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const [tableName, columnName] = line.split('\t');
    if (!tableName || !columnName || !/^[a-z][a-z0-9_]*$/.test(tableName) || !/^[a-z][a-z0-9_]*$/.test(columnName)) {
      throw new Error('Could not parse a ' + label + ' manifest column. See ' + columnState.logPath);
    }
    const columns = tableColumns.get(tableName) ?? [];
    columns.push(columnName);
    tableColumns.set(tableName, columns);
  }
  if (tableColumns.size !== tableNames.length || tableNames.some((name) => !tableColumns.has(name))) {
    throw new Error('The ' + label + ' column snapshot did not cover all manifest tables. See ' + columnState.logPath);
  }
  if (tableNames.length !== expectedManifestTableCount || tableNames.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error(`Expected ${expectedManifestTableCount} safe manifest table names in the ${label} snapshot; observed ${tableNames.length}. See ${tableList.logPath}`);
  }
  const countSql = tableNames.map((name) => {
    const priorColumns = captureOptions.preserveTableColumnsFrom?.tableColumns.get(name);
    const currentColumns = tableColumns.get(name) ?? [];
    if (priorColumns && priorColumns.some((columnName) => !currentColumns.includes(columnName))) {
      throw new Error('The ' + label + ' snapshot lost a pre-migration column from ' + name + '.');
    }
    const rowContent = priorColumns
      ? 'jsonb_build_object(' + priorColumns.map((columnName) => "'" + columnName + "',t.\"" + columnName + '\"').join(',') + ')::text'
      : name === 'appmeta' ? "(to_jsonb(t) - 'revision')::text" : 'to_jsonb(t)::text';
    return `SELECT '${name}' || chr(9) || count(*)::text || chr(9) || md5(coalesce(string_agg(${rowContent}, E'\\n' ORDER BY ${rowContent}),'')) FROM public."${name}" t`;
  }).join(' UNION ALL ') + ' ORDER BY 1;';
  const countResult = await runPsqlWithGeneratedSql(
    options, runDirectory, label + '-manifest-row-counts', databaseName,
    ['--tuples-only', '--no-align', '--quiet'], countSql, deadlineAt
  );
  const countLines = countResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tableCounts = new Map<string, bigint>();
  const tableRowFingerprints = new Map<string, string>();
  for (const line of countLines) {
    const [tableName, countText, rowFingerprint] = line.split('\t');
    if (!tableName || !/^[0-9]+$/.test(countText ?? '') || !/^[a-f0-9]{32}$/.test(rowFingerprint ?? '')) {
      throw new Error(`Could not parse a ${label} manifest row count. See ${countResult.logPath}`);
    }
    tableCounts.set(tableName, BigInt(countText));
    tableRowFingerprints.set(tableName, rowFingerprint);
  }
  if (tableCounts.size !== tableNames.length || tableRowFingerprints.size !== tableNames.length
    || tableNames.some((name) => !tableCounts.has(name) || !tableRowFingerprints.has(name))) {
    throw new Error(`The ${label} row snapshot did not cover all manifest tables. See ${countResult.logPath}`);
  }

  const appmetaRows = await runPsql(
    options, runDirectory, `${label}-appmeta-row-state`, databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg((to_jsonb(t) - 'revision')::text, E'\\n' ORDER BY (to_jsonb(t) - 'revision')::text),''))",
      'FROM public.appmeta t'
    ].join(' ')],
    deadlineAt
  );
  const [appmetaCountText, appmetaContentFingerprint] = appmetaRows.stdout.trim().split('\t');
  if (!/^[0-9]+$/.test(appmetaCountText ?? '') || !/^[a-f0-9]{32}$/.test(appmetaContentFingerprint ?? '')) {
    throw new Error(`Could not parse the ${label} appmeta row snapshot. See ${appmetaRows.logPath}`);
  }
  const workflowLedgerPresence = await runPsql(
    options, runDirectory, `${label}-workflow-ledger-state`, databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command',
      "SELECT CASE WHEN to_regclass('nexus_private.workflow_projection_migrations') IS NULL THEN 'absent' ELSE 'present' END;"],
    deadlineAt
  );
  let workflowLedgerSnapshot: WorkflowLedgerSnapshot | null = null;
  if (workflowLedgerPresence.stdout.trim() === 'present') {
    const workflowLedger = await runPsql(
      options, runDirectory, `${label}-workflow-ledger-rows`, databaseName,
      ['--tuples-only', '--no-align', '--quiet', '--command', [
        "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg(id || ':' || definition_digest,E'\\n' ORDER BY id),'')) || chr(9) ||",
        `count(*) FILTER (WHERE id<>'${CONVERSATION_MIGRATION_ID}')::text || chr(9) ||`,
        `md5(coalesce(string_agg(id || ':' || definition_digest,E'\\n' ORDER BY id) FILTER (WHERE id<>'${CONVERSATION_MIGRATION_ID}'),'')) || chr(9) ||`,
        `count(*) FILTER (WHERE id<>'${SNAPSHOT_PROOF_MIGRATION_ID}')::text || chr(9) ||`,
        `md5(coalesce(string_agg(id || ':' || definition_digest,E'\\n' ORDER BY id) FILTER (WHERE id<>'${SNAPSHOT_PROOF_MIGRATION_ID}'),'')) || chr(9) ||`,
        `count(*) FILTER (WHERE id<>'${ACTION_TARGET_PROVENANCE_MIGRATION_ID}')::text || chr(9) ||`,
        `md5(coalesce(string_agg(id || ':' || definition_digest,E'\\n' ORDER BY id) FILTER (WHERE id<>'${ACTION_TARGET_PROVENANCE_MIGRATION_ID}'),''))`,
        'FROM nexus_private.workflow_projection_migrations'
      ].join(' ')],
      deadlineAt
    );
    const [workflowLedgerCountText, workflowLedgerFingerprint, workflowLedgerHistoryCountText, workflowLedgerHistoryFingerprint,
      workflowLedgerSnapshotProofHistoryCountText, workflowLedgerSnapshotProofHistoryFingerprint,
      workflowLedgerActionTargetProvenanceHistoryCountText, workflowLedgerActionTargetProvenanceHistoryFingerprint]
      = workflowLedger.stdout.trim().split('\t');
    if (!/^[0-9]+$/.test(workflowLedgerCountText ?? '') || !/^[a-f0-9]{32}$/.test(workflowLedgerFingerprint ?? '')
      || !/^[0-9]+$/.test(workflowLedgerHistoryCountText ?? '') || !/^[a-f0-9]{32}$/.test(workflowLedgerHistoryFingerprint ?? '')
      || !/^[0-9]+$/.test(workflowLedgerSnapshotProofHistoryCountText ?? '')
      || !/^[a-f0-9]{32}$/.test(workflowLedgerSnapshotProofHistoryFingerprint ?? '')
      || !/^[0-9]+$/.test(workflowLedgerActionTargetProvenanceHistoryCountText ?? '')
      || !/^[a-f0-9]{32}$/.test(workflowLedgerActionTargetProvenanceHistoryFingerprint ?? '')) {
      throw new Error(`Could not parse the ${label} workflow migration ledger snapshot. See ${workflowLedger.logPath}`);
    }
    workflowLedgerSnapshot = {
      count: BigInt(workflowLedgerCountText),
      fingerprint: workflowLedgerFingerprint,
      historyCount: BigInt(workflowLedgerHistoryCountText),
      historyFingerprint: workflowLedgerHistoryFingerprint,
      snapshotProofHistoryCount: BigInt(workflowLedgerSnapshotProofHistoryCountText),
      snapshotProofHistoryFingerprint: workflowLedgerSnapshotProofHistoryFingerprint,
      actionTargetProvenanceHistoryCount: BigInt(workflowLedgerActionTargetProvenanceHistoryCountText),
      actionTargetProvenanceHistoryFingerprint: workflowLedgerActionTargetProvenanceHistoryFingerprint
    };
  } else if (workflowLedgerPresence.stdout.trim() !== 'absent') {
    throw new Error(`Could not determine whether the ${label} workflow migration ledger exists. See ${workflowLedgerPresence.logPath}`);
  }
  const responsibilitiesIndex = await runPsql(
    options, runDirectory, `${label}-responsibilities-active-unique-index`, databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT indexname || chr(9) || indexdef",
      'FROM pg_catalog.pg_indexes',
      `WHERE schemaname='public' AND tablename='responsibilities' AND indexname='${RESPONSIBILITIES_ACTIVE_UNIQUE_INDEX}';`
    ].join(' ')],
    deadlineAt
  );
  const [responsibilitiesIndexName, ...responsibilitiesIndexDefinitionParts] = responsibilitiesIndex.stdout.trim().split('\t');
  const responsibilitiesIndexDefinition = responsibilitiesIndexDefinitionParts.join('\t');
  if (responsibilitiesIndexName !== RESPONSIBILITIES_ACTIVE_UNIQUE_INDEX
    || !/CREATE UNIQUE INDEX/i.test(responsibilitiesIndexDefinition)
    || !/\(\s*identity_id\s*,\s*purpose\s*,\s*org_unit_id\s*\)/i.test(responsibilitiesIndexDefinition)
    || !/WHERE[\s\S]*active/i.test(responsibilitiesIndexDefinition)) {
    throw new Error(`The ${label} responsibilities unique index did not encode the identity/purpose/org-unit triplet and active predicate. See ${responsibilitiesIndex.logPath}`);
  }
  let completenessChildCount: bigint | null = null;
  let completenessChildFingerprint: string | null = null;
  let completenessLedgerCount: bigint | null = null;
  let completenessLedgerFingerprint: string | null = null;
  if (captureOptions.includeCompletenessChild) {
    const childState = await runPsql(
      options, runDirectory, label + '-completeness-child-state', databaseName,
      ['--tuples-only', '--no-align', '--quiet', '--command', [
        "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text),''))",
        'FROM public."' + COMPLETENESS_CHILD_TABLE + '" t'
      ].join(' ')],
      deadlineAt
    );
    const [childCountText, childFingerprint] = childState.stdout.trim().split('\t');
    if (!/^[0-9]+$/.test(childCountText ?? '') || !/^[a-f0-9]{32}$/.test(childFingerprint ?? '')) {
      throw new Error('Could not parse the ' + label + ' completeness child snapshot. See ' + childState.logPath);
    }
    completenessChildCount = BigInt(childCountText);
    completenessChildFingerprint = childFingerprint;
    const ledgerState = await runPsql(
      options, runDirectory, label + '-completeness-ledger-state', databaseName,
      ['--tuples-only', '--no-align', '--quiet', '--command', [
        "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg(id || ':' || definition_digest, E'\\n' ORDER BY id),''))",
        "FROM nexus_private.workflow_projection_migrations WHERE id='202610030002_workflow_projection_completeness';"
      ].join(' ')],
      deadlineAt
    );
    const [ledgerCountText, ledgerFingerprint] = ledgerState.stdout.trim().split('\t');
    if (!/^[0-9]+$/.test(ledgerCountText ?? '') || !/^[a-f0-9]{32}$/.test(ledgerFingerprint ?? '')) {
      throw new Error('Could not parse the ' + label + ' completeness ledger snapshot. See ' + ledgerState.logPath);
    }
    completenessLedgerCount = BigInt(ledgerCountText);
    completenessLedgerFingerprint = ledgerFingerprint;
  }

  return {
    revision,
    adapterWrite,
    catalogFingerprint,
    tableCounts,
    tableRowFingerprints,
    tableColumns,
    publicTableNames,
    completenessChildCount,
    completenessChildFingerprint,
    completenessLedgerCount,
    completenessLedgerFingerprint,
    appmetaCount: BigInt(appmetaCountText),
    appmetaContentFingerprint,
    workflowLedger: workflowLedgerSnapshot,
    responsibilitiesIndexMetadata: `${responsibilitiesIndexName}\t${responsibilitiesIndexDefinition}`
  };
}

async function captureStandalonePendingActionV1State(
  options: Options,
  runDirectory: string,
  label: string,
  databaseName: string,
  deadlineAt: number
): Promise<StandalonePendingActionV1State> {
  const catalogResult = await runPsql(
    options, runDirectory, label + '-catalog-state', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', STANDALONE_V1_CATALOG_STATE_SQL], deadlineAt
  );
  const catalogHashes = catalogResult.stdout.trim().split('\t');
  if (catalogHashes.length !== 8 || catalogHashes.some((hash) => !/^[a-f0-9]{32}$/.test(hash))) {
    throw new Error('Could not parse the ' + label + ' standalone catalog fingerprint. See ' + catalogResult.logPath);
  }
  const catalogFingerprint = catalogHashes.join('\t');

  const rowsResult = await runPsql(
    options, runDirectory, label + '-pending-action-rows', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg(to_jsonb(p)::text,E'\\n' ORDER BY p.id COLLATE \"C\"),'')) || chr(9) ||",
      "md5(coalesce(string_agg(p.id || ':' || p.payload::text,E'\\n' ORDER BY p.id COLLATE \"C\"),'')) || chr(9) ||",
      "count(*) FILTER (WHERE p.payload->>'status'='completed')::text || chr(9) ||",
      "count(*) FILTER (WHERE p.payload->>'status'='pending')::text || chr(9) ||",
      "count(*) FILTER (WHERE p.payload->>'actionContractVersion'='1')::text",
      'FROM public.pending_actions p'
    ].join(' ')],
    deadlineAt
  );
  const [pendingCountText, pendingFullRowFingerprint, pendingBodyFingerprint, completedCountText,
    pendingStatusCountText, actionContractVersionOneCountText] = rowsResult.stdout.trim().split('\t');
  if (!/^[0-9]+$/.test(pendingCountText ?? '') || !/^[a-f0-9]{32}$/.test(pendingFullRowFingerprint ?? '')
    || !/^[a-f0-9]{32}$/.test(pendingBodyFingerprint ?? '') || !/^[0-9]+$/.test(completedCountText ?? '')
    || !/^[0-9]+$/.test(pendingStatusCountText ?? '') || !/^[0-9]+$/.test(actionContractVersionOneCountText ?? '')) {
    throw new Error('Could not parse the ' + label + ' standalone pending-action rows. See ' + rowsResult.logPath);
  }

  const seedExpectedIds = PENDING_ACTION_V1_STANDALONE_HISTORICAL_ACTIONS
    .map((action) => "('" + action.id + "')").join(',');
  const historicalSeedResult = await runPsql(
    options, runDirectory, label + '-historical-seed-row-images', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      'WITH expected(id) AS (VALUES ' + seedExpectedIds + ')',
      'SELECT count(action_row.id)::text || chr(9) ||',
      "md5(coalesce(string_agg(action_row.id || ':' || action_row.payload::text,E'\\n' ORDER BY expected.id COLLATE \"C\"),'')) || chr(9) ||",
      "md5(coalesce(string_agg(to_jsonb(action_row)::text,E'\\n' ORDER BY expected.id COLLATE \"C\"),''))",
      'FROM expected LEFT JOIN public.pending_actions AS action_row ON action_row.id=expected.id;'
    ].join(' ')],
    deadlineAt
  );
  const [historicalSeedCountText, historicalSeedBodyFingerprint, historicalSeedRowImageFingerprint]
    = historicalSeedResult.stdout.trim().split('\t');
  if (!/^[0-9]+$/.test(historicalSeedCountText ?? '')
    || !/^[a-f0-9]{32}$/.test(historicalSeedBodyFingerprint ?? '')
    || !/^[a-f0-9]{32}$/.test(historicalSeedRowImageFingerprint ?? '')) {
    throw new Error('Could not parse the ' + label + ' historical seed row-image snapshot. See ' + historicalSeedResult.logPath);
  }

  const columnsResult = await runPsql(
    options, runDirectory, label + '-pending-action-columns', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      'SELECT column_name || chr(9) || data_type || chr(9) || is_nullable',
      'FROM information_schema.columns',
      "WHERE table_schema='public' AND table_name='pending_actions'",
      'ORDER BY ordinal_position;'
    ].join(' ')],
    deadlineAt
  );
  const pendingColumns = columnsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!pendingColumns.every((line) => /^[a-z][a-z0-9_]*\t[a-z][a-z0-9 ]*\t(NO|YES)$/.test(line))) {
    throw new Error('The ' + label + ' pending-action columns contain an unsafe or malformed value. See ' + columnsResult.logPath);
  }

  const publicTablesResult = await runPsql(
    options, runDirectory, label + '-public-table-list', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      'SELECT c.relname',
      'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace',
      "WHERE n.nspname='public' AND c.relkind IN ('r','p')",
      'ORDER BY c.relname;'
    ].join(' ')],
    deadlineAt
  );
  const publicTableNames = new Set(publicTablesResult.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean));
  if ([...publicTableNames].some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error('The ' + label + ' public table list contains an unsafe identifier. See ' + publicTablesResult.logPath);
  }

  const appmetaResult = await runPsql(
    options, runDirectory, label + '-appmeta-state', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT count(*)::text || chr(9) || coalesce(min(revision)::text,'') || chr(9) ||",
      "md5(coalesce(string_agg(to_jsonb(a)::text,E'\\n' ORDER BY singleton),''))",
      'FROM public.appmeta a'
    ].join(' ')],
    deadlineAt
  );
  const [appmetaCountText, appmetaRevisionText, appmetaFingerprint] = appmetaResult.stdout.trim().split('\t');
  if (!/^[0-9]+$/.test(appmetaCountText ?? '') || !/^[0-9]+$/.test(appmetaRevisionText ?? '')
    || !/^[a-f0-9]{32}$/.test(appmetaFingerprint ?? '')) {
    throw new Error('Could not parse the ' + label + ' appmeta state. See ' + appmetaResult.logPath);
  }

  const baseSurfaceResult = await runPsql(
    options, runDirectory, label + '-base-surface-state', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      'SELECT CASE WHEN',
      "EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='pending_actions' AND c.relrowsecurity)",
      "AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.pending_actions'::regclass AND t.tgname='nexus_revision' AND t.tgfoid='nexus_private.bump_revision()'::regprocedure AND t.tgenabled IN ('O','A') AND t.tgtype=60)",
      "AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='public.nexus_commit(bigint,jsonb)'::regprocedure AND p.prorettype='bigint'::regtype AND NOT p.prosecdef)",
      "THEN 'ready' ELSE 'invalid' END || chr(9) || CASE WHEN",
      "to_regclass('public.workflow_policies') IS NULL AND to_regclass('nexus_private.workflow_manifest') IS NULL AND to_regclass('nexus_private.workflow_projection_migrations') IS NULL",
      "THEN 'absent' ELSE 'present' END;"
    ].join(' ')],
    deadlineAt
  );
  const [baseV1SurfaceText, v2SurfaceText] = baseSurfaceResult.stdout.trim().split('\t');
  if (!['ready', 'invalid'].includes(baseV1SurfaceText ?? '') || !['absent', 'present'].includes(v2SurfaceText ?? '')) {
    throw new Error('Could not parse the ' + label + ' V1/V2 surface state. See ' + baseSurfaceResult.logPath);
  }

  const ledgerPresenceResult = await runPsql(
    options, runDirectory, label + '-standalone-ledger-presence', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command',
      "SELECT CASE WHEN to_regclass('nexus_private.pending_action_v1_migrations') IS NULL THEN 'absent' ELSE 'present' END;"],
    deadlineAt
  );
  const ledgerPresence = ledgerPresenceResult.stdout.trim();
  if (ledgerPresence !== 'absent' && ledgerPresence !== 'present') {
    throw new Error('Could not determine the ' + label + ' standalone ledger state. See ' + ledgerPresenceResult.logPath);
  }
  let guardLedgerCount = 0n;
  let guardLedgerFingerprint = 'absent';
  let guardLedgerEntryCount = 0n;
  let guardLedgerDigest: string | null = null;
  if (ledgerPresence === 'present') {
    const ledgerResult = await runPsql(
      options, runDirectory, label + '-standalone-ledger-state', databaseName,
      ['--tuples-only', '--no-align', '--quiet', '--command', [
        "SELECT count(*)::text || chr(9) || md5(coalesce(string_agg(id || ':' || definition_digest,E'\\n' ORDER BY id),'')) || chr(9) ||",
        `count(*) FILTER (WHERE id='${PENDING_ACTION_V1_STANDALONE_MIGRATION_ID}')::text || chr(9) ||`,
        `coalesce(max(definition_digest) FILTER (WHERE id='${PENDING_ACTION_V1_STANDALONE_MIGRATION_ID}'),'')`,
        'FROM nexus_private.pending_action_v1_migrations'
      ].join(' ')],
      deadlineAt
    );
    const [ledgerCountText, ledgerFingerprintText, ledgerEntryCountText, ledgerDigestText]
      = ledgerResult.stdout.trim().split('\t');
    if (!/^[0-9]+$/.test(ledgerCountText ?? '') || !/^[a-f0-9]{32}$/.test(ledgerFingerprintText ?? '')
      || !/^[0-9]+$/.test(ledgerEntryCountText ?? '')
      || (ledgerDigestText !== '' && !/^[a-f0-9]{32}$/.test(ledgerDigestText ?? ''))) {
      throw new Error('Could not parse the ' + label + ' standalone ledger state. See ' + ledgerResult.logPath);
    }
    guardLedgerCount = BigInt(ledgerCountText);
    guardLedgerFingerprint = ledgerFingerprintText;
    guardLedgerEntryCount = BigInt(ledgerEntryCountText);
    guardLedgerDigest = ledgerDigestText || null;
  }

  const guardTriggersResult = await runPsql(
    options, runDirectory, label + '-guard-trigger-state', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT CASE WHEN count(*)=2 AND bool_and(t.tgfoid=to_regprocedure('nexus_private.standalone_pending_action_v1_guard()') AND t.tgenabled IN ('O','A') AND ((t.tgname='standalone_pending_action_v1_guard' AND t.tgtype=31) OR (t.tgname='standalone_pending_action_v1_truncate_guard' AND t.tgtype=34))) THEN 'active' ELSE 'missing' END",
      "FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.pending_actions'::regclass AND t.tgname IN ('standalone_pending_action_v1_guard','standalone_pending_action_v1_truncate_guard');"
    ].join(' ')],
    deadlineAt
  );
  const guardTriggersText = guardTriggersResult.stdout.trim();
  if (guardTriggersText !== 'active' && guardTriggersText !== 'missing') {
    throw new Error('Could not parse the ' + label + ' standalone guard trigger state. See ' + guardTriggersResult.logPath);
  }

  const guardSecurityResult = await runPsql(
    options, runDirectory, label + '-guard-security-state', databaseName,
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT CASE WHEN to_regclass('nexus_private.pending_action_v1_migrations') IS NULL THEN 'not-installed' WHEN",
      "(SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=to_regclass('nexus_private.pending_action_v1_migrations')) IS NOT TRUE",
      'OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (',
      "to_regprocedure('nexus_private.standalone_pending_action_v1_utf16_length(text)'),",
      "to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)'),",
      "to_regprocedure('nexus_private.standalone_pending_action_v1_guard()')))<>3",
      "OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN (to_regprocedure('nexus_private.standalone_pending_action_v1_utf16_length(text)'),to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)'),to_regprocedure('nexus_private.standalone_pending_action_v1_guard()'))",
      "AND p.proowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.appmeta'::regclass))",
      "OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a",
      "WHERE p.oid IN (to_regprocedure('nexus_private.standalone_pending_action_v1_utf16_length(text)'),to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)'),to_regprocedure('nexus_private.standalone_pending_action_v1_guard()'))",
      "AND (a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable))",
      "OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN (to_regprocedure('nexus_private.standalone_pending_action_v1_utf16_length(text)'),to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)'),to_regprocedure('nexus_private.standalone_pending_action_v1_guard()'))",
      "AND (SELECT array(SELECT a.privilege_type FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a ORDER BY a.privilege_type)) IS DISTINCT FROM ARRAY['EXECUTE'])",
      "OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a",
      "WHERE c.oid=to_regclass('nexus_private.pending_action_v1_migrations') AND (c.relowner<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.appmeta'::regclass)",
      'OR a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable))',
      "OR (SELECT array(SELECT a.privilege_type FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a ORDER BY a.privilege_type)",
      "FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('nexus_private.pending_action_v1_migrations')) IS DISTINCT FROM",
      "(SELECT array(SELECT a.privilege_type FROM pg_catalog.aclexplode(pg_catalog.acldefault('r',c.relowner)) a WHERE a.grantee=c.relowner ORDER BY a.privilege_type)",
      "FROM pg_catalog.pg_class c WHERE c.oid='public.appmeta'::regclass)",
      "THEN 'exposed' ELSE 'private' END;"
    ].join(' ')],
    deadlineAt
  );
  const guardSecurityText = guardSecurityResult.stdout.trim();
  if (guardSecurityText !== 'not-installed' && guardSecurityText !== 'private' && guardSecurityText !== 'exposed') {
    throw new Error('Could not parse the ' + label + ' standalone guard privilege state. See ' + guardSecurityResult.logPath);
  }
  const guardSecurity = guardSecurityText as StandalonePendingActionV1State['guardSecurity'];

  return {
    catalogFingerprint,
    pendingCount: BigInt(pendingCountText),
    pendingFullRowFingerprint,
    pendingBodyFingerprint,
    completedCount: BigInt(completedCountText),
    pendingStatusCount: BigInt(pendingStatusCountText),
    actionContractVersionOneCount: BigInt(actionContractVersionOneCountText),
    historicalSeedCount: BigInt(historicalSeedCountText),
    historicalSeedBodyFingerprint,
    historicalSeedRowImageFingerprint,
    pendingColumns,
    publicTableNames,
    appmetaCount: BigInt(appmetaCountText),
    appmetaRevision: BigInt(appmetaRevisionText),
    appmetaFingerprint,
    v2SurfaceAbsent: v2SurfaceText === 'absent',
    baseV1SurfaceReady: baseV1SurfaceText === 'ready',
    guardTriggersActive: guardTriggersText === 'active',
    guardSecurity,
    guardLedgerPresent: ledgerPresence === 'present',
    guardLedgerCount,
    guardLedgerFingerprint,
    guardLedgerEntryCount,
    guardLedgerDigest
  };
}

function totalRows(tableCounts: Map<string, bigint>): bigint {
  return [...tableCounts.values()].reduce((total, count) => total + count, 0n);
}

function sameTableCounts(left: Map<string, bigint>, right: Map<string, bigint>): boolean {
  return left.size === right.size && [...left].every(([name, count]) => right.get(name) === count);
}

function sameExistingTableCounts(before: Map<string, bigint>, after: Map<string, bigint>): boolean {
  return [...before].every(([name, count]) => after.get(name) === count);
}

function sameTableRowFingerprints(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([name, fingerprint]) => right.get(name) === fingerprint);
}

function sameExistingTableRowFingerprints(before: Map<string, string>, after: Map<string, string>): boolean {
  return [...before].every(([name, fingerprint]) => after.get(name) === fingerprint);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStandalonePendingActionV1State(left: StandalonePendingActionV1State, right: StandalonePendingActionV1State): boolean {
  return left.catalogFingerprint === right.catalogFingerprint
    && left.pendingCount === right.pendingCount
    && left.pendingFullRowFingerprint === right.pendingFullRowFingerprint
    && left.pendingBodyFingerprint === right.pendingBodyFingerprint
    && left.completedCount === right.completedCount
    && left.pendingStatusCount === right.pendingStatusCount
    && left.actionContractVersionOneCount === right.actionContractVersionOneCount
    && left.historicalSeedCount === right.historicalSeedCount
    && left.historicalSeedBodyFingerprint === right.historicalSeedBodyFingerprint
    && left.historicalSeedRowImageFingerprint === right.historicalSeedRowImageFingerprint
    && sameStringArray(left.pendingColumns, right.pendingColumns)
    && sameStringSet(left.publicTableNames, right.publicTableNames)
    && left.appmetaCount === right.appmetaCount
    && left.appmetaRevision === right.appmetaRevision
    && left.appmetaFingerprint === right.appmetaFingerprint
    && left.v2SurfaceAbsent === right.v2SurfaceAbsent
    && left.baseV1SurfaceReady === right.baseV1SurfaceReady
    && left.guardTriggersActive === right.guardTriggersActive
    && left.guardSecurity === right.guardSecurity
    && left.guardLedgerPresent === right.guardLedgerPresent
    && left.guardLedgerCount === right.guardLedgerCount
    && left.guardLedgerFingerprint === right.guardLedgerFingerprint
    && left.guardLedgerEntryCount === right.guardLedgerEntryCount
    && left.guardLedgerDigest === right.guardLedgerDigest;
}

function sameStandalonePendingActionV1Rows(left: StandalonePendingActionV1State, right: StandalonePendingActionV1State): boolean {
  return left.pendingCount === right.pendingCount
    && left.pendingFullRowFingerprint === right.pendingFullRowFingerprint
    && left.pendingBodyFingerprint === right.pendingBodyFingerprint
    && left.completedCount === right.completedCount
    && left.pendingStatusCount === right.pendingStatusCount
    && left.actionContractVersionOneCount === right.actionContractVersionOneCount
    && left.historicalSeedCount === right.historicalSeedCount
    && left.historicalSeedBodyFingerprint === right.historicalSeedBodyFingerprint
    && left.historicalSeedRowImageFingerprint === right.historicalSeedRowImageFingerprint;
}

function isStandalonePendingActionV1Seed(state: StandalonePendingActionV1State): boolean {
  return state.pendingCount === 9n
    && state.completedCount === 8n
    && state.pendingStatusCount === 1n
    && state.actionContractVersionOneCount === 9n
    && state.historicalSeedCount === 9n
    && state.historicalSeedBodyFingerprint === PENDING_ACTION_V1_STANDALONE_SEED_BODY_MD5
    && state.historicalSeedRowImageFingerprint === PENDING_ACTION_V1_STANDALONE_SEED_ROW_IMAGE_MD5
    && sameStringArray(state.pendingColumns, ['id\ttext\tNO', 'payload\tjsonb\tNO'])
    && state.appmetaCount === 1n
    && state.baseV1SurfaceReady
    && state.v2SurfaceAbsent
    && !state.guardLedgerPresent
    && state.guardSecurity === 'not-installed'
    && !state.guardTriggersActive;
}

async function runStandalonePendingActionV1Phase(args: {
  options: Options;
  runDirectory: string;
  databaseName: string;
  deadlineAt: number;
  migrationSnapshot: string;
  sqlSnapshot: string;
  migrationSha256: string;
  migrationRawSha256: string;
  sqlSha256: string;
  sqlRawSha256: string;
  expectedCases: string[];
}): Promise<void> {
  const { options, runDirectory, databaseName, deadlineAt } = args;
  const fixturePath = join(runDirectory, 'standalone-v1-historical-fixture.sql');
  await writeFile(fixturePath, PENDING_ACTION_V1_STANDALONE_FIXTURE_SQL, { encoding: 'utf8', flag: 'wx' });
  await runPsql(options, runDirectory, 'seed-standalone-v1-history', databaseName, ['--file', fixturePath], deadlineAt);

  const seeded = await captureStandalonePendingActionV1State(
    options, runDirectory, 'standalone-v1-seeded', databaseName, deadlineAt
  );
  if (!isStandalonePendingActionV1Seed(seeded)) {
    throw new Error('The original V1 schema or pinned nine-row fixture did not match the standalone baseline. See standalone-v1-seeded logs.');
  }

  await runPsql(options, runDirectory, 'apply-standalone-v1-guard-migration', databaseName,
    ['--file', args.migrationSnapshot], deadlineAt);
  const afterInstall = await captureStandalonePendingActionV1State(
    options, runDirectory, 'standalone-v1-after-install', databaseName, deadlineAt
  );
  if (!sameStandalonePendingActionV1Rows(seeded, afterInstall)
    || seeded.appmetaCount !== afterInstall.appmetaCount
    || seeded.appmetaRevision !== afterInstall.appmetaRevision
    || seeded.appmetaFingerprint !== afterInstall.appmetaFingerprint
    || !sameStringArray(seeded.pendingColumns, afterInstall.pendingColumns)
    || !sameStringSet(seeded.publicTableNames, afterInstall.publicTableNames)
    || !afterInstall.baseV1SurfaceReady || !afterInstall.v2SurfaceAbsent
    || !afterInstall.guardLedgerPresent || afterInstall.guardLedgerCount !== 1n
    || afterInstall.guardLedgerEntryCount !== 1n
    || afterInstall.guardLedgerDigest !== PENDING_ACTION_V1_STANDALONE_LEDGER_DIGEST
    || !afterInstall.guardTriggersActive || afterInstall.guardSecurity !== 'private') {
    throw new Error('Standalone 010002 changed V1 rows/appmeta/native columns or failed its pinned ledger/trigger/privilege contract. See standalone-v1-after-install logs.');
  }

  const conformance = await runPsql(options, runDirectory, 'standalone-v1-conformance', databaseName,
    ['--set=PENDING_ACTION_REVISION_MIGRATION=' + basename(args.migrationSnapshot), '--file', args.sqlSnapshot], deadlineAt);
  const passed = conformance.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('CASE PASS: '))
    .map((line) => line.slice('CASE PASS: '.length));
  if (passed.length !== args.expectedCases.length || args.expectedCases.some((name, index) => passed[index] !== name)) {
    throw new Error(`Expected ${args.expectedCases.length} standalone V1 named SQL cases in order; observed ${passed.length}. See ${conformance.logPath}`);
  }

  const beforeReapply = await captureStandalonePendingActionV1State(
    options, runDirectory, 'standalone-v1-before-reapply', databaseName, deadlineAt
  );
  if (beforeReapply.historicalSeedBodyFingerprint !== PENDING_ACTION_V1_STANDALONE_SEED_BODY_MD5
    || beforeReapply.historicalSeedRowImageFingerprint !== PENDING_ACTION_V1_STANDALONE_SEED_ROW_IMAGE_MD5) {
    throw new Error('Standalone behavior cases changed the pinned nine historical V1 actions.');
  }

  await runPsql(options, runDirectory, 'reapply-standalone-v1-guard-migration', databaseName,
    ['--file', args.migrationSnapshot], deadlineAt);
  const afterReapply = await captureStandalonePendingActionV1State(
    options, runDirectory, 'standalone-v1-after-reapply', databaseName, deadlineAt
  );
  if (!sameStandalonePendingActionV1State(beforeReapply, afterReapply)) {
    throw new Error('Same-file 010002 reapply changed V1 row/body, native schema, appmeta, ledger, catalog, trigger, or privilege fingerprints.');
  }

  const alteredDigestProbe = join(runDirectory, 'standalone-v1-altered-digest-reapply.sql');
  await writeFile(alteredDigestProbe, [
    '\\set ON_ERROR_STOP 1',
    '\\set VERBOSITY verbose',
    'BEGIN;',
    `UPDATE nexus_private.pending_action_v1_migrations SET definition_digest=repeat('0',32) WHERE id='${PENDING_ACTION_V1_STANDALONE_MIGRATION_ID}';`,
    '\\ir :PENDING_ACTION_REVISION_MIGRATION',
    'COMMIT;'
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  const alteredDigest = await runPsql(options, runDirectory, 'standalone-v1-altered-digest-reapply', databaseName,
    ['--set=PENDING_ACTION_REVISION_MIGRATION=' + basename(args.migrationSnapshot), '--file', alteredDigestProbe],
    deadlineAt, undefined, true);
  const alteredOutput = alteredDigest.stdout + '\n' + alteredDigest.stderr;
  if (alteredDigest.code === 0 || alteredDigest.timedOut || !alteredOutput.includes('23514')
    || !alteredOutput.includes('Standalone pending action contract changed without a new schema version')) {
    throw new Error(`Altered-digest reapply did not fail with the pinned SQLSTATE/text. See ${alteredDigest.logPath}`);
  }
  const afterRollback = await captureStandalonePendingActionV1State(
    options, runDirectory, 'standalone-v1-after-altered-digest-rollback', databaseName, deadlineAt
  );
  if (!sameStandalonePendingActionV1State(afterReapply, afterRollback)) {
    throw new Error('Rejected altered-digest reapply left persistent changes instead of rolling back atomically.');
  }

  await writeFile(join(runDirectory, 'standalone-v1-idempotency.txt'), [
    'sameFileReapply=preserved',
    'alteredDigestReapply=expected-rejection',
    'alteredDigestSqlState=23514',
    'alteredDigestMessage=Standalone pending action contract changed without a new schema version',
    'alteredDigestRollbackState=preserved',
    `pendingRows=${afterReapply.pendingCount}`,
    `pendingBodyFingerprint=${afterReapply.pendingBodyFingerprint}`,
    `pendingFullRowFingerprint=${afterReapply.pendingFullRowFingerprint}`,
    `historicalSeedBodyFingerprint=${afterReapply.historicalSeedBodyFingerprint}`,
    `historicalSeedRowImageFingerprint=${afterReapply.historicalSeedRowImageFingerprint}`,
    `appmetaRevision=${afterReapply.appmetaRevision}`,
    `appmetaFingerprint=${afterReapply.appmetaFingerprint}`,
    `catalogFingerprint=${afterReapply.catalogFingerprint}`,
    `guardLedgerDigest=${afterReapply.guardLedgerDigest}`,
    `migrationNormalizedSqlSha256=${args.migrationSha256}`,
    `migrationRawByteSha256=${args.migrationRawSha256}`
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(runDirectory, 'result.txt'), [
    'status=passed',
    'mode=standalone-original-v1-only',
    'evidence=private local PostgreSQL SQL conformance; no V2 migration applied',
    `database=${databaseName}`,
    `migrationNormalizedSqlSha256=${args.migrationSha256}`,
    `migrationRawByteSha256=${args.migrationRawSha256}`,
    `conformanceNormalizedSqlSha256=${args.sqlSha256}`,
    `conformanceRawByteSha256=${args.sqlRawSha256}`,
    `seedBodyMd5=${PENDING_ACTION_V1_STANDALONE_SEED_BODY_MD5}`,
    `seedRowImageMd5=${PENDING_ACTION_V1_STANDALONE_SEED_ROW_IMAGE_MD5}`,
    `namedCases=${passed.length}`,
    ...passed.map((name) => `case=${name}`),
    'sameFileReapply=preserved',
    'alteredDigestReapply=expected-rejection-and-rollback'
  ].join('\n'), { encoding: 'utf8', flag: 'w' });
}

function sameMigrationStateExactly(left: MigrationState, right: MigrationState): boolean {
  const ledgerSame = left.workflowLedger === null ? right.workflowLedger === null
    : right.workflowLedger !== null
      && left.workflowLedger.count === right.workflowLedger.count
      && left.workflowLedger.fingerprint === right.workflowLedger.fingerprint;
  return left.catalogFingerprint === right.catalogFingerprint
    && sameTableCounts(left.tableCounts, right.tableCounts)
    && sameTableRowFingerprints(left.tableRowFingerprints, right.tableRowFingerprints)
    && sameStringSet(left.publicTableNames, right.publicTableNames)
    && left.revision === right.revision
    && left.adapterWrite === right.adapterWrite
    && left.appmetaCount === right.appmetaCount
    && left.appmetaContentFingerprint === right.appmetaContentFingerprint
    && left.completenessChildCount === right.completenessChildCount
    && left.completenessChildFingerprint === right.completenessChildFingerprint
    && left.completenessLedgerCount === right.completenessLedgerCount
    && left.completenessLedgerFingerprint === right.completenessLedgerFingerprint
    && ledgerSame
    && left.responsibilitiesIndexMetadata === right.responsibilitiesIndexMetadata;
}

function sameMigrationStateExceptRevision(left: MigrationState, right: MigrationState): boolean {
  return sameMigrationStateExactly({ ...left, revision: right.revision }, right);
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function requireWorkflowLedger(state: MigrationState, label: string): WorkflowLedgerSnapshot {
  if (!state.workflowLedger) {
    throw new Error('Expected the workflow projection migration ledger to exist after ' + label + '.');
  }
  return state.workflowLedger;
}

function differenceStringSets(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

interface CompletenessPhaseArgs {
  options: Options;
  runDirectory: string;
  databaseName: string;
  deadlineAt: number;
  serverVersion: string;
  connectedUser: string;
  connectedRoleBypassRls: string;
  originalSha256: string;
  workflowSha256: string;
  conformanceSha256: string;
  completenessMigrationSha256: string;
  completenessSqlSha256: string;
  expectedCompletenessCases: string[];
  completenessMigrationSnapshot: string;
  completenessSqlSnapshot: string;
  legacyPassed: string[];
  legacyStateBeforeReapply: MigrationState;
  legacyStateAfterReapply: MigrationState;
}

async function runCompletenessPhase(args: CompletenessPhaseArgs): Promise<void> {
  await writeFile(join(args.runDirectory, 'workflow-v2-phase.txt'), [
    'status=passed',
    'namedCases=' + String(args.legacyPassed.length),
    'migrationSha256=' + args.workflowSha256,
    'conformanceSqlSha256=' + args.conformanceSha256,
    'revisionBeforeReapply=' + String(args.legacyStateBeforeReapply.revision),
    'revisionAfterReapply=' + String(args.legacyStateAfterReapply.revision),
    ...args.legacyPassed.map((name) => 'case=' + name)
  ].join('\n'));
  const fixtureSnapshot = join(args.runDirectory, 'completeness-legacy-fixtures.sql');
  await writeFile(fixtureSnapshot, COMPLETENESS_LEGACY_FIXTURE_SQL, { encoding: 'utf8', flag: 'wx' });
  await runPsql(
    args.options, args.runDirectory, 'prepare-completeness-legacy-fixtures', args.databaseName,
    ['--file', fixtureSnapshot],
    args.deadlineAt
  );

  const stateBeforeCompleteness = await captureMigrationState(
    args.options, args.runDirectory, 'before-completeness-migration', args.databaseName, args.deadlineAt
  );
  await runPsql(
    args.options, args.runDirectory, 'apply-workflow-completeness-migration', args.databaseName,
    ['--file', args.completenessMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterCompleteness = await captureMigrationState(
    args.options, args.runDirectory, 'after-completeness-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true, preserveTableColumnsFrom: stateBeforeCompleteness }
  );
  const oldTableCountsStable = sameTableCounts(stateBeforeCompleteness.tableCounts, stateAfterCompleteness.tableCounts);
  const oldTableRowsStable = sameTableRowFingerprints(
    stateBeforeCompleteness.tableRowFingerprints, stateAfterCompleteness.tableRowFingerprints
  );
  const appmetaRowsStable = stateBeforeCompleteness.appmetaCount === stateAfterCompleteness.appmetaCount;
  const appmetaContentsStableAcrossMigration = stateBeforeCompleteness.appmetaContentFingerprint
    === stateAfterCompleteness.appmetaContentFingerprint;
  const revisionStable = stateBeforeCompleteness.revision === stateAfterCompleteness.revision;
  const addedPublicTables = differenceStringSets(stateAfterCompleteness.publicTableNames, stateBeforeCompleteness.publicTableNames);
  const removedPublicTables = differenceStringSets(stateBeforeCompleteness.publicTableNames, stateAfterCompleteness.publicTableNames);
  const onlyExpectedChildAdded = addedPublicTables.length === 1
    && addedPublicTables[0] === COMPLETENESS_CHILD_TABLE && removedPublicTables.length === 0;
  const migrationChildEmpty = stateAfterCompleteness.completenessChildCount === 0n;
  const migrationLedgerInstalled = stateAfterCompleteness.completenessLedgerCount === 1n;
  await writeFile(join(args.runDirectory, 'completeness-migration-preservation.txt'), [
    'status=compared-before-and-after-additive-migration',
    'legacyRowsComparedUsingEveryPreMigrationManifestColumn=true',
    'manifestTableCount=62',
    'publicTableDeltaAllowsOnlyTheNormalizedChild=true',
    'expectedNewChild=workflow_offboarding_plan_assignments',
    'preExistingManifestRowCountsUnchanged=' + oldTableCountsStable,
    'preExistingManifestRowContentsUnchanged=' + oldTableRowsStable,
    'appmetaRowCountUnchanged=' + appmetaRowsStable,
    'appmetaContentsExcludingRevisionUnchanged=' + appmetaContentsStableAcrossMigration,
    'appmetaRevisionUnchanged=' + revisionStable,
    'onlyExpectedPublicTableAdded=' + onlyExpectedChildAdded,
    'newChildRowsBeforeCompletenessCases=' + String(stateAfterCompleteness.completenessChildCount),
    'newChildEmptyBeforeCompletenessCases=' + migrationChildEmpty,
    'completenessLedgerRows=' + String(stateAfterCompleteness.completenessLedgerCount),
    'completenessLedgerInstalled=' + migrationLedgerInstalled,
    'manifestRowsBeforeMigration=' + String(totalRows(stateBeforeCompleteness.tableCounts)),
    'manifestRowsAfterMigration=' + String(totalRows(stateAfterCompleteness.tableCounts)),
    'revisionBeforeMigration=' + String(stateBeforeCompleteness.revision),
    'revisionAfterMigration=' + String(stateAfterCompleteness.revision),
    'publicTablesAdded=' + addedPublicTables.join(','),
    'publicTablesRemoved=' + removedPublicTables.join(',')
  ].join('\n'));
  if (!oldTableCountsStable || !oldTableRowsStable || !appmetaRowsStable || !appmetaContentsStableAcrossMigration
    || !revisionStable || !onlyExpectedChildAdded || !migrationChildEmpty || !migrationLedgerInstalled) {
    throw new Error('The completeness migration changed pre-migration manifest rows/revision or added an unexpected public table. See completeness-migration-preservation.txt.');
  }

  const conformance = await runPsql(
    args.options, args.runDirectory, 'workflow-completeness-conformance', args.databaseName,
    ['--set=KEEP_COMPLETENESS_ROWS=1', '--file', args.completenessSqlSnapshot],
    args.deadlineAt
  );
  const passed = conformance.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('CASE PASS: '))
    .map((line) => line.slice('CASE PASS: '.length));
  const expectedCases = args.expectedCompletenessCases;
  if (passed.length !== expectedCases.length || expectedCases.some((name, index) => passed[index] !== name)) {
    throw new Error('Expected ' + expectedCases.length + ' named completeness SQL cases in order; observed '
      + passed.length + '. See ' + conformance.logPath);
  }

  const stateBeforeReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-completeness-fixtures-before-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  if (totalRows(stateBeforeReapply.tableCounts) <= totalRows(stateAfterCompleteness.tableCounts)
    || stateBeforeReapply.completenessChildCount !== 1n) {
    throw new Error('Completeness cases did not commit their expected manifest rows and one normalized child row.');
  }
  await runPsql(
    args.options, args.runDirectory, 'reapply-workflow-completeness-migration', args.databaseName,
    ['--file', args.completenessMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-completeness-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const catalogStable = stateBeforeReapply.catalogFingerprint === stateAfterReapply.catalogFingerprint;
  const rowCountsStable = sameTableCounts(stateBeforeReapply.tableCounts, stateAfterReapply.tableCounts);
  const rowContentsStable = sameTableRowFingerprints(
    stateBeforeReapply.tableRowFingerprints, stateAfterReapply.tableRowFingerprints
  );
  const childCountStable = stateBeforeReapply.completenessChildCount === stateAfterReapply.completenessChildCount;
  const childContentsStable = stateBeforeReapply.completenessChildFingerprint
    === stateAfterReapply.completenessChildFingerprint;
  const ledgerCountStable = stateBeforeReapply.completenessLedgerCount === stateAfterReapply.completenessLedgerCount;
  const ledgerContentsStable = stateBeforeReapply.completenessLedgerFingerprint
    === stateAfterReapply.completenessLedgerFingerprint;
  const appmetaCountStable = stateBeforeReapply.appmetaCount === stateAfterReapply.appmetaCount;
  const appmetaContentsStable = stateBeforeReapply.appmetaContentFingerprint
    === stateAfterReapply.appmetaContentFingerprint;
  const revisionStableAcrossReapply = stateBeforeReapply.revision === stateAfterReapply.revision;
  const publicTablesStable = sameStringSet(stateBeforeReapply.publicTableNames, stateAfterReapply.publicTableNames);
  const responsibilitiesIndexStable = stateBeforeReapply.responsibilitiesIndexMetadata
    === stateAfterReapply.responsibilitiesIndexMetadata;
  await writeFile(join(args.runDirectory, 'completeness-migration-idempotency.txt'), [
    'status=compared-after-populated-completeness-conformance',
    'catalogFingerprintUnchanged=' + catalogStable,
    'catalogFingerprintIncludesColumnsManifestIndexesConstraintsTriggersRlsPoliciesAclsAndFunctions=true',
    'manifestTableCountsUnchanged=' + rowCountsStable,
    'manifestRowContentsUnchanged=' + rowContentsStable,
    'normalizedChildCountUnchanged=' + childCountStable,
    'normalizedChildContentsUnchanged=' + childContentsStable,
    'completenessLedgerCountUnchanged=' + ledgerCountStable,
    'completenessLedgerContentsUnchanged=' + ledgerContentsStable,
    'appmetaRowCountUnchanged=' + appmetaCountStable,
    'appmetaContentsExcludingRevisionUnchanged=' + appmetaContentsStable,
    'appmetaRevisionUnchanged=' + revisionStableAcrossReapply,
    'publicTableSetUnchanged=' + publicTablesStable,
    'responsibilitiesActiveIndexMetadataUnchanged=' + responsibilitiesIndexStable,
    'manifestBusinessRowsBefore=' + String(totalRows(stateBeforeReapply.tableCounts)),
    'manifestBusinessRowsAfter=' + String(totalRows(stateAfterReapply.tableCounts)),
    'normalizedChildRowsBefore=' + String(stateBeforeReapply.completenessChildCount),
    'normalizedChildRowsAfter=' + String(stateAfterReapply.completenessChildCount),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'namedCases=' + String(passed.length)
  ].join('\n'));
  if (!catalogStable || !rowCountsStable || !rowContentsStable || !childCountStable || !childContentsStable
    || !ledgerCountStable || !ledgerContentsStable
    || !appmetaCountStable || !appmetaContentsStable || !revisionStableAcrossReapply
    || !publicTablesStable || !responsibilitiesIndexStable) {
    throw new Error('Reapplying the completeness migration changed catalog metadata, manifest/child rows, or appmeta revision. See completeness-migration-idempotency.txt.');
  }

  await writeFile(join(args.runDirectory, 'workflow-completeness-phase.txt'), [
    'status=passed',
    'namedCases=' + String(passed.length),
    'migrationSha256=' + args.completenessMigrationSha256,
    'conformanceSqlSha256=' + args.completenessSqlSha256,
    'preExistingRowsPreserved=' + (oldTableCountsStable && oldTableRowsStable && revisionStable),
    'catalogUnchangedAcrossReapply=' + catalogStable,
    'normalizedChildRows=' + String(stateAfterReapply.completenessChildCount),
    ...passed.map((name) => 'case=' + name)
  ].join('\n'));
  await writeFile(join(args.runDirectory, 'result.txt'), [
    'status=passed',
    'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
    'serverVersion=' + args.serverVersion,
    'connectedUser=' + args.connectedUser,
    'connectedRoleBypassRls=' + args.connectedRoleBypassRls,
    'originalMigrationSha256=' + args.originalSha256,
    'workflowV2MigrationSha256=' + args.workflowSha256,
    'workflowV2ConformanceSqlSha256=' + args.conformanceSha256,
    'workflowV2NamedCases=' + String(args.legacyPassed.length),
    'completenessMigrationSha256=' + args.completenessMigrationSha256,
    'completenessConformanceSqlSha256=' + args.completenessSqlSha256,
    'completenessNamedCases=' + String(passed.length),
    'preExistingManifestRowsPreserved=' + (oldTableCountsStable && oldTableRowsStable),
    'preExistingRevisionPreserved=' + revisionStable,
    'onlyExpectedPublicTableAdded=' + onlyExpectedChildAdded,
    'completenessCatalogUnchangedAcrossReapply=' + catalogStable,
    'completenessManifestRowsUnchangedAcrossReapply=' + (rowCountsStable && rowContentsStable),
    'completenessChildRowsUnchangedAcrossReapply=' + (childCountStable && childContentsStable),
    'completenessAppmetaRevisionUnchangedAcrossReapply=' + revisionStableAcrossReapply,
    'completenessChildRows=' + String(stateAfterReapply.completenessChildCount),
    ...args.legacyPassed.map((name) => 'legacyCase=' + name),
    ...passed.map((name) => 'completenessCase=' + name)
  ].join('\n'));
}

interface ConversationPhaseArgs {
  options: Options;
  runDirectory: string;
  databaseName: string;
  deadlineAt: number;
  serverVersion: string;
  connectedUser: string;
  connectedRoleBypassRls: string;
  originalSha256: string;
  workflowSha256: string;
  conformanceSha256: string;
  completenessMigrationSha256: string;
  completenessSqlSha256: string;
  conversationMigrationSha256: string;
  conversationSqlSha256: string;
  expectedConversationCases: string[];
  conversationMigrationSnapshot: string;
  conversationSqlSnapshot: string;
  legacyPassed: string[];
  completenessPassed: string[];
}

async function runConversationPersistencePhase(args: ConversationPhaseArgs): Promise<void> {
  const fixtureSnapshot = join(args.runDirectory, 'conversation-legacy-fixtures.sql');
  await writeFile(fixtureSnapshot, CONVERSATION_LEGACY_FIXTURE_SQL, { encoding: 'utf8', flag: 'wx' });
  await runPsql(
    args.options, args.runDirectory, 'prepare-conversation-legacy-fixtures', args.databaseName,
    ['--file', fixtureSnapshot],
    args.deadlineAt
  );

  const stateBeforeForward = await captureMigrationState(
    args.options, args.runDirectory, 'before-conversation-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerBeforeForward = requireWorkflowLedger(stateBeforeForward, 'the completeness migration and its reapply');
  if (stateBeforeForward.tableCounts.get('conversations') !== 2n
    || stateBeforeForward.tableCounts.get('conversation_messages') !== 2n) {
    throw new Error('The populated pre-forward conversation fixtures were not present in the owned database.');
  }

  await runPsql(
    args.options, args.runDirectory, 'prepare-contradictory-conversation-identity', args.databaseName,
    ['--command', [
      'BEGIN;',
      'ALTER TABLE public.conversation_messages DISABLE TRIGGER workflow_guard;',
      'ALTER TABLE public.conversation_messages DISABLE TRIGGER nexus_revision;',
      'ALTER TABLE public.conversation_messages ADD COLUMN turn_id text;',
      "UPDATE public.conversation_messages SET turn_id='workflow-pg-contradictory-turn' WHERE id='workflow-pg-conversation-legacy-user';",
      'ALTER TABLE public.conversation_messages ENABLE TRIGGER workflow_guard;',
      'ALTER TABLE public.conversation_messages ENABLE TRIGGER nexus_revision;',
      'COMMIT;'
    ].join(' ')],
    args.deadlineAt
  );
  const stateBeforeRejectedForward = await captureMigrationState(
    args.options, args.runDirectory, 'before-rejected-conversation-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerBeforeRejectedForward = requireWorkflowLedger(stateBeforeRejectedForward, 'the populated pre-forward fixture');
  let contradictionRejected = false;
  try {
    await runPsql(
      args.options, args.runDirectory, 'reject-contradictory-conversation-forward-migration', args.databaseName,
      ['--file', args.conversationMigrationSnapshot],
      args.deadlineAt
    );
  } catch (error) {
    const rejectionLog = await readFile(join(args.runDirectory, 'reject-contradictory-conversation-forward-migration.log'), 'utf8');
    if (!rejectionLog.includes('Workflow conversation contains contradictory native identity')) {
      throw new Error('The contradictory historical identity did not fail at the expected fail-closed migration guard. '
        + (error instanceof Error ? error.message : String(error)));
    }
    contradictionRejected = true;
  }
  if (!contradictionRejected) throw new Error('The forward migration accepted a contradictory pre-existing native identity.');

  const stateAfterRejectedForward = await captureMigrationState(
    args.options, args.runDirectory, 'after-rejected-conversation-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerAfterRejectedForward = requireWorkflowLedger(stateAfterRejectedForward, 'the rejected contradictory migration');
  const rejectedCatalogStable = stateBeforeRejectedForward.catalogFingerprint === stateAfterRejectedForward.catalogFingerprint;
  const rejectedRowsStable = sameTableCounts(stateBeforeRejectedForward.tableCounts, stateAfterRejectedForward.tableCounts)
    && sameTableRowFingerprints(stateBeforeRejectedForward.tableRowFingerprints, stateAfterRejectedForward.tableRowFingerprints);
  const rejectedAppmetaStable = stateBeforeRejectedForward.revision === stateAfterRejectedForward.revision
    && stateBeforeRejectedForward.appmetaCount === stateAfterRejectedForward.appmetaCount
    && stateBeforeRejectedForward.appmetaContentFingerprint === stateAfterRejectedForward.appmetaContentFingerprint;
  const rejectedLedgerStable = ledgerBeforeRejectedForward.count === ledgerAfterRejectedForward.count
    && ledgerBeforeRejectedForward.fingerprint === ledgerAfterRejectedForward.fingerprint;
  if (!rejectedCatalogStable || !rejectedRowsStable || !rejectedAppmetaStable || !rejectedLedgerStable) {
    throw new Error('The rejected contradictory migration did not roll back its catalog, rows, appmeta revision, and ledger changes.');
  }
  await runPsql(
    args.options, args.runDirectory, 'remove-contradictory-conversation-identity', args.databaseName,
    ['--command', 'ALTER TABLE public.conversation_messages DROP COLUMN turn_id;'],
    args.deadlineAt
  );
  const stateAfterContradictionCleanup = await captureMigrationState(
    args.options, args.runDirectory, 'after-contradiction-cleanup', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerAfterContradictionCleanup = requireWorkflowLedger(stateAfterContradictionCleanup, 'contradictory-fixture cleanup');
  if (stateBeforeForward.catalogFingerprint !== stateAfterContradictionCleanup.catalogFingerprint
    || !sameTableCounts(stateBeforeForward.tableCounts, stateAfterContradictionCleanup.tableCounts)
    || !sameTableRowFingerprints(stateBeforeForward.tableRowFingerprints, stateAfterContradictionCleanup.tableRowFingerprints)
    || stateBeforeForward.revision !== stateAfterContradictionCleanup.revision
    || ledgerBeforeForward.count !== ledgerAfterContradictionCleanup.count
    || ledgerBeforeForward.fingerprint !== ledgerAfterContradictionCleanup.fingerprint) {
    throw new Error('The contradictory-identity rollback fixture did not restore the exact pre-forward database state.');
  }

  await runPsql(
    args.options, args.runDirectory, 'apply-workflow-conversation-persistence-migration', args.databaseName,
    ['--file', args.conversationMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterForward = await captureMigrationState(
    args.options, args.runDirectory, 'after-conversation-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true, preserveTableColumnsFrom: stateBeforeForward }
  );
  const ledgerAfterForward = requireWorkflowLedger(stateAfterForward, 'the conversation forward migration');
  const oldTableCountsStable = sameTableCounts(stateBeforeForward.tableCounts, stateAfterForward.tableCounts);
  const oldTableRowsStable = sameTableRowFingerprints(stateBeforeForward.tableRowFingerprints, stateAfterForward.tableRowFingerprints);
  const appmetaStable = stateBeforeForward.revision === stateAfterForward.revision
    && stateBeforeForward.appmetaCount === stateAfterForward.appmetaCount
    && stateBeforeForward.appmetaContentFingerprint === stateAfterForward.appmetaContentFingerprint;
  const previousLedgerStable = ledgerBeforeForward.count === ledgerAfterForward.historyCount
    && ledgerBeforeForward.fingerprint === ledgerAfterForward.historyFingerprint;
  const forwardLedgerAddedOnce = ledgerAfterForward.count === ledgerBeforeForward.count + 1n;
  const completenessLedgerStable = stateBeforeForward.completenessLedgerCount === stateAfterForward.completenessLedgerCount
    && stateBeforeForward.completenessLedgerFingerprint === stateAfterForward.completenessLedgerFingerprint;
  const publicTablesStable = sameStringSet(stateBeforeForward.publicTableNames, stateAfterForward.publicTableNames);
  const addedColumns = [...stateAfterForward.tableColumns].flatMap(([table, columns]) => {
    const previous = new Set(stateBeforeForward.tableColumns.get(table) ?? []);
    return columns.filter((column) => !previous.has(column)).map((column) => `${table}.${column}`);
  }).sort();
  const onlyNativeIdentityColumnsAdded = addedColumns.length === 2
    && addedColumns[0] === 'conversation_messages.session_id'
    && addedColumns[1] === 'conversation_messages.turn_id';
  await writeFile(join(args.runDirectory, 'conversation-migration-preservation.txt'), [
    'status=compared-before-and-after-forward-migration',
    'preForwardConversations=' + String(stateBeforeForward.tableCounts.get('conversations')),
    'preForwardMessages=' + String(stateBeforeForward.tableCounts.get('conversation_messages')),
    'historicalManifestRowsUnchanged=' + oldTableCountsStable,
    'historicalBodiesProjectionsAndVersionsUnchanged=' + oldTableRowsStable,
    'appmetaRevisionAndOtherFieldsUnchanged=' + appmetaStable,
    'historicalWorkflowLedgerEntriesUnchanged=' + previousLedgerStable,
    'forwardLedgerEntryAddedExactlyOnce=' + forwardLedgerAddedOnce,
    'completenessLedgerUnchanged=' + completenessLedgerStable,
    'publicTableSetUnchanged=' + publicTablesStable,
    'onlyExpectedNativeColumnsAdded=' + onlyNativeIdentityColumnsAdded,
    'addedColumns=' + addedColumns.join(','),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'historicalLedgerRowsBeforeForward=' + String(ledgerBeforeForward.count),
    'historicalLedgerRowsAfterForward=' + String(ledgerAfterForward.historyCount),
    'forwardLedgerRowsAfterForward=' + String(ledgerAfterForward.count - ledgerBeforeForward.count),
    'contradictoryMigrationRejected=' + contradictionRejected,
    'contradictoryMigrationCatalogRollback=' + rejectedCatalogStable,
    'contradictoryMigrationRowRollback=' + rejectedRowsStable,
    'contradictoryMigrationAppmetaRollback=' + rejectedAppmetaStable,
    'contradictoryMigrationLedgerRollback=' + rejectedLedgerStable
  ].join('\n'));
  if (!oldTableCountsStable || !oldTableRowsStable || !appmetaStable || !previousLedgerStable
    || !forwardLedgerAddedOnce || !completenessLedgerStable || !publicTablesStable || !onlyNativeIdentityColumnsAdded) {
    throw new Error('The forward migration changed historical conversation/workflow data, revision or ledger history, or added an unexpected projection. See conversation-migration-preservation.txt.');
  }

  const conformance = await runPsql(
    args.options, args.runDirectory, 'workflow-conversation-persistence-conformance', args.databaseName,
    ['--file', args.conversationSqlSnapshot],
    args.deadlineAt
  );
  const passed = conformance.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('CASE PASS: '))
    .map((line) => line.slice('CASE PASS: '.length));
  if (passed.length !== args.expectedConversationCases.length
    || args.expectedConversationCases.some((name, index) => passed[index] !== name)) {
    throw new Error('Expected ' + args.expectedConversationCases.length + ' named conversation SQL cases in order; observed '
      + passed.length + '. See ' + conformance.logPath);
  }

  const stateBeforeReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-conversation-fixtures-before-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerBeforeReapply = requireWorkflowLedger(stateBeforeReapply, 'the populated conversation conformance cases');
  if (totalRows(stateBeforeReapply.tableCounts) <= totalRows(stateAfterForward.tableCounts)) {
    throw new Error('Conversation SQL cases passed but committed no manifest rows for the populated reapply check.');
  }
  await runPsql(
    args.options, args.runDirectory, 'reapply-workflow-conversation-persistence-migration', args.databaseName,
    ['--file', args.conversationMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-conversation-persistence-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true, preserveTableColumnsFrom: stateBeforeReapply }
  );
  const ledgerAfterReapply = requireWorkflowLedger(stateAfterReapply, 'the populated conversation migration reapply');
  const catalogStable = stateBeforeReapply.catalogFingerprint === stateAfterReapply.catalogFingerprint;
  const rowCountsStable = sameTableCounts(stateBeforeReapply.tableCounts, stateAfterReapply.tableCounts);
  const rowContentsStable = sameTableRowFingerprints(stateBeforeReapply.tableRowFingerprints, stateAfterReapply.tableRowFingerprints);
  const childCountStable = stateBeforeReapply.completenessChildCount === stateAfterReapply.completenessChildCount;
  const childContentsStable = stateBeforeReapply.completenessChildFingerprint === stateAfterReapply.completenessChildFingerprint;
  const ledgerCountStable = ledgerBeforeReapply.count === ledgerAfterReapply.count;
  const ledgerContentsStable = ledgerBeforeReapply.fingerprint === ledgerAfterReapply.fingerprint;
  const completenessLedgerReapplyStable = stateBeforeReapply.completenessLedgerCount === stateAfterReapply.completenessLedgerCount
    && stateBeforeReapply.completenessLedgerFingerprint === stateAfterReapply.completenessLedgerFingerprint;
  const appmetaReapplyStable = stateBeforeReapply.revision === stateAfterReapply.revision
    && stateBeforeReapply.appmetaCount === stateAfterReapply.appmetaCount
    && stateBeforeReapply.appmetaContentFingerprint === stateAfterReapply.appmetaContentFingerprint;
  const publicTablesStableAfterReapply = sameStringSet(stateBeforeReapply.publicTableNames, stateAfterReapply.publicTableNames);
  const responsibilitiesIndexStable = stateBeforeReapply.responsibilitiesIndexMetadata
    === stateAfterReapply.responsibilitiesIndexMetadata;
  await writeFile(join(args.runDirectory, 'conversation-migration-idempotency.txt'), [
    'status=compared-after-populated-conversation-conformance',
    'catalogFingerprintUnchanged=' + catalogStable,
    'manifestTableCountsUnchanged=' + rowCountsStable,
    'manifestBodiesProjectionsAndVersionsUnchanged=' + rowContentsStable,
    'completenessChildCountAndContentsUnchanged=' + (childCountStable && childContentsStable),
    'historicalAndForwardLedgerUnchanged=' + (ledgerCountStable && ledgerContentsStable),
    'completenessLedgerUnchanged=' + completenessLedgerReapplyStable,
    'appmetaRevisionAndOtherFieldsUnchanged=' + appmetaReapplyStable,
    'publicTableSetUnchanged=' + publicTablesStableAfterReapply,
    'responsibilitiesActiveIndexMetadataUnchanged=' + responsibilitiesIndexStable,
    'manifestRowsBeforeReapply=' + String(totalRows(stateBeforeReapply.tableCounts)),
    'manifestRowsAfterReapply=' + String(totalRows(stateAfterReapply.tableCounts)),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'workflowLedgerEntries=' + String(ledgerAfterReapply.count),
    'namedCases=' + String(passed.length)
  ].join('\n'));
  if (!catalogStable || !rowCountsStable || !rowContentsStable || !childCountStable || !childContentsStable
    || !ledgerCountStable || !ledgerContentsStable || !completenessLedgerReapplyStable || !appmetaReapplyStable
    || !publicTablesStableAfterReapply || !responsibilitiesIndexStable) {
    throw new Error('Reapplying the conversation migration changed catalog metadata, populated rows, appmeta revision or migration ledgers. See conversation-migration-idempotency.txt.');
  }

  await writeFile(join(args.runDirectory, 'conversation-persistence-phase.txt'), [
    'status=passed',
    'namedCases=' + String(passed.length),
    'migrationSha256=' + args.conversationMigrationSha256,
    'conformanceSqlSha256=' + args.conversationSqlSha256,
    'preForwardBodyVersionRevisionAndHistoryPreserved=' + (oldTableRowsStable && appmetaStable && previousLedgerStable),
    'populatedReapplyStable=' + (catalogStable && rowContentsStable && appmetaReapplyStable && ledgerContentsStable),
    'contradictoryMigrationRollbackVerified=' + contradictionRejected,
    ...passed.map((name) => 'case=' + name)
  ].join('\n'));
  await writeFile(join(args.runDirectory, 'result.txt'), [
    'status=passed',
    'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
    'serverVersion=' + args.serverVersion,
    'connectedUser=' + args.connectedUser,
    'connectedRoleBypassRls=' + args.connectedRoleBypassRls,
    'originalMigrationSha256=' + args.originalSha256,
    'workflowV2MigrationSha256=' + args.workflowSha256,
    'workflowV2ConformanceSqlSha256=' + args.conformanceSha256,
    'workflowV2NamedCases=' + String(args.legacyPassed.length),
    'completenessMigrationSha256=' + args.completenessMigrationSha256,
    'completenessConformanceSqlSha256=' + args.completenessSqlSha256,
    'completenessNamedCases=' + String(args.completenessPassed.length),
    'conversationMigrationSha256=' + args.conversationMigrationSha256,
    'conversationConformanceSqlSha256=' + args.conversationSqlSha256,
    'conversationNamedCases=' + String(passed.length),
    'contradictoryMigrationRollbackVerified=' + contradictionRejected,
    'preForwardHistoryRows=' + String(ledgerBeforeForward.count),
    'postForwardHistoryRows=' + String(ledgerAfterForward.historyCount),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'catalogUnchangedAcrossPopulatedReapply=' + catalogStable,
    'manifestRowsUnchangedAcrossPopulatedReapply=' + (rowCountsStable && rowContentsStable),
    'appmetaUnchangedAcrossPopulatedReapply=' + appmetaReapplyStable,
    'workflowLedgerUnchangedAcrossPopulatedReapply=' + (ledgerCountStable && ledgerContentsStable),
    ...args.legacyPassed.map((name) => 'legacyCase=' + name),
    ...args.completenessPassed.map((name) => 'completenessCase=' + name),
    ...passed.map((name) => 'conversationCase=' + name)
  ].join('\n'));
}

interface SnapshotProofPhaseArgs {
  options: Options;
  runDirectory: string;
  databaseName: string;
  deadlineAt: number;
  serverVersion: string;
  connectedUser: string;
  connectedRoleBypassRls: string;
  originalSha256: string;
  workflowSha256: string;
  conformanceSha256: string;
  completenessMigrationSha256: string;
  completenessSqlSha256: string;
  conversationMigrationSha256: string;
  conversationSqlSha256: string;
  snapshotProofMigrationSha256: string;
  snapshotProofSqlSha256: string;
  snapshotProofMigrationSnapshot: string;
  snapshotProofSqlSnapshot: string;
  expectedSnapshotProofCases: string[];
  legacyPassed: string[];
  completenessPassed: string[];
  conversationPassed: string[];
}

async function runSnapshotProofPhase(args: SnapshotProofPhaseArgs): Promise<void> {
  const fixtureSnapshot = join(args.runDirectory, 'snapshot-proof-legacy-fixtures.sql');
  await writeFile(fixtureSnapshot, SNAPSHOT_PROOF_LEGACY_FIXTURE_SQL, { encoding: 'utf8', flag: 'wx' });
  await runPsql(
    args.options, args.runDirectory, 'prepare-snapshot-proof-legacy-fixtures', args.databaseName,
    ['--file', fixtureSnapshot],
    args.deadlineAt
  );

  const stateBeforeForward = await captureMigrationState(
    args.options, args.runDirectory, 'before-snapshot-proof-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerBeforeForward = requireWorkflowLedger(stateBeforeForward, 'the conversation migration and its populated reapply');
  if (stateBeforeForward.tableCounts.get('review_snapshot_targets') !== 1n) {
    throw new Error('The populated pre-forward snapshot target fixture was not present in the owned database.');
  }

  const malformedTrials = [
    {
      label: 'evidence',
      field: 'evidence',
      valueSql: "jsonb_build_object('scope',jsonb_build_object('region','east','date','2026-10-04'),'asOf','not-an-instant')"
    },
    {
      label: 'sources',
      field: 'sources',
      valueSql: "jsonb_build_array(jsonb_build_object('id','workflow-pg-bad-source','system','synthetic','observedAt','not-an-instant','retrievedAt','2026-10-04T02:01:00.000Z','freshness','fresh','detail','Synthetic malformed nested source.'))"
    }
  ];
  for (const trial of malformedTrials) {
    const phase = `reject-malformed-historical-${trial.label}-snapshot-proof-migration`;
    await runPsql(
      args.options, args.runDirectory, `prepare-malformed-historical-${trial.label}-proof`, args.databaseName,
      ['--command', [
        'BEGIN;',
        'ALTER TABLE public.conversation_messages DISABLE TRIGGER workflow_guard;',
        'ALTER TABLE public.conversation_messages DISABLE TRIGGER nexus_revision;',
        `UPDATE public.conversation_messages SET payload=payload||jsonb_build_object('${trial.field}',${trial.valueSql}) WHERE id='workflow-pg-conversation-legacy-assistant';`,
        'ALTER TABLE public.conversation_messages ENABLE TRIGGER workflow_guard;',
        'ALTER TABLE public.conversation_messages ENABLE TRIGGER nexus_revision;',
        'COMMIT;'
      ].join(' ')],
      args.deadlineAt
    );
    const stateBeforeRejectedMigration = await captureMigrationState(
      args.options, args.runDirectory, `before-${trial.label}-snapshot-proof-rejection`, args.databaseName, args.deadlineAt,
      { includeCompletenessChild: true }
    );
    let rejectedForHistoricalProof = false;
    try {
      await runPsql(
        args.options, args.runDirectory, phase, args.databaseName,
        ['--file', args.snapshotProofMigrationSnapshot],
        args.deadlineAt
      );
    } catch (error) {
      const rejectionLog = await readFile(join(args.runDirectory, `${phase}.log`), 'utf8');
      if (!rejectionLog.includes('Workflow snapshot proof contains incompatible historical conversation proof')) {
        throw new Error('Malformed historical ' + trial.label + ' did not fail at its expected fail-closed adoption guard. '
          + (error instanceof Error ? error.message : String(error)));
      }
      rejectedForHistoricalProof = true;
    }
    if (!rejectedForHistoricalProof) {
      throw new Error('The snapshot proof migration adopted malformed historical ' + trial.label + ' data.');
    }
    const stateAfterRejectedMigration = await captureMigrationState(
      args.options, args.runDirectory, `after-${trial.label}-snapshot-proof-rejection`, args.databaseName, args.deadlineAt,
      { includeCompletenessChild: true }
    );
    if (!sameMigrationStateExactly(stateBeforeRejectedMigration, stateAfterRejectedMigration)) {
      throw new Error('Rejecting malformed historical ' + trial.label + ' changed schema, rows, appmeta revision or migration ledgers.');
    }
    await runPsql(
      args.options, args.runDirectory, `restore-historical-${trial.label}-fixture`, args.databaseName,
      ['--command', [
        'BEGIN;',
        'ALTER TABLE public.conversation_messages DISABLE TRIGGER workflow_guard;',
        'ALTER TABLE public.conversation_messages DISABLE TRIGGER nexus_revision;',
        `UPDATE public.conversation_messages SET payload=payload-'${trial.field}' WHERE id='workflow-pg-conversation-legacy-assistant';`,
        'ALTER TABLE public.conversation_messages ENABLE TRIGGER workflow_guard;',
        'ALTER TABLE public.conversation_messages ENABLE TRIGGER nexus_revision;',
        'COMMIT;'
      ].join(' ')],
      args.deadlineAt
    );
    const stateAfterFixtureRestore = await captureMigrationState(
      args.options, args.runDirectory, `after-${trial.label}-fixture-restore`, args.databaseName, args.deadlineAt,
      { includeCompletenessChild: true }
    );
    if (!sameMigrationStateExactly(stateBeforeForward, stateAfterFixtureRestore)) {
      throw new Error('Malformed historical ' + trial.label + ' probe did not restore the exact pre-forward database state.');
    }
  }

  await runPsql(
    args.options, args.runDirectory, 'apply-workflow-snapshot-proof-references-migration', args.databaseName,
    ['--file', args.snapshotProofMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterForward = await captureMigrationState(
    args.options, args.runDirectory, 'after-snapshot-proof-forward-migration', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true, preserveTableColumnsFrom: stateBeforeForward }
  );
  const ledgerAfterForward = requireWorkflowLedger(stateAfterForward, 'the snapshot proof forward migration');
  const oldTableCountsStable = sameTableCounts(stateBeforeForward.tableCounts, stateAfterForward.tableCounts);
  const oldTableRowsStable = sameTableRowFingerprints(stateBeforeForward.tableRowFingerprints, stateAfterForward.tableRowFingerprints);
  const appmetaStable = stateBeforeForward.revision === stateAfterForward.revision
    && stateBeforeForward.appmetaCount === stateAfterForward.appmetaCount
    && stateBeforeForward.appmetaContentFingerprint === stateAfterForward.appmetaContentFingerprint;
  const previousLedgerStable = ledgerBeforeForward.count === ledgerAfterForward.snapshotProofHistoryCount
    && ledgerBeforeForward.fingerprint === ledgerAfterForward.snapshotProofHistoryFingerprint;
  const forwardLedgerAddedOnce = ledgerAfterForward.count === ledgerBeforeForward.count + 1n;
  const completenessLedgerStable = stateBeforeForward.completenessLedgerCount === stateAfterForward.completenessLedgerCount
    && stateBeforeForward.completenessLedgerFingerprint === stateAfterForward.completenessLedgerFingerprint;
  const publicTablesStable = sameStringSet(stateBeforeForward.publicTableNames, stateAfterForward.publicTableNames);
  const addedColumns = [...stateAfterForward.tableColumns].flatMap(([table, columns]) => {
    const previous = new Set(stateBeforeForward.tableColumns.get(table) ?? []);
    return columns.filter((column) => !previous.has(column)).map((column) => `${table}.${column}`);
  }).sort();
  const onlySnapshotProofColumnsAdded = addedColumns.length === 4
    && addedColumns[0] === 'review_snapshot_targets.action_execution_contract_version'
    && addedColumns[1] === 'review_snapshot_targets.action_execution_id'
    && addedColumns[2] === 'review_snapshot_targets.directory_identity_id'
    && addedColumns[3] === 'review_snapshot_targets.responsibility_id';
  await writeFile(join(args.runDirectory, 'snapshot-proof-migration-preservation.txt'), [
    'status=compared-before-and-after-forward-migration',
    'preForwardSnapshotTargets=' + String(stateBeforeForward.tableCounts.get('review_snapshot_targets')),
    'historicalManifestRowsUnchanged=' + oldTableCountsStable,
    'historicalBodiesProjectionsAndVersionsUnchanged=' + oldTableRowsStable,
    'appmetaRevisionAndOtherFieldsUnchanged=' + appmetaStable,
    'historicalWorkflowLedgerEntriesUnchanged=' + previousLedgerStable,
    'forwardLedgerEntryAddedExactlyOnce=' + forwardLedgerAddedOnce,
    'completenessLedgerUnchanged=' + completenessLedgerStable,
    'publicTableSetUnchanged=' + publicTablesStable,
    'onlyExpectedNativeColumnsAdded=' + onlySnapshotProofColumnsAdded,
    'addedColumns=' + addedColumns.join(','),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'historicalLedgerRowsBeforeForward=' + String(ledgerBeforeForward.count),
    'historicalLedgerRowsAfterForward=' + String(ledgerAfterForward.snapshotProofHistoryCount),
    'forwardLedgerRowsAfterForward=' + String(ledgerAfterForward.count - ledgerBeforeForward.count),
    'malformedHistoricalEvidenceRejectedAndRolledBack=true',
    'malformedHistoricalSourcesRejectedAndRolledBack=true'
  ].join('\n'));
  if (!oldTableCountsStable || !oldTableRowsStable || !appmetaStable || !previousLedgerStable
    || !forwardLedgerAddedOnce || !completenessLedgerStable || !publicTablesStable || !onlySnapshotProofColumnsAdded) {
    throw new Error('The snapshot proof migration changed historical rows, revision or ledger history, or added an unexpected projection. See snapshot-proof-migration-preservation.txt.');
  }

  const conformance = await runPsql(
    args.options, args.runDirectory, 'workflow-snapshot-proof-references-conformance', args.databaseName,
    ['--file', args.snapshotProofSqlSnapshot],
    args.deadlineAt
  );
  const passed = conformance.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('CASE PASS: '))
    .map((line) => line.slice('CASE PASS: '.length));
  if (passed.length !== args.expectedSnapshotProofCases.length
    || args.expectedSnapshotProofCases.some((name, index) => passed[index] !== name)) {
    throw new Error('Expected ' + args.expectedSnapshotProofCases.length + ' named snapshot proof SQL cases in order; observed '
      + passed.length + '. See ' + conformance.logPath);
  }

  const stateBeforeReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-snapshot-proof-fixtures-before-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true }
  );
  const ledgerBeforeReapply = requireWorkflowLedger(stateBeforeReapply, 'the populated snapshot proof conformance cases');
  if (totalRows(stateBeforeReapply.tableCounts) <= totalRows(stateAfterForward.tableCounts)) {
    throw new Error('Snapshot proof SQL cases passed but committed no manifest rows for the populated reapply check.');
  }
  await runPsql(
    args.options, args.runDirectory, 'reapply-workflow-snapshot-proof-references-migration', args.databaseName,
    ['--file', args.snapshotProofMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-snapshot-proof-references-reapply', args.databaseName, args.deadlineAt,
    { includeCompletenessChild: true, preserveTableColumnsFrom: stateBeforeReapply }
  );
  const ledgerAfterReapply = requireWorkflowLedger(stateAfterReapply, 'the populated snapshot proof migration reapply');
  const populatedReapplyStable = sameMigrationStateExactly(stateBeforeReapply, stateAfterReapply);
  const populatedLedgerStable = ledgerBeforeReapply.count === ledgerAfterReapply.count
    && ledgerBeforeReapply.fingerprint === ledgerAfterReapply.fingerprint;
  await writeFile(join(args.runDirectory, 'snapshot-proof-migration-idempotency.txt'), [
    'status=compared-after-populated-snapshot-proof-conformance',
    'catalogRowsRevisionAndLedgersUnchanged=' + populatedReapplyStable,
    'workflowLedgerCountAndContentsUnchanged=' + populatedLedgerStable,
    'manifestRowsBeforeReapply=' + String(totalRows(stateBeforeReapply.tableCounts)),
    'manifestRowsAfterReapply=' + String(totalRows(stateAfterReapply.tableCounts)),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'workflowLedgerEntries=' + String(ledgerAfterReapply.count),
    'namedCases=' + String(passed.length)
  ].join('\n'));
  if (!populatedReapplyStable || !populatedLedgerStable) {
    throw new Error('Reapplying the snapshot proof migration changed catalog metadata, populated rows, appmeta revision or migration ledgers. See snapshot-proof-migration-idempotency.txt.');
  }

  await writeFile(join(args.runDirectory, 'snapshot-proof-phase.txt'), [
    'status=passed',
    'namedCases=' + String(passed.length),
    'migrationSha256=' + args.snapshotProofMigrationSha256,
    'conformanceSqlSha256=' + args.snapshotProofSqlSha256,
    'malformedHistoricalEvidenceRollbackVerified=true',
    'malformedHistoricalSourcesRollbackVerified=true',
    'preForwardBodiesVersionsRevisionAndHistoryPreserved=' + (oldTableRowsStable && appmetaStable && previousLedgerStable),
    'populatedReapplyStable=' + populatedReapplyStable,
    ...passed.map((name) => 'case=' + name)
  ].join('\n'));
  await writeFile(join(args.runDirectory, 'result.txt'), [
    'status=passed',
    'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
    'serverVersion=' + args.serverVersion,
    'connectedUser=' + args.connectedUser,
    'connectedRoleBypassRls=' + args.connectedRoleBypassRls,
    'originalMigrationSha256=' + args.originalSha256,
    'workflowV2MigrationSha256=' + args.workflowSha256,
    'workflowV2ConformanceSqlSha256=' + args.conformanceSha256,
    'workflowV2NamedCases=' + String(args.legacyPassed.length),
    'completenessMigrationSha256=' + args.completenessMigrationSha256,
    'completenessConformanceSqlSha256=' + args.completenessSqlSha256,
    'completenessNamedCases=' + String(args.completenessPassed.length),
    'conversationMigrationSha256=' + args.conversationMigrationSha256,
    'conversationConformanceSqlSha256=' + args.conversationSqlSha256,
    'conversationNamedCases=' + String(args.conversationPassed.length),
    'snapshotProofMigrationSha256=' + args.snapshotProofMigrationSha256,
    'snapshotProofConformanceSqlSha256=' + args.snapshotProofSqlSha256,
    'snapshotProofNamedCases=' + String(passed.length),
    'malformedHistoricalEvidenceRollbackVerified=true',
    'malformedHistoricalSourcesRollbackVerified=true',
    'preForwardHistoryRows=' + String(ledgerBeforeForward.count),
    'postForwardHistoryRows=' + String(ledgerAfterForward.snapshotProofHistoryCount),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'catalogRowsRevisionAndLedgersUnchangedAcrossPopulatedReapply=' + populatedReapplyStable,
    ...args.legacyPassed.map((name) => 'legacyCase=' + name),
    ...args.completenessPassed.map((name) => 'completenessCase=' + name),
    ...args.conversationPassed.map((name) => 'conversationCase=' + name),
    ...passed.map((name) => 'snapshotProofCase=' + name)
  ].join('\n'));
}

interface ActionTargetProvenancePhaseArgs {
  options: Options;
  runDirectory: string;
  databaseName: string;
  deadlineAt: number;
  serverVersion: string;
  connectedUser: string;
  connectedRoleBypassRls: string;
  originalSha256: string;
  workflowSha256: string;
  conformanceSha256: string;
  completenessMigrationSha256: string;
  completenessSqlSha256: string;
  conversationMigrationSha256: string;
  conversationSqlSha256: string;
  snapshotProofMigrationSha256: string;
  snapshotProofSqlSha256: string;
  actionTargetProvenanceMigrationSha256: string;
  actionTargetProvenanceSqlSha256: string;
  actionTargetProvenanceMigrationSnapshot: string;
  actionTargetProvenanceSqlSnapshot: string;
  expectedActionTargetProvenanceCases: string[];
  legacyPassed: string[];
  completenessPassed: string[];
  conversationPassed: string[];
  snapshotProofPassed: string[];
}

async function runActionTargetProvenancePhase(args: ActionTargetProvenancePhaseArgs): Promise<void> {
  const fixturePath = join(args.runDirectory, 'action-target-provenance-legacy-fixtures.sql');
  await writeFile(fixturePath, ACTION_TARGET_PROVENANCE_LEGACY_FIXTURE_SQL, { encoding: 'utf8', flag: 'wx' });
  await runPsql(
    args.options, args.runDirectory, 'prepare-action-target-provenance-legacy-fixtures', args.databaseName,
    ['--file', fixturePath],
    args.deadlineAt
  );

  let stateBeforeForward = await captureMigrationState(
    args.options, args.runDirectory, 'before-action-target-provenance-forward-migration', args.databaseName,
    args.deadlineAt, { includeCompletenessChild: true }
  );
  let ledgerBeforeForward = requireWorkflowLedger(stateBeforeForward, 'the snapshot proof migration and populated reapply');
  if (stateBeforeForward.tableCounts.size !== 62
    || stateBeforeForward.tableCounts.get('action_targets') !== 1n
    || stateBeforeForward.tableCounts.get('dashboard_shares') !== 3n
    || stateBeforeForward.publicTableNames.has('dashboard_share_revoke_events')) {
    throw new Error('The populated pre-forward action target/share fixtures or 62-table predecessor snapshot were not present.');
  }

  const malformedFixture = [
    'BEGIN;',
    "INSERT INTO public.dashboard_shares(id,row_version,workflow_contract_version,payload)",
    "SELECT 'workflow-pg-provenance-malformed-share',1,2,payload||jsonb_build_object(",
    "  'id','workflow-pg-provenance-malformed-share','rowVersion',1,",
    "  'semanticKey','workflow-pg-provenance-malformed-share-semantic')",
    "FROM public.dashboard_shares WHERE id='workflow-pg-share';",
    'SET CONSTRAINTS ALL IMMEDIATE;',
    'ALTER TABLE public.dashboard_shares DISABLE TRIGGER workflow_guard;',
    'ALTER TABLE public.dashboard_shares DISABLE TRIGGER nexus_revision;',
    "UPDATE public.dashboard_shares SET payload=payload||jsonb_build_object('rowVersion',2)",
    "WHERE id='workflow-pg-provenance-malformed-share';",
    'ALTER TABLE public.dashboard_shares ENABLE TRIGGER workflow_guard;',
    'ALTER TABLE public.dashboard_shares ENABLE TRIGGER nexus_revision;',
    'COMMIT;'
  ].join(' ');
  await runPsql(
    args.options, args.runDirectory, 'prepare-malformed-historical-action-share', args.databaseName,
    ['--command', malformedFixture],
    args.deadlineAt
  );
  const stateBeforeRejectedMigration = await captureMigrationState(
    args.options, args.runDirectory, 'before-malformed-action-share-rejection', args.databaseName,
    args.deadlineAt, { includeCompletenessChild: true }
  );
  let malformedHistoricalShareRejected = false;
  const malformedPhase = 'reject-malformed-historical-share-action-target-provenance-migration';
  try {
    await runPsql(
      args.options, args.runDirectory, malformedPhase, args.databaseName,
      ['--file', args.actionTargetProvenanceMigrationSnapshot],
      args.deadlineAt
    );
  } catch (error) {
    const rejectionLog = await readFile(join(args.runDirectory, `${malformedPhase}.log`), 'utf8');
    if (!rejectionLog.includes('Workflow action provenance contains incompatible historical share')) {
      throw new Error('Malformed historical share did not fail at its expected fail-closed adoption guard. '
        + (error instanceof Error ? error.message : String(error)));
    }
    malformedHistoricalShareRejected = true;
  }
  if (!malformedHistoricalShareRejected) {
    throw new Error('The action provenance migration adopted a malformed historical V2 share.');
  }
  const stateAfterRejectedMigration = await captureMigrationState(
    args.options, args.runDirectory, 'after-malformed-action-share-rejection', args.databaseName,
    args.deadlineAt, { includeCompletenessChild: true }
  );
  const malformedRollbackStable = sameMigrationStateExactly(stateBeforeRejectedMigration, stateAfterRejectedMigration);
  if (!malformedRollbackStable) {
    throw new Error('Rejecting malformed historical share changed schema, rows, appmeta revision or migration ledgers.');
  }

  const restoreMalformedFixture = [
    'BEGIN;',
    'ALTER TABLE public.dashboard_shares DISABLE TRIGGER workflow_guard;',
    'ALTER TABLE public.dashboard_shares DISABLE TRIGGER nexus_revision;',
    "DELETE FROM public.dashboard_shares WHERE id='workflow-pg-provenance-malformed-share';",
    'SET CONSTRAINTS ALL IMMEDIATE;',
    'ALTER TABLE public.dashboard_shares ENABLE TRIGGER workflow_guard;',
    'ALTER TABLE public.dashboard_shares ENABLE TRIGGER nexus_revision;',
    'COMMIT;'
  ].join(' ');
  await runPsql(
    args.options, args.runDirectory, 'restore-action-share-after-malformed-probe', args.databaseName,
    ['--command', restoreMalformedFixture],
    args.deadlineAt
  );
  const stateAfterFixtureRestore = await captureMigrationState(
    args.options, args.runDirectory, 'after-action-share-malformed-fixture-restore', args.databaseName,
    args.deadlineAt, { includeCompletenessChild: true }
  );
  const fixtureRestoredApartFromRevision = sameMigrationStateExceptRevision(stateBeforeForward, stateAfterFixtureRestore);
  if (!fixtureRestoredApartFromRevision) {
    throw new Error('The malformed historical share probe changed catalog, manifest rows, trigger modes, ledger or non-revision appmeta state.');
  }
  const malformedFixtureLifecycleRevisionDrift = stateAfterFixtureRestore.revision - stateBeforeForward.revision;
  stateBeforeForward = stateAfterFixtureRestore;
  ledgerBeforeForward = requireWorkflowLedger(stateBeforeForward, 'the restored populated pre-forward fixture state');

  await runPsql(
    args.options, args.runDirectory, 'apply-workflow-action-target-provenance-migration', args.databaseName,
    ['--file', args.actionTargetProvenanceMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterForward = await captureMigrationState(
    args.options, args.runDirectory, 'after-action-target-provenance-forward-migration', args.databaseName,
    args.deadlineAt, {
      includeCompletenessChild: true,
      preserveTableColumnsFrom: stateBeforeForward,
      expectedManifestTableCount: ACTION_TARGET_PROVENANCE_MANIFEST_TABLE_COUNT
    }
  );
  const ledgerAfterForward = requireWorkflowLedger(stateAfterForward, 'the action target provenance forward migration');
  const oldTableCountsStable = sameExistingTableCounts(stateBeforeForward.tableCounts, stateAfterForward.tableCounts);
  const oldTableRowsStable = sameExistingTableRowFingerprints(stateBeforeForward.tableRowFingerprints, stateAfterForward.tableRowFingerprints);
  const appmetaStable = stateBeforeForward.revision === stateAfterForward.revision
    && stateBeforeForward.appmetaCount === stateAfterForward.appmetaCount
    && stateBeforeForward.appmetaContentFingerprint === stateAfterForward.appmetaContentFingerprint;
  const previousLedgerStable = ledgerBeforeForward.count === ledgerAfterForward.actionTargetProvenanceHistoryCount
    && ledgerBeforeForward.fingerprint === ledgerAfterForward.actionTargetProvenanceHistoryFingerprint;
  const forwardLedgerAddedOnce = ledgerAfterForward.count === ledgerBeforeForward.count + 1n;
  const completenessLedgerStable = stateBeforeForward.completenessLedgerCount === stateAfterForward.completenessLedgerCount
    && stateBeforeForward.completenessLedgerFingerprint === stateAfterForward.completenessLedgerFingerprint;
  const addedPublicTables = differenceStringSets(stateAfterForward.publicTableNames, stateBeforeForward.publicTableNames);
  const removedPublicTables = differenceStringSets(stateBeforeForward.publicTableNames, stateAfterForward.publicTableNames);
  const publicTablesStable = addedPublicTables.length === 1
    && addedPublicTables[0] === 'dashboard_share_revoke_events' && removedPublicTables.length === 0;
  const addedColumns = [...stateAfterForward.tableColumns].flatMap(([table, columns]) => {
    const previous = new Set(stateBeforeForward.tableColumns.get(table) ?? []);
    return columns.filter((column) => !previous.has(column)).map((column) => `${table}.${column}`);
  }).sort();
  const expectedAddedColumns = [
    'action_targets.dashboard_share_contract_version',
    'action_targets.dashboard_share_id',
    'action_targets.investigation_case_id',
    'dashboard_share_revoke_events.actor_id',
    'dashboard_share_revoke_events.body',
    'dashboard_share_revoke_events.created_at',
    'dashboard_share_revoke_events.execution_contract_version',
    'dashboard_share_revoke_events.execution_id',
    'dashboard_share_revoke_events.id',
    'dashboard_share_revoke_events.prior_share_row_version',
    'dashboard_share_revoke_events.revoked_share_row_version',
    'dashboard_share_revoke_events.row_version',
    'dashboard_share_revoke_events.share_contract_version',
    'dashboard_share_revoke_events.share_creation_execution_contract_version',
    'dashboard_share_revoke_events.share_creation_execution_id',
    'dashboard_share_revoke_events.share_id',
    'dashboard_shares.pre_migration_revoke_quarantined',
    'dashboard_shares.workflow_revoke_creation_execution_id',
    'dashboard_shares.workflow_revoke_share_id',
    'dashboard_shares.workflow_revoke_share_row_version'
  ].sort();
  const onlyExpectedNativeColumnsAdded = expectedAddedColumns.length === addedColumns.length
    && expectedAddedColumns.every((column, index) => addedColumns[index] === column);
  const emptyForwardEventTable = stateAfterForward.tableCounts.get('dashboard_share_revoke_events') === 0n;
  await writeFile(join(args.runDirectory, 'action-target-provenance-migration-preservation.txt'), [
    'status=compared-before-and-after-forward-migration',
    'preForwardManifestTableCount=' + String(stateBeforeForward.tableCounts.size),
    'postForwardManifestTableCount=' + String(stateAfterForward.tableCounts.size),
    'preForwardActionTargets=' + String(stateBeforeForward.tableCounts.get('action_targets')),
    'preForwardDashboardShares=' + String(stateBeforeForward.tableCounts.get('dashboard_shares')),
    'historicalManifestRowsUnchanged=' + oldTableCountsStable,
    'historicalBodiesProjectionsAndVersionsUnchanged=' + oldTableRowsStable,
    'appmetaRevisionAndOtherFieldsUnchanged=' + appmetaStable,
    'historicalWorkflowLedgerEntriesUnchanged=' + previousLedgerStable,
    'preForwardFixtureRestoredExceptRevision=' + fixtureRestoredApartFromRevision,
    'malformedFixtureLifecycleRevisionDrift=' + String(malformedFixtureLifecycleRevisionDrift),
    'forwardLedgerEntryAddedExactlyOnce=' + forwardLedgerAddedOnce,
    'completenessLedgerUnchanged=' + completenessLedgerStable,
    'onlyRevokeEventTableAdded=' + publicTablesStable,
    'onlyExpectedNativeColumnsAdded=' + onlyExpectedNativeColumnsAdded,
    'addedColumns=' + addedColumns.join(','),
    'newRevokeEventRowsBeforeConformance=' + String(stateAfterForward.tableCounts.get('dashboard_share_revoke_events')),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'historicalLedgerRowsBeforeForward=' + String(ledgerBeforeForward.count),
    'historicalLedgerRowsAfterForward=' + String(ledgerAfterForward.actionTargetProvenanceHistoryCount),
    'forwardLedgerRowsAfterForward=' + String(ledgerAfterForward.count - ledgerBeforeForward.count),
    'malformedHistoricalShareRejectedAndRolledBack=' + malformedRollbackStable
  ].join('\n'));
  if (!oldTableCountsStable || !oldTableRowsStable || !appmetaStable || !previousLedgerStable
    || !forwardLedgerAddedOnce || !completenessLedgerStable || !publicTablesStable
    || !onlyExpectedNativeColumnsAdded || !emptyForwardEventTable) {
    throw new Error('The action provenance migration changed historical rows/revision/ledger history or added unexpected schema. See action-target-provenance-migration-preservation.txt.');
  }

  const conformance = await runPsql(
    args.options, args.runDirectory, 'workflow-action-target-provenance-conformance', args.databaseName,
    ['--file', args.actionTargetProvenanceSqlSnapshot],
    args.deadlineAt
  );
  const passed = conformance.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('CASE PASS: '))
    .map((line) => line.slice('CASE PASS: '.length));
  if (passed.length !== args.expectedActionTargetProvenanceCases.length
    || args.expectedActionTargetProvenanceCases.some((name, index) => passed[index] !== name)) {
    throw new Error('Expected ' + args.expectedActionTargetProvenanceCases.length
      + ' named action target provenance SQL cases in order; observed ' + passed.length + '. See ' + conformance.logPath);
  }

  const stateBeforeReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-action-target-provenance-fixtures-before-reapply', args.databaseName,
    args.deadlineAt, { includeCompletenessChild: true, expectedManifestTableCount: ACTION_TARGET_PROVENANCE_MANIFEST_TABLE_COUNT }
  );
  const ledgerBeforeReapply = requireWorkflowLedger(stateBeforeReapply, 'the populated action target provenance conformance cases');
  if (totalRows(stateBeforeReapply.tableCounts) <= totalRows(stateAfterForward.tableCounts)) {
    throw new Error('Action target provenance SQL cases passed but committed no manifest rows for the populated reapply check.');
  }
  await runPsql(
    args.options, args.runDirectory, 'reapply-workflow-action-target-provenance-migration', args.databaseName,
    ['--file', args.actionTargetProvenanceMigrationSnapshot],
    args.deadlineAt
  );
  const stateAfterReapply = await captureMigrationState(
    args.options, args.runDirectory, 'after-action-target-provenance-reapply', args.databaseName,
    args.deadlineAt, {
      includeCompletenessChild: true,
      preserveTableColumnsFrom: stateBeforeReapply,
      expectedManifestTableCount: ACTION_TARGET_PROVENANCE_MANIFEST_TABLE_COUNT
    }
  );
  const ledgerAfterReapply = requireWorkflowLedger(stateAfterReapply, 'the populated action target provenance migration reapply');
  const populatedReapplyStable = sameMigrationStateExactly(stateBeforeReapply, stateAfterReapply);
  const populatedLedgerStable = ledgerBeforeReapply.count === ledgerAfterReapply.count
    && ledgerBeforeReapply.fingerprint === ledgerAfterReapply.fingerprint;
  await writeFile(join(args.runDirectory, 'action-target-provenance-migration-idempotency.txt'), [
    'status=compared-after-populated-action-target-provenance-conformance',
    'catalogRowsRevisionAndLedgersUnchanged=' + populatedReapplyStable,
    'workflowLedgerCountAndContentsUnchanged=' + populatedLedgerStable,
    'manifestRowsBeforeReapply=' + String(totalRows(stateBeforeReapply.tableCounts)),
    'manifestRowsAfterReapply=' + String(totalRows(stateAfterReapply.tableCounts)),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'workflowLedgerEntries=' + String(ledgerAfterReapply.count),
    'namedCases=' + String(passed.length)
  ].join('\n'));
  if (!populatedReapplyStable || !populatedLedgerStable) {
    throw new Error('Reapplying action target provenance changed catalog metadata, populated rows, appmeta revision or migration ledgers. See action-target-provenance-migration-idempotency.txt.');
  }

  await writeFile(join(args.runDirectory, 'action-target-provenance-phase.txt'), [
    'status=passed',
    'namedCases=' + String(passed.length),
    'migrationSha256=' + args.actionTargetProvenanceMigrationSha256,
    'conformanceSqlSha256=' + args.actionTargetProvenanceSqlSha256,
    'malformedHistoricalShareRollbackVerified=true',
    'preForwardBodiesVersionsRevisionAndHistoryPreserved=' + (oldTableRowsStable && appmetaStable && previousLedgerStable),
    'populatedReapplyStable=' + populatedReapplyStable,
    ...passed.map((name) => 'case=' + name)
  ].join('\n'));
  await writeFile(join(args.runDirectory, 'result.txt'), [
    'status=passed',
    'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
    'serverVersion=' + args.serverVersion,
    'connectedUser=' + args.connectedUser,
    'connectedRoleBypassRls=' + args.connectedRoleBypassRls,
    'originalMigrationSha256=' + args.originalSha256,
    'workflowV2MigrationSha256=' + args.workflowSha256,
    'workflowV2ConformanceSqlSha256=' + args.conformanceSha256,
    'workflowV2NamedCases=' + String(args.legacyPassed.length),
    'completenessMigrationSha256=' + args.completenessMigrationSha256,
    'completenessConformanceSqlSha256=' + args.completenessSqlSha256,
    'completenessNamedCases=' + String(args.completenessPassed.length),
    'conversationMigrationSha256=' + args.conversationMigrationSha256,
    'conversationConformanceSqlSha256=' + args.conversationSqlSha256,
    'conversationNamedCases=' + String(args.conversationPassed.length),
    'snapshotProofMigrationSha256=' + args.snapshotProofMigrationSha256,
    'snapshotProofConformanceSqlSha256=' + args.snapshotProofSqlSha256,
    'snapshotProofNamedCases=' + String(args.snapshotProofPassed.length),
    'actionTargetProvenanceMigrationSha256=' + args.actionTargetProvenanceMigrationSha256,
    'actionTargetProvenanceConformanceSqlSha256=' + args.actionTargetProvenanceSqlSha256,
    'actionTargetProvenanceNamedCases=' + String(passed.length),
    'malformedHistoricalShareRollbackVerified=true',
    'preForwardHistoryRows=' + String(ledgerBeforeForward.count),
    'postForwardHistoryRows=' + String(ledgerAfterForward.actionTargetProvenanceHistoryCount),
    'revisionBeforeForward=' + String(stateBeforeForward.revision),
    'revisionAfterForward=' + String(stateAfterForward.revision),
    'revisionBeforeReapply=' + String(stateBeforeReapply.revision),
    'revisionAfterReapply=' + String(stateAfterReapply.revision),
    'catalogRowsRevisionAndLedgersUnchangedAcrossPopulatedReapply=' + populatedReapplyStable,
    ...args.legacyPassed.map((name) => 'legacyCase=' + name),
    ...args.completenessPassed.map((name) => 'completenessCase=' + name),
    ...args.conversationPassed.map((name) => 'conversationCase=' + name),
    ...args.snapshotProofPassed.map((name) => 'snapshotProofCase=' + name),
    ...passed.map((name) => 'actionTargetProvenanceCase=' + name)
  ].join('\n'));
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const standaloneV1Mode = Boolean(options.expectedPendingActionV1StandaloneSha256);
  const passfileStat = await stat(options.passfile);
  if (!passfileStat.isFile()) throw new Error('--passfile must name a file. Its contents are never read or printed.');
  const dataDirectoryStat = await stat(options.expectedDataDirectory);
  if (!dataDirectoryStat.isDirectory()) throw new Error('--expected-data-directory must name an existing directory.');
  const resolvedExpectedDataDirectory = await realpath(options.expectedDataDirectory);
  if (standaloneV1Mode) {
    const primaryRoot = await realpath(derivePrimaryRepositoryRoot());
    const canonicalScratchDataDirectory = await realpath(join(
      primaryRoot, '.local', 'postgres16-runtime', 'private', 'testdb'
    ));
    const canonicalPsqlPath = await realpath(join(
      primaryRoot, '.local', 'postgres16-runtime', 'pgsql', 'bin',
      process.platform === 'win32' ? 'psql.exe' : 'psql'
    ));
    const suppliedPsqlPath = await realpath(options.psql);
    if (normaliseWindowsPath(resolvedExpectedDataDirectory) !== normaliseWindowsPath(canonicalScratchDataDirectory)) {
      throw new Error('Standalone V1 mode requires the code-derived repository-private PostgreSQL data directory.');
    }
    if (normaliseWindowsPath(suppliedPsqlPath) !== normaliseWindowsPath(canonicalPsqlPath)) {
      throw new Error('Standalone V1 mode requires the matching repository-private PostgreSQL client executable.');
    }
  }
  const localSystemIdentifier = isAbsolute(options.psql)
    ? readPostgresSystemIdentifier(await realpath(options.psql), resolvedExpectedDataDirectory)
    : undefined;

  const runId = randomUUID();
  const databaseName = `${RUN_PREFIX}${runId.replaceAll('-', '')}`;
  if (!new RegExp(`^${RUN_PREFIX}[a-f0-9]{32}$`).test(databaseName)) {
    throw new Error('Generated database name failed its ownership-prefix guard.');
  }
  const localRoot = resolve(REPOSITORY_ROOT, '.local', 'pg-conformance');
  const runDirectory = join(localRoot, runId);
  await mkdir(localRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: false });

  const originalBytes = await readFile(resolve(REPOSITORY_ROOT, ORIGINAL_MIGRATION));
  const workflowBytes = standaloneV1Mode ? Buffer.alloc(0) : await readFile(resolve(REPOSITORY_ROOT, WORKFLOW_MIGRATION));
  const testBytes = standaloneV1Mode ? Buffer.alloc(0) : await readFile(resolve(REPOSITORY_ROOT, CONFORMANCE_SQL));
  const expectedCases = testBytes.length > 0 ? extractExpectedCases(testBytes) : [];
  const completenessMigrationBytes = options.expectedCompletenessSha256
    ? await readFile(resolve(REPOSITORY_ROOT, COMPLETENESS_MIGRATION)) : undefined;
  const completenessTestBytes = options.expectedCompletenessSha256
    ? await readFile(resolve(REPOSITORY_ROOT, COMPLETENESS_SQL)) : undefined;
  const expectedCompletenessCases = completenessTestBytes
    ? extractExpectedCaseCount(completenessTestBytes, EXPECTED_COMPLETENESS_CASE_COUNT, 'the completeness SQL') : [];
  const conversationMigrationBytes = options.expectedConversationSha256
    ? await readFile(resolve(REPOSITORY_ROOT, CONVERSATION_MIGRATION)) : undefined;
  const conversationTestBytes = options.expectedConversationSha256
    ? await readFile(resolve(REPOSITORY_ROOT, CONVERSATION_SQL)) : undefined;
  const expectedConversationCases = conversationTestBytes
    ? extractExpectedCaseCount(conversationTestBytes, EXPECTED_CONVERSATION_CASE_COUNT, 'the conversation persistence SQL') : [];
  const snapshotProofMigrationBytes = options.expectedSnapshotProofSha256
    ? await readFile(resolve(REPOSITORY_ROOT, SNAPSHOT_PROOF_MIGRATION)) : undefined;
  const snapshotProofTestBytes = options.expectedSnapshotProofSha256
    ? await readFile(resolve(REPOSITORY_ROOT, SNAPSHOT_PROOF_SQL)) : undefined;
  const expectedSnapshotProofCases = snapshotProofTestBytes
    ? extractExpectedCaseCount(snapshotProofTestBytes, EXPECTED_SNAPSHOT_PROOF_CASE_COUNT, 'the snapshot proof SQL') : [];
  const actionTargetProvenanceMigrationBytes = options.expectedActionTargetProvenanceSha256
    ? await readFile(resolve(REPOSITORY_ROOT, ACTION_TARGET_PROVENANCE_MIGRATION)) : undefined;
  const actionTargetProvenanceTestBytes = options.expectedActionTargetProvenanceSha256
    ? await readFile(resolve(REPOSITORY_ROOT, ACTION_TARGET_PROVENANCE_SQL)) : undefined;
  const expectedActionTargetProvenanceCases = actionTargetProvenanceTestBytes
    ? extractExpectedCaseCount(actionTargetProvenanceTestBytes, EXPECTED_ACTION_TARGET_PROVENANCE_CASE_COUNT,
      'the action target provenance SQL') : [];
  const pendingActionV1StandaloneMigrationBytes = options.expectedPendingActionV1StandaloneSha256
    ? await readFile(resolve(REPOSITORY_ROOT, PENDING_ACTION_V1_STANDALONE_MIGRATION)) : undefined;
  const pendingActionV1StandaloneSqlBytes = options.expectedPendingActionV1StandaloneSha256
    ? await readFile(resolve(REPOSITORY_ROOT, PENDING_ACTION_V1_STANDALONE_SQL)) : undefined;
  const expectedPendingActionV1StandaloneCases = pendingActionV1StandaloneSqlBytes
    ? extractExpectedNamedCases(pendingActionV1StandaloneSqlBytes, PENDING_ACTION_V1_STANDALONE_CASE_NAMES,
      'the standalone pending-action V1 guard SQL') : [];
  let originalIsClean = true;
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ORIGINAL_MIGRATION], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore'
    });
  } catch {
    originalIsClean = false;
  }
  const workflowSha256 = sha256(workflowBytes);
  const originalSha256 = sha256(originalBytes);
  const conformanceSha256 = sha256(testBytes);
  const completenessMigrationSha256 = completenessMigrationBytes ? sha256(completenessMigrationBytes) : undefined;
  const completenessSqlSha256 = completenessTestBytes ? sha256(completenessTestBytes) : undefined;
  const conversationMigrationSha256 = conversationMigrationBytes ? sha256(conversationMigrationBytes) : undefined;
  const conversationSqlSha256 = conversationTestBytes ? sha256(conversationTestBytes) : undefined;
  const snapshotProofMigrationSha256 = snapshotProofMigrationBytes ? sha256(snapshotProofMigrationBytes) : undefined;
  const snapshotProofSqlSha256 = snapshotProofTestBytes ? sha256(snapshotProofTestBytes) : undefined;
  const actionTargetProvenanceMigrationSha256 = actionTargetProvenanceMigrationBytes
    ? sha256(actionTargetProvenanceMigrationBytes) : undefined;
  const actionTargetProvenanceSqlSha256 = actionTargetProvenanceTestBytes ? sha256(actionTargetProvenanceTestBytes) : undefined;
  const pendingActionV1StandaloneMigrationSha256 = pendingActionV1StandaloneMigrationBytes
    ? sha256SqlSource(pendingActionV1StandaloneMigrationBytes) : undefined;
  const pendingActionV1StandaloneMigrationRawSha256 = pendingActionV1StandaloneMigrationBytes
    ? sha256Raw(pendingActionV1StandaloneMigrationBytes) : undefined;
  const pendingActionV1StandaloneSqlSha256 = pendingActionV1StandaloneSqlBytes
    ? sha256SqlSource(pendingActionV1StandaloneSqlBytes) : undefined;
  const pendingActionV1StandaloneSqlRawSha256 = pendingActionV1StandaloneSqlBytes
    ? sha256Raw(pendingActionV1StandaloneSqlBytes) : undefined;
  await writeFile(join(runDirectory, 'source-hash-provenance.txt'), [
    'standalone SQL SHA-256 normalizes CRLF to LF; existing V2 verification retains raw-byte hashes',
    'originalMigrationRawByteSha256=' + sha256Raw(originalBytes),
    'originalMigrationNormalizedSqlSha256=' + originalSha256,
    ...(workflowBytes.length > 0
      ? ['workflowV2MigrationRawByteSha256=' + sha256Raw(workflowBytes),
        'workflowV2MigrationNormalizedSqlSha256=' + workflowSha256] : ['workflowV2Assets=not-read']),
    ...(testBytes.length > 0
      ? ['workflowV2ConformanceSqlRawByteSha256=' + sha256Raw(testBytes),
        'workflowV2ConformanceSqlNormalizedSha256=' + conformanceSha256] : []),
    ...(completenessMigrationBytes && completenessMigrationSha256
      ? ['completenessMigrationRawByteSha256=' + sha256Raw(completenessMigrationBytes),
        'completenessMigrationNormalizedSqlSha256=' + completenessMigrationSha256] : []),
    ...(completenessTestBytes && completenessSqlSha256
      ? ['completenessSqlRawByteSha256=' + sha256Raw(completenessTestBytes),
        'completenessSqlNormalizedSha256=' + completenessSqlSha256] : []),
    ...(conversationMigrationBytes && conversationMigrationSha256
      ? ['conversationMigrationRawByteSha256=' + sha256Raw(conversationMigrationBytes),
        'conversationMigrationNormalizedSqlSha256=' + conversationMigrationSha256] : []),
    ...(conversationTestBytes && conversationSqlSha256
      ? ['conversationSqlRawByteSha256=' + sha256Raw(conversationTestBytes),
        'conversationSqlNormalizedSha256=' + conversationSqlSha256] : []),
    ...(snapshotProofMigrationBytes && snapshotProofMigrationSha256
      ? ['snapshotProofMigrationRawByteSha256=' + sha256Raw(snapshotProofMigrationBytes),
        'snapshotProofMigrationNormalizedSqlSha256=' + snapshotProofMigrationSha256] : []),
    ...(snapshotProofTestBytes && snapshotProofSqlSha256
      ? ['snapshotProofSqlRawByteSha256=' + sha256Raw(snapshotProofTestBytes),
        'snapshotProofSqlNormalizedSha256=' + snapshotProofSqlSha256] : []),
    ...(actionTargetProvenanceMigrationBytes && actionTargetProvenanceMigrationSha256
      ? ['actionTargetProvenanceMigrationRawByteSha256=' + sha256Raw(actionTargetProvenanceMigrationBytes),
        'actionTargetProvenanceMigrationNormalizedSqlSha256=' + actionTargetProvenanceMigrationSha256] : []),
    ...(actionTargetProvenanceTestBytes && actionTargetProvenanceSqlSha256
      ? ['actionTargetProvenanceSqlRawByteSha256=' + sha256Raw(actionTargetProvenanceTestBytes),
        'actionTargetProvenanceSqlNormalizedSha256=' + actionTargetProvenanceSqlSha256] : []),
    ...(pendingActionV1StandaloneMigrationBytes && pendingActionV1StandaloneMigrationSha256
      ? ['pendingActionV1StandaloneMigrationRawByteSha256=' + pendingActionV1StandaloneMigrationRawSha256,
        'pendingActionV1StandaloneMigrationNormalizedSqlSha256=' + pendingActionV1StandaloneMigrationSha256] : []),
    ...(pendingActionV1StandaloneSqlBytes && pendingActionV1StandaloneSqlSha256
      ? ['pendingActionV1StandaloneSqlRawByteSha256=' + pendingActionV1StandaloneSqlRawSha256,
        'pendingActionV1StandaloneSqlNormalizedSha256=' + pendingActionV1StandaloneSqlSha256] : [])
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  const originalSnapshot = join(runDirectory, 'original-migration.sql');
  const workflowSnapshot = join(runDirectory, 'workflow-v2-migration.sql');
  const conformanceSnapshot = join(runDirectory, 'workflow-v2-conformance.sql');
  const completenessMigrationSnapshot = join(runDirectory, 'workflow-completeness-migration.sql');
  const completenessSqlSnapshot = join(runDirectory, 'workflow-completeness-conformance.sql');
  const conversationMigrationSnapshot = join(runDirectory, 'workflow-conversation-persistence-migration.sql');
  const conversationSqlSnapshot = join(runDirectory, 'workflow-conversation-persistence-conformance.sql');
  const snapshotProofMigrationSnapshot = join(runDirectory, 'workflow-snapshot-proof-references-migration.sql');
  const snapshotProofSqlSnapshot = join(runDirectory, 'workflow-snapshot-proof-references-conformance.sql');
  const actionTargetProvenanceMigrationSnapshot = join(runDirectory, 'workflow-action-target-provenance-migration.sql');
  const actionTargetProvenanceSqlSnapshot = join(runDirectory, 'workflow-action-target-provenance-conformance.sql');
  const pendingActionV1StandaloneMigrationSnapshot = join(runDirectory, 'workflow-pending-action-v1-standalone-migration.sql');
  const pendingActionV1StandaloneSqlSnapshot = join(runDirectory, 'workflow-pending-action-v1-standalone-conformance.sql');
  const coreSnapshots = [writeFile(originalSnapshot, originalBytes, { flag: 'wx' })];
  if (workflowBytes.length > 0 && testBytes.length > 0) {
    coreSnapshots.push(writeFile(workflowSnapshot, workflowBytes, { flag: 'wx' }));
    coreSnapshots.push(writeFile(conformanceSnapshot, testBytes, { flag: 'wx' }));
  }
  await Promise.all(coreSnapshots);
  if (completenessMigrationBytes && completenessTestBytes) {
    await Promise.all([
      writeFile(completenessMigrationSnapshot, completenessMigrationBytes, { flag: 'wx' }),
      writeFile(completenessSqlSnapshot, completenessTestBytes, { flag: 'wx' })
    ]);
  }
  if (conversationMigrationBytes && conversationTestBytes) {
    await Promise.all([
      writeFile(conversationMigrationSnapshot, conversationMigrationBytes, { flag: 'wx' }),
      writeFile(conversationSqlSnapshot, conversationTestBytes, { flag: 'wx' })
    ]);
  }
  if (snapshotProofMigrationBytes && snapshotProofTestBytes) {
    await Promise.all([
      writeFile(snapshotProofMigrationSnapshot, snapshotProofMigrationBytes, { flag: 'wx' }),
      writeFile(snapshotProofSqlSnapshot, snapshotProofTestBytes, { flag: 'wx' })
    ]);
  }
  if (actionTargetProvenanceMigrationBytes && actionTargetProvenanceTestBytes) {
    await Promise.all([
      writeFile(actionTargetProvenanceMigrationSnapshot, actionTargetProvenanceMigrationBytes, { flag: 'wx' }),
      writeFile(actionTargetProvenanceSqlSnapshot, actionTargetProvenanceTestBytes, { flag: 'wx' })
    ]);
  }
  if (pendingActionV1StandaloneMigrationBytes && pendingActionV1StandaloneSqlBytes) {
    await Promise.all([
      writeFile(pendingActionV1StandaloneMigrationSnapshot, pendingActionV1StandaloneMigrationBytes, { flag: 'wx' }),
      writeFile(pendingActionV1StandaloneSqlSnapshot, pendingActionV1StandaloneSqlBytes, { flag: 'wx' })
    ]);
  }

  if (!originalIsClean) {
    await writeFile(join(runDirectory, 'preflight.log'), 'Original migration differs from HEAD; nothing was applied.\n');
    throw new Error(`Refusing to apply a changed original migration. Evidence: ${runDirectory}`);
  }
  if (!standaloneV1Mode && workflowSha256.toLowerCase() !== options.expectedV2Sha256) {
    await writeFile(join(runDirectory, 'preflight.log'), [
      'Frozen PostgreSQL migration SHA-256 mismatch; nothing was applied.',
      `expected=${options.expectedV2Sha256.toUpperCase()}`,
      `actual=${workflowSha256}`
    ].join('\n'));
    throw new Error(`Refusing to apply a workflow migration outside the supplied freeze hash. Evidence: ${runDirectory}`);
  }
  if (options.expectedPendingActionV1StandaloneSha256
    && (pendingActionV1StandaloneMigrationSha256?.toUpperCase() !== PENDING_ACTION_V1_STANDALONE_MIGRATION_SHA256
      || pendingActionV1StandaloneMigrationSha256?.toLowerCase() !== options.expectedPendingActionV1StandaloneSha256
      || pendingActionV1StandaloneSqlSha256?.toUpperCase() !== PENDING_ACTION_V1_STANDALONE_SQL_SHA256)) {
    await writeFile(join(runDirectory, 'preflight-pending-action-v1-standalone.log'), [
      'Pinned standalone PostgreSQL pending-action V1 migration or SQL SHA-256 mismatch; nothing was applied.',
      `expectedMigration=${PENDING_ACTION_V1_STANDALONE_MIGRATION_SHA256}`,
      `suppliedMigration=${options.expectedPendingActionV1StandaloneSha256.toUpperCase()}`,
      `actualMigrationNormalized=${pendingActionV1StandaloneMigrationSha256 ?? 'missing'}`,
      `actualMigrationRaw=${pendingActionV1StandaloneMigrationRawSha256 ?? 'missing'}`,
      `expectedSql=${PENDING_ACTION_V1_STANDALONE_SQL_SHA256}`,
      `actualSqlNormalized=${pendingActionV1StandaloneSqlSha256 ?? 'missing'}`,
      `actualSqlRaw=${pendingActionV1StandaloneSqlRawSha256 ?? 'missing'}`,
      'normalization=CRLF-to-LF'
    ].join('\n'));
    throw new Error(`Refusing to apply a standalone pending-action V1 migration/test outside their pinned freeze hashes. Evidence: ${runDirectory}`);
  }
  if (options.expectedCompletenessSha256 && completenessMigrationSha256?.toLowerCase() !== options.expectedCompletenessSha256) {
    await writeFile(join(runDirectory, 'preflight-completeness.log'), [
      'Frozen completeness migration SHA-256 mismatch; nothing was applied.',
      `expected=${options.expectedCompletenessSha256.toUpperCase()}`,
      `actual=${completenessMigrationSha256 ?? 'missing'}`
    ].join('\n'));
    throw new Error(`Refusing to apply a completeness migration outside the supplied freeze hash. Evidence: ${runDirectory}`);
  }
  if (options.expectedConversationSha256
    && (conversationMigrationSha256?.toUpperCase() !== CONVERSATION_MIGRATION_SHA256
      || conversationMigrationSha256?.toLowerCase() !== options.expectedConversationSha256)) {
    await writeFile(join(runDirectory, 'preflight-conversation.log'), [
      'Pinned PostgreSQL conversation migration SHA-256 mismatch; nothing was applied.',
      `expected=${CONVERSATION_MIGRATION_SHA256}`,
      `supplied=${options.expectedConversationSha256.toUpperCase()}`,
      `actual=${conversationMigrationSha256 ?? 'missing'}`
    ].join('\n'));
    throw new Error(`Refusing to apply a conversation migration outside its pinned freeze hash. Evidence: ${runDirectory}`);
  }
  if (options.expectedSnapshotProofSha256
    && (snapshotProofMigrationSha256?.toUpperCase() !== SNAPSHOT_PROOF_MIGRATION_SHA256
      || snapshotProofMigrationSha256?.toLowerCase() !== options.expectedSnapshotProofSha256)) {
    await writeFile(join(runDirectory, 'preflight-snapshot-proof.log'), [
      'Pinned PostgreSQL snapshot proof migration SHA-256 mismatch; nothing was applied.',
      `expected=${SNAPSHOT_PROOF_MIGRATION_SHA256}`,
      `supplied=${options.expectedSnapshotProofSha256.toUpperCase()}`,
      `actual=${snapshotProofMigrationSha256 ?? 'missing'}`
    ].join('\n'));
    throw new Error(`Refusing to apply a snapshot proof migration outside its pinned freeze hash. Evidence: ${runDirectory}`);
  }
  if (options.expectedActionTargetProvenanceSha256
    && (actionTargetProvenanceMigrationSha256?.toUpperCase() !== ACTION_TARGET_PROVENANCE_MIGRATION_SHA256
      || actionTargetProvenanceMigrationSha256?.toLowerCase() !== options.expectedActionTargetProvenanceSha256)) {
    await writeFile(join(runDirectory, 'preflight-action-target-provenance.log'), [
      'Pinned PostgreSQL action target provenance migration SHA-256 mismatch; nothing was applied.',
      `expected=${ACTION_TARGET_PROVENANCE_MIGRATION_SHA256 || 'not-frozen'}`,
      `supplied=${options.expectedActionTargetProvenanceSha256.toUpperCase()}`,
      `actual=${actionTargetProvenanceMigrationSha256 ?? 'missing'}`
    ].join('\n'));
    throw new Error(`Refusing to apply an action target provenance migration outside its pinned freeze hash. Evidence: ${runDirectory}`);
  }

  const deadlineAt = Date.now() + options.deadlineMs;
  const connectedRole = await runPsql(
    options, runDirectory, 'connected-role-check', 'postgres',
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT current_setting('server_version') || chr(9) || current_setting('data_directory') || chr(9) || current_user || chr(9) ||",
      "(SELECT rolsuper::text || ':' || rolbypassrls::text FROM pg_catalog.pg_roles WHERE rolname=current_user) || chr(9) || inet_server_port()::text || chr(9) ||",
      "(SELECT system_identifier::text FROM pg_catalog.pg_control_system())"
    ].join(' ')],
    deadlineAt
  );
  const preflightParts = connectedRole.stdout.trim().split('\t');
  const serverVersion = preflightParts[0] ?? '';
  const dataDirectory = preflightParts[1] ?? '';
  const connectedUser = preflightParts[2] ?? '';
  const connectedRoleFlags = preflightParts[3] ?? '';
  const connectedPort = preflightParts[4] ?? '';
  const connectedSystemIdentifier = preflightParts[5] ?? '';
  const [connectedRoleIsSuperuser, connectedRoleBypassRls] = connectedRoleFlags.split(':');
  if (!serverVersion.startsWith('16.15')) throw new Error(`Expected PostgreSQL 16.15; saw ${serverVersion || 'no version result'}.`);
  if (normaliseWindowsPath(dataDirectory) !== normaliseWindowsPath(resolvedExpectedDataDirectory)) {
    throw new Error(`PostgreSQL data directory did not match the resolved expected cluster. Evidence: ${connectedRole.logPath}`);
  }
  if (connectedUser !== 'postgres') throw new Error(`Expected to connect as postgres; saw ${connectedUser || 'no user result'}.`);
  if (connectedRoleIsSuperuser !== 'true') {
    throw new Error('The explicit database user must be a PostgreSQL superuser for the private-cluster bootstrap.');
  }
  if (connectedRoleBypassRls !== 'true' && connectedRoleBypassRls !== 'false') {
    throw new Error(`Could not determine the connected postgres role's BYPASSRLS flag. Evidence: ${connectedRole.logPath}`);
  }
  if (!/^[0-9]+$/.test(connectedPort) || Number(connectedPort) !== options.port) {
    throw new Error(`Connected PostgreSQL server port ${connectedPort || 'unknown'} did not match the requested loopback port.`);
  }
  if (!/^[0-9]+$/.test(connectedSystemIdentifier)
    || (localSystemIdentifier !== undefined && connectedSystemIdentifier !== localSystemIdentifier)) {
    throw new Error('Connected PostgreSQL system identifier did not match the local pg_controldata identity.');
  }
  await writeFile(join(runDirectory, 'cluster-identity.txt'), [
    'host=' + options.host,
    `serverPort=${connectedPort}`,
    `serverVersion=${serverVersion}`,
    `dataDirectory=${dataDirectory}`,
    `systemIdentifier=${connectedSystemIdentifier}`,
    `pgControlSystemIdentifier=${localSystemIdentifier ?? 'not-independently-checked'}`,
    `systemIdentifierMatch=${localSystemIdentifier === undefined ? 'not-checked' : String(connectedSystemIdentifier === localSystemIdentifier)}`,
    `connectedUser=${connectedUser}`,
    `connectedRoleIsSuperuser=${connectedRoleIsSuperuser}`,
    `connectedRoleBypassRls=${connectedRoleBypassRls}`
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });

  if (!standaloneV1Mode) {
    await runPsql(
      options, runDirectory, 'bootstrap-test-roles', 'postgres',
      ['--command', [
        'DO $bootstrap$ BEGIN',
        "IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='anon') THEN EXECUTE 'CREATE ROLE anon NOLOGIN'; END IF;",
        "IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='authenticated') THEN EXECUTE 'CREATE ROLE authenticated NOLOGIN'; END IF;",
        "IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE ROLE service_role NOLOGIN BYPASSRLS'; END IF;",
        'END; $bootstrap$;'
      ].join(' ')],
      deadlineAt
    );
  }

  const roleFlags = await runPsql(
    options, runDirectory, 'test-role-shape', 'postgres',
    ['--tuples-only', '--no-align', '--quiet', '--command', [
      "SELECT (SELECT rolsuper::text || ':' || rolbypassrls::text || ':' || rolcanlogin::text FROM pg_catalog.pg_roles WHERE rolname='anon') || chr(9) ||",
      "(SELECT rolsuper::text || ':' || rolbypassrls::text || ':' || rolcanlogin::text FROM pg_catalog.pg_roles WHERE rolname='authenticated') || chr(9) ||",
      "(SELECT rolsuper::text || ':' || rolbypassrls::text || ':' || rolcanlogin::text FROM pg_catalog.pg_roles WHERE rolname='service_role')"
    ].join(' ')],
    deadlineAt
  );
  if (roleFlags.stdout.trim() !== 'false:false:false\tfalse:false:false\tfalse:true:false') {
    throw new Error((standaloneV1Mode ? 'Standalone V1 requires' : 'Existing test roles are not')
      + ' the expected non-login anon/authenticated/service_role shapes with only service_role bypassing RLS.');
  }

  let databaseCreateAttempted = false;
  let databaseCreated = false;
  let primaryError: unknown;
  try {
    const priorDatabase = await runPsql(
      options, runDirectory, 'confirm-owned-database-name-absent', 'postgres',
      ['--tuples-only', '--no-align', '--quiet', '--command',
        `SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname='${databaseName}';`],
      deadlineAt
    );
    if (priorDatabase.stdout.trim() !== '0') {
      throw new Error('The generated scratch database name was already present; refusing to create or own it.');
    }
    databaseCreateAttempted = true;
    await runPsql(
      options, runDirectory, 'create-owned-database', 'postgres',
      ['--command', `CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8';`],
      deadlineAt
    );
    databaseCreated = true;

    await runPsql(options, runDirectory, 'apply-original-migration', databaseName, ['--file', originalSnapshot], deadlineAt);
    if (options.expectedPendingActionV1StandaloneSha256) {
      if (!pendingActionV1StandaloneMigrationSha256 || !pendingActionV1StandaloneMigrationRawSha256
        || !pendingActionV1StandaloneSqlSha256 || !pendingActionV1StandaloneSqlRawSha256) {
        throw new Error('Standalone V1 migration and SQL snapshots were not prepared.');
      }
      await runStandalonePendingActionV1Phase({
        options,
        runDirectory,
        databaseName,
        deadlineAt,
        migrationSnapshot: pendingActionV1StandaloneMigrationSnapshot,
        sqlSnapshot: pendingActionV1StandaloneSqlSnapshot,
        migrationSha256: pendingActionV1StandaloneMigrationSha256,
        migrationRawSha256: pendingActionV1StandaloneMigrationRawSha256,
        sqlSha256: pendingActionV1StandaloneSqlSha256,
        sqlRawSha256: pendingActionV1StandaloneSqlRawSha256,
        expectedCases: expectedPendingActionV1StandaloneCases
      });
    } else {
      await runPsql(options, runDirectory, 'apply-workflow-v2-migration', databaseName, ['--file', workflowSnapshot], deadlineAt);
      if (options.probeOnly) {
      const stateAfterFirstApply = await captureMigrationState(
        options, runDirectory, 'after-first-apply', databaseName, deadlineAt
      );
      if (totalRows(stateAfterFirstApply.tableCounts) !== 0n) {
        throw new Error('The fresh catalog-probe database unexpectedly contains workflow rows.');
      }
      await writeFile(join(runDirectory, 'catalog-probe.txt'), [
        'status=single-apply-snapshot',
        `catalogFingerprint=${stateAfterFirstApply.catalogFingerprint}`,
        `manifestTables=${stateAfterFirstApply.tableCounts.size}`,
        `manifestBusinessRows=${totalRows(stateAfterFirstApply.tableCounts)}`,
        `appmetaRows=${stateAfterFirstApply.appmetaCount}`,
        'appmetaContentFingerprintExcludesOnlyRevision=true',
        `responsibilitiesIndexMetadata=${stateAfterFirstApply.responsibilitiesIndexMetadata.replaceAll('\t', ' | ')}`,
        `revisionAfterFirstApply=${stateAfterFirstApply.revision}`,
        `workflowAdapterWrite=${stateAfterFirstApply.adapterWrite}`
      ].join('\n'));
      await writeFile(join(runDirectory, 'result.txt'), [
        'status=probe-passed',
        'evidence=catalog and empty-row-count query syntax only; no SQL conformance cases executed',
        `serverVersion=${serverVersion}`,
        `connectedUser=${connectedUser}`,
        `connectedRoleBypassRls=${connectedRoleBypassRls}`,
        `migrationSha256=${workflowSha256}`,
        `originalMigrationSha256=${originalSha256}`,
        `manifestTables=${stateAfterFirstApply.tableCounts.size}`,
        `manifestBusinessRows=${totalRows(stateAfterFirstApply.tableCounts)}`,
        `revisionAfterFirstApply=${stateAfterFirstApply.revision}`
      ].join('\n'));
      } else {
      const conformance = await runPsql(
        options, runDirectory, 'workflow-v2-conformance', databaseName,
        ['--set=KEEP_CONFORMANCE_ROWS=1', '--file', conformanceSnapshot],
        deadlineAt
      );
      const passed = conformance.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('CASE PASS: '))
        .map((line) => line.slice('CASE PASS: '.length));
      if (passed.length !== expectedCases.length || expectedCases.some((name, index) => passed[index] !== name)) {
        throw new Error(`Expected ${expectedCases.length} named SQL cases in order; observed ${passed.length}. See ${conformance.logPath}`);
      }

      const stateBeforeReapply = await captureMigrationState(
        options, runDirectory, 'after-fixtures-before-reapply', databaseName, deadlineAt
      );
      if (totalRows(stateBeforeReapply.tableCounts) === 0n) {
        throw new Error('Conformance cases passed but committed no manifest rows for the populated reapply check.');
      }
      await runPsql(options, runDirectory, 'reapply-workflow-v2-migration', databaseName, ['--file', workflowSnapshot], deadlineAt);
      const stateAfterReapply = await captureMigrationState(
        options, runDirectory, 'after-reapply', databaseName, deadlineAt
      );
      const catalogStable = stateBeforeReapply.catalogFingerprint === stateAfterReapply.catalogFingerprint;
      const rowCountsStable = sameTableCounts(stateBeforeReapply.tableCounts, stateAfterReapply.tableCounts);
      const rowContentsStable = sameTableRowFingerprints(
        stateBeforeReapply.tableRowFingerprints, stateAfterReapply.tableRowFingerprints
      );
      const appmetaRowsStable = stateBeforeReapply.appmetaCount === stateAfterReapply.appmetaCount;
      const appmetaOtherContentsStable = stateBeforeReapply.appmetaContentFingerprint
        === stateAfterReapply.appmetaContentFingerprint;
      const responsibilitiesIndexStable = stateBeforeReapply.responsibilitiesIndexMetadata
        === stateAfterReapply.responsibilitiesIndexMetadata;
      const revisionMonotonic = stateAfterReapply.revision >= stateBeforeReapply.revision;
      await writeFile(join(runDirectory, 'migration-idempotency.txt'), [
        'status=compared-after-populated-conformance',
        `catalogFingerprintUnchanged=${catalogStable}`,
        `manifestTableCountsUnchanged=${rowCountsStable}`,
        `manifestRowContentsUnchanged=${rowContentsStable}`,
        `appmetaRowCountUnchanged=${appmetaRowsStable}`,
        `appmetaContentsExcludingRevisionUnchanged=${appmetaOtherContentsStable}`,
        `responsibilitiesActiveIndexMetadataUnchanged=${responsibilitiesIndexStable}`,
        `responsibilitiesActiveIndexMetadataBefore=${stateBeforeReapply.responsibilitiesIndexMetadata.replaceAll('\t', ' | ')}`,
        `responsibilitiesActiveIndexMetadataAfter=${stateAfterReapply.responsibilitiesIndexMetadata.replaceAll('\t', ' | ')}`,
        'appmetaRevisionContentFieldExcludedOnly=true',
        `manifestBusinessRowsBefore=${totalRows(stateBeforeReapply.tableCounts)}`,
        `manifestBusinessRowsAfter=${totalRows(stateAfterReapply.tableCounts)}`,
        'appmetaRevisionExcludedFromRowContentFingerprint=true',
        `revisionBeforeReapply=${stateBeforeReapply.revision}`,
        `revisionAfterReapply=${stateAfterReapply.revision}`,
        `revisionDrift=${stateAfterReapply.revision - stateBeforeReapply.revision}`,
        `revisionMonotonic=${revisionMonotonic}`
      ].join('\n'));
      if (!revisionMonotonic || !catalogStable || !rowCountsStable || !rowContentsStable
        || !appmetaRowsStable || !appmetaOtherContentsStable || !responsibilitiesIndexStable) {
        throw new Error('Reapplying the workflow migration changed catalog definitions, manifest row counts or contents, non-revision appmeta contents, responsibilities index metadata, or moved the global revision backward. See migration-idempotency.txt.');
      }

      await writeFile(join(runDirectory, 'result.txt'), [
        'status=passed',
        'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
        `serverVersion=${serverVersion}`,
        `connectedUser=${connectedUser}`,
        `connectedRoleBypassRls=${connectedRoleBypassRls}`,
        `migrationSha256=${workflowSha256}`,
        `originalMigrationSha256=${originalSha256}`,
        `conformanceSqlSha256=${conformanceSha256}`,
        `revisionBeforeReapply=${stateBeforeReapply.revision}`,
        `revisionAfterReapply=${stateAfterReapply.revision}`,
        `revisionDrift=${stateAfterReapply.revision - stateBeforeReapply.revision}`,
        `catalogFingerprintUnchanged=${catalogStable}`,
        `manifestTableCountsUnchanged=${rowCountsStable}`,
        `manifestRowContentsUnchanged=${rowContentsStable}`,
        `appmetaRowCountUnchanged=${appmetaRowsStable}`,
        `appmetaContentsExcludingRevisionUnchanged=${appmetaOtherContentsStable}`,
        `responsibilitiesActiveIndexMetadataUnchanged=${responsibilitiesIndexStable}`,
        `responsibilitiesActiveIndexMetadataBefore=${stateBeforeReapply.responsibilitiesIndexMetadata.replaceAll('\t', ' | ')}`,
        `responsibilitiesActiveIndexMetadataAfter=${stateAfterReapply.responsibilitiesIndexMetadata.replaceAll('\t', ' | ')}`,
        'appmetaRevisionContentFieldExcludedOnly=true',
        `manifestBusinessRowsBefore=${totalRows(stateBeforeReapply.tableCounts)}`,
        `manifestBusinessRowsAfter=${totalRows(stateAfterReapply.tableCounts)}`,
        'appmetaRevisionExcludedFromRowContentFingerprint=true',
        `namedCases=${passed.length}`,
        ...passed.map((name) => `case=${name}`)
      ].join('\n'));
      if (options.expectedCompletenessSha256) {
        if (!completenessMigrationSha256 || !completenessSqlSha256) {
          throw new Error('The opt-in completeness migration snapshots were not prepared.');
        }
        await runCompletenessPhase({
          options,
          runDirectory,
          databaseName,
          deadlineAt,
          serverVersion,
          connectedUser,
          connectedRoleBypassRls,
          originalSha256,
          workflowSha256,
          conformanceSha256,
          completenessMigrationSha256,
          completenessSqlSha256,
          expectedCompletenessCases,
          completenessMigrationSnapshot,
          completenessSqlSnapshot,
          legacyPassed: passed,
          legacyStateBeforeReapply: stateBeforeReapply,
          legacyStateAfterReapply: stateAfterReapply
        });
        if (options.expectedConversationSha256) {
          if (!conversationMigrationSha256 || !conversationSqlSha256) {
            throw new Error('The opt-in conversation persistence snapshots were not prepared.');
          }
          await runConversationPersistencePhase({
            options,
            runDirectory,
            databaseName,
            deadlineAt,
            serverVersion,
            connectedUser,
            connectedRoleBypassRls,
            originalSha256,
            workflowSha256,
            conformanceSha256,
            completenessMigrationSha256: completenessMigrationSha256!,
            completenessSqlSha256: completenessSqlSha256!,
            conversationMigrationSha256,
            conversationSqlSha256,
            expectedConversationCases,
            conversationMigrationSnapshot,
            conversationSqlSnapshot,
            legacyPassed: passed,
            completenessPassed: expectedCompletenessCases
          });
          if (options.expectedSnapshotProofSha256) {
            if (!snapshotProofMigrationSha256 || !snapshotProofSqlSha256) {
              throw new Error('The opt-in snapshot proof persistence snapshots were not prepared.');
            }
            await runSnapshotProofPhase({
              options,
              runDirectory,
              databaseName,
              deadlineAt,
              serverVersion,
              connectedUser,
              connectedRoleBypassRls,
              originalSha256,
              workflowSha256,
              conformanceSha256,
              completenessMigrationSha256: completenessMigrationSha256!,
              completenessSqlSha256: completenessSqlSha256!,
              conversationMigrationSha256,
              conversationSqlSha256,
              snapshotProofMigrationSha256,
              snapshotProofSqlSha256,
              snapshotProofMigrationSnapshot,
              snapshotProofSqlSnapshot,
              expectedSnapshotProofCases,
              legacyPassed: passed,
              completenessPassed: expectedCompletenessCases,
              conversationPassed: expectedConversationCases
            });
            if (options.expectedActionTargetProvenanceSha256) {
              if (!actionTargetProvenanceMigrationSha256 || !actionTargetProvenanceSqlSha256) {
                throw new Error('The opt-in action target provenance snapshots were not prepared.');
              }
              await runActionTargetProvenancePhase({
                options,
                runDirectory,
                databaseName,
                deadlineAt,
                serverVersion,
                connectedUser,
                connectedRoleBypassRls,
                originalSha256,
                workflowSha256,
                conformanceSha256,
                completenessMigrationSha256: completenessMigrationSha256!,
                completenessSqlSha256: completenessSqlSha256!,
                conversationMigrationSha256,
                conversationSqlSha256,
                snapshotProofMigrationSha256,
                snapshotProofSqlSha256,
                actionTargetProvenanceMigrationSha256,
                actionTargetProvenanceSqlSha256,
                actionTargetProvenanceMigrationSnapshot,
                actionTargetProvenanceSqlSnapshot,
                expectedActionTargetProvenanceCases,
                legacyPassed: passed,
                completenessPassed: expectedCompletenessCases,
                conversationPassed: expectedConversationCases,
                snapshotProofPassed: expectedSnapshotProofCases
              });
            }
          }
        }
      }
      }
    }
  } catch (error) {
    primaryError = error;
    await writeFile(join(runDirectory, 'result.txt'), [
      'status=failed',
      'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
      `serverVersion=${serverVersion}`,
      `connectedUser=${connectedUser}`,
      `connectedRoleBypassRls=${connectedRoleBypassRls}`,
      ...(workflowSha256 ? [`migrationSha256=${workflowSha256}`] : ['workflowV2Migration=not-read']),
      `originalMigrationSha256=${originalSha256}`,
      ...(conformanceSha256 ? [`conformanceSqlSha256=${conformanceSha256}`] : ['workflowV2ConformanceSql=not-read']),
      ...(completenessMigrationSha256 ? ['completenessMigrationSha256=' + completenessMigrationSha256] : []),
      ...(completenessSqlSha256 ? ['completenessSqlSha256=' + completenessSqlSha256] : []),
      ...(conversationMigrationSha256 ? ['conversationMigrationSha256=' + conversationMigrationSha256] : []),
      ...(conversationSqlSha256 ? ['conversationSqlSha256=' + conversationSqlSha256] : []),
      ...(snapshotProofMigrationSha256 ? ['snapshotProofMigrationSha256=' + snapshotProofMigrationSha256] : []),
      ...(snapshotProofSqlSha256 ? ['snapshotProofSqlSha256=' + snapshotProofSqlSha256] : []),
      ...(actionTargetProvenanceMigrationSha256 ? ['actionTargetProvenanceMigrationSha256=' + actionTargetProvenanceMigrationSha256] : []),
      ...(actionTargetProvenanceSqlSha256 ? ['actionTargetProvenanceSqlSha256=' + actionTargetProvenanceSqlSha256] : []),
      ...(pendingActionV1StandaloneMigrationSha256 ? ['standaloneV1MigrationSha256=' + pendingActionV1StandaloneMigrationSha256] : []),
      ...(pendingActionV1StandaloneMigrationRawSha256 ? ['standaloneV1MigrationRawByteSha256=' + pendingActionV1StandaloneMigrationRawSha256] : []),
      ...(pendingActionV1StandaloneSqlSha256 ? ['standaloneV1SqlSha256=' + pendingActionV1StandaloneSqlSha256] : []),
      ...(pendingActionV1StandaloneSqlRawSha256 ? ['standaloneV1SqlRawByteSha256=' + pendingActionV1StandaloneSqlRawSha256] : []),
      `error=${error instanceof Error ? error.message : String(error)}`
    ].join('\n'));
  } finally {
    if (databaseCreateAttempted && !databaseCreated) {
      try {
        const cleanupIdentity = await runPsql(
          options, runDirectory, 'reconcile-ambiguous-database-create-cluster-identity', 'postgres',
          ['--tuples-only', '--no-align', '--quiet', '--command', [
            "SELECT current_setting('data_directory') || chr(9) || inet_server_port()::text || chr(9) ||",
            "(SELECT system_identifier::text FROM pg_catalog.pg_control_system()) || chr(9) || current_user"
          ].join(' ')],
          Date.now() + CLEANUP_TIMEOUT_MS,
          CLEANUP_TIMEOUT_MS
        );
        const [cleanupDataDirectory, cleanupPort, cleanupSystemIdentifier, cleanupUser]
          = cleanupIdentity.stdout.trim().split('\t');
        if (localSystemIdentifier === undefined
          || normaliseWindowsPath(cleanupDataDirectory ?? '') !== normaliseWindowsPath(resolvedExpectedDataDirectory)
          || cleanupPort !== connectedPort || cleanupSystemIdentifier !== localSystemIdentifier
          || cleanupSystemIdentifier !== connectedSystemIdentifier || cleanupUser !== connectedUser) {
          throw new Error('The server identity no longer matches the independently verified scratch cluster.');
        }

        const candidateState = await runPsql(
          options, runDirectory, 'reconcile-ambiguous-database-create-owned-name', 'postgres',
          ['--tuples-only', '--no-align', '--quiet', '--command', [
            `SELECT CASE WHEN count(*)=0 THEN 'absent' WHEN count(*)=1 AND bool_and(datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND NOT datistemplate AND datname='${databaseName}') THEN 'owned' ELSE 'unowned' END`,
            `FROM pg_catalog.pg_database WHERE datname='${databaseName}';`
          ].join(' ')],
          Date.now() + CLEANUP_TIMEOUT_MS,
          CLEANUP_TIMEOUT_MS
        );
        const state = candidateState.stdout.trim();
        if (state === 'owned') databaseCreated = true;
        else if (state !== 'absent') throw new Error('The generated database name exists but ownership could not be proven.');
        await writeFile(join(runDirectory, 'database-create-reconciliation.txt'), [
          'createResult=ambiguous',
          `serverDataDirectory=${cleanupDataDirectory}`,
          `serverPort=${cleanupPort}`,
          `serverSystemIdentifier=${cleanupSystemIdentifier}`,
          `databaseName=${databaseName}`,
          `databaseOwnership=${state}`,
          `ownedScratchDatabaseWillBeDropped=${databaseCreated}`
        ].join('\n'), { encoding: 'utf8', flag: 'wx' });
      } catch (reconciliationError) {
        const previous = primaryError instanceof Error ? `${primaryError.message}\n` : '';
        const reconciliationFailure = new Error(`${previous}Could not safely reconcile the ambiguous scratch database create: ${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}. Database: ${databaseName}`);
        primaryError = reconciliationFailure;
        await writeFile(join(runDirectory, 'result.txt'), [
          'status=failed',
          'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
          `database=${databaseName}`,
          'databaseCreateOutcome=ambiguous',
          'databaseCleanup=refused-without-cluster-and-owned-name-proof',
          `error=${reconciliationFailure.message}`
        ].join('\n'));
      }
    }
    if (databaseCreated) {
      try {
        await runPsql(
          options, runDirectory, 'drop-owned-database', 'postgres',
          ['--command', `DROP DATABASE "${databaseName}" WITH (FORCE);`],
          Date.now() + CLEANUP_TIMEOUT_MS,
          CLEANUP_TIMEOUT_MS
        );
      } catch (cleanupError) {
        const previous = primaryError instanceof Error ? `${primaryError.message}\n` : '';
        const cleanupFailure = new Error(`${previous}Owned database cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Database: ${databaseName}`);
        primaryError = cleanupFailure;
        await writeFile(join(runDirectory, 'result.txt'), [
          'status=failed',
          'evidence=local PostgreSQL SQL conformance only; not hosted Supabase platform proof',
          `database=${databaseName}`,
          `error=${cleanupFailure.message}`
        ].join('\n'));
      }
    }
  }

  if (primaryError) throw primaryError;
  if (options.expectedPendingActionV1StandaloneSha256) {
    console.log('Standalone PostgreSQL V1 conformance passed: 8 named cases, same-file reapply, and altered-digest rollback.');
    console.log('Only 010001 + standalone 010002 were applied; the V2 chain was not applied.');
    console.log(`Migration SHA-256: ${PENDING_ACTION_V1_STANDALONE_MIGRATION_SHA256}; database ${databaseName} was dropped; evidence: ${runDirectory}`);
    return;
  }
  if (options.expectedActionTargetProvenanceSha256) {
    console.log('Local PostgreSQL SQL conformance passed: '
      + EXPECTED_CASE_COUNT + ' legacy + ' + EXPECTED_COMPLETENESS_CASE_COUNT + ' completeness + '
      + EXPECTED_CONVERSATION_CASE_COUNT + ' conversation + ' + EXPECTED_SNAPSHOT_PROOF_CASE_COUNT
      + ' snapshot proof + ' + EXPECTED_ACTION_TARGET_PROVENANCE_CASE_COUNT
      + ' action target provenance named cases, plus 3 malformed-history rollback checks.');
    console.log('PostgreSQL: ' + serverVersion + '; connected user: ' + connectedUser
      + '; BYPASSRLS: ' + connectedRoleBypassRls + '; action target provenance migration SHA-256: '
      + ACTION_TARGET_PROVENANCE_MIGRATION_SHA256 + '.');
    console.log('Owned database ' + databaseName + ' was dropped; snapshots and logs: ' + runDirectory);
    console.log('This is PostgreSQL SQL conformance, not hosted Supabase platform proof.');
    return;
  }
  if (options.expectedSnapshotProofSha256) {
    console.log('Local PostgreSQL SQL conformance passed: '
      + EXPECTED_CASE_COUNT + ' legacy + ' + EXPECTED_COMPLETENESS_CASE_COUNT + ' completeness + '
      + EXPECTED_CONVERSATION_CASE_COUNT + ' conversation + ' + EXPECTED_SNAPSHOT_PROOF_CASE_COUNT
      + ' snapshot proof named cases, plus 2 malformed-history rollback checks.');
    console.log('PostgreSQL: ' + serverVersion + '; connected user: ' + connectedUser
      + '; BYPASSRLS: ' + connectedRoleBypassRls + '; snapshot proof migration SHA-256: ' + SNAPSHOT_PROOF_MIGRATION_SHA256 + '.');
    console.log('Owned database ' + databaseName + ' was dropped; snapshots and logs: ' + runDirectory);
    console.log('This is PostgreSQL SQL conformance, not hosted Supabase platform proof.');
    return;
  }
  if (options.expectedConversationSha256) {
    console.log('Local PostgreSQL SQL conformance passed: '
      + EXPECTED_CASE_COUNT + ' legacy + ' + EXPECTED_COMPLETENESS_CASE_COUNT + ' completeness + '
      + EXPECTED_CONVERSATION_CASE_COUNT + ' conversation named cases.');
    console.log('PostgreSQL: ' + serverVersion + '; connected user: ' + connectedUser
      + '; BYPASSRLS: ' + connectedRoleBypassRls + '; conversation migration SHA-256: ' + CONVERSATION_MIGRATION_SHA256 + '.');
    console.log('Owned database ' + databaseName + ' was dropped; snapshots and logs: ' + runDirectory);
    console.log('This is PostgreSQL SQL conformance, not hosted Supabase platform proof.');
    return;
  }
  if (options.expectedCompletenessSha256) {
    console.log('Local PostgreSQL SQL conformance passed: '
      + EXPECTED_CASE_COUNT + ' legacy + ' + EXPECTED_COMPLETENESS_CASE_COUNT + ' completeness named cases.');
    console.log('PostgreSQL: ' + serverVersion + '; connected user: ' + connectedUser
      + '; BYPASSRLS: ' + connectedRoleBypassRls + '; workflow-v2 migration SHA-256: ' + workflowSha256
      + '; completeness migration SHA-256: ' + options.expectedCompletenessSha256.toUpperCase() + '.');
    console.log('Owned database ' + databaseName + ' was dropped; snapshots and logs: ' + runDirectory);
    console.log('This is PostgreSQL SQL conformance, not hosted Supabase platform proof.');
    return;
  }
  if (options.probeOnly) {
    console.log('Local PostgreSQL catalog/row-count syntax probe passed; zero conformance cases were executed.');
    console.log(`Owned database ${databaseName} was dropped; snapshots and logs: ${runDirectory}`);
    return;
  }
  console.log(`Local PostgreSQL SQL conformance passed: ${EXPECTED_CASE_COUNT}/${EXPECTED_CASE_COUNT} named cases.`);
  console.log(`PostgreSQL: ${serverVersion}; connected user: ${connectedUser}; BYPASSRLS: ${connectedRoleBypassRls}; migration SHA-256: ${workflowSha256}.`);
  console.log(`Owned database ${databaseName} was dropped; snapshots and logs: ${runDirectory}`);
  console.log('This is PostgreSQL SQL conformance, not hosted Supabase platform proof.');
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedScriptUrl === import.meta.url) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

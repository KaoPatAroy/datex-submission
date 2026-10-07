-- Local PostgreSQL SQL conformance only. This does not prove hosted Supabase
-- Auth, Data API, policy, or deployment behavior.
\set ON_ERROR_STOP 1
\echo CONFORMANCE: native action source references and attributed share-revoke provenance

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

DO $case$
DECLARE
  action_reference_columns integer;
  action_v2_marker boolean;
  share_quarantine_column boolean;
  share_revoke_columns integer;
  event_columns integer;
  event_marker_columns integer;
  action_reference_fks integer;
  action_share_v2_fk boolean;
  event_foreign_keys integer;
  event_scalar_foreign_keys integer;
  event_v2_foreign_keys integer;
  event_rls_enabled boolean;
  event_access_guard boolean;
  share_event_fk boolean;
  event_share_fk boolean;
  provenance_guards integer;
  unique_indexes integer;
BEGIN
  SELECT count(*) INTO action_reference_columns
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='public.action_targets'::regclass
    AND a.attname IN ('investigation_case_id','dashboard_share_id')
    AND a.atttypid='text'::regtype AND NOT a.attnotnull AND a.attgenerated=''
    AND a.attnum>0 AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.action_targets'::regclass
      AND a.attname='dashboard_share_contract_version'
      AND a.atttypid='integer'::regtype AND NOT a.attnotnull AND a.attgenerated='s'
      AND lower(regexp_replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'[()[:space:]]','','g'))
        ='casewhendashboard_share_idisnotnullthen2elsenull::integerend'
  ) INTO action_v2_marker;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.dashboard_shares'::regclass
      AND a.attname='pre_migration_revoke_quarantined'
      AND a.atttypid='integer'::regtype AND a.attnotnull AND a.attgenerated=''
      AND pg_catalog.pg_get_expr(d.adbin,d.adrelid) IN ('0','0::integer')
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid=a.attrelid AND c.contype='c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%pre_migration_revoke_quarantined%'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%0%'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%1%'
      )
  ) INTO share_quarantine_column;

  SELECT count(*) INTO share_revoke_columns
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.dashboard_shares'::regclass
    AND a.attname IN ('workflow_revoke_share_id','workflow_revoke_share_row_version','workflow_revoke_creation_execution_id')
    AND a.attgenerated='s' AND a.attnum>0 AND NOT a.attisdropped;

  SELECT count(*) INTO event_columns
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='public.dashboard_share_revoke_events'::regclass
    AND a.attname IN ('id','row_version','body','share_id','actor_id','execution_id',
      'share_creation_execution_id','prior_share_row_version','revoked_share_row_version','created_at',
      'share_contract_version','execution_contract_version','share_creation_execution_contract_version')
    AND a.attnum>0 AND NOT a.attisdropped;

  SELECT count(*) INTO event_marker_columns
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.dashboard_share_revoke_events'::regclass
    AND a.attname IN ('share_contract_version','execution_contract_version','share_creation_execution_contract_version')
    AND a.atttypid='integer'::regtype AND a.attgenerated='s';

  SELECT count(*) INTO action_reference_fks
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.action_targets'::regclass AND c.contype='f' AND c.convalidated
    AND c.condeferrable AND c.condeferred AND c.confdeltype='a' AND c.confupdtype='a'
    AND c.conname IN (
      'wf_action_targets_investigation_case_id_fk',
      'wf_action_targets_dashboard_share_id_fk',
      'wf_action_targets_dashboard_share_id_contract_fk');

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.action_targets'::regclass
      AND c.conname='wf_action_targets_dashboard_share_id_contract_fk'
      AND c.contype='f' AND c.condeferrable AND c.condeferred
      AND c.confrelid='public.dashboard_shares'::regclass
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='dashboard_share_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='dashboard_share_contract_version')
      ]::smallint[]
      AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='workflow_contract_version')
      ]::smallint[]
  ) INTO action_share_v2_fk;

  SELECT count(*) INTO event_foreign_keys
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.dashboard_share_revoke_events'::regclass
    AND c.contype='f' AND c.convalidated AND c.confdeltype='a' AND c.confupdtype='a';

  SELECT count(*) INTO event_scalar_foreign_keys
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.dashboard_share_revoke_events'::regclass
    AND c.contype='f' AND array_length(c.conkey,1)=1
    AND c.confrelid IN ('public.dashboard_shares'::regclass,'public.profiles'::regclass,
      'public.action_executions'::regclass);

  SELECT count(*) INTO event_v2_foreign_keys
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.dashboard_share_revoke_events'::regclass
    AND c.contype='f' AND array_length(c.conkey,1)=2
    AND c.condeferrable AND c.condeferred AND c.confdeltype='a' AND c.confupdtype='a'
    AND ((c.confrelid='public.dashboard_shares'::regclass AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_contract_version')
      ]::smallint[] AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='workflow_contract_version')
      ]::smallint[])
      OR (c.confrelid='public.action_executions'::regclass AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='execution_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='execution_contract_version')
      ]::smallint[] AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='workflow_contract_version')
      ]::smallint[])
      OR (c.confrelid='public.action_executions'::regclass AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_creation_execution_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_creation_execution_contract_version')
      ]::smallint[] AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='workflow_contract_version')
      ]::smallint[]));

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.dashboard_shares'::regclass
      AND c.conname='wf_dashboard_shares_revoke_event_fk'
      AND c.contype='f' AND c.condeferrable AND c.condeferred
      AND c.confdeltype='a' AND c.confupdtype='a'
      AND c.confrelid='public.dashboard_share_revoke_events'::regclass
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='workflow_revoke_share_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='workflow_revoke_share_row_version'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='workflow_revoke_creation_execution_id')
      ]::smallint[]
      AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='share_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='revoked_share_row_version'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='share_creation_execution_id')
      ]::smallint[]
  ) INTO share_event_fk;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.dashboard_share_revoke_events'::regclass
      AND c.conname='wf_dashboard_share_revoke_events_share_version_creation_fk'
      AND c.contype='f' AND c.condeferrable AND c.condeferred
      AND c.confdeltype='a' AND c.confupdtype='a'
      AND c.confrelid='public.dashboard_shares'::regclass
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='revoked_share_row_version'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='share_creation_execution_id')
      ]::smallint[]
      AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='row_version'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='execution_id')
      ]::smallint[]
  ) INTO event_share_fk;

  SELECT count(*) INTO provenance_guards
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
  WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN ('action_targets','dashboard_shares','dashboard_share_revoke_events')
    AND t.tgname='workflow_action_provenance_guard' AND t.tgenabled IN ('O','A')
    AND NOT t.tgisinternal AND p.oid='nexus_private.workflow_action_provenance_guard()'::regprocedure;

  SELECT count(*) INTO unique_indexes
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
  WHERE i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    AND x.relname IN (
      'dashboard_shares_revoke_version_creation_unique',
      'dashboard_share_revoke_events_share_unique',
      'dashboard_share_revoke_events_execution_unique',
      'dashboard_share_revoke_events_version_creation_unique')
    AND (SELECT array_agg(a.attname::text ORDER BY k.position)
      FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
      =CASE x.relname
        WHEN 'dashboard_shares_revoke_version_creation_unique' THEN ARRAY['id','row_version','execution_id']::text[]
        WHEN 'dashboard_share_revoke_events_share_unique' THEN ARRAY['share_id']::text[]
        WHEN 'dashboard_share_revoke_events_execution_unique' THEN ARRAY['execution_id']::text[]
        WHEN 'dashboard_share_revoke_events_version_creation_unique' THEN ARRAY[
          'share_id','revoked_share_row_version','share_creation_execution_id']::text[]
      END;

  SELECT c.relrowsecurity INTO event_rls_enabled
  FROM pg_catalog.pg_class c WHERE c.oid='public.dashboard_share_revoke_events'::regclass;
  SELECT NOT has_table_privilege('anon','public.dashboard_share_revoke_events','SELECT')
    AND NOT has_table_privilege('anon','public.dashboard_share_revoke_events','INSERT')
    AND NOT has_table_privilege('anon','public.dashboard_share_revoke_events','UPDATE')
    AND NOT has_table_privilege('anon','public.dashboard_share_revoke_events','DELETE')
    AND NOT has_table_privilege('authenticated','public.dashboard_share_revoke_events','SELECT')
    AND NOT has_table_privilege('authenticated','public.dashboard_share_revoke_events','INSERT')
    AND NOT has_table_privilege('authenticated','public.dashboard_share_revoke_events','UPDATE')
    AND NOT has_table_privilege('authenticated','public.dashboard_share_revoke_events','DELETE')
    AND has_table_privilege('service_role','public.dashboard_share_revoke_events','SELECT')
    AND has_table_privilege('service_role','public.dashboard_share_revoke_events','INSERT')
    AND has_table_privilege('service_role','public.dashboard_share_revoke_events','UPDATE')
    AND has_table_privilege('service_role','public.dashboard_share_revoke_events','DELETE')
    INTO event_access_guard;

  IF action_reference_columns<>2 OR action_v2_marker IS DISTINCT FROM true
    OR share_quarantine_column IS DISTINCT FROM true OR share_revoke_columns<>3
    OR event_columns<>13 OR event_marker_columns<>3 OR action_reference_fks<>3
    OR action_share_v2_fk IS DISTINCT FROM true OR event_foreign_keys<>8
    OR event_scalar_foreign_keys<>4 OR event_v2_foreign_keys<>3
    OR share_event_fk IS DISTINCT FROM true
    OR event_share_fk IS DISTINCT FROM true OR provenance_guards<>3 OR unique_indexes<>4
    OR event_rls_enabled IS DISTINCT FROM true OR event_access_guard IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'action provenance native columns, tagged V2 FKs, paired event constraints, unique indexes, guard, or row security are incomplete: action refs %, marker %, quarantine %, share refs %, event cols %, event markers %, action FKs %, action V2 FK %, event FKs %, scalar event FKs %, V2 event FKs %, inverse FK %, reverse FK %, guards %, unique indexes %, RLS %, role grants %',
      action_reference_columns,action_v2_marker,share_quarantine_column,share_revoke_columns,event_columns,
      event_marker_columns,action_reference_fks,action_share_v2_fk,event_foreign_keys,
      event_scalar_foreign_keys,event_v2_foreign_keys,share_event_fk,event_share_fk,
      provenance_guards,unique_indexes,event_rls_enabled,event_access_guard;
  END IF;
END
$case$;
\echo CASE PASS: native investigation/share references and paired V2 revoke constraints are installed

DO $case$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.action_targets t
    WHERE t.id='workflow-pg-provenance-legacy-branch-target'
      AND t.row_version=1 AND t.execution_id='workflow-pg-snapshot-proof-execution'
      AND t.entity_type='branches' AND t.target_id='workflow-pg-ordered-cas-branch'
      AND t.branch_id='workflow-pg-ordered-cas-branch'
      AND t.investigation_case_id IS NULL AND t.dashboard_share_id IS NULL
      AND t.dashboard_share_contract_version IS NULL
      AND t.body->'ref'->>'table'='branches'
      AND t.body->'ref'->>'id'='workflow-pg-ordered-cas-branch'
      AND num_nonnulls(t.branch_id,t.inventory_snapshot_id,t.incident_id,t.employee_id,t.badge_id,
        t.dashboard_version_id,t.opportunity_id,t.onboarding_request_id,t.onboarding_document_id,
        t.onboarding_event_id,t.offboarding_case_id,t.offboarding_plan_id,t.asset_assignment_id,
        t.contract_id,t.policy_document_id,t.investigation_case_id,t.dashboard_share_id)=1
  ) THEN
    RAISE EXCEPTION 'the populated pre-forward action target did not retain its source identity and exact-one native reference';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.dashboard_shares s
    WHERE s.id='workflow-pg-provenance-legacy-revoked-share'
      AND s.row_version=2 AND s.workflow_contract_version=2
      AND s.status='revoked' AND s.execution_id='workflow-pg-execution'
      AND s.payload->>'executionId'='workflow-pg-execution'
      AND s.payload->>'revokedAt'='2026-10-04T02:32:00.000Z'
      AND s.pre_migration_revoke_quarantined=1
      AND s.workflow_revoke_share_id IS NULL
      AND s.workflow_revoke_share_row_version IS NULL
      AND s.workflow_revoke_creation_execution_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events e WHERE e.share_id=s.id)
  ) THEN
    RAISE EXCEPTION 'the pre-forward revoked V2 share was changed or received fabricated revoke proof instead of quarantine';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.dashboard_shares s
    WHERE s.id='workflow-pg-share' AND s.row_version=1 AND s.status='active'
      AND s.execution_id='workflow-pg-execution' AND s.payload->>'executionId'='workflow-pg-execution'
      AND s.pre_migration_revoke_quarantined=0
      AND s.workflow_revoke_share_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.dashboard_shares s
    WHERE s.id='workflow-pg-provenance-forged-share' AND s.row_version=1 AND s.status='active'
      AND s.workflow_contract_version=2
      AND s.execution_id='workflow-pg-snapshot-proof-execution'
      AND s.payload->>'executionId'='workflow-pg-snapshot-proof-execution'
      AND s.pre_migration_revoke_quarantined=0
      AND s.workflow_revoke_share_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events e WHERE e.share_id=s.id)
  ) OR NOT EXISTS (
    SELECT 1 FROM public.action_executions e
    WHERE e.id='workflow-pg-execution' AND e.workflow_contract_version=2
      AND e.payload->>'kind'='investigation_create'
  ) THEN
    RAISE EXCEPTION 'the original share creation receipt or active share changed during provenance adoption';
  END IF;
END
$case$;
\echo CASE PASS: historical target and share bodies persist with one-time quarantine and no fabricated event

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  v_share_id constant text:='workflow-pg-provenance-valid-share';
  v_numeric_share_id constant text:='987';
  v_numeric_dashboard_id constant text:='123';
  v_numeric_recipient_id constant text:='456';
  v_numeric_version_id constant text:='workflow-pg-numeric-dashboard-version';
  v_numeric_creator_action_id constant text:='workflow-pg-numeric-share-create-action';
  v_numeric_creator_root_id constant text:='workflow-pg-numeric-share-create-root';
  v_numeric_creator_execution_id constant text:='workflow-pg-numeric-share-create-execution';
  v_numeric_revoke_action_id constant text:='workflow-pg-numeric-share-revoke-action';
  v_numeric_revoke_root_id constant text:='workflow-pg-numeric-share-revoke-root';
  v_numeric_revoke_execution_id constant text:='workflow-pg-numeric-share-revoke-execution';
  v_creation_action_id constant text:='workflow-pg-share-create-action';
  v_creation_root_id constant text:='workflow-pg-share-create-root';
  v_creation_execution_id constant text:='workflow-pg-share-create-execution';
  v_action_id constant text:='workflow-pg-share-revoke-action';
  v_root_id constant text:='workflow-pg-share-revoke-root';
  v_execution_id constant text:='workflow-pg-share-revoke-execution';
  v_case_id constant text:='workflow-pg-case';
  v_actor_profile_id text;
  share_body jsonb;
  base_share jsonb;
  case_version bigint;
  base_action jsonb;
  action_body jsonb;
  expected_rows jsonb;
  create_expected_rows jsonb;
  root_body jsonb;
  receipt_body jsonb;
  creation_proof jsonb;
BEGIN
  SELECT profile_id INTO STRICT v_actor_profile_id
  FROM public.directory_identities WHERE id='workflow-pg-sender';
  SELECT payload INTO STRICT base_share FROM public.dashboard_shares WHERE id='workflow-pg-share';
  SELECT row_version INTO STRICT case_version FROM public.investigation_cases WHERE id=v_case_id;
  SELECT payload INTO STRICT base_action FROM public.pending_actions
  WHERE id='workflow-pg-action' AND workflow_contract_version=2;

  share_body:=base_share||jsonb_build_object(
    'id',v_share_id,'rowVersion',1,'semanticKey','workflow-pg-provenance-valid-share-semantic',
    'executionId',v_creation_execution_id,'createdAt','2026-10-04T02:36:00.000Z',
    'status','active','revokedAt',NULL);

  create_expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','dashboard_versions','id','workflow-pg-dashboard-version'),
    'rowVersion',1,'state',NULL));
  action_body:=base_action||jsonb_build_object(
    'id',v_creation_action_id,
    'payload',jsonb_build_object('kind','dashboard_share','dashboardId',share_body->>'dashboardId',
      'recipientIdentityId',share_body->>'recipientIdentityId','channel',share_body->>'channel',
      'subject','Synthetic SQL share creation','body','Synthetic reviewed share body.'),
    'payloadHash',repeat('9',64),'idempotencyKey',repeat('8',64),
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId',v_share_id,'ref',jsonb_build_object('table','dashboard_versions','id','workflow-pg-dashboard-version'),
      'semanticKey','workflow-pg-dashboard-share-create:'||v_share_id,
      'expectedRows',create_expected_rows,'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','dashboard_shares','id',v_share_id),
      'expectedEffectVersion',1)),
    'targetCount',1,'expectedRows',create_expected_rows,
    'approvedBranchIds',share_body->'approvedBranchIds',
    'createdAt','2026-10-04T02:35:00.000Z','expiresAt','2026-10-04T03:35:00.000Z','status','pending');
  INSERT INTO public.pending_actions(id,row_version,workflow_contract_version,payload)
  VALUES (v_creation_action_id,1,2,action_body);

  root_body:=jsonb_build_object(
    'id',v_creation_root_id,'rowVersion',1,'actorId',v_actor_profile_id,'idempotencyKey',repeat('7',64),
    'activeExecutionId',NULL,'actionId',v_creation_action_id,'createdAt','2026-10-04T02:35:01.000Z','status','open');
  INSERT INTO public.action_idempotency_roots(id,row_version,body)
  VALUES (v_creation_root_id,1,root_body);
  receipt_body:=jsonb_build_object(
    'id',v_creation_execution_id,'actionId',v_creation_action_id,'contractVersion',2,
    'actorId',v_actor_profile_id,'kind','dashboard_share','outcome','pending',
    'proofs',jsonb_build_array(),'createdAt','2026-10-04T02:36:00.000Z',
    'verifiedAt',NULL,'currentStates',jsonb_build_array());
  INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
  VALUES (v_creation_execution_id,1,2,v_creation_root_id,1,receipt_body);
  root_body:=root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',v_creation_execution_id);
  UPDATE public.action_idempotency_roots SET row_version=2,body=root_body WHERE id=v_creation_root_id;
  INSERT INTO public.dashboard_shares(id,row_version,workflow_contract_version,payload)
  VALUES (v_share_id,1,2,share_body);
  creation_proof:=jsonb_build_object(
    'targetId',v_share_id,'ref',jsonb_build_object('table','dashboard_shares','id',v_share_id),
    'outcome','verified_success','executionId',v_creation_execution_id,
    'observedRowVersion',1,'checkedAt','2026-10-04T02:36:01.000Z','mismatchCodes',jsonb_build_array());
  receipt_body:=receipt_body||jsonb_build_object(
    'outcome','verified_success','verifiedAt','2026-10-04T02:36:01.000Z',
    'proofs',jsonb_build_array(creation_proof));
  UPDATE public.action_executions SET row_version=2,payload=receipt_body WHERE id=v_creation_execution_id;

  expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','dashboard_shares','id',v_share_id),
    'rowVersion',1,'state','active'));
  action_body:=base_action||jsonb_build_object(
    'id',v_action_id,'payload',jsonb_build_object('kind','dashboard_share_revoke','shareId',v_share_id),
    'payloadHash',repeat('c',64),'idempotencyKey',repeat('e',64),
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId',v_share_id,'ref',jsonb_build_object('table','dashboard_shares','id',v_share_id),
      'semanticKey','workflow-pg-share-revoke:'||v_share_id,
      'expectedRows',expected_rows,'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','dashboard_shares','id',v_share_id),
      'expectedEffectVersion',2)),
    'targetCount',1,'expectedRows',expected_rows,'createdAt','2026-10-04T02:33:00.000Z',
    'expiresAt','2026-10-04T03:33:00.000Z','status','pending');
  INSERT INTO public.pending_actions(id,row_version,workflow_contract_version,payload)
  VALUES (v_action_id,1,2,action_body);

  root_body:=jsonb_build_object(
    'id',v_root_id,'rowVersion',1,'actorId',v_actor_profile_id,'idempotencyKey',repeat('f',64),
    'activeExecutionId',NULL,'actionId',v_action_id,'createdAt','2026-10-04T02:33:01.000Z','status','open');
  INSERT INTO public.action_idempotency_roots(id,row_version,body)
  VALUES (v_root_id,1,root_body);
  receipt_body:=jsonb_build_object(
    'id',v_execution_id,'actionId',v_action_id,'contractVersion',2,
    'actorId',v_actor_profile_id,'kind','dashboard_share_revoke','outcome','pending',
    'proofs',jsonb_build_array(),'createdAt','2026-10-04T02:33:02.000Z',
    'verifiedAt',NULL,'currentStates',jsonb_build_array());
  INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
  VALUES (v_execution_id,1,2,v_root_id,1,receipt_body);
  root_body:=root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',v_execution_id);
  UPDATE public.action_idempotency_roots SET row_version=2,body=root_body WHERE id=v_root_id;

  INSERT INTO public.action_targets(id,row_version,body) VALUES
    ('workflow-pg-provenance-case-target',1,jsonb_build_object(
      'id','workflow-pg-provenance-case-target','rowVersion',1,'executionId',v_execution_id,
      'targetId',v_case_id,'entityType','investigation_cases','expectedRowVersion',case_version,
      'expectedState','open','targetStatus','pending',
      'ref',jsonb_build_object('table','investigation_cases','id',v_case_id))),
    ('workflow-pg-provenance-share-target',1,jsonb_build_object(
      'id','workflow-pg-provenance-share-target','rowVersion',1,'executionId',v_execution_id,
      'targetId',v_share_id,'entityType','dashboard_shares','expectedRowVersion',1,
      'expectedState','active','targetStatus','pending',
      'ref',jsonb_build_object('table','dashboard_shares','id',v_share_id)));

  IF NOT EXISTS (
    SELECT 1 FROM public.dashboard_shares s
    JOIN public.action_executions x ON x.id=s.execution_id AND x.workflow_contract_version=2
    JOIN public.pending_actions a ON a.id=x.action_id AND a.workflow_contract_version=2
    WHERE s.id=v_share_id AND s.row_version=1 AND s.workflow_contract_version=2
      AND s.execution_id=v_creation_execution_id AND s.payload->>'createdAt'=x.payload->>'createdAt'
      AND x.row_version=2 AND x.payload->>'kind'='dashboard_share'
      AND x.payload->>'outcome'='verified_success' AND x.payload->>'actorId'=v_actor_profile_id
      AND jsonb_array_length(x.payload->'proofs')=1
      AND x.payload->'proofs'->0->>'outcome'='verified_success'
      AND x.payload->'proofs'->0->'ref'->>'table'='dashboard_shares'
      AND x.payload->'proofs'->0->'ref'->>'id'=s.id
      AND x.payload->'proofs'->0->>'executionId'=s.execution_id
      AND x.payload->'proofs'->0->>'observedRowVersion'='1'
      AND a.payload->>'actorId'=v_actor_profile_id
      AND a.payload->'payload'->>'kind'='dashboard_share'
      AND a.payload->'payload'->>'dashboardId'=s.payload->>'dashboardId'
      AND a.payload->'payload'->>'recipientIdentityId'=s.payload->>'recipientIdentityId'
      AND a.payload->'payload'->>'channel'=s.payload->>'channel'
      AND a.payload->'targets'->0->'expectedEffectRef'->>'table'='dashboard_shares'
      AND a.payload->'targets'->0->'expectedEffectRef'->>'id'=s.id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.action_targets t
    WHERE t.id='workflow-pg-provenance-case-target' AND t.investigation_case_id=v_case_id
      AND t.dashboard_share_id IS NULL AND t.dashboard_share_contract_version IS NULL
      AND t.body->'ref'->>'table'='investigation_cases'
      AND num_nonnulls(t.branch_id,t.inventory_snapshot_id,t.incident_id,t.employee_id,t.badge_id,
        t.dashboard_version_id,t.opportunity_id,t.onboarding_request_id,t.onboarding_document_id,
        t.onboarding_event_id,t.offboarding_case_id,t.offboarding_plan_id,t.asset_assignment_id,
        t.contract_id,t.policy_document_id,t.investigation_case_id,t.dashboard_share_id)=1
  ) OR NOT EXISTS (
    SELECT 1 FROM public.action_targets t
    WHERE t.id='workflow-pg-provenance-share-target' AND t.dashboard_share_id=v_share_id
      AND t.dashboard_share_contract_version=2 AND t.investigation_case_id IS NULL
      AND t.body->'ref'->>'table'='dashboard_shares'
      AND t.body->'ref'->>'id'=v_share_id
      AND num_nonnulls(t.branch_id,t.inventory_snapshot_id,t.incident_id,t.employee_id,t.badge_id,
        t.dashboard_version_id,t.opportunity_id,t.onboarding_request_id,t.onboarding_document_id,
        t.onboarding_event_id,t.offboarding_case_id,t.offboarding_plan_id,t.asset_assignment_id,
        t.contract_id,t.policy_document_id,t.investigation_case_id,t.dashboard_share_id)=1
  ) THEN
    RAISE EXCEPTION 'investigation-case and V2 share action targets did not project one exact tagged native source reference';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: investigation cases and V2 shares persist as exactly-one tagged action target sources

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  share_body jsonb;
  case_version bigint;
  current_revision bigint;
  rejected_zero boolean:=false;
  rejected_missing_case boolean:=false;
  rejected_projection_tamper boolean:=false;
  rejected_creation_execution_change boolean:=false;
  rejected_quarantine_override boolean:=false;
BEGIN
  SELECT row_version INTO STRICT case_version FROM public.investigation_cases WHERE id='workflow-pg-case';
  SELECT payload INTO STRICT share_body FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share';
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.action_targets(id,row_version,body) VALUES (
      'workflow-pg-provenance-zero-target',1,jsonb_build_object(
        'id','workflow-pg-provenance-zero-target','rowVersion',1,
        'executionId','workflow-pg-share-revoke-execution','targetId','workflow-pg-zero-source',
        'entityType','investigation_cases','expectedRowVersion',case_version,'expectedState','open',
        'targetStatus','pending','ref',jsonb_build_object('table','investigation_cases','id',NULL)));
  EXCEPTION WHEN check_violation THEN
    rejected_zero:=true;
  END;
  BEGIN
    INSERT INTO public.action_targets(id,row_version,body) VALUES (
      'workflow-pg-provenance-missing-case-target',1,jsonb_build_object(
        'id','workflow-pg-provenance-missing-case-target','rowVersion',1,
        'executionId','workflow-pg-share-revoke-execution','targetId','workflow-pg-missing-case',
        'entityType','investigation_cases','expectedRowVersion',1,'expectedState','open',
        'targetStatus','pending','ref',jsonb_build_object('table','investigation_cases','id','workflow-pg-missing-case')));
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_missing_case:=false;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_missing_case:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  BEGIN
    INSERT INTO public.action_targets(id,row_version,dashboard_share_id,body) VALUES (
      'workflow-pg-provenance-tampered-source-target',1,'workflow-pg-share',jsonb_build_object(
        'id','workflow-pg-provenance-tampered-source-target','rowVersion',1,
        'executionId','workflow-pg-share-revoke-execution','targetId','workflow-pg-tampered-source',
        'entityType','investigation_cases','expectedRowVersion',case_version,'expectedState','open',
        'targetStatus','pending','ref',jsonb_build_object('table','investigation_cases','id','workflow-pg-case')));
  EXCEPTION WHEN check_violation THEN
    rejected_projection_tamper:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected_zero OR NOT rejected_missing_case OR NOT rejected_projection_tamper
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>current_revision
    OR EXISTS (SELECT 1 FROM public.action_targets WHERE id IN (
      'workflow-pg-provenance-zero-target','workflow-pg-provenance-missing-case-target',
      'workflow-pg-provenance-tampered-source-target')) THEN
    RAISE EXCEPTION 'zero, missing, or contradictory action-target sources were accepted or left partial rows';
  END IF;
  BEGIN
    UPDATE public.dashboard_shares
    SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'executionId','workflow-pg-share-revoke-execution')
    WHERE id='workflow-pg-provenance-valid-share';
  EXCEPTION WHEN check_violation THEN
    rejected_creation_execution_change:=true;
  END;
  BEGIN
    UPDATE public.dashboard_shares SET pre_migration_revoke_quarantined=1
    WHERE id='workflow-pg-provenance-valid-share';
  EXCEPTION WHEN check_violation THEN
    rejected_quarantine_override:=true;
  END;
  IF NOT rejected_creation_execution_change OR NOT rejected_quarantine_override
    OR (SELECT payload FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share') IS DISTINCT FROM share_body
    OR (SELECT pre_migration_revoke_quarantined FROM public.dashboard_shares
        WHERE id='workflow-pg-provenance-valid-share')<>0
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>current_revision THEN
    RAISE EXCEPTION 'active share creation execution or migration-only quarantine value was mutable';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: target source guards and active-share creation/quarantine fields reject tampering

RESET ROLE;
DO $case$
DECLARE
  v_share_id constant text:='workflow-pg-provenance-valid-share';
  v_numeric_share_id constant text:='987';
  v_numeric_dashboard_id constant text:='123';
  v_numeric_recipient_id constant text:='456';
  v_numeric_version_id constant text:='workflow-pg-numeric-dashboard-version';
  v_numeric_creator_action_id constant text:='workflow-pg-numeric-share-create-action';
  v_numeric_creator_root_id constant text:='workflow-pg-numeric-share-create-root';
  v_numeric_creator_execution_id constant text:='workflow-pg-numeric-share-create-execution';
  v_numeric_revoke_action_id constant text:='workflow-pg-numeric-share-revoke-action';
  v_numeric_revoke_root_id constant text:='workflow-pg-numeric-share-revoke-root';
  v_numeric_revoke_execution_id constant text:='workflow-pg-numeric-share-revoke-execution';
  rejected_missing_event boolean:=false;
  rejected_wrong_actor boolean:=false;
  rejected_wrong_receipt boolean:=false;
  rejected_wrong_creation boolean:=false;
  rejected_bad_versions boolean:=false;
  rejected_unverified_creation integer:=0;
  rejected_target_id_mismatch boolean:=false;
  rejected_creator_contract_string boolean:=false;
  rejected_revoker_contract_string boolean:=false;
  numeric_id_rejections integer:=0;
  numeric_provenance_rejections integer:=0;
  v_actor_profile_id text;
  base_action jsonb;
  base_share jsonb;
  action_body jsonb;
  expected_rows jsonb;
  root_body jsonb;
  receipt_body jsonb;
  event_body jsonb;
  original_creator_action_payload jsonb;
  original_creator_receipt_payload jsonb;
  original_revoker_receipt_payload jsonb;
  numeric_dashboard_body jsonb;
  numeric_version_body jsonb;
  numeric_identity_body jsonb;
  numeric_share_body jsonb;
  numeric_expected_rows jsonb;
  original_numeric_creator_action_payload jsonb;
  original_numeric_creator_receipt_payload jsonb;
  original_numeric_revoker_action_payload jsonb;
  original_numeric_revoker_receipt_payload jsonb;
  numeric_create_action_body jsonb;
  numeric_revoke_action_body jsonb;
  numeric_root_body jsonb;
  numeric_receipt_body jsonb;
  numeric_proof jsonb;
  before_revision bigint;
  trial record;
  trial_share_id text;
  trial_creation_execution_id text;
  trial_action_id text;
  trial_root_id text;
  trial_execution_id text;
  trial_label text;
  numeric_field text;
BEGIN
  SELECT profile_id INTO STRICT v_actor_profile_id FROM public.directory_identities WHERE id='workflow-pg-sender';

  BEGIN
    UPDATE public.dashboard_shares
    SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z')
    WHERE id=v_share_id;
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_missing_event:=false;
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    rejected_missing_event:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;

  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-wrong-actor-event','rowVersion',1,
    'shareId',v_share_id,'actorId','workflow-pg-recipient',
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:34:00.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-wrong-actor-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_wrong_actor:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_wrong_actor:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;

  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-wrong-receipt-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:34:00.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-wrong-receipt-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_wrong_receipt:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_wrong_receipt:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;

  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-wrong-creation-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-snapshot-proof-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:34:00.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-wrong-creation-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_wrong_creation:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_wrong_creation:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;

  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-bad-versions-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',3,'createdAt','2026-10-04T02:34:01.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-bad-versions-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_bad_versions:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_bad_versions:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;

  SELECT payload INTO STRICT base_action FROM public.pending_actions
  WHERE id='workflow-pg-action' AND workflow_contract_version=2;

  FOR trial IN
    SELECT * FROM (VALUES
      ('historical-unverified','workflow-pg-share','workflow-pg-execution'),
      ('unrelated-verified','workflow-pg-provenance-forged-share','workflow-pg-snapshot-proof-execution')
    ) AS candidates(label,share_id,creation_execution_id)
  LOOP
    trial_label:=trial.label;
    trial_share_id:=trial.share_id;
    trial_creation_execution_id:=trial.creation_execution_id;
    trial_action_id:='workflow-pg-provenance-'||trial_label||'-revoke-action';
    trial_root_id:='workflow-pg-provenance-'||trial_label||'-revoke-root';
    trial_execution_id:='workflow-pg-provenance-'||trial_label||'-revoke-execution';
    expected_rows:=jsonb_build_array(jsonb_build_object(
      'ref',jsonb_build_object('table','dashboard_shares','id',trial_share_id),
      'rowVersion',1,'state','active'));
    action_body:=base_action||jsonb_build_object(
      'id',trial_action_id,'payload',jsonb_build_object('kind','dashboard_share_revoke','shareId',trial_share_id),
      'payloadHash',repeat(CASE WHEN trial_label='historical-unverified' THEN '5' ELSE '3' END,64),
      'idempotencyKey',repeat(CASE WHEN trial_label='historical-unverified' THEN '6' ELSE '4' END,64),
      'targets',jsonb_build_array(jsonb_build_object(
        'targetId',trial_share_id,'ref',jsonb_build_object('table','dashboard_shares','id',trial_share_id),
        'semanticKey','workflow-pg-provenance-reject-revoke:'||trial_share_id,
        'expectedRows',expected_rows,'ownerIdentityId','workflow-pg-sender',
        'expectedEffectRef',jsonb_build_object('table','dashboard_shares','id',trial_share_id),
        'expectedEffectVersion',2)),
      'targetCount',1,'expectedRows',expected_rows,
      'createdAt','2026-10-04T02:34:00.000Z','expiresAt','2026-10-04T03:34:00.000Z','status','pending');
    INSERT INTO public.pending_actions(id,row_version,workflow_contract_version,payload)
    VALUES (trial_action_id,1,2,action_body);
    root_body:=jsonb_build_object(
      'id',trial_root_id,'rowVersion',1,'actorId',v_actor_profile_id,
      'idempotencyKey',repeat(CASE WHEN trial_label='historical-unverified' THEN '1' ELSE '2' END,64),
      'activeExecutionId',NULL,'actionId',trial_action_id,'createdAt','2026-10-04T02:34:01.000Z','status','open');
    INSERT INTO public.action_idempotency_roots(id,row_version,body)
    VALUES (trial_root_id,1,root_body);
    receipt_body:=jsonb_build_object(
      'id',trial_execution_id,'actionId',trial_action_id,'contractVersion',2,
      'actorId',v_actor_profile_id,'kind','dashboard_share_revoke','outcome','pending',
      'proofs',jsonb_build_array(),'createdAt','2026-10-04T02:34:02.000Z',
      'verifiedAt',NULL,'currentStates',jsonb_build_array());
    INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
    VALUES (trial_execution_id,1,2,trial_root_id,1,receipt_body);
    root_body:=root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',trial_execution_id);
    UPDATE public.action_idempotency_roots SET row_version=2,body=root_body WHERE id=trial_root_id;
  END LOOP;

  SELECT payload INTO STRICT base_share FROM public.dashboard_shares WHERE id=v_share_id;
  INSERT INTO public.profiles(id,payload) VALUES ('456',jsonb_build_object(
    'id','456','name','Numeric identifier recipient','role','hr_director','active',true,
    'permissions',jsonb_build_array(),'regions',jsonb_build_array()));
  numeric_identity_body:=jsonb_build_object(
    'id',v_numeric_recipient_id,'rowVersion',1,'profileId',v_numeric_recipient_id,
    'displayName','Numeric identifier recipient','active',true,'role','hr_director',
    'department','hr','orgUnitId','workflow-pg-org','managerIdentityId',NULL,
    'verifiedDemoEmail','workflow-pg-456@example.invalid','slackIdentity',NULL,
    'allowedChannels',jsonb_build_array('simulated_email'),'classificationCeiling','internal');
  INSERT INTO public.directory_identities(id,row_version,body)
  VALUES (v_numeric_recipient_id,1,numeric_identity_body);
  numeric_dashboard_body:=jsonb_build_object(
    'id',v_numeric_dashboard_id,'ownerId',v_actor_profile_id,'createdAt','2026-10-04T02:40:00.000Z',
    'updatedAt','2026-10-04T02:40:00.000Z','spec',jsonb_build_object('title','Numeric identifier dashboard'),
    'packs',jsonb_build_array());
  INSERT INTO public.dashboards(id,payload) VALUES (v_numeric_dashboard_id,numeric_dashboard_body);
  numeric_version_body:=jsonb_build_object(
    'id',v_numeric_version_id,'dashboardId',v_numeric_dashboard_id,'version',1,'ownerId',v_actor_profile_id,
    'createdAt','2026-10-04T02:40:01.000Z','spec',jsonb_build_object('title','Numeric identifier dashboard'),
    'packs',jsonb_build_array(),'digest',repeat('d',64));
  INSERT INTO public.dashboard_versions(id,row_version,body)
  VALUES (v_numeric_version_id,1,numeric_version_body);

  numeric_expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','dashboard_versions','id',v_numeric_version_id),
    'rowVersion',1,'state',NULL));
  numeric_create_action_body:=base_action||jsonb_build_object(
    'id',v_numeric_creator_action_id,
    'payload',jsonb_build_object('kind','dashboard_share','dashboardId',v_numeric_dashboard_id,
      'recipientIdentityId',v_numeric_recipient_id,'channel','simulated_email',
      'subject','Numeric identifier share','body','Numeric identifier test share.'),
    'payloadHash',repeat('0',64),'idempotencyKey',repeat('a',64),
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId',v_numeric_share_id,'ref',jsonb_build_object('table','dashboard_versions','id',v_numeric_version_id),
      'semanticKey','workflow-pg-numeric-create:'||v_numeric_share_id,
      'expectedRows',numeric_expected_rows,'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','dashboard_shares','id',v_numeric_share_id),
      'expectedEffectVersion',1)),
    'targetCount',1,'expectedRows',numeric_expected_rows,
    'approvedBranchIds',jsonb_build_array('workflow-pg-ordered-cas-branch'),
    'createdAt','2026-10-04T02:41:00.000Z','expiresAt','2026-10-04T03:41:00.000Z','status','pending');
  INSERT INTO public.pending_actions(id,row_version,workflow_contract_version,payload)
  VALUES (v_numeric_creator_action_id,1,2,numeric_create_action_body);
  numeric_root_body:=jsonb_build_object(
    'id',v_numeric_creator_root_id,'rowVersion',1,'actorId',v_actor_profile_id,'idempotencyKey',repeat('0',64),
    'activeExecutionId',NULL,'actionId',v_numeric_creator_action_id,
    'createdAt','2026-10-04T02:41:01.000Z','status','open');
  INSERT INTO public.action_idempotency_roots(id,row_version,body)
  VALUES (v_numeric_creator_root_id,1,numeric_root_body);
  numeric_receipt_body:=jsonb_build_object(
    'id',v_numeric_creator_execution_id,'actionId',v_numeric_creator_action_id,'contractVersion',2,
    'actorId',v_actor_profile_id,'kind','dashboard_share','outcome','pending','proofs',jsonb_build_array(),
    'createdAt','2026-10-04T02:43:00.000Z','verifiedAt',NULL,'currentStates',jsonb_build_array());
  INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
  VALUES (v_numeric_creator_execution_id,1,2,v_numeric_creator_root_id,1,numeric_receipt_body);
  numeric_root_body:=numeric_root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',v_numeric_creator_execution_id);
  UPDATE public.action_idempotency_roots SET row_version=2,body=numeric_root_body WHERE id=v_numeric_creator_root_id;
  numeric_share_body:=jsonb_build_object(
    'id',v_numeric_share_id,'rowVersion',1,'dashboardId',v_numeric_dashboard_id,
    'dashboardVersionId',v_numeric_version_id,'senderIdentityId','workflow-pg-sender',
    'recipientIdentityId',v_numeric_recipient_id,
    'approvedBranchIds',jsonb_build_array('workflow-pg-ordered-cas-branch'),
    'classification','internal','verificationDigest',repeat('b',64),'keyVersion',1,
    'channel','simulated_email','policy',base_share->'policy','status','active',
    'expiresAt','2099-01-01T00:00:00.000Z','semanticKey','workflow-pg-numeric-share-semantic',
    'executionId',v_numeric_creator_execution_id,'createdAt','2026-10-04T02:43:00.000Z','revokedAt',NULL);
  INSERT INTO public.dashboard_shares(id,row_version,workflow_contract_version,payload)
  VALUES (v_numeric_share_id,1,2,numeric_share_body);
  numeric_proof:=jsonb_build_object(
    'targetId',v_numeric_share_id,'ref',jsonb_build_object('table','dashboard_shares','id',v_numeric_share_id),
    'outcome','verified_success','executionId',v_numeric_creator_execution_id,
    'observedRowVersion',1,'checkedAt','2026-10-04T02:43:01.000Z','mismatchCodes',jsonb_build_array());
  numeric_receipt_body:=numeric_receipt_body||jsonb_build_object(
    'outcome','verified_success','verifiedAt','2026-10-04T02:43:01.000Z','proofs',jsonb_build_array(numeric_proof));
  UPDATE public.action_executions SET row_version=2,payload=numeric_receipt_body
  WHERE id=v_numeric_creator_execution_id;

  numeric_expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','dashboard_shares','id',v_numeric_share_id),
    'rowVersion',1,'state','active'));
  numeric_revoke_action_body:=base_action||jsonb_build_object(
    'id',v_numeric_revoke_action_id,
    'payload',jsonb_build_object('kind','dashboard_share_revoke','shareId',v_numeric_share_id),
    'payloadHash',repeat('6',64),'idempotencyKey',repeat('7',64),
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId',v_numeric_share_id,'ref',jsonb_build_object('table','dashboard_shares','id',v_numeric_share_id),
      'semanticKey','workflow-pg-numeric-revoke:'||v_numeric_share_id,
      'expectedRows',numeric_expected_rows,'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','dashboard_shares','id',v_numeric_share_id),
      'expectedEffectVersion',2)),
    'targetCount',1,'expectedRows',numeric_expected_rows,
    'createdAt','2026-10-04T02:44:00.000Z','expiresAt','2026-10-04T03:44:00.000Z','status','pending');
  INSERT INTO public.pending_actions(id,row_version,workflow_contract_version,payload)
  VALUES (v_numeric_revoke_action_id,1,2,numeric_revoke_action_body);
  numeric_root_body:=jsonb_build_object(
    'id',v_numeric_revoke_root_id,'rowVersion',1,'actorId',v_actor_profile_id,'idempotencyKey',repeat('8',64),
    'activeExecutionId',NULL,'actionId',v_numeric_revoke_action_id,
    'createdAt','2026-10-04T02:44:01.000Z','status','open');
  INSERT INTO public.action_idempotency_roots(id,row_version,body)
  VALUES (v_numeric_revoke_root_id,1,numeric_root_body);
  numeric_receipt_body:=jsonb_build_object(
    'id',v_numeric_revoke_execution_id,'actionId',v_numeric_revoke_action_id,'contractVersion',2,
    'actorId',v_actor_profile_id,'kind','dashboard_share_revoke','outcome','pending','proofs',jsonb_build_array(),
    'createdAt','2026-10-04T02:44:02.000Z','verifiedAt',NULL,'currentStates',jsonb_build_array());
  INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
  VALUES (v_numeric_revoke_execution_id,1,2,v_numeric_revoke_root_id,1,numeric_receipt_body);
  numeric_root_body:=numeric_root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',v_numeric_revoke_execution_id);
  UPDATE public.action_idempotency_roots SET row_version=2,body=numeric_root_body WHERE id=v_numeric_revoke_root_id;

  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  FOR trial IN
    SELECT * FROM (VALUES
      ('historical-unverified','workflow-pg-share','workflow-pg-execution'),
      ('unrelated-verified','workflow-pg-provenance-forged-share','workflow-pg-snapshot-proof-execution')
    ) AS candidates(label,share_id,creation_execution_id)
  LOOP
    trial_label:=trial.label;
    trial_share_id:=trial.share_id;
    trial_creation_execution_id:=trial.creation_execution_id;
    trial_execution_id:='workflow-pg-provenance-'||trial_label||'-revoke-execution';
    event_body:=jsonb_build_object(
      'id','workflow-pg-provenance-'||trial_label||'-revoke-event','rowVersion',1,
      'shareId',trial_share_id,'actorId',v_actor_profile_id,'executionId',trial_execution_id,
      'shareCreationExecutionId',trial_creation_execution_id,
      'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:34:00.000Z');
    BEGIN
      UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
        'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:34:00.000Z') WHERE id=trial_share_id;
      INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
      VALUES (event_body->>'id',1,event_body);
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      rejected_unverified_creation:=rejected_unverified_creation+1;
      SET CONSTRAINTS ALL DEFERRED;
    END;
  END LOOP;

  FOREACH numeric_field IN ARRAY ARRAY['shareId','actorId','executionId','shareCreationExecutionId'] LOOP
    event_body:=jsonb_build_object(
      'id','workflow-pg-provenance-numeric-'||numeric_field,'rowVersion',1,
      'shareId',v_share_id,'actorId',v_actor_profile_id,
      'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
      'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:37:30.000Z');
    event_body:=jsonb_set(event_body,ARRAY[numeric_field],to_jsonb(123::integer));
    BEGIN
      INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
      VALUES (event_body->>'id',1,event_body);
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      numeric_id_rejections:=numeric_id_rejections+1;
      SET CONSTRAINTS ALL DEFERRED;
    END;
  END LOOP;

  SELECT payload INTO STRICT original_creator_action_payload FROM public.pending_actions
  WHERE id='workflow-pg-share-create-action';
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions
  SET payload=jsonb_set(payload,'{targets,0,targetId}',to_jsonb('workflow-pg-share-create-target-alias'::text))
  WHERE id='workflow-pg-share-create-action';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-proof-target-mismatch-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:37:30.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:37:30.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-proof-target-mismatch-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_target_id_mismatch:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_target_id_mismatch:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions SET payload=original_creator_action_payload
  WHERE id='workflow-pg-share-create-action';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SELECT payload INTO STRICT original_creator_receipt_payload FROM public.action_executions
  WHERE id='workflow-pg-share-create-execution';
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER nexus_revision';
  UPDATE public.action_executions
  SET payload=jsonb_set(payload,'{contractVersion}',to_jsonb('2'::text))
  WHERE id='workflow-pg-share-create-execution';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-string-creator-contract-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:37:31.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:37:31.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-string-creator-contract-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_creator_contract_string:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_creator_contract_string:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER nexus_revision';
  UPDATE public.action_executions SET payload=original_creator_receipt_payload
  WHERE id='workflow-pg-share-create-execution';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SELECT payload INTO STRICT original_revoker_receipt_payload FROM public.action_executions
  WHERE id='workflow-pg-share-revoke-execution';
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER nexus_revision';
  UPDATE public.action_executions
  SET payload=jsonb_set(payload,'{contractVersion}',to_jsonb('2'::text))
  WHERE id='workflow-pg-share-revoke-execution';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-provenance-string-revoker-contract-event','rowVersion',1,
    'shareId',v_share_id,'actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:37:32.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:37:32.000Z') WHERE id=v_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-provenance-string-revoker-contract-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_revoker_contract_string:=false;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_revoker_contract_string:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions DISABLE TRIGGER nexus_revision';
  UPDATE public.action_executions SET payload=original_revoker_receipt_payload
  WHERE id='workflow-pg-share-revoke-execution';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.action_executions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SELECT payload INTO STRICT original_numeric_creator_action_payload FROM public.pending_actions
  WHERE id=v_numeric_creator_action_id;
  SELECT payload INTO STRICT original_numeric_revoker_action_payload FROM public.pending_actions
  WHERE id=v_numeric_revoke_action_id;
  SELECT payload INTO STRICT original_numeric_creator_receipt_payload FROM public.action_executions
  WHERE id=v_numeric_creator_execution_id;
  SELECT payload INTO STRICT original_numeric_revoker_receipt_payload FROM public.action_executions
  WHERE id=v_numeric_revoke_execution_id;

  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions
  SET payload=jsonb_set(jsonb_set(payload,'{payload,dashboardId}',to_jsonb(123::integer)),
    '{payload,recipientIdentityId}',to_jsonb(456::integer))
  WHERE id=v_numeric_creator_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-numeric-creator-identifiers-event','rowVersion',1,
    'shareId',v_numeric_share_id,'actorId',v_actor_profile_id,
    'executionId',v_numeric_revoke_execution_id,'shareCreationExecutionId',v_numeric_creator_execution_id,
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:45:00.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:45:00.000Z') WHERE id=v_numeric_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-numeric-creator-identifiers-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    numeric_provenance_rejections:=numeric_provenance_rejections+1;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions SET payload=original_numeric_creator_action_payload
  WHERE id=v_numeric_creator_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions
  SET payload=jsonb_set(payload,'{contractVersion}',to_jsonb('2'::text))
  WHERE id=v_numeric_creator_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-string-creator-action-contract-event','rowVersion',1,
    'shareId',v_numeric_share_id,'actorId',v_actor_profile_id,
    'executionId',v_numeric_revoke_execution_id,'shareCreationExecutionId',v_numeric_creator_execution_id,
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:45:01.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:45:01.000Z') WHERE id=v_numeric_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-string-creator-action-contract-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    numeric_provenance_rejections:=numeric_provenance_rejections+1;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions SET payload=original_numeric_creator_action_payload
  WHERE id=v_numeric_creator_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions
  SET payload=jsonb_set(payload,'{payload,shareId}',to_jsonb(987::integer))
  WHERE id=v_numeric_revoke_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-numeric-revoker-share-event','rowVersion',1,
    'shareId',v_numeric_share_id,'actorId',v_actor_profile_id,
    'executionId',v_numeric_revoke_execution_id,'shareCreationExecutionId',v_numeric_creator_execution_id,
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:45:02.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:45:02.000Z') WHERE id=v_numeric_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-numeric-revoker-share-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    numeric_provenance_rejections:=numeric_provenance_rejections+1;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions SET payload=original_numeric_revoker_action_payload
  WHERE id=v_numeric_revoke_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions
  SET payload=jsonb_set(payload,'{contractVersion}',to_jsonb('2'::text))
  WHERE id=v_numeric_revoke_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;
  event_body:=jsonb_build_object(
    'id','workflow-pg-string-revoker-action-contract-event','rowVersion',1,
    'shareId',v_numeric_share_id,'actorId',v_actor_profile_id,
    'executionId',v_numeric_revoke_execution_id,'shareCreationExecutionId',v_numeric_creator_execution_id,
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:45:03.000Z');
  BEGIN
    UPDATE public.dashboard_shares SET row_version=2,payload=payload||jsonb_build_object(
      'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:45:03.000Z') WHERE id=v_numeric_share_id;
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
    VALUES ('workflow-pg-string-revoker-action-contract-event',1,event_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    numeric_provenance_rejections:=numeric_provenance_rejections+1;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions DISABLE TRIGGER nexus_revision';
  UPDATE public.pending_actions SET payload=original_numeric_revoker_action_payload
  WHERE id=v_numeric_revoke_action_id;
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER workflow_guard';
  EXECUTE 'ALTER TABLE public.pending_actions ENABLE TRIGGER nexus_revision';
  SET CONSTRAINTS ALL DEFERRED;

  IF NOT rejected_missing_event OR NOT rejected_wrong_actor OR NOT rejected_wrong_receipt
    OR NOT rejected_wrong_creation OR NOT rejected_bad_versions OR rejected_unverified_creation<>2
    OR numeric_id_rejections<>4 OR numeric_provenance_rejections<>4 OR NOT rejected_target_id_mismatch
    OR NOT rejected_creator_contract_string OR NOT rejected_revoker_contract_string
    OR (SELECT row_version FROM public.dashboard_shares WHERE id=v_share_id)<>1
    OR (SELECT status FROM public.dashboard_shares WHERE id=v_share_id)<>'active'
    OR EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events WHERE share_id=v_share_id)
    OR (SELECT row_version FROM public.dashboard_shares WHERE id='workflow-pg-share')<>1
    OR (SELECT status FROM public.dashboard_shares WHERE id='workflow-pg-share')<>'active'
    OR (SELECT row_version FROM public.dashboard_shares WHERE id='workflow-pg-provenance-forged-share')<>1
    OR (SELECT status FROM public.dashboard_shares WHERE id='workflow-pg-provenance-forged-share')<>'active'
    OR EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events WHERE share_id IN (
      'workflow-pg-share','workflow-pg-provenance-forged-share'))
    OR EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events WHERE id LIKE 'workflow-pg-provenance-%')
    OR (SELECT row_version FROM public.dashboard_shares WHERE id=v_numeric_share_id)<>1
    OR (SELECT status FROM public.dashboard_shares WHERE id=v_numeric_share_id)<>'active'
    OR EXISTS (SELECT 1 FROM public.dashboard_share_revoke_events WHERE share_id=v_numeric_share_id)
    OR (SELECT payload->'targets'->0->>'targetId' FROM public.pending_actions
        WHERE id='workflow-pg-share-create-action')<>'workflow-pg-provenance-valid-share'
    OR (SELECT payload->'contractVersion' FROM public.action_executions
        WHERE id='workflow-pg-share-create-execution') IS DISTINCT FROM '2'::jsonb
    OR (SELECT payload->'contractVersion' FROM public.action_executions
        WHERE id='workflow-pg-share-revoke-execution') IS DISTINCT FROM '2'::jsonb
    OR (SELECT payload->'contractVersion' FROM public.pending_actions
        WHERE id=v_numeric_creator_action_id) IS DISTINCT FROM '2'::jsonb
    OR (SELECT payload->'payload'->>'dashboardId' FROM public.pending_actions
        WHERE id=v_numeric_creator_action_id)<>'123'
    OR (SELECT payload->'payload'->>'recipientIdentityId' FROM public.pending_actions
        WHERE id=v_numeric_creator_action_id)<>'456'
    OR (SELECT jsonb_typeof(payload #> '{payload,dashboardId}') FROM public.pending_actions
        WHERE id=v_numeric_creator_action_id)<>'string'
    OR (SELECT jsonb_typeof(payload #> '{payload,recipientIdentityId}') FROM public.pending_actions
        WHERE id=v_numeric_creator_action_id)<>'string'
    OR (SELECT payload->'contractVersion' FROM public.pending_actions
        WHERE id=v_numeric_revoke_action_id) IS DISTINCT FROM '2'::jsonb
    OR (SELECT payload->'payload'->>'shareId' FROM public.pending_actions
        WHERE id=v_numeric_revoke_action_id)<>'987'
    OR (SELECT jsonb_typeof(payload #> '{payload,shareId}') FROM public.pending_actions
        WHERE id=v_numeric_revoke_action_id)<>'string'
    OR (SELECT payload->'contractVersion' FROM public.action_executions
        WHERE id=v_numeric_creator_execution_id) IS DISTINCT FROM '2'::jsonb
    OR (SELECT payload->'contractVersion' FROM public.action_executions
        WHERE id=v_numeric_revoke_execution_id) IS DISTINCT FROM '2'::jsonb
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'an orphan, misattributed, or unverified/unrelated creation-receipt revoke escaped rollback';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: orphan, misattributed, and unverified creation-receipt revocations fail closed

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  share_body jsonb;
  event_body jsonb;
  event_id constant text:='workflow-pg-share-revoke-event';
  v_actor_profile_id text;
  before_version bigint;
BEGIN
  SELECT payload,row_version INTO STRICT share_body,before_version
  FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share';
  SELECT profile_id INTO STRICT v_actor_profile_id FROM public.directory_identities WHERE id='workflow-pg-sender';
  IF before_version<>1 OR share_body->>'status'<>'active'
    OR share_body->>'executionId'<>'workflow-pg-share-create-execution' THEN
    RAISE EXCEPTION 'the share was not active with its verified V2 creation receipt before the valid revoke';
  END IF;

  UPDATE public.dashboard_shares
  SET row_version=2,payload=payload||jsonb_build_object(
    'rowVersion',2,'status','revoked','revokedAt','2026-10-04T02:37:00.000Z')
  WHERE id='workflow-pg-provenance-valid-share';
  event_body:=jsonb_build_object(
    'id',event_id,'rowVersion',1,'shareId','workflow-pg-provenance-valid-share','actorId',v_actor_profile_id,
    'executionId','workflow-pg-share-revoke-execution','shareCreationExecutionId','workflow-pg-share-create-execution',
    'priorShareRowVersion',1,'revokedShareRowVersion',2,'createdAt','2026-10-04T02:37:00.000Z');
  INSERT INTO public.dashboard_share_revoke_events(id,row_version,body)
  VALUES (event_id,1,event_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  IF NOT EXISTS (
    SELECT 1 FROM public.dashboard_shares s
    JOIN public.dashboard_share_revoke_events e
      ON e.share_id=s.id AND e.revoked_share_row_version=s.row_version
        AND e.share_creation_execution_id=s.execution_id
    JOIN public.action_executions x ON x.id=e.execution_id AND x.workflow_contract_version=2
    JOIN public.pending_actions a ON a.id=x.action_id AND a.workflow_contract_version=2
    WHERE s.id='workflow-pg-provenance-valid-share' AND s.row_version=2 AND s.status='revoked'
      AND s.execution_id='workflow-pg-share-create-execution'
      AND s.payload->>'executionId'='workflow-pg-share-create-execution'
      AND s.pre_migration_revoke_quarantined=0
      AND s.workflow_revoke_share_id=s.id
      AND s.workflow_revoke_share_row_version=s.row_version
      AND s.workflow_revoke_creation_execution_id='workflow-pg-share-create-execution'
      AND e.id=event_id AND e.row_version=1 AND e.actor_id=v_actor_profile_id
      AND e.execution_id='workflow-pg-share-revoke-execution'
      AND e.share_creation_execution_id='workflow-pg-share-create-execution'
      AND e.prior_share_row_version=1 AND e.revoked_share_row_version=2
      AND e.created_at='2026-10-04T02:37:00.000Z'
      AND e.share_contract_version=2 AND e.execution_contract_version=2
      AND e.share_creation_execution_contract_version=2
      AND x.payload->>'kind'='dashboard_share_revoke' AND x.payload->>'actorId'=v_actor_profile_id
      AND a.payload->'payload'->>'kind'='dashboard_share_revoke'
      AND a.payload->'payload'->>'shareId'=s.id
  ) THEN
    RAISE EXCEPTION 'the same-transaction revoke did not persist exact V2 source, actor, execution, version, and creation provenance';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: active-to-revoked CAS and one exact attributed V2 event commit together

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  before_event jsonb;
  before_revision bigint;
  rejected_update boolean:=false;
  rejected_delete boolean:=false;
  rejected_duplicate boolean:=false;
BEGIN
  SELECT body INTO STRICT before_event FROM public.dashboard_share_revoke_events
  WHERE id='workflow-pg-share-revoke-event';
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    UPDATE public.dashboard_share_revoke_events
    SET body=body||jsonb_build_object('actorId','workflow-pg-recipient')
    WHERE id='workflow-pg-share-revoke-event';
  EXCEPTION WHEN check_violation THEN
    rejected_update:=true;
  END;
  BEGIN
    DELETE FROM public.dashboard_share_revoke_events WHERE id='workflow-pg-share-revoke-event';
  EXCEPTION WHEN check_violation THEN
    rejected_delete:=true;
  END;
  BEGIN
    INSERT INTO public.dashboard_share_revoke_events(id,row_version,body) VALUES (
      'workflow-pg-share-revoke-event-duplicate',1,
      before_event||jsonb_build_object('id','workflow-pg-share-revoke-event-duplicate'));
    SET CONSTRAINTS ALL IMMEDIATE;
    rejected_duplicate:=false;
  EXCEPTION WHEN unique_violation OR check_violation OR foreign_key_violation THEN
    rejected_duplicate:=true;
    SET CONSTRAINTS ALL DEFERRED;
  END;
  IF NOT rejected_update OR NOT rejected_delete OR NOT rejected_duplicate
    OR (SELECT body FROM public.dashboard_share_revoke_events WHERE id='workflow-pg-share-revoke-event') IS DISTINCT FROM before_event
    OR (SELECT count(*) FROM public.dashboard_share_revoke_events WHERE share_id='workflow-pg-provenance-valid-share')<>1
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'revoke event mutation, deletion, or second share event was accepted or changed the original proof';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: revoke events are append-only and unique for one share lifecycle

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  share_body jsonb;
BEGIN
  SELECT payload INTO STRICT share_body FROM public.dashboard_shares
  WHERE id='workflow-pg-provenance-valid-share';
  IF (SELECT row_version FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share')<>2
    OR (SELECT status FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share')<>'revoked'
    OR (SELECT execution_id FROM public.dashboard_shares WHERE id='workflow-pg-provenance-valid-share')<>'workflow-pg-share-create-execution'
    OR share_body->>'executionId'<>'workflow-pg-share-create-execution'
    OR (SELECT pre_migration_revoke_quarantined FROM public.dashboard_shares
        WHERE id='workflow-pg-provenance-valid-share')<>0
    OR (SELECT share_creation_execution_id FROM public.dashboard_share_revoke_events
        WHERE id='workflow-pg-share-revoke-event')<>'workflow-pg-share-create-execution'
    OR (SELECT count(*) FROM public.action_executions
        WHERE id='workflow-pg-share-create-execution' AND workflow_contract_version=2
          AND payload->>'outcome'='verified_success'
          AND payload->'proofs'->0->'ref'->>'table'='dashboard_shares'
          AND payload->'proofs'->0->'ref'->>'id'='workflow-pg-provenance-valid-share')<>1 THEN
    RAISE EXCEPTION 'revocation changed the share creation execution, verified receipt, or migration quarantine';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: the immutable dashboard-share creation receipt remains distinct from revoke attribution

COMMIT;

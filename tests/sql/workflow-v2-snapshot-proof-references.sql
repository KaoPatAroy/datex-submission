-- Local PostgreSQL SQL conformance only. This does not prove hosted Supabase
-- Auth, Data API, policy, or deployment behavior.
\set ON_ERROR_STOP 1
\echo CONFORMANCE: snapshot proof reference FKs and optional conversation evidence/source guards

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

DO $case$
DECLARE
  native_columns integer;
  generated_marker boolean;
  reference_foreign_keys integer;
  reference_fk_targets boolean;
  proof_guard boolean;
  execution_key boolean;
  manifest_tags boolean;
BEGIN
  SELECT count(*) INTO native_columns
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='public.review_snapshot_targets'::regclass
    AND a.attname IN ('directory_identity_id','responsibility_id','action_execution_id')
    AND a.atttypid='text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
    AND a.attgenerated='' AND a.attnum>0 AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.review_snapshot_targets'::regclass
      AND a.attname='action_execution_contract_version'
      AND a.atttypid='integer'::regtype AND NOT a.attnotnull AND a.attgenerated='s'
      AND lower(regexp_replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'[()[:space:]]','','g'))
        ='casewhenaction_execution_idisnotnullthen2elsenull::integerend'
  ) INTO generated_marker;

  SELECT count(*) INTO reference_foreign_keys
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.review_snapshot_targets'::regclass
    AND c.conname IN (
      'wf_review_snapshot_targets_directory_identity_id_fk',
      'wf_review_snapshot_targets_responsibility_id_fk',
      'wf_review_snapshot_targets_action_execution_id_fk',
      'wf_review_snapshot_targets_action_execution_id_contract_fk')
    AND c.contype='f' AND c.condeferrable AND c.condeferred AND c.convalidated
    AND c.confdeltype='a' AND c.confupdtype='a';

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.review_snapshot_targets'::regclass
      AND c.conname='wf_review_snapshot_targets_directory_identity_id_fk'
      AND c.confrelid='public.directory_identities'::regclass
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='directory_identity_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[]
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.review_snapshot_targets'::regclass
      AND c.conname='wf_review_snapshot_targets_responsibility_id_fk'
      AND c.confrelid='public.responsibilities'::regclass
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.review_snapshot_targets'::regclass
      AND c.conname='wf_review_snapshot_targets_action_execution_id_fk'
      AND c.confrelid='public.action_executions'::regclass
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.review_snapshot_targets'::regclass
      AND c.conname='wf_review_snapshot_targets_action_execution_id_contract_fk'
      AND c.confrelid='public.action_executions'::regclass
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='action_execution_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='action_execution_contract_version')
      ]::smallint[]
      AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='workflow_contract_version')
      ]::smallint[]
  ) INTO reference_fk_targets;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.conversation_messages'::regclass
      AND t.tgname='workflow_chat_proof_guard'
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgtype=23
      AND p.oid='nexus_private.workflow_chat_proof_guard()'::regprocedure AND p.prosecdef
  ) INTO proof_guard;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indrelid='public.action_executions'::regclass
      AND i.indexrelid=to_regclass('public.workflow_action_executions_contract_reference_unique')
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2 AND i.indnatts=2
      AND (SELECT array_agg(a.attname::text ORDER BY k.position)
        FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
        =ARRAY['id','workflow_contract_version']::text[]
  ) INTO execution_key;

  SELECT EXISTS (
    SELECT 1 FROM nexus_private.workflow_manifest m
    WHERE m.table_name='review_snapshot_targets'
      AND m.definition->'columns' @> '[{"column":"directory_identity_id","bodyField":"ref.id","type":"text","nullable":true,"tagField":"ref.table","tagValue":"directory_identities"},{"column":"responsibility_id","bodyField":"ref.id","type":"text","nullable":true,"tagField":"ref.table","tagValue":"responsibilities"},{"column":"action_execution_id","bodyField":"ref.id","type":"text","nullable":true,"tagField":"ref.table","tagValue":"action_executions"}]'::jsonb
      AND m.definition->'foreignKeys' @> '[{"column":"action_execution_id","target":"action_executions","requiredContractVersion":2}]'::jsonb
  ) INTO manifest_tags;

  IF native_columns<>3 OR generated_marker IS DISTINCT FROM true OR reference_foreign_keys<>4
    OR reference_fk_targets IS DISTINCT FROM true OR proof_guard IS DISTINCT FROM true
    OR execution_key IS DISTINCT FROM true OR NOT manifest_tags THEN
    RAISE EXCEPTION 'snapshot proof native tags, generated V2 marker, FKs, unique execution key, or message guard are incomplete: columns %, marker %, FKs %, FK targets %, proof guard %, execution key %, manifest %',
      native_columns,generated_marker,reference_foreign_keys,reference_fk_targets,proof_guard,execution_key,manifest_tags;
  END IF;
END
$case$;
\echo CASE PASS: native tagged references, generated V2 marker, deferred FKs, execution key, and proof guard are installed

DO $case$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.review_snapshot_targets t
    WHERE t.id='workflow-pg-snapshot-proof-legacy-branch'
      AND t.row_version=1 AND t.snapshot_id='workflow-pg-logical-policy-snapshot'
      AND t.entity_type='branches' AND t.target_id='workflow-pg-ordered-cas-branch'
      AND t.body->'ref'->>'table'='branches'
      AND t.body->'ref'->>'id'='workflow-pg-ordered-cas-branch'
      AND t.branch_id='workflow-pg-ordered-cas-branch'
      AND t.directory_identity_id IS NULL AND t.responsibility_id IS NULL
      AND t.action_execution_id IS NULL AND t.action_execution_contract_version IS NULL
      AND num_nonnulls(t.branch_id,t.inventory_snapshot_id,t.incident_id,t.employee_id,t.badge_id,
        t.dashboard_version_id,t.opportunity_id,t.onboarding_request_id,t.onboarding_document_id,
        t.onboarding_event_id,t.offboarding_case_id,t.offboarding_plan_id,t.asset_assignment_id,
        t.contract_id,t.policy_document_id,t.directory_identity_id,t.responsibility_id,t.action_execution_id)=1
  ) THEN
    RAISE EXCEPTION 'the populated pre-forward branch target did not retain its single native reference and body';
  END IF;
END
$case$;
\echo CASE PASS: pre-forward snapshot target body/version and its one branch projection survive adoption

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  v_snapshot_id constant text:='workflow-pg-snapshot-proof-director-snapshot';
  v_session_id constant text:='workflow-pg-snapshot-proof-director-session';
  v_actor_id constant text:='workflow-pg-actor';
  v_snapshot_actor_id constant text:='workflow-pg-recipient';
  v_action_id constant text:='workflow-pg-action';
  v_root_id constant text:='workflow-pg-snapshot-proof-root';
  v_execution_id constant text:='workflow-pg-snapshot-proof-execution';
  branch_version bigint;
  identity_version bigint;
  responsibility_version bigint;
  root_body jsonb;
  receipt_body jsonb;
  proof_body jsonb;
BEGIN
  SELECT row_version INTO STRICT branch_version FROM public.branches WHERE id='workflow-pg-ordered-cas-branch';
  SELECT row_version INTO STRICT identity_version FROM public.directory_identities WHERE id='workflow-pg-recipient-identity';
  SELECT row_version INTO STRICT responsibility_version FROM public.responsibilities WHERE id='workflow-pg-director-responsibility-a';

  INSERT INTO public.sessions(id,payload) VALUES (
    v_session_id,jsonb_build_object('id',v_session_id,'rowVersion',1,'profileId',v_snapshot_actor_id,
      'expiresAt','2026-10-04T04:00:00.000Z','mode','scripted_demo','modeRevision',0,
      'csrfToken','snapshot-proof-synthetic-csrf','createdAt','2026-10-04T02:29:00.000Z'));

  root_body:=jsonb_build_object(
    'id',v_root_id,'rowVersion',1,'actorId',v_actor_id,'idempotencyKey',repeat('d',64),
    'activeExecutionId',NULL,'actionId',v_action_id,'createdAt','2026-10-04T02:30:00.000Z','status','open');
  INSERT INTO public.action_idempotency_roots(id,row_version,body) VALUES (v_root_id,1,root_body);
  receipt_body:=jsonb_build_object(
    'id',v_execution_id,'actionId',v_action_id,'contractVersion',2,
    'actorId',v_actor_id,'kind','investigation_create','outcome','pending',
    'proofs',jsonb_build_array(),'createdAt','2026-10-04T02:30:01.000Z',
    'verifiedAt',NULL,'currentStates',jsonb_build_array());
  INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
  VALUES (v_execution_id,1,2,v_root_id,1,receipt_body);

  root_body:=root_body||jsonb_build_object('rowVersion',2,'activeExecutionId',v_execution_id);
  UPDATE public.action_idempotency_roots SET row_version=2,body=root_body WHERE id=v_root_id;
  proof_body:=jsonb_build_object(
    'targetId','workflow-pg-ordered-cas-branch',
    'ref',jsonb_build_object('table','branches','id','workflow-pg-ordered-cas-branch'),
    'outcome','verified_success','executionId',v_execution_id,
    'observedRowVersion',branch_version,'checkedAt','2026-10-04T02:30:02.000Z',
    'mismatchCodes',jsonb_build_array());
  receipt_body:=receipt_body||jsonb_build_object(
    'outcome','verified_success','verifiedAt','2026-10-04T02:30:03.000Z',
    'proofs',jsonb_build_array(proof_body));
  UPDATE public.action_executions SET row_version=2,payload=receipt_body WHERE id=v_execution_id;

  INSERT INTO public.review_snapshots(id,row_version,body) VALUES (
    v_snapshot_id,1,jsonb_build_object(
      'id',v_snapshot_id,'actorId',v_snapshot_actor_id,'actorSessionId',v_session_id,
      'purpose','director_queue','orgUnitIds',jsonb_build_array('workflow-pg-org'),
      'displayedIds',jsonb_build_array('workflow-pg-snapshot-proof-director-target'),'count',1,
      'expectedRows',jsonb_build_array(
        jsonb_build_object('ref',jsonb_build_object('table','directory_identities','id','workflow-pg-recipient-identity'),
          'rowVersion',identity_version,'state','active'),
        jsonb_build_object('ref',jsonb_build_object('table','responsibilities','id','workflow-pg-director-responsibility-a'),
          'rowVersion',responsibility_version,'state','active'),
        jsonb_build_object('ref',jsonb_build_object('table','action_executions','id',v_execution_id),
          'rowVersion',2,'state','verified_success')),
      'policy',jsonb_build_object('id','demo-workflow','version',1,
        'digest','0515a53cb4bb6a1259d1c8f6d75b0c2b954598e3ecce723857a6fb8a652b04be'),
      'createdAt','2026-10-04T02:30:10.000Z','expiresAt','2026-10-04T03:30:10.000Z',
      'digest',repeat('7',64)));

  INSERT INTO public.review_snapshot_targets(id,row_version,body) VALUES
    ('workflow-pg-snapshot-proof-directory-target',1,jsonb_build_object(
      'id','workflow-pg-snapshot-proof-directory-target','rowVersion',1,
      'snapshotId',v_snapshot_id,'entityType','directory_identities','targetId','workflow-pg-recipient-identity',
      'expectedRowVersion',identity_version,'expectedState','active',
      'ref',jsonb_build_object('table','directory_identities','id','workflow-pg-recipient-identity'))),
    ('workflow-pg-snapshot-proof-responsibility-target',1,jsonb_build_object(
      'id','workflow-pg-snapshot-proof-responsibility-target','rowVersion',1,
      'snapshotId',v_snapshot_id,'entityType','responsibilities','targetId','workflow-pg-director-responsibility-a',
      'expectedRowVersion',responsibility_version,'expectedState',NULL,
      'ref',jsonb_build_object('table','responsibilities','id','workflow-pg-director-responsibility-a'))),
    ('workflow-pg-snapshot-proof-receipt-target',1,jsonb_build_object(
      'id','workflow-pg-snapshot-proof-receipt-target','rowVersion',1,
      'snapshotId',v_snapshot_id,'entityType','action_executions','targetId',v_execution_id,
      'expectedRowVersion',2,'expectedState','verified_success',
      'ref',jsonb_build_object('table','action_executions','id',v_execution_id)));
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  IF NOT EXISTS (SELECT 1 FROM public.review_snapshots
      WHERE id=v_snapshot_id AND purpose='director_queue' AND actor_id=v_snapshot_actor_id
        AND actor_session_id=v_session_id AND digest=repeat('7',64))
    OR (SELECT count(*) FROM public.review_snapshot_targets WHERE id IN (
      'workflow-pg-snapshot-proof-directory-target',
      'workflow-pg-snapshot-proof-responsibility-target',
      'workflow-pg-snapshot-proof-receipt-target'))<>3
    OR NOT EXISTS (SELECT 1 FROM public.review_snapshot_targets
      WHERE id='workflow-pg-snapshot-proof-directory-target' AND directory_identity_id='workflow-pg-recipient-identity'
        AND num_nonnulls(branch_id,inventory_snapshot_id,incident_id,employee_id,badge_id,dashboard_version_id,
          opportunity_id,onboarding_request_id,onboarding_document_id,onboarding_event_id,offboarding_case_id,
          offboarding_plan_id,asset_assignment_id,contract_id,policy_document_id,directory_identity_id,
          responsibility_id,action_execution_id)=1)
    OR NOT EXISTS (SELECT 1 FROM public.review_snapshot_targets
      WHERE id='workflow-pg-snapshot-proof-responsibility-target'
        AND responsibility_id='workflow-pg-director-responsibility-a'
        AND num_nonnulls(branch_id,inventory_snapshot_id,incident_id,employee_id,badge_id,dashboard_version_id,
          opportunity_id,onboarding_request_id,onboarding_document_id,onboarding_event_id,offboarding_case_id,
          offboarding_plan_id,asset_assignment_id,contract_id,policy_document_id,directory_identity_id,
          responsibility_id,action_execution_id)=1)
    OR NOT EXISTS (SELECT 1 FROM public.review_snapshot_targets
      WHERE id='workflow-pg-snapshot-proof-receipt-target'
        AND action_execution_id=v_execution_id AND action_execution_contract_version=2
        AND num_nonnulls(branch_id,inventory_snapshot_id,incident_id,employee_id,badge_id,dashboard_version_id,
          opportunity_id,onboarding_request_id,onboarding_document_id,onboarding_event_id,offboarding_case_id,
          offboarding_plan_id,asset_assignment_id,contract_id,policy_document_id,directory_identity_id,
          responsibility_id,action_execution_id)=1)
    OR NOT EXISTS (SELECT 1 FROM public.action_executions e
      WHERE e.id=v_execution_id AND e.workflow_contract_version=2 AND e.row_version=2
        AND e.payload->>'outcome'='verified_success' AND e.payload->>'verifiedAt'='2026-10-04T02:30:03.000Z'
        AND jsonb_array_length(e.payload->'proofs')=1
        AND (SELECT count(*) FROM jsonb_object_keys(e.payload->'proofs'->0))=7
        AND e.payload->'proofs'->0->>'outcome'='verified_success'
        AND e.payload->'proofs'->0->>'executionId'=v_execution_id
        AND e.payload->'proofs'->0->'ref'->>'table'='branches'
        AND e.payload->'proofs'->0->'ref'->>'id'='workflow-pg-ordered-cas-branch') THEN
    RAISE EXCEPTION 'tagged identity/responsibility/V2 receipt reference fixture did not persist exactly once';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: identity, responsibility, and verified V2 receipt targets persist one correctly tagged native reference

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  before_revision bigint;
  rejected_zero boolean:=false;
  rejected_tamper boolean:=false;
  rejected_tag boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.review_snapshot_targets(id,row_version,body) VALUES (
      'workflow-pg-snapshot-proof-zero-reference',1,jsonb_build_object(
        'id','workflow-pg-snapshot-proof-zero-reference','rowVersion',1,
        'snapshotId','workflow-pg-logical-policy-snapshot','entityType','branches',
        'targetId','workflow-pg-zero-reference','expectedRowVersion',1,'expectedState',NULL,
        'ref',jsonb_build_object('table','branches','id',NULL)));
  EXCEPTION WHEN check_violation THEN
    rejected_zero:=true;
  END;
  BEGIN
    INSERT INTO public.review_snapshot_targets(id,row_version,body,directory_identity_id) VALUES (
      'workflow-pg-snapshot-proof-tampered-reference',1,jsonb_build_object(
        'id','workflow-pg-snapshot-proof-tampered-reference','rowVersion',1,
        'snapshotId','workflow-pg-logical-policy-snapshot','entityType','branches',
        'targetId','workflow-pg-ordered-cas-branch','expectedRowVersion',1,'expectedState',NULL,
        'ref',jsonb_build_object('table','branches','id','workflow-pg-ordered-cas-branch')),
      'workflow-pg-sender');
  EXCEPTION WHEN check_violation THEN
    rejected_tamper:=true;
  END;
  BEGIN
    INSERT INTO public.review_snapshot_targets(id,row_version,body) VALUES (
      'workflow-pg-snapshot-proof-mismatched-tag',1,jsonb_build_object(
        'id','workflow-pg-snapshot-proof-mismatched-tag','rowVersion',1,
        'snapshotId','workflow-pg-logical-policy-snapshot','entityType','directory_identities',
        'targetId','workflow-pg-ordered-cas-branch','expectedRowVersion',1,'expectedState',NULL,
        'ref',jsonb_build_object('table','branches','id','workflow-pg-ordered-cas-branch')));
  EXCEPTION WHEN check_violation THEN
    rejected_tag:=true;
  END;
  IF NOT rejected_zero OR NOT rejected_tamper OR NOT rejected_tag
    OR EXISTS (SELECT 1 FROM public.review_snapshot_targets WHERE id IN (
      'workflow-pg-snapshot-proof-zero-reference','workflow-pg-snapshot-proof-tampered-reference',
      'workflow-pg-snapshot-proof-mismatched-tag'))
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'zero, contradictory native, or mismatched tagged reference was accepted or left partial state';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: zero, contradictory native, and mismatched tagged references fail atomically

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  before_revision bigint;
  rejected_missing_identity boolean:=false;
  rejected_legacy_receipt boolean:=false;
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.review_snapshot_targets(id,row_version,body) VALUES (
      'workflow-pg-snapshot-proof-missing-identity',1,jsonb_build_object(
        'id','workflow-pg-snapshot-proof-missing-identity','rowVersion',1,
        'snapshotId','workflow-pg-logical-policy-snapshot','entityType','directory_identities',
        'targetId','workflow-pg-missing-directory-identity','expectedRowVersion',1,'expectedState',NULL,
        'ref',jsonb_build_object('table','directory_identities','id','workflow-pg-missing-directory-identity')));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_missing_identity:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  BEGIN
    INSERT INTO public.review_snapshot_targets(id,row_version,body) VALUES (
      'workflow-pg-snapshot-proof-legacy-receipt',1,jsonb_build_object(
        'id','workflow-pg-snapshot-proof-legacy-receipt','rowVersion',1,
        'snapshotId','workflow-pg-logical-policy-snapshot','entityType','action_executions',
        'targetId','workflow-pg-v1-effect-execution','expectedRowVersion',1,'expectedState','pending',
        'ref',jsonb_build_object('table','action_executions','id','workflow-pg-v1-effect-execution')));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_legacy_receipt:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected_missing_identity OR NOT rejected_legacy_receipt
    OR EXISTS (SELECT 1 FROM public.review_snapshot_targets WHERE id IN (
      'workflow-pg-snapshot-proof-missing-identity','workflow-pg-snapshot-proof-legacy-receipt'))
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision
    OR NOT EXISTS (SELECT 1 FROM public.action_executions
      WHERE id='workflow-pg-v1-effect-execution' AND workflow_contract_version IS NULL) THEN
    RAISE EXCEPTION 'deferred target FKs accepted a missing identity or a markerless legacy receipt';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: deferred tagged FKs reject missing identities and markerless legacy execution receipts

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  source_500 jsonb;
  source_100 jsonb;
  incident_120 jsonb;
  source_ids_100 jsonb;
  branches_12 jsonb;
  warnings_50 jsonb;
  scope_branches jsonb;
  valid_evidence jsonb;
  valid_message jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'id','workflow-pg-boundary-source-'||g.n,
    'system','synthetic-evidence',
    'observedAt',CASE WHEN g.n=1 THEN '' ELSE '2026-10-04T02:31:00.000Z' END,
    'retrievedAt','2026-10-04T02:32:00.000Z',
    'freshness',CASE WHEN g.n=1 THEN 'missing' ELSE 'fresh' END,
    'detail',CASE WHEN g.n=500 THEN repeat('d',500) ELSE 'Synthetic source detail.' END
  ) ORDER BY g.n) INTO source_500 FROM generate_series(1,500) AS g(n);
  SELECT jsonb_agg(jsonb_build_object(
    'id','workflow-pg-boundary-evidence-source-'||g.n,
    'system','synthetic-evidence',
    'observedAt',CASE WHEN g.n=1 THEN '' ELSE '2026-10-04T02:31:00.000Z' END,
    'retrievedAt','2026-10-04T02:32:00.000Z',
    'freshness',CASE WHEN g.n=1 THEN 'missing' ELSE 'fresh' END,
    'detail','Synthetic evidence source.'
  ) ORDER BY g.n) INTO source_100 FROM generate_series(1,100) AS g(n);
  SELECT jsonb_agg(jsonb_build_object(
    'id','workflow-pg-boundary-incident-'||g.n,
    'branchId','workflow-pg-proof-boundary-branch-1','date','2026-10-04',
    'title','Synthetic incident','kind','operations','status','open',
    'startedAt','2026-10-04T02:30:00.000Z','endedAt',NULL,'updatedAt','2026-10-04T02:31:00.000Z'
  ) ORDER BY g.n) INTO incident_120 FROM generate_series(1,120) AS g(n);
  SELECT jsonb_agg('workflow-pg-boundary-source-id-'||g.n ORDER BY g.n)
    INTO source_ids_100 FROM generate_series(1,100) AS g(n);
  SELECT jsonb_agg('workflow-pg-proof-boundary-branch-'||g.n ORDER BY g.n)
    INTO scope_branches FROM generate_series(1,12) AS g(n);
  SELECT jsonb_agg(jsonb_build_object(
    'branchId','workflow-pg-proof-boundary-branch-'||g.n,
    'branchName','Synthetic branch '||g.n,'region','east',
    'netSales',0,'target',0,'gap',0,'achievement',NULL,
    'stockIssues',0,'incidentCount',0,'staffingPlanned',0,'staffingActual',0,
    'incidents',incident_120,'sourceIds',source_ids_100
  ) ORDER BY g.n) INTO branches_12 FROM generate_series(1,12) AS g(n);
  SELECT jsonb_agg(to_jsonb(repeat('w',500)) ORDER BY g.n)
    INTO warnings_50 FROM generate_series(1,50) AS g(n);
  valid_evidence:=jsonb_build_object(
    'scope',jsonb_build_object('region','east','date','2026-10-04','branchIds',scope_branches),
    'asOf','2026-10-04T02:33:00.000Z','version','snapshot-proof-boundary-v1',
    'branches',branches_12,
    'totals',jsonb_build_object('netSales',0,'target',0,'gap',0,'achievement',NULL),
    'sources',source_100,'warnings',warnings_50);
  valid_message:=jsonb_build_object(
    'id','workflow-pg-snapshot-proof-boundary-message','rowVersion',1,
    'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',
    'role','assistant','text','Synthetic evidence boundary fixture.',
    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:33:01.000Z',
    'turnId','workflow-pg-snapshot-proof-boundary-turn','sessionId','workflow-pg-snapshot-proof-boundary-session',
    'evidence',valid_evidence,'sources',source_500);
  INSERT INTO public.conversation_messages(id,row_version,payload)
  VALUES ('workflow-pg-snapshot-proof-boundary-message',1,valid_message);
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_messages m
    WHERE m.id='workflow-pg-snapshot-proof-boundary-message'
      AND jsonb_array_length(m.payload->'sources')=500
      AND jsonb_array_length(m.payload #> '{evidence,sources}')=100
      AND jsonb_array_length(m.payload #> '{evidence,branches}')=12
      AND jsonb_array_length(m.payload #> '{evidence,warnings}')=50
      AND jsonb_array_length(m.payload #> '{evidence,branches,0,incidents}')=120
      AND jsonb_array_length(m.payload #> '{evidence,branches,0,sourceIds}')=100
      AND m.payload #>> '{sources,0,observedAt}'=''
      AND m.payload #>> '{sources,0,freshness}'='missing'
      AND length(m.payload #>> '{sources,499,detail}')=500
  ) THEN
    RAISE EXCEPTION 'complete optional evidence/source values at schema boundaries did not persist';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: optional evidence and sources accept complete nested values at every configured array/string boundary

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  valid_source jsonb;
  valid_incident jsonb;
  valid_branch jsonb;
  valid_totals jsonb;
  valid_evidence jsonb;
  base_message jsonb;
  bad_message jsonb;
  bad_evidence jsonb;
  bad_branch jsonb;
  bad_incident jsonb;
  bad_source jsonb;
  bad_totals jsonb;
  before_revision bigint;
  rejected boolean;
  case_index integer;
  message_id text;
BEGIN
  valid_source:=jsonb_build_object(
    'id','workflow-pg-strict-source','system','synthetic-evidence',
    'observedAt','2026-10-04T02:34:00.000Z','retrievedAt','2026-10-04T02:35:00.000Z',
    'freshness','fresh','detail','Synthetic source detail.');
  valid_incident:=jsonb_build_object(
    'id','workflow-pg-strict-incident','branchId','workflow-pg-proof-branch',
    'date','2026-10-04','title','Synthetic incident','kind','operations','status','open',
    'startedAt','2026-10-04T02:34:00.000Z','endedAt',NULL,'updatedAt','2026-10-04T02:35:00.000Z');
  valid_branch:=jsonb_build_object(
    'branchId','workflow-pg-proof-branch','branchName','Synthetic branch','region','east',
    'netSales',0,'target',0,'gap',0,'achievement',NULL,'stockIssues',0,'incidentCount',0,
    'staffingPlanned',0,'staffingActual',0,'incidents',jsonb_build_array(),
    'sourceIds',jsonb_build_array());
  valid_totals:=jsonb_build_object('netSales',0,'target',0,'gap',0,'achievement',NULL);
  valid_evidence:=jsonb_build_object(
    'scope',jsonb_build_object('region','east','date','2026-10-04'),
    'asOf','2026-10-04T02:35:00.000Z','version','snapshot-proof-strict-v1',
    'branches',jsonb_build_array(valid_branch),'totals',valid_totals,
    'sources',jsonb_build_array(valid_source),'warnings',jsonb_build_array());
  base_message:=jsonb_build_object(
    'rowVersion',1,'conversationId','workflow-pg-conversation-legacy-root',
    'actorId','workflow-pg-conversation-actor','role','assistant','text','Synthetic strict-shape fixture.',
    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:35:01.000Z',
    'turnId','workflow-pg-snapshot-proof-strict-turn','sessionId','workflow-pg-snapshot-proof-strict-session');
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  FOR case_index IN 1..5 LOOP
    message_id:='workflow-pg-snapshot-proof-invalid-extra-'||case_index;
    bad_message:=base_message||jsonb_build_object('id',message_id);
    CASE case_index
      WHEN 1 THEN
        bad_source:=valid_source||jsonb_build_object('syntheticExtra','unexpected');
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 2 THEN
        bad_evidence:=valid_evidence||jsonb_build_object('syntheticExtra','unexpected');
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 3 THEN
        bad_branch:=valid_branch||jsonb_build_object('syntheticExtra','unexpected');
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 4 THEN
        bad_incident:=valid_incident||jsonb_build_object('syntheticExtra','unexpected');
        bad_branch:=jsonb_set(valid_branch,'{incidents}',jsonb_build_array(bad_incident),true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      ELSE
        bad_totals:=valid_totals||jsonb_build_object('syntheticExtra',1);
        bad_evidence:=jsonb_set(valid_evidence,'{totals}',bad_totals,true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
    END CASE;
    rejected:=false;
    BEGIN
      INSERT INTO public.conversation_messages(id,row_version,payload)
      VALUES (message_id,1,bad_message);
    EXCEPTION WHEN check_violation THEN
      rejected:=true;
    END;
    IF NOT rejected OR EXISTS (SELECT 1 FROM public.conversation_messages WHERE id=message_id) THEN
      RAISE EXCEPTION 'strict nested evidence/source shape case % was accepted or persisted',case_index;
    END IF;
  END LOOP;
  IF (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'rejected nested evidence/source shapes changed the application revision';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: evidence, branch, incident, totals, and source objects reject nested extra keys without persistence

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  valid_source jsonb;
  valid_incident jsonb;
  valid_branch jsonb;
  valid_evidence jsonb;
  base_message jsonb;
  too_many_sources jsonb;
  too_many_evidence_sources jsonb;
  too_many_branches jsonb;
  too_many_warnings jsonb;
  too_many_incidents jsonb;
  too_many_source_ids jsonb;
  bad_evidence jsonb;
  bad_branch jsonb;
  bad_message jsonb;
  case_index integer;
  message_id text;
  before_revision bigint;
  rejected boolean;
BEGIN
  valid_source:=jsonb_build_object(
    'id','workflow-pg-limit-source','system','synthetic-evidence',
    'observedAt','2026-10-04T02:36:00.000Z','retrievedAt','2026-10-04T02:37:00.000Z',
    'freshness','fresh','detail','Synthetic source detail.');
  valid_incident:=jsonb_build_object(
    'id','workflow-pg-limit-incident','branchId','workflow-pg-proof-branch',
    'date','2026-10-04','title','Synthetic incident','kind','operations','status','open',
    'startedAt','2026-10-04T02:36:00.000Z','endedAt',NULL,'updatedAt','2026-10-04T02:37:00.000Z');
  valid_branch:=jsonb_build_object(
    'branchId','workflow-pg-proof-branch','branchName','Synthetic branch','region','east',
    'netSales',0,'target',0,'gap',0,'achievement',NULL,'stockIssues',0,'incidentCount',0,
    'staffingPlanned',0,'staffingActual',0,'incidents',jsonb_build_array(),
    'sourceIds',jsonb_build_array());
  valid_evidence:=jsonb_build_object(
    'scope',jsonb_build_object('region','east','date','2026-10-04'),
    'asOf','2026-10-04T02:37:00.000Z','version','snapshot-proof-count-v1',
    'branches',jsonb_build_array(valid_branch),
    'totals',jsonb_build_object('netSales',0,'target',0,'gap',0,'achievement',NULL),
    'sources',jsonb_build_array(valid_source),'warnings',jsonb_build_array());
  SELECT jsonb_agg(valid_source ORDER BY g.n) INTO too_many_sources FROM generate_series(1,501) AS g(n);
  SELECT jsonb_agg(valid_source ORDER BY g.n) INTO too_many_evidence_sources FROM generate_series(1,101) AS g(n);
  SELECT jsonb_agg(valid_branch ORDER BY g.n) INTO too_many_branches FROM generate_series(1,13) AS g(n);
  SELECT jsonb_agg(to_jsonb('synthetic warning'::text) ORDER BY g.n) INTO too_many_warnings FROM generate_series(1,51) AS g(n);
  SELECT jsonb_agg(valid_incident ORDER BY g.n) INTO too_many_incidents FROM generate_series(1,121) AS g(n);
  SELECT jsonb_agg('workflow-pg-source-id-'||g.n ORDER BY g.n) INTO too_many_source_ids FROM generate_series(1,101) AS g(n);
  base_message:=jsonb_build_object(
    'rowVersion',1,'conversationId','workflow-pg-conversation-legacy-root',
    'actorId','workflow-pg-conversation-actor','role','assistant','text','Synthetic limits fixture.',
    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:37:01.000Z',
    'turnId','workflow-pg-snapshot-proof-limit-turn','sessionId','workflow-pg-snapshot-proof-limit-session');
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  FOR case_index IN 1..8 LOOP
    message_id:='workflow-pg-snapshot-proof-invalid-limit-'||case_index;
    bad_message:=base_message||jsonb_build_object('id',message_id);
    bad_evidence:=valid_evidence;
    CASE case_index
      WHEN 1 THEN bad_message:=bad_message||jsonb_build_object('sources',too_many_sources);
      WHEN 2 THEN
        bad_evidence:=jsonb_set(valid_evidence,'{sources}',too_many_evidence_sources,true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 3 THEN
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',too_many_branches,true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 4 THEN
        bad_evidence:=jsonb_set(valid_evidence,'{warnings}',too_many_warnings,true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 5 THEN
        bad_branch:=jsonb_set(valid_branch,'{incidents}',too_many_incidents,true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 6 THEN
        bad_branch:=jsonb_set(valid_branch,'{sourceIds}',too_many_source_ids,true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 7 THEN
        bad_branch:=jsonb_set(valid_branch,'{stockIssues}',to_jsonb(0.5),true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      ELSE
        bad_branch:=jsonb_set(valid_branch,'{target}',to_jsonb(-1),true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
    END CASE;
    rejected:=false;
    BEGIN
      INSERT INTO public.conversation_messages(id,row_version,payload)
      VALUES (message_id,1,bad_message);
    EXCEPTION WHEN check_violation THEN
      rejected:=true;
    END;
    IF NOT rejected OR EXISTS (SELECT 1 FROM public.conversation_messages WHERE id=message_id) THEN
      RAISE EXCEPTION 'proof array/count/type boundary case % was accepted or persisted',case_index;
    END IF;
  END LOOP;
  IF (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'rejected proof array/count/type boundaries changed the application revision';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: source/evidence arrays and integral/nonnegative metric limits fail closed above their bounds

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  valid_source jsonb;
  valid_incident jsonb;
  valid_branch jsonb;
  valid_evidence jsonb;
  base_message jsonb;
  bad_source jsonb;
  bad_incident jsonb;
  bad_branch jsonb;
  bad_evidence jsonb;
  bad_message jsonb;
  case_index integer;
  message_id text;
  before_revision bigint;
  rejected boolean;
BEGIN
  valid_source:=jsonb_build_object(
    'id','workflow-pg-time-source','system','synthetic-evidence',
    'observedAt','2026-10-04T02:38:00.000Z','retrievedAt','2026-10-04T02:39:00.000Z',
    'freshness','fresh','detail','Synthetic source detail.');
  valid_incident:=jsonb_build_object(
    'id','workflow-pg-time-incident','branchId','workflow-pg-proof-branch',
    'date','2026-10-04','title','Synthetic incident','kind','operations','status','open',
    'startedAt','2026-10-04T02:38:00.000Z','endedAt',NULL,'updatedAt','2026-10-04T02:39:00.000Z');
  valid_branch:=jsonb_build_object(
    'branchId','workflow-pg-proof-branch','branchName','Synthetic branch','region','east',
    'netSales',0,'target',0,'gap',0,'achievement',NULL,'stockIssues',0,'incidentCount',0,
    'staffingPlanned',0,'staffingActual',0,'incidents',jsonb_build_array(valid_incident),
    'sourceIds',jsonb_build_array());
  valid_evidence:=jsonb_build_object(
    'scope',jsonb_build_object('region','east','date','2026-10-04'),
    'asOf','2026-10-04T02:39:00.000Z','version','snapshot-proof-time-v1',
    'branches',jsonb_build_array(valid_branch),
    'totals',jsonb_build_object('netSales',0,'target',0,'gap',0,'achievement',NULL),
    'sources',jsonb_build_array(valid_source),'warnings',jsonb_build_array());
  base_message:=jsonb_build_object(
    'rowVersion',1,'conversationId','workflow-pg-conversation-legacy-root',
    'actorId','workflow-pg-conversation-actor','role','assistant','text','Synthetic timestamp/freshness fixture.',
    'mode','scripted_demo','modeRevision',0,'createdAt','2026-10-04T02:39:01.000Z',
    'turnId','workflow-pg-snapshot-proof-time-turn','sessionId','workflow-pg-snapshot-proof-time-session');
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  FOR case_index IN 1..9 LOOP
    message_id:='workflow-pg-snapshot-proof-invalid-time-'||case_index;
    bad_message:=base_message||jsonb_build_object('id',message_id);
    bad_evidence:=valid_evidence;
    bad_source:=valid_source;
    CASE case_index
      WHEN 1 THEN
        bad_source:=jsonb_set(valid_source,'{observedAt}',to_jsonb('not-an-instant'::text),true);
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 2 THEN
        bad_source:=jsonb_set(valid_source,'{retrievedAt}',to_jsonb('not-an-instant'::text),true);
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 3 THEN
        bad_source:=jsonb_set(valid_source,'{freshness}',to_jsonb('unknown'::text),true);
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 4 THEN
        bad_source:=jsonb_set(jsonb_set(valid_source,'{observedAt}',to_jsonb(''::text),true),
          '{freshness}',to_jsonb('fresh'::text),true);
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 5 THEN
        bad_source:=jsonb_set(valid_source,'{detail}',to_jsonb(repeat('d',501)),true);
        bad_message:=bad_message||jsonb_build_object('sources',jsonb_build_array(bad_source));
      WHEN 6 THEN
        bad_evidence:=jsonb_set(valid_evidence,'{asOf}',to_jsonb('not-an-instant'::text),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 7 THEN
        bad_evidence:=jsonb_set(valid_evidence,'{scope,date}',to_jsonb('2026-02-30'::text),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      WHEN 8 THEN
        bad_incident:=jsonb_set(valid_incident,'{startedAt}',to_jsonb('not-an-instant'::text),true);
        bad_branch:=jsonb_set(valid_branch,'{incidents}',jsonb_build_array(bad_incident),true);
        bad_evidence:=jsonb_set(valid_evidence,'{branches}',jsonb_build_array(bad_branch),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
      ELSE
        bad_evidence:=jsonb_set(valid_evidence,'{warnings}',jsonb_build_array(to_jsonb(repeat('w',501))),true);
        bad_message:=bad_message||jsonb_build_object('evidence',bad_evidence);
    END CASE;
    rejected:=false;
    BEGIN
      INSERT INTO public.conversation_messages(id,row_version,payload)
      VALUES (message_id,1,bad_message);
    EXCEPTION WHEN check_violation THEN
      rejected:=true;
    END;
    IF NOT rejected OR EXISTS (SELECT 1 FROM public.conversation_messages WHERE id=message_id) THEN
      RAISE EXCEPTION 'proof timestamp/freshness case % was accepted or persisted',case_index;
    END IF;
  END LOOP;
  IF (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'rejected timestamp/freshness values changed the application revision';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: source freshness, timestamps, observation pairing, date validity, and text bounds reject malformed values

DO $case$
DECLARE
  snapshot_rows integer;
  proof_marker boolean;
  historical_rows boolean;
BEGIN
  SELECT count(*) INTO snapshot_rows
  FROM nexus_private.workflow_projection_migrations
  WHERE id='202610040002_workflow_snapshot_proof_references';
  SELECT EXISTS (
    SELECT 1 FROM nexus_private.workflow_projection_migrations
    WHERE id='202610040001_workflow_conversation_persistence'
  ) AND EXISTS (
    SELECT 1 FROM nexus_private.workflow_projection_migrations
    WHERE id='202610030002_workflow_projection_completeness'
  ) INTO historical_rows;
  SELECT EXISTS (
    SELECT 1 FROM public.review_snapshot_targets
    WHERE id='workflow-pg-snapshot-proof-receipt-target'
      AND action_execution_contract_version=2
      AND action_execution_id='workflow-pg-snapshot-proof-execution'
  ) INTO proof_marker;
  IF snapshot_rows<>1 OR NOT historical_rows OR NOT proof_marker THEN
    RAISE EXCEPTION 'snapshot proof ledger, predecessor history or generated V2 receipt marker is incomplete';
  END IF;
END
$case$;
\echo CASE PASS: snapshot proof ledger appends once and preserves 040001/completeness history with V2 receipt provenance

COMMIT;

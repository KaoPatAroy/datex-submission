-- Local PostgreSQL SQL conformance only. This does not prove hosted Supabase
-- Auth, Data API, policy, or deployment behavior.
\set ON_ERROR_STOP 1
\echo CONFORMANCE: PostgreSQL migration, projection, transaction, and role guards

BEGIN;

DO $case$
DECLARE
  manifest_count integer;
  open_state_present boolean;
  open_index_valid boolean;
  branch_fk_present boolean;
  positive_row_version_check_present boolean;
BEGIN
  SELECT count(*) INTO manifest_count FROM nexus_private.workflow_manifest;
  SELECT EXISTS (
    SELECT 1
    FROM nexus_private.workflow_manifest m
    CROSS JOIN LATERAL jsonb_array_elements(m.definition->'unique') AS u(value)
    WHERE m.table_name='asset_assignments'
      AND u.value->>'name'='asset_assignments_open_asset_unique'
      AND u.value->>'openOnly'='true'
      AND u.value->'openStates'='["assigned"]'::jsonb
  ) INTO open_state_present;
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    WHERE i.indexrelid=to_regclass('public.asset_assignments_open_asset_unique')
      AND i.indisvalid AND i.indisready
      AND pg_get_expr(i.indpred,i.indrelid) LIKE '%assigned%'
  ) INTO open_index_valid;
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.employees'::regclass
      AND c.conname='wf_employees_branch_id_fk'
      AND c.contype='f' AND c.condeferrable
  ) INTO branch_fk_present;
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.branches'::regclass
      AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%row_version > 0%'
  ) INTO positive_row_version_check_present;

  IF manifest_count<>62 OR NOT open_state_present OR NOT open_index_valid
    OR NOT branch_fk_present OR NOT positive_row_version_check_present THEN
    RAISE EXCEPTION 'manifest or native workflow index/FK/check installation is incomplete: manifest %, open state %, index %, branch FK %, row-version check %',
      manifest_count,open_state_present,open_index_valid,branch_fk_present,positive_row_version_check_present;
  END IF;
END
$case$;
\echo CASE PASS: manifest metadata, positive row-version check, regenerated open-state index, and native branch FK are installed

SET LOCAL ROLE service_role;

DO $case$
DECLARE
  current_revision bigint;
  returned_revision bigint;
  revision_before_duplicate bigint;
  preserved_version bigint;
  preserved_status text;
  duplicate_rejected boolean:=false;
BEGIN
  INSERT INTO public.employees(id,payload) VALUES ('workflow-pg-assigned-employee',jsonb_build_object(
    'id','workflow-pg-assigned-employee','name','Synthetic assigned employee',
    'branchId','workflow-pg-ordered-cas-branch','active',true));

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(
    current_revision,
    jsonb_build_array(
      jsonb_build_object('kind','insert_unique','table','assets','constraint','assets_tag_unique',
        'values',jsonb_build_object('assetTag','workflow-pg-open-assignment-tag'),
        'row',jsonb_build_object('id','workflow-pg-open-assignment-asset','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-open-assignment-asset','rowVersion',1,'assetTag','workflow-pg-open-assignment-tag',
          'status','available','serialNumber','workflow-pg-serial','kind','laptop','model','SQL fixture'))),
      jsonb_build_object('kind','insert_unique','table','asset_assignments',
        'constraint','asset_assignments_open_asset_unique',
        'values',jsonb_build_object('assetId','workflow-pg-open-assignment-asset'),
        'row',jsonb_build_object('id','workflow-pg-assignment-one','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-assignment-one','rowVersion',1,'assetId','workflow-pg-open-assignment-asset',
          'employeeId','workflow-pg-assigned-employee','status','assigned','assignedAt','2026-10-03T00:00:00.000Z')))
    )
  ) INTO returned_revision;

  IF returned_revision<>current_revision+1
    OR (SELECT row_version FROM public.asset_assignments WHERE id='workflow-pg-assignment-one')<>1
    OR (SELECT status FROM public.asset_assignments WHERE id='workflow-pg-assignment-one')<>'assigned' THEN
    RAISE EXCEPTION 'first open asset assignment was not committed at its initial state';
  END IF;

  SELECT revision INTO revision_before_duplicate FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.asset_assignments(id,row_version,body)
    VALUES ('workflow-pg-assignment-duplicate-open',1,jsonb_build_object(
      'id','workflow-pg-assignment-duplicate-open','rowVersion',1,
      'assetId','workflow-pg-open-assignment-asset','employeeId','workflow-pg-assigned-employee',
      'status','assigned','assignedAt','2026-10-03T00:03:00.000Z'));
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected:=true;
  END;
  SELECT row_version,status INTO preserved_version,preserved_status
  FROM public.asset_assignments WHERE id='workflow-pg-assignment-one';
  IF NOT duplicate_rejected
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.asset_assignments WHERE id='workflow-pg-assignment-duplicate-open')
    OR preserved_version<>1 OR preserved_status<>'assigned' THEN
    RAISE EXCEPTION 'native partial unique index did not reject a duplicate open assignment atomically';
  END IF;

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(
    current_revision,
    jsonb_build_array(
      jsonb_build_object('kind','cas','table','asset_assignments','id','workflow-pg-assignment-one',
        'expected',jsonb_build_object('rowVersion',1,'state','assigned'),
        'next',jsonb_build_object('id','workflow-pg-assignment-one','rowVersion',2,'body',jsonb_build_object(
          'id','workflow-pg-assignment-one','rowVersion',2,'assetId','workflow-pg-open-assignment-asset',
          'employeeId','workflow-pg-assigned-employee','status','returned','assignedAt','2026-10-03T00:00:00.000Z',
          'returnedAt','2026-10-03T00:05:00.000Z'))),
      jsonb_build_object('kind','insert_unique','table','asset_assignments',
        'constraint','asset_assignments_open_asset_unique',
        'values',jsonb_build_object('assetId','workflow-pg-open-assignment-asset'),
        'row',jsonb_build_object('id','workflow-pg-assignment-two','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-assignment-two','rowVersion',1,'assetId','workflow-pg-open-assignment-asset',
          'employeeId','workflow-pg-assigned-employee','status','assigned','assignedAt','2026-10-03T00:06:00.000Z')))
    )
  ) INTO returned_revision;
  IF returned_revision<>current_revision+1
    OR (SELECT status FROM public.asset_assignments WHERE id='workflow-pg-assignment-one')<>'returned'
    OR (SELECT status FROM public.asset_assignments WHERE id='workflow-pg-assignment-two')<>'assigned' THEN
    RAISE EXCEPTION 'open asset uniqueness did not release after its configured terminal state';
  END IF;
END
$case$;
\echo CASE PASS: partial open-asset uniqueness allows a replacement after the prior assignment is returned

DO $case$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.employees(id,payload)
    VALUES ('workflow-pg-missing-branch-employee',jsonb_build_object(
      'id','workflow-pg-missing-branch-employee','name','Synthetic employee',
      'branchId','workflow-pg-absent-branch','active',true));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected OR EXISTS (
    SELECT 1 FROM public.employees WHERE id='workflow-pg-missing-branch-employee'
  ) THEN
    RAISE EXCEPTION 'employee branch reference was not rejected atomically';
  END IF;
END
$case$;
\echo CASE PASS: native employee-to-branch FK rejects an absent source row

DO $case$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.branches(id,row_version,payload)
    VALUES ('workflow-pg-zero-version',0,jsonb_build_object(
      'id','workflow-pg-zero-version','name','Invalid version','region','east'));
  EXCEPTION WHEN check_violation THEN
    rejected:=true;
  END;
  IF NOT rejected OR EXISTS (SELECT 1 FROM public.branches WHERE id='workflow-pg-zero-version') THEN
    RAISE EXCEPTION 'zero workflow row version was not rejected atomically';
  END IF;
END
$case$;
\echo CASE PASS: native row-version check rejects zero

DO $case$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.branches(id,payload)
    VALUES ('workflow-pg-body-id','{"id":"workflow-pg-other-id","name":"Wrong identity","region":"east"}'::jsonb);
  EXCEPTION WHEN check_violation THEN
    rejected:=true;
  END;
  IF NOT rejected OR EXISTS (SELECT 1 FROM public.branches WHERE id='workflow-pg-body-id') THEN
    RAISE EXCEPTION 'payload identity mismatch was not rejected atomically';
  END IF;
END
$case$;
\echo CASE PASS: legacy payload identity check rejects mismatched body id

DO $case$
DECLARE
  start_revision bigint;
  returned_revision bigint;
  current_version bigint;
  current_name text;
  branch_id constant text:='workflow-pg-ordered-cas-branch';
BEGIN
  SELECT revision INTO start_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(
    start_revision,
    jsonb_build_array(
      jsonb_build_object(
        'kind','insert_unique','table','branches','constraint','branches_primary_key',
        'values',jsonb_build_object('id',branch_id),
        'row',jsonb_build_object('id',branch_id,'rowVersion',1,'body',jsonb_build_object(
          'id',branch_id,'name','Workflow branch first','region','east','active',true,
          'updatedAt','2026-10-03T00:00:00.000Z'))),
      jsonb_build_object(
        'kind','cas','table','branches','id',branch_id,
        'expected',jsonb_build_object('rowVersion',1,'state',NULL::text),
        'next',jsonb_build_object('id',branch_id,'rowVersion',2,'body',jsonb_build_object(
          'id',branch_id,'name','Workflow branch second','region','east','active',true,
          'updatedAt','2026-10-03T00:01:00.000Z'))),
      jsonb_build_object(
        'kind','cas','table','branches','id',branch_id,
        'expected',jsonb_build_object('rowVersion',2,'state',NULL::text),
        'next',jsonb_build_object('id',branch_id,'rowVersion',3,'body',jsonb_build_object(
          'id',branch_id,'name','Workflow branch third','region','east','active',true,
          'updatedAt','2026-10-03T00:02:00.000Z')))
    )
  ) INTO returned_revision;

  SELECT row_version,payload->>'name' INTO current_version,current_name
  FROM public.branches WHERE id=branch_id AND payload->>'id'=id;
  IF returned_revision<>start_revision+1 OR current_version<>3 OR current_name<>'Workflow branch third' THEN
    RAISE EXCEPTION 'ordered insert/CAS/CAS did not commit one revision and the final body';
  END IF;
END
$case$;
\echo CASE PASS: ordered unique insert then CAS then CAS commits one revision and version three

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  kept_version bigint;
  kept_name text;
  rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(
      before_revision,
      jsonb_build_array(jsonb_build_object(
        'kind','insert_unique','table','branches','constraint','branches_primary_key',
        'values',jsonb_build_object('id','workflow-pg-ordered-cas-branch'),
        'row',jsonb_build_object('id','workflow-pg-ordered-cas-branch','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-ordered-cas-branch','name','MUST NOT OVERWRITE','region','west'))))
    );
  EXCEPTION WHEN unique_violation THEN
    rejected:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  SELECT row_version,payload->>'name' INTO kept_version,kept_name
  FROM public.branches WHERE id='workflow-pg-ordered-cas-branch';
  IF NOT rejected OR before_revision<>after_revision OR kept_version<>3 OR kept_name<>'Workflow branch third' THEN
    RAISE EXCEPTION 'conflicting unique insert overwrote the existing row or advanced the revision';
  END IF;
END
$case$;
\echo CASE PASS: conflicting unique insert fails without overwriting the existing row

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  stale_cas_rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(
      before_revision,
      jsonb_build_array(
        jsonb_build_object(
          'kind','insert_unique','table','branches','constraint','branches_primary_key',
          'values',jsonb_build_object('id','workflow-pg-rolled-back-insert'),
          'row',jsonb_build_object('id','workflow-pg-rolled-back-insert','rowVersion',1,'body',jsonb_build_object(
            'id','workflow-pg-rolled-back-insert','name','Must roll back','region','east'))),
        jsonb_build_object(
          'kind','cas','table','branches','id','workflow-pg-ordered-cas-branch',
          'expected',jsonb_build_object('rowVersion',1,'state',NULL::text),
          'next',jsonb_build_object('id','workflow-pg-ordered-cas-branch','rowVersion',2,'body',jsonb_build_object(
            'id','workflow-pg-ordered-cas-branch','name','Must not commit','region','east')))
      )
    );
  EXCEPTION WHEN serialization_failure THEN
    stale_cas_rejected:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT stale_cas_rejected OR before_revision<>after_revision
    OR EXISTS (SELECT 1 FROM public.branches WHERE id='workflow-pg-rolled-back-insert')
    OR (SELECT row_version FROM public.branches WHERE id='workflow-pg-ordered-cas-branch')<>3 THEN
    RAISE EXCEPTION 'stale row CAS did not roll back its earlier insert atomically';
  END IF;
END
$case$;
\echo CASE PASS: stale row CAS rolls the preceding unique insert back atomically

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(
      before_revision+1,
      jsonb_build_array(jsonb_build_object(
        'kind','insert_unique','table','branches','constraint','branches_primary_key',
        'values',jsonb_build_object('id','workflow-pg-global-conflict-insert'),
        'row',jsonb_build_object('id','workflow-pg-global-conflict-insert','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-global-conflict-insert','name','Must roll back','region','east'))))
    );
  EXCEPTION WHEN serialization_failure THEN
    rejected:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT rejected OR before_revision<>after_revision
    OR EXISTS (SELECT 1 FROM public.branches WHERE id='workflow-pg-global-conflict-insert') THEN
    RAISE EXCEPTION 'stale global revision did not reject the batch atomically';
  END IF;
END
$case$;
\echo CASE PASS: global revision conflict rejects the complete batch

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  rejected_pending boolean:=false;
  rejected_execution boolean:=false;
  rejected_share_markers integer:=0;
  rejected_null_share_markers integer:=0;
  marker_field text;
  share_id text;
  share_body jsonb;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_commit(
      before_revision,
      jsonb_build_array(jsonb_build_object(
        'table','pending_actions','id','workflow-pg-v1-marker-rejected',
        'payload',jsonb_build_object('id','workflow-pg-v1-marker-rejected','contractVersion',2)))
    );
  EXCEPTION WHEN check_violation THEN
    rejected_pending:=true;
  END;
  BEGIN
    PERFORM public.nexus_commit(
      before_revision,
      jsonb_build_array(jsonb_build_object(
        'table','action_executions','id','workflow-pg-v1-markerless-execution-rejected',
        'payload',jsonb_build_object('id','workflow-pg-v1-markerless-execution-rejected','contractVersion',2)))
    );
  EXCEPTION WHEN check_violation THEN
    rejected_execution:=true;
  END;
  FOR marker_field IN SELECT unnest(ARRAY['senderIdentityId','recipientIdentityId','approvedBranchIds']) LOOP
    share_id:='workflow-pg-v1-markerless-share-'||marker_field;
    share_body:=jsonb_build_object('id',share_id);
    IF marker_field='approvedBranchIds' THEN
      share_body:=share_body||jsonb_build_object(marker_field,jsonb_build_array('workflow-pg-ordered-cas-branch'));
    ELSE
      share_body:=share_body||jsonb_build_object(marker_field,'workflow-pg-sender');
    END IF;
    BEGIN
      PERFORM public.nexus_commit(
        before_revision,
        jsonb_build_array(jsonb_build_object('table','dashboard_shares','id',share_id,'payload',share_body))
      );
    EXCEPTION WHEN check_violation THEN
      rejected_share_markers:=rejected_share_markers+1;
    END;
  END LOOP;
  FOR marker_field IN SELECT unnest(ARRAY['senderIdentityId','recipientIdentityId','approvedBranchIds']) LOOP
    share_id:='workflow-pg-v1-markerless-null-share-'||marker_field;
    share_body:=jsonb_build_object('id',share_id,marker_field,NULL::jsonb);
    BEGIN
      PERFORM public.nexus_commit(
        before_revision,
        jsonb_build_array(jsonb_build_object('table','dashboard_shares','id',share_id,'payload',share_body))
      );
    EXCEPTION WHEN check_violation THEN
      rejected_null_share_markers:=rejected_null_share_markers+1;
    END;
  END LOOP;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT rejected_pending OR NOT rejected_execution OR rejected_share_markers<>3 OR rejected_null_share_markers<>3
    OR before_revision<>after_revision
    OR EXISTS (SELECT 1 FROM public.pending_actions WHERE id='workflow-pg-v1-marker-rejected')
    OR EXISTS (SELECT 1 FROM public.action_executions WHERE id='workflow-pg-v1-markerless-execution-rejected')
    OR EXISTS (SELECT 1 FROM public.dashboard_shares WHERE id LIKE 'workflow-pg-v1-markerless-share-%'
      OR id LIKE 'workflow-pg-v1-markerless-null-share-%') THEN
    RAISE EXCEPTION 'legacy nexus_commit accepted a markerless V2 action or share body';
  END IF;
END
$case$;
\echo CASE PASS: legacy nexus_commit rejects markerless V2 actions and present-null share bodies

DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  action_id constant text:='workflow-pg-action';
  actor_id constant text:='workflow-pg-actor';
  session_id constant text:='workflow-pg-session';
  conversation_id constant text:='workflow-pg-conversation';
  branch_version bigint;
  current_revision bigint;
  returned_revision bigint;
  action_body jsonb;
  expected_rows jsonb;
  canonical_policy jsonb;
  canonical_policy_digest constant text:='0515a53cb4bb6a1259d1c8f6d75b0c2b954598e3ecce723857a6fb8a652b04be';
BEGIN
  INSERT INTO public.profiles(id,payload) VALUES (actor_id,jsonb_build_object(
    'id',actor_id,'name','Synthetic workflow actor','role','hr_admin','active',true,
    'permissions',jsonb_build_array(),'regions',jsonb_build_array()));
  INSERT INTO public.profiles(id,payload) VALUES ('workflow-pg-recipient',jsonb_build_object(
    'id','workflow-pg-recipient','name','Synthetic workflow recipient','role','executive','active',true,
    'permissions',jsonb_build_array(),'regions',jsonb_build_array()));
  INSERT INTO public.sessions(id,payload) VALUES (session_id,jsonb_build_object(
    'id',session_id,'profileId',actor_id,'expiresAt','2099-01-01T00:00:00.000Z',
    'mode','scripted_demo','modeRevision',0,'csrfToken','sql-conformance-csrf','createdAt','2026-10-03T00:00:00.000Z'));
  INSERT INTO public.conversations(id,payload) VALUES (conversation_id,jsonb_build_object(
    'id',conversation_id,'actorId',actor_id,'createdAt','2026-10-03T00:00:00.000Z',
    'lastScope',jsonb_build_object('region','east','date','2026-10-03')));

  canonical_policy:=jsonb_build_object(
    'id','demo-workflow','version',1,'timezone','Asia/Bangkok','classification','internal',
    'pendingTtlSeconds',600,'shareTtlSeconds',86400,
    'shareSigning',jsonb_build_object('purpose','nexus/share-url/v1','keyVersion',1),
    'requiredOnboardingDocuments',jsonb_build_array('identity_document','signed_offer','signed_contract'),
    'restock',jsonb_build_object('targetMinimumMultiplier',2,'maxQuantity',1000,'maxEvidenceAgeHours',24),
    'crmInactiveDays',14,
    'tasks',jsonb_build_object('normalDueDays',3,'highDueDays',1,'defaultPriority','normal'),
    'contractReminderDays',30,
    'incident',jsonb_build_object('from','un_escalated','to','team_requested','targetTeam','demo_operations'),
    'discount',jsonb_build_object('minBasisPoints',1,'maxBasisPoints',10000,'initialStage','manager_review_pending'),
    'onboardingTaskTemplates',jsonb_build_array('hr_welcome','it_setup_request','policy_acknowledgement'),
    'offboardingTaskTemplates',jsonb_build_array('it_disable_request','asset_return','badge_review'),
    'policyAcknowledgementVersion','1.0','maxBatchTargets',100,'maxReasonChars',500,'connectorMode','simulated_only');
  INSERT INTO public.workflow_policies(id,row_version,body)
  VALUES ('workflow-pg-policy-physical-row',1,jsonb_build_object(
    'id','workflow-pg-policy-physical-row','version',1,'digest',canonical_policy_digest,'policy',canonical_policy));
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_policies
    WHERE id='workflow-pg-policy-physical-row' AND policy_id='demo-workflow'
      AND version=1 AND digest=canonical_policy_digest
  ) THEN
    RAISE EXCEPTION 'policy fixture did not preserve the physical/logical ID distinction';
  END IF;

  SELECT row_version INTO branch_version FROM public.branches WHERE id=branch_id;
  expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','branches','id',branch_id),
    'rowVersion',branch_version,'state',NULL::text));
  action_body:=jsonb_build_object(
    'id',action_id,'contractVersion',2,'actorId',actor_id,'sessionId',session_id,
    'conversationId',conversation_id,'turnId','workflow-pg-turn','mode','scripted_demo','modeRevision',0,
    'payload',jsonb_build_object('kind','investigation_create','businessDate','2026-10-03','targets',jsonb_build_array(
      jsonb_build_object('ownerIdentityId','workflow-pg-sender','reason','Review a synthetic inventory discrepancy.',
        'dueDate','2026-10-06','priority','normal','branchId',branch_id,'caseId','workflow-pg-case',
        'sourceIds',jsonb_build_array('workflow-pg-source'),'unansweredQuestion','Which movement explains the reviewed difference?'))),
    'payloadHash',repeat('a',64),'idempotencyKey',repeat('b',64),
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId','workflow-pg-target','ref',jsonb_build_object('table','investigation_cases','id','workflow-pg-case'),
      'semanticKey','workflow-pg-investigation:workflow-pg-case','expectedRows',expected_rows,
      'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','investigation_tasks','id','workflow-pg-task'),
      'expectedEffectVersion',1)),
    'targetCount',1,'expectedRows',expected_rows,'approvedBranchIds',jsonb_build_array(branch_id),
    'approvedOrgUnitIds',jsonb_build_array(),'reviewedSnapshotId',NULL,
    'policy',jsonb_build_object('id','demo-workflow','version',1,'digest',canonical_policy_digest),
    'packs',jsonb_build_array(jsonb_build_object('id','workflow-operations','version','1.0',
      'schemaDigest',repeat('d',64),'implementationRevision','operations-r1')),
    'releaseRevision','release-r1','executionMode','atomic_local','createdAt','2026-10-03T00:01:00.000Z',
    'expiresAt','2026-10-03T00:11:00.000Z','status','pending');

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'kind','insert_unique','table','pending_actions','constraint','pending_actions_primary_key',
    'values',jsonb_build_object('id',action_id),
    'row',jsonb_build_object('id',action_id,'rowVersion',1,'body',action_body))))
    INTO returned_revision;
  IF returned_revision<>current_revision+1 OR NOT EXISTS (
    SELECT 1 FROM public.pending_actions
    WHERE id=action_id AND workflow_contract_version=2 AND row_version=1
      AND payload->'expectedRows'=expected_rows
  ) THEN
    RAISE EXCEPTION 'canonical pending action did not persist with marker, version, and pinned source version';
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END
$case$;
\echo CASE PASS: canonical pending-action fixture persists a marker-two row and pins its source version

DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  action_id constant text:='workflow-pg-action';
  before_revision bigint;
  returned_revision bigint;
  after_revision bigint;
  old_source_version bigint;
  new_source_version bigint;
  pinned_expected_version bigint;
  pinned_expected_version_after bigint;
  adapter_write_before integer;
  adapter_write_after integer;
  updated_payload jsonb;
BEGIN
  SELECT revision,workflow_adapter_write INTO before_revision,adapter_write_before
  FROM public.appmeta WHERE singleton=1;
  SELECT row_version INTO old_source_version FROM public.branches WHERE id=branch_id;
  SELECT (payload #>> '{expectedRows,0,rowVersion}')::bigint INTO pinned_expected_version
  FROM public.pending_actions WHERE id=action_id AND workflow_contract_version=2;
  RAISE NOTICE 'CASE12 before V1 nexus_commit: appmeta_revision=%, source_row_version=%, historical_expected_row_version=%, workflow_adapter_write=%, custom_guc_probe=%',
    before_revision,old_source_version,pinned_expected_version,adapter_write_before,
    current_setting('nexus.workflow_adapter_write',true);
  IF old_source_version<>3 OR pinned_expected_version<>old_source_version THEN
    RAISE EXCEPTION 'fixture did not establish the original expected source version';
  END IF;
  SELECT public.nexus_commit(
    before_revision,
    jsonb_build_array(jsonb_build_object(
      'table','branches','id',branch_id,
      'payload',(SELECT payload||jsonb_build_object('name','Workflow V1 source updated') FROM public.branches WHERE id=branch_id)))
  ) INTO returned_revision;
  SELECT revision,workflow_adapter_write INTO after_revision,adapter_write_after
  FROM public.appmeta WHERE singleton=1;
  SELECT row_version INTO new_source_version FROM public.branches WHERE id=branch_id;
  SELECT (payload #>> '{expectedRows,0,rowVersion}')::bigint INTO pinned_expected_version_after
  FROM public.pending_actions WHERE id=action_id AND workflow_contract_version=2;
  RAISE NOTICE 'CASE12 after V1 nexus_commit: returned_revision=%, appmeta_revision_before=%, appmeta_revision_after=%, source_row_version_before=%, source_row_version_after=%, historical_expected_row_version_before=%, historical_expected_row_version_after=%, workflow_adapter_write_before=%, workflow_adapter_write_after=%, custom_guc_probe=%',
    returned_revision,before_revision,after_revision,old_source_version,new_source_version,
    pinned_expected_version,pinned_expected_version_after,adapter_write_before,adapter_write_after,
    current_setting('nexus.workflow_adapter_write',true);
  IF returned_revision<=before_revision OR returned_revision<>after_revision
    OR new_source_version<>old_source_version+1
    OR pinned_expected_version_after<>old_source_version
    OR adapter_write_before<>0 OR adapter_write_after<>0 THEN
    RAISE EXCEPTION 'V1 source update failed: returned_revision=%, appmeta_before=%, appmeta_after=%, source_version_before=%, source_version_after=%, expected_row_version_before=%, expected_row_version_after=%, adapter_write_before=%, adapter_write_after=%',
      returned_revision,before_revision,after_revision,old_source_version,new_source_version,
      pinned_expected_version,pinned_expected_version_after,adapter_write_before,adapter_write_after;
  END IF;
END
$case$;
\echo CASE PASS: legitimate V1 source update advances revision/version and preserves the action expected version

DO $case$
DECLARE
  current_revision bigint;
  rejected boolean:=false;
BEGIN
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
      'table','pending_actions','id','workflow-pg-action',
      'payload',(SELECT payload||jsonb_build_object('status','claimed') FROM public.pending_actions WHERE id='workflow-pg-action'))));
  EXCEPTION WHEN check_violation THEN
    rejected:=true;
  END;
  IF NOT rejected OR (SELECT payload->>'status' FROM public.pending_actions WHERE id='workflow-pg-action')<>'pending' THEN
    RAISE EXCEPTION 'legacy nexus_commit mutated a protected V2 action';
  END IF;
END
$case$;
\echo CASE PASS: legacy nexus_commit cannot overwrite an existing protected V2 action

DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  actor_id constant text:='workflow-pg-actor';
  current_revision bigint;
  returned_revision bigint;
  org_body jsonb;
  sender_body jsonb;
  recipient_body jsonb;
  dashboard_body jsonb;
  root_body jsonb;
  receipt_body jsonb;
  version_body jsonb;
  share_body jsonb;
  allowed_child jsonb;
  operations jsonb;
BEGIN
  INSERT INTO public.dashboards(id,payload) VALUES ('workflow-pg-dashboard',jsonb_build_object(
    'id','workflow-pg-dashboard','ownerId',actor_id,'createdAt','2026-10-03T00:00:00.000Z',
    'updatedAt','2026-10-03T00:00:00.000Z','spec',jsonb_build_object('title','Synthetic SQL conformance dashboard'),
    'packs',jsonb_build_array()));
  INSERT INTO public.branches(id,payload) VALUES ('workflow-pg-share-outside-branch',jsonb_build_object(
    'id','workflow-pg-share-outside-branch','name','Unapproved synthetic branch','region','west'));

  org_body:=jsonb_build_object('id','workflow-pg-org','parentOrgUnitId',NULL,
    'name','Workflow PostgreSQL SQL conformance','active',true,'kind','department','createdAt','2026-10-03T00:00:00.000Z');
  sender_body:=jsonb_build_object('id','workflow-pg-sender','profileId',actor_id,'displayName','Synthetic sender',
    'active',true,'role','hr_admin','department','hr','orgUnitId','workflow-pg-org','managerIdentityId',NULL,
    'verifiedDemoEmail','workflow-pg-sender@example.invalid','slackIdentity',NULL,
    'allowedChannels',jsonb_build_array('simulated_email'),'classificationCeiling','internal','rowVersion',1);
  recipient_body:=jsonb_build_object('id','workflow-pg-recipient-identity','profileId','workflow-pg-recipient',
    'displayName','Synthetic recipient','active',true,'role','hr_director','department','hr',
    'orgUnitId','workflow-pg-org','managerIdentityId',NULL,
    'verifiedDemoEmail','workflow-pg-recipient@example.invalid','slackIdentity',NULL,
    'allowedChannels',jsonb_build_array('simulated_email'),'classificationCeiling','internal','rowVersion',1);
  root_body:=jsonb_build_object('id','workflow-pg-root','actorId',actor_id,
    'idempotencyKey',repeat('b',64),'activeExecutionId','workflow-pg-execution','actionId','workflow-pg-action',
    'createdAt','2026-10-03T00:02:00.000Z','status','open');
  receipt_body:=jsonb_build_object('id','workflow-pg-execution','actionId','workflow-pg-action',
    'contractVersion',2,'actorId',actor_id,'kind','investigation_create','outcome','pending',
    'proofs',jsonb_build_array(),'createdAt','2026-10-03T00:02:00.000Z','verifiedAt',NULL,
    'currentStates',jsonb_build_array());
  version_body:=jsonb_build_object('id','workflow-pg-dashboard-version',
    'dashboardId','workflow-pg-dashboard','version',1,'ownerId',actor_id,
    'createdAt','2026-10-03T00:02:00.000Z','spec',jsonb_build_object('title','Synthetic SQL conformance dashboard'),
    'packs',jsonb_build_array(),'digest',repeat('f',64));
  share_body:=jsonb_build_object('id','workflow-pg-share','dashboardId','workflow-pg-dashboard',
    'dashboardVersionId','workflow-pg-dashboard-version','senderIdentityId','workflow-pg-sender',
    'recipientIdentityId','workflow-pg-recipient-identity','approvedBranchIds',jsonb_build_array(branch_id),
    'classification','internal','verificationDigest',repeat('e',64),'keyVersion',1,'channel','simulated_email',
    'policy',jsonb_build_object('id','demo-workflow','version',1,
      'digest','0515a53cb4bb6a1259d1c8f6d75b0c2b954598e3ecce723857a6fb8a652b04be'),
    'status','active','expiresAt','2099-01-01T00:00:00.000Z','rowVersion',1,
    'semanticKey','workflow-pg-share-semantic','executionId','workflow-pg-execution',
    'createdAt','2026-10-03T00:02:00.000Z','revokedAt',NULL);
  allowed_child:=jsonb_build_object('id','workflow-pg-share-branch-child',
    'shareId','workflow-pg-share','branchId',branch_id);

  INSERT INTO public.org_units(id,row_version,body)
  VALUES ('workflow-pg-org',1,org_body);
  INSERT INTO public.directory_identities(id,row_version,body)
  VALUES ('workflow-pg-sender',1,sender_body),('workflow-pg-recipient-identity',1,recipient_body);

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  operations:=jsonb_build_array(
    jsonb_build_object('kind','insert_unique','table','action_idempotency_roots',
      'constraint','action_idempotency_roots_key_unique','values',jsonb_build_object('idempotencyKey',repeat('b',64)),
      'row',jsonb_build_object('id','workflow-pg-root','rowVersion',1,'body',root_body)),
    jsonb_build_object('kind','insert_unique','table','action_executions',
      'constraint','action_executions_root_attempt_unique','values',jsonb_build_object('rootId','workflow-pg-root','attempt',1),
      'row',jsonb_build_object('id','workflow-pg-execution','rowVersion',1,'body',receipt_body)),
    jsonb_build_object('kind','insert_unique','table','dashboard_versions',
      'constraint','dashboard_versions_primary_key','values',jsonb_build_object('id','workflow-pg-dashboard-version'),
      'row',jsonb_build_object('id','workflow-pg-dashboard-version','rowVersion',1,'body',version_body)),
    jsonb_build_object('kind','insert_unique','table','dashboard_shares',
      'constraint','dashboard_shares_semantic_unique','values',jsonb_build_object('semanticKey','workflow-pg-share-semantic'),
      'row',jsonb_build_object('id','workflow-pg-share','rowVersion',1,'body',share_body)),
    jsonb_build_object('kind','insert_unique','table','share_scope_branches',
      'constraint','share_scope_branches_share_branch_unique',
      'values',jsonb_build_object('shareId','workflow-pg-share','branchId',branch_id),
      'row',jsonb_build_object('id','workflow-pg-share-branch-child','rowVersion',1,'body',allowed_child))
  );
  SELECT public.nexus_workflow_commit(current_revision,operations) INTO returned_revision;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF returned_revision<>current_revision+1
    OR NOT EXISTS (SELECT 1 FROM public.action_executions WHERE id='workflow-pg-execution'
      AND root_id='workflow-pg-root' AND attempt=1 AND workflow_contract_version=2
      AND payload->>'contractVersion'='2')
    OR NOT EXISTS (SELECT 1 FROM public.share_scope_branches WHERE id='workflow-pg-share-branch-child') THEN
    RAISE EXCEPTION 'canonical receipt/root/share fixture failed to project its SQL metadata';
  END IF;
END
$case$;
\echo CASE PASS: strict receipt body and SQL root/attempt metadata support a valid parent grant and child scope

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(
      before_revision,
      jsonb_build_array(jsonb_build_object(
        'kind','insert_unique','table','share_scope_branches',
        'constraint','share_scope_branches_share_branch_unique',
        'values',jsonb_build_object('shareId','workflow-pg-share','branchId','workflow-pg-share-outside-branch'),
        'row',jsonb_build_object('id','workflow-pg-share-outside-child','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-share-outside-child',
          'shareId','workflow-pg-share','branchId','workflow-pg-share-outside-branch'))))
    );
  EXCEPTION WHEN check_violation THEN
    rejected:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT rejected OR before_revision<>after_revision
    OR EXISTS (SELECT 1 FROM public.share_scope_branches WHERE id='workflow-pg-share-outside-child') THEN
    RAISE EXCEPTION 'share child scope exceeded the parent approved-branch grant or failed to roll back';
  END IF;
END
$case$;
\echo CASE PASS: child scope cannot exceed the parent approved-branch grant

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  new_version bigint;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  UPDATE public.action_executions
  SET row_version=row_version+1,
      payload=payload||jsonb_build_object('outcome','verified_success','verifiedAt','2026-10-03T00:03:00.000Z',
    'proofs',jsonb_build_array(jsonb_build_object('targetId','workflow-pg-target','outcome','verified_success')))
  WHERE id='workflow-pg-execution';
  SELECT row_version INTO new_version FROM public.action_executions WHERE id='workflow-pg-execution';
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF new_version<>2 OR after_revision<>before_revision+1
    OR (SELECT payload->>'outcome' FROM public.action_executions WHERE id='workflow-pg-execution')<>'verified_success' THEN
    RAISE EXCEPTION 'pending receipt did not transition to a terminal state with one revision';
  END IF;
END
$case$;
\echo CASE PASS: pending receipt transitions once to verified terminal history

DO $case$
DECLARE
  before_revision bigint;
  after_revision bigint;
  rejected_update boolean:=false;
  rejected_delete boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    UPDATE public.action_executions
    SET row_version=row_version+1,
        payload=payload||jsonb_build_object('outcome','failed')
    WHERE id='workflow-pg-execution';
  EXCEPTION WHEN check_violation THEN
    rejected_update:=true;
  END;
  BEGIN
    DELETE FROM public.action_executions WHERE id='workflow-pg-execution';
  EXCEPTION WHEN check_violation THEN
    rejected_delete:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT rejected_update OR NOT rejected_delete OR before_revision<>after_revision
    OR NOT EXISTS (SELECT 1 FROM public.action_executions WHERE id='workflow-pg-execution'
      AND row_version=2 AND payload->>'outcome'='verified_success') THEN
    RAISE EXCEPTION 'terminal receipt history mutation/deletion was not denied without side effects';
  END IF;
END
$case$;
\echo CASE PASS: terminal receipt update and deletion are denied without revision changes

RESET ROLE;
DO $case$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.branches'::regclass)
    OR has_table_privilege('anon','public.branches','SELECT')
    OR has_table_privilege('anon','public.branches','INSERT')
    OR has_table_privilege('anon','public.branches','UPDATE')
    OR has_table_privilege('anon','public.branches','DELETE')
    OR has_table_privilege('authenticated','public.branches','SELECT')
    OR has_table_privilege('authenticated','public.branches','INSERT')
    OR has_table_privilege('authenticated','public.branches','UPDATE')
    OR has_table_privilege('authenticated','public.branches','DELETE')
    OR has_function_privilege('anon','public.nexus_workflow_commit(bigint,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.nexus_workflow_commit(bigint,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.nexus_commit(bigint,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.nexus_commit(bigint,jsonb)','EXECUTE')
    OR has_table_privilege('anon','public.pending_actions','INSERT')
    OR has_table_privilege('authenticated','public.pending_actions','UPDATE')
    OR has_table_privilege('anon','public.share_scope_branches','DELETE')
    OR has_table_privilege('authenticated','public.share_scope_branches','INSERT')
    OR has_table_privilege('service_role','nexus_private.workflow_manifest','SELECT')
    OR NOT has_table_privilege('service_role','public.branches','SELECT')
    OR NOT has_table_privilege('service_role','public.branches','INSERT')
    OR NOT has_table_privilege('service_role','public.branches','UPDATE')
    OR NOT has_table_privilege('service_role','public.branches','DELETE')
    OR NOT has_function_privilege('service_role','public.nexus_workflow_commit(bigint,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.nexus_commit(bigint,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'PostgreSQL role grants do not match the server-only service-role boundary';
  END IF;
END
$case$;
SET LOCAL ROLE service_role;
DO $case$
DECLARE private_manifest_denied boolean:=false;
BEGIN
  BEGIN
    PERFORM 1 FROM nexus_private.workflow_manifest LIMIT 1;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    private_manifest_denied:=true;
  END;
  IF NOT private_manifest_denied THEN
    RAISE EXCEPTION 'service_role unexpectedly read the private workflow manifest';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: API roles lack table/RPC access and service_role cannot read private workflow metadata

SET LOCAL ROLE anon;
DO $case$
DECLARE table_denied boolean:=false; v2_rpc_denied boolean:=false; v1_rpc_denied boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.branches(id,payload) VALUES ('workflow-pg-anon-write',jsonb_build_object(
      'id','workflow-pg-anon-write','name','Denied','region','east'));
  EXCEPTION WHEN insufficient_privilege THEN table_denied:=true;
  END;
  BEGIN
    PERFORM public.nexus_workflow_commit(0,'[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v2_rpc_denied:=true;
  END;
  BEGIN
    PERFORM public.nexus_commit(0,'[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v1_rpc_denied:=true;
  END;
  IF NOT table_denied OR NOT v2_rpc_denied OR NOT v1_rpc_denied THEN
    RAISE EXCEPTION 'anon could mutate a protected table or call a commit RPC';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: anon cannot insert workflow rows or invoke either commit RPC

SET LOCAL ROLE authenticated;
DO $case$
DECLARE table_denied boolean:=false; v2_rpc_denied boolean:=false; v1_rpc_denied boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.branches(id,payload) VALUES ('workflow-pg-authenticated-write',jsonb_build_object(
      'id','workflow-pg-authenticated-write','name','Denied','region','east'));
  EXCEPTION WHEN insufficient_privilege THEN table_denied:=true;
  END;
  BEGIN
    PERFORM public.nexus_workflow_commit(0,'[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v2_rpc_denied:=true;
  END;
  BEGIN
    PERFORM public.nexus_commit(0,'[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v1_rpc_denied:=true;
  END;
  IF NOT table_denied OR NOT v2_rpc_denied OR NOT v1_rpc_denied THEN
    RAISE EXCEPTION 'authenticated could mutate a protected table or call a commit RPC';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: authenticated cannot insert workflow rows or invoke either commit RPC

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  actor_id constant text:='workflow-pg-actor';
  session_id constant text:='workflow-pg-session';
  canonical_digest constant text:='0515a53cb4bb6a1259d1c8f6d75b0c2b954598e3ecce723857a6fb8a652b04be';
  alternate_policy_id constant text:='workflow-pg-policy-alternate-digest';
  snapshot_id constant text:='workflow-pg-logical-policy-snapshot';
  branch_version bigint;
  valid_snapshot jsonb;
  base_action jsonb;
  invalid_pin jsonb;
  invalid_snapshot jsonb;
  invalid_action jsonb;
  invalid_id text;
  current_revision bigint;
  after_revision bigint;
  returned_revision bigint;
  snapshot_rejected boolean;
  action_rejected boolean;
  alternate_policy_rejected boolean:=false;
  canonical_policy_body jsonb;
  variant record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_policies
    WHERE id='workflow-pg-policy-physical-row' AND policy_id='demo-workflow'
      AND version=1 AND digest=canonical_digest
  ) THEN
    RAISE EXCEPTION 'logical workflow policy fixture is not present under its distinct physical row id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pending_actions
    WHERE id='workflow-pg-action' AND policy_id='demo-workflow'
      AND policy_version=1 AND policy_digest=canonical_digest
  ) THEN
    RAISE EXCEPTION 'pending action did not preserve its logical policy pin';
  END IF;

  SELECT row_version INTO branch_version FROM public.branches WHERE id=branch_id;
  valid_snapshot:=jsonb_build_object(
    'id',snapshot_id,'actorId',actor_id,'actorSessionId',session_id,
    'purpose','manager_queue','orgUnitIds',jsonb_build_array('workflow-pg-org'),
    'displayedIds',jsonb_build_array(branch_id),'count',1,
    'expectedRows',jsonb_build_array(jsonb_build_object(
      'ref',jsonb_build_object('table','branches','id',branch_id),
      'rowVersion',branch_version,'state',NULL::text)),
    'policy',jsonb_build_object('id','demo-workflow','version',1,'digest',canonical_digest),
    'createdAt','2026-10-03T00:07:00.000Z','expiresAt','2026-10-03T00:17:00.000Z',
    'digest','16e7a249e067f2029a06c815bdb301e64cc56528d9d6ff0bd2640d9821c78273');
  INSERT INTO public.review_snapshots(id,row_version,body)
  VALUES (snapshot_id,1,valid_snapshot);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (
    SELECT 1 FROM public.review_snapshots
    WHERE id=snapshot_id AND policy_id='demo-workflow'
      AND policy_version=1 AND policy_digest=canonical_digest
  ) THEN
    RAISE EXCEPTION 'review snapshot did not project its logical policy pin';
  END IF;

  SELECT payload INTO base_action FROM public.pending_actions WHERE id='workflow-pg-action';
  FOR variant IN
    SELECT * FROM (VALUES
      ('workflow-pg-policy-wrong-logical-id','workflow-pg-policy-physical-row',1,canonical_digest,'0b7248b06139d9ba5d9277c01178f172d6e9a75331c53d4ddf938f4626b9eea5'),
      ('workflow-pg-policy-wrong-version','demo-workflow',2,canonical_digest,'749138f153f73ede1083bb41f121c39991977e5273672dbeb3b8923707f89b2c'),
      ('workflow-pg-policy-wrong-digest','demo-workflow',1,'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','c5f51883b25a9012a7235050bd64ee8869687ac4f9a9935cb7a37fb0dc5f37f1')
    ) AS invalid_case(id,policy_id,policy_version,policy_digest,snapshot_digest)
  LOOP
    invalid_pin:=jsonb_build_object(
      'id',variant.policy_id,'version',variant.policy_version,'digest',variant.policy_digest);
    invalid_snapshot:=jsonb_set(valid_snapshot,'{id}',to_jsonb(variant.id),false);
    invalid_snapshot:=jsonb_set(invalid_snapshot,'{policy}',invalid_pin,false);
    invalid_snapshot:=jsonb_set(invalid_snapshot,'{digest}',to_jsonb(variant.snapshot_digest),false);

    SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
    snapshot_rejected:=false;
    BEGIN
      INSERT INTO public.review_snapshots(id,row_version,body)
      VALUES (variant.id,1,invalid_snapshot);
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN foreign_key_violation THEN
      snapshot_rejected:=true;
    END;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
    IF NOT snapshot_rejected OR after_revision<>current_revision
      OR EXISTS (SELECT 1 FROM public.review_snapshots WHERE id=variant.id) THEN
      RAISE EXCEPTION 'review snapshot accepted policy pin variant id=% version=% digest=%',
        variant.policy_id,variant.policy_version,variant.policy_digest;
    END IF;

    invalid_id:=variant.id||'-action';
    invalid_action:=jsonb_set(base_action,'{id}',to_jsonb(invalid_id),false);
    invalid_action:=jsonb_set(invalid_action,'{idempotencyKey}',to_jsonb(repeat('9',64)),false);
    invalid_action:=jsonb_set(invalid_action,'{policy}',invalid_pin,false);
    SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
    action_rejected:=false;
    BEGIN
      SELECT public.nexus_workflow_commit(
        current_revision,
        jsonb_build_array(jsonb_build_object(
          'kind','insert_unique','table','pending_actions','constraint','pending_actions_primary_key',
          'values',jsonb_build_object('id',invalid_id),
          'row',jsonb_build_object('id',invalid_id,'rowVersion',1,'body',invalid_action)))
      ) INTO returned_revision;
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN foreign_key_violation THEN
      action_rejected:=true;
    END;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
    IF NOT action_rejected OR after_revision<>current_revision
      OR EXISTS (SELECT 1 FROM public.pending_actions WHERE id=invalid_id) THEN
      RAISE EXCEPTION 'pending action accepted policy pin variant id=% version=% digest=%',
        variant.policy_id,variant.policy_version,variant.policy_digest;
    END IF;
  END LOOP;

  SELECT body->'policy' INTO canonical_policy_body
  FROM public.workflow_policies AS canonical_policy_row
  WHERE canonical_policy_row.id='workflow-pg-policy-physical-row'
    AND canonical_policy_row.policy_id='demo-workflow'
    AND canonical_policy_row.version=1
    AND canonical_policy_row.digest=canonical_digest;
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.workflow_policies(id,row_version,body)
    VALUES (alternate_policy_id,1,jsonb_build_object(
      'id',alternate_policy_id,'version',1,'digest',repeat('f',64),'policy',canonical_policy_body));
  EXCEPTION WHEN unique_violation THEN
    alternate_policy_rejected:=true;
  END;
  SELECT revision INTO after_revision FROM public.appmeta WHERE singleton=1;
  IF NOT alternate_policy_rejected OR after_revision<>current_revision
    OR EXISTS (SELECT 1 FROM public.workflow_policies WHERE id=alternate_policy_id)
    OR NOT EXISTS (SELECT 1 FROM public.workflow_policies AS canonical_policy_row
      WHERE canonical_policy_row.id='workflow-pg-policy-physical-row'
        AND canonical_policy_row.policy_id='demo-workflow'
        AND canonical_policy_row.version=1 AND canonical_policy_row.digest=canonical_digest)
    OR NOT EXISTS (SELECT 1 FROM public.review_snapshots AS pinned_snapshot
      WHERE pinned_snapshot.id=snapshot_id AND pinned_snapshot.policy_id='demo-workflow'
        AND pinned_snapshot.policy_version=1 AND pinned_snapshot.policy_digest=canonical_digest)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS pinned_action
      WHERE pinned_action.id='workflow-pg-action' AND pinned_action.policy_id='demo-workflow'
        AND pinned_action.policy_version=1 AND pinned_action.policy_digest=canonical_digest) THEN
    RAISE EXCEPTION 'policy version accepted a competing digest or changed existing pins';
  END IF;
END
$case$;
\echo CASE PASS: policy version pins enforce logical ID/version/digest and retain existing rows

DO $case$
DECLARE
  current_revision bigint;
  returned_revision bigint;
  closed_revision bigint;
  rejected_discount boolean:=false;
  rejected_case boolean:=false;
  rejected_plan boolean:=false;
BEGIN
  INSERT INTO public.employees(id,payload) VALUES ('workflow-pg-offboarding-employee-2',jsonb_build_object(
    'id','workflow-pg-offboarding-employee-2','name','Second synthetic offboarding employee',
    'branchId','workflow-pg-ordered-cas-branch','active',true));

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(
    jsonb_build_object('kind','insert_unique','table','crm_customers','constraint','crm_customers_primary_key',
      'values',jsonb_build_object('id','workflow-pg-discount-customer'),
      'row',jsonb_build_object('id','workflow-pg-discount-customer','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-discount-customer','ownerIdentityId','workflow-pg-sender','name','Synthetic discount customer',
        'status','active','createdAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','crm_customers','constraint','crm_customers_primary_key',
      'values',jsonb_build_object('id','workflow-pg-discount-customer-2'),
      'row',jsonb_build_object('id','workflow-pg-discount-customer-2','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-discount-customer-2','ownerIdentityId','workflow-pg-sender','name','Alternate synthetic discount customer',
        'status','active','createdAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','crm_opportunities','constraint','crm_opportunities_primary_key',
      'values',jsonb_build_object('id','workflow-pg-discount-opportunity'),
      'row',jsonb_build_object('id','workflow-pg-discount-opportunity','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-discount-opportunity','customerId','workflow-pg-discount-customer',
        'ownerIdentityId','workflow-pg-sender','title','Synthetic discount opportunity',
        'stage','prospecting','amountSatang',100000,'createdAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','crm_opportunities','constraint','crm_opportunities_primary_key',
      'values',jsonb_build_object('id','workflow-pg-discount-opportunity-2'),
      'row',jsonb_build_object('id','workflow-pg-discount-opportunity-2','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-discount-opportunity-2','customerId','workflow-pg-discount-customer-2',
        'ownerIdentityId','workflow-pg-sender','title','Alternate synthetic discount opportunity',
        'stage','prospecting','amountSatang',120000,'createdAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','discount_requests','constraint','discount_requests_primary_key',
      'values',jsonb_build_object('id','workflow-pg-discount-request'),
      'row',jsonb_build_object('id','workflow-pg-discount-request','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-discount-request','opportunityId','workflow-pg-discount-opportunity',
        'ownerIdentityId','workflow-pg-sender','status','manager_review_pending','discountBasisPoints',500,
        'expiresAt','2026-10-10T05:00:00.000Z','reason','Request a reviewed synthetic discount.',
        'createdAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','offboarding_cases','constraint','offboarding_cases_primary_key',
      'values',jsonb_build_object('id','workflow-pg-offboarding-case'),
      'row',jsonb_build_object('id','workflow-pg-offboarding-case','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-offboarding-case','employeeId','workflow-pg-assigned-employee',
        'ownerIdentityId','workflow-pg-sender','status','active','lifecycleId','workflow-pg-offboarding-lifecycle',
        'lastDay','2026-10-15','reason','Employee departure review.','createdAt','2026-10-03T00:00:00.000Z',
        'updatedAt','2026-10-03T00:00:00.000Z'))),
    jsonb_build_object('kind','insert_unique','table','offboarding_plans',
      'constraint','offboarding_plans_case_purpose_unique',
      'values',jsonb_build_object('caseId','workflow-pg-offboarding-case','purpose','standard_offboarding'),
      'row',jsonb_build_object('id','workflow-pg-offboarding-plan','rowVersion',1,'body',jsonb_build_object(
        'id','workflow-pg-offboarding-plan','caseId','workflow-pg-offboarding-case',
        'purpose','standard_offboarding','status','prepared','createdAt','2026-10-03T00:00:00.000Z')))
  )) INTO returned_revision;

  IF returned_revision<>current_revision+1
    OR (SELECT body->>'status' FROM public.discount_requests WHERE id='workflow-pg-discount-request')<>'manager_review_pending'
    OR (SELECT body->>'status' FROM public.offboarding_cases WHERE id='workflow-pg-offboarding-case')<>'active'
    OR (SELECT body->>'status' FROM public.offboarding_plans WHERE id='workflow-pg-offboarding-plan')<>'prepared' THEN
    RAISE EXCEPTION 'canonical discount/offboarding initial statuses did not persist';
  END IF;

  BEGIN
    INSERT INTO public.discount_requests(id,row_version,body)
    VALUES ('workflow-pg-invalid-discount-status',1,jsonb_build_object(
      'id','workflow-pg-invalid-discount-status','opportunityId','workflow-pg-discount-opportunity-2',
      'ownerIdentityId','workflow-pg-sender','status','pending','discountBasisPoints',500,
      'expiresAt','2026-10-10T05:00:00.000Z','reason','Invalid state probe.','createdAt','2026-10-03T00:00:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_discount:=true;
  END;
  BEGIN
    INSERT INTO public.offboarding_cases(id,row_version,body)
    VALUES ('workflow-pg-invalid-offboarding-case-status',1,jsonb_build_object(
      'id','workflow-pg-invalid-offboarding-case-status','employeeId','workflow-pg-offboarding-employee-2',
      'ownerIdentityId','workflow-pg-sender','status','open','lifecycleId','workflow-pg-invalid-offboarding-lifecycle',
      'lastDay','2026-10-16','reason','Invalid state probe.','createdAt','2026-10-03T00:00:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_case:=true;
  END;
  BEGIN
    INSERT INTO public.offboarding_plans(id,row_version,body)
    VALUES ('workflow-pg-invalid-offboarding-plan-status',1,jsonb_build_object(
      'id','workflow-pg-invalid-offboarding-plan-status','caseId','workflow-pg-offboarding-case',
      'purpose','alternate_plan_purpose','status','active','createdAt','2026-10-03T00:00:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_plan:=true;
  END;
  IF NOT rejected_discount OR NOT rejected_case OR NOT rejected_plan
    OR EXISTS (SELECT 1 FROM public.discount_requests WHERE id='workflow-pg-invalid-discount-status')
    OR EXISTS (SELECT 1 FROM public.offboarding_cases WHERE id='workflow-pg-invalid-offboarding-case-status')
    OR EXISTS (SELECT 1 FROM public.offboarding_plans WHERE id='workflow-pg-invalid-offboarding-plan-status') THEN
    RAISE EXCEPTION 'a noncontract discount/offboarding state was accepted';
  END IF;

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'kind','cas','table','offboarding_cases','id','workflow-pg-offboarding-case',
    'expected',jsonb_build_object('rowVersion',1,'state','active'),
    'next',jsonb_build_object('id','workflow-pg-offboarding-case','rowVersion',2,'body',jsonb_build_object(
      'id','workflow-pg-offboarding-case','employeeId','workflow-pg-assigned-employee',
      'ownerIdentityId','workflow-pg-sender','status','closed','lifecycleId','workflow-pg-offboarding-lifecycle',
      'lastDay','2026-10-15','reason','Employee departure review.','createdAt','2026-10-03T00:00:00.000Z',
      'updatedAt','2026-10-03T00:01:00.000Z'))))) INTO closed_revision;
  IF closed_revision<>current_revision+1
    OR (SELECT row_version FROM public.offboarding_cases WHERE id='workflow-pg-offboarding-case')<>2
    OR (SELECT body->>'status' FROM public.offboarding_cases WHERE id='workflow-pg-offboarding-case')<>'closed' THEN
    RAISE EXCEPTION 'offboarding case did not follow active to closed with one row-version increment';
  END IF;
END
$case$;
\echo CASE PASS: discount manager_review_pending and offboarding active/closed/prepared states are enforced

DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  actor_id constant text:='workflow-pg-actor';
  session_id constant text:='workflow-pg-session';
  conversation_id constant text:='workflow-pg-conversation';
  incident_id constant text:='workflow-pg-escalation-incident';
  team_id constant text:='demo_operations';
  action_id constant text:='workflow-pg-incident-action';
  root_id_value constant text:='workflow-pg-incident-root';
  v_execution_id constant text:='workflow-pg-incident-execution';
  event_id constant text:='workflow-pg-incident-event';
  lifecycle_id constant text:='workflow-pg-incident-lifecycle';
  policy_digest constant text:='0515a53cb4bb6a1259d1c8f6d75b0c2b954598e3ecce723857a6fb8a652b04be';
  current_revision bigint;
  returned_revision bigint;
  expected_rows jsonb;
  action_payload jsonb;
  action_body jsonb;
  root_body jsonb;
  receipt_body jsonb;
  operation_batch jsonb;
  event_body jsonb;
  invalid_id text;
  invalid_reference record;
  reference_rejected boolean;
  rejected_missing_execution boolean:=false;
  rejected_invalid_stage boolean:=false;
BEGIN
  INSERT INTO public.incidents(id,payload) VALUES (incident_id,jsonb_build_object(
    'id',incident_id,'branchId',branch_id,'date','2026-10-01','status','open',
    'title','Synthetic operations incident','kind','operations','startedAt','2026-10-01T08:00:00.000Z',
    'endedAt',NULL,'updatedAt','2026-10-03T00:00:00.000Z'));
  expected_rows:=jsonb_build_array(jsonb_build_object(
    'ref',jsonb_build_object('table','incidents','id',incident_id),'rowVersion',1,'state','open'));
  action_payload:=jsonb_build_object('kind','incident_escalate','targets',jsonb_build_array(
    jsonb_build_object('incidentId',incident_id,'targetTeamId',team_id,
      'evidenceIds',jsonb_build_array('workflow-pg-incident-evidence'),
      'reason','Escalate the reviewed synthetic incident to operations.')));
  action_body:=jsonb_build_object(
    'id',action_id,'contractVersion',2,'actorId',actor_id,'sessionId',session_id,
    'conversationId',conversation_id,'turnId','workflow-pg-incident-turn','mode','scripted_demo','modeRevision',0,
    'payload',action_payload,'payloadHash','3235390644e80826d3684d54ccf5c3c90ac38b93cd8304eeadb8b047b689ae47',
    'idempotencyKey','bf95e7d378057d6dccb2a44f1b63882e2f03f6af19915971f3e4821587af2063',
    'targets',jsonb_build_array(jsonb_build_object(
      'targetId','workflow-pg-incident-target','ref',jsonb_build_object('table','incidents','id',incident_id),
      'semanticKey','incident:workflow-pg-escalation-incident:workflow-pg-incident-lifecycle:team_requested',
      'expectedRows',expected_rows,'ownerIdentityId','workflow-pg-sender',
      'expectedEffectRef',jsonb_build_object('table','incident_escalation_events','id',event_id),
      'expectedEffectVersion',1)),
    'targetCount',1,'expectedRows',expected_rows,'approvedBranchIds',jsonb_build_array(branch_id),
    'approvedOrgUnitIds',jsonb_build_array('workflow-pg-org'),'reviewedSnapshotId',NULL,
    'policy',jsonb_build_object('id','demo-workflow','version',1,'digest',policy_digest),
    'packs',jsonb_build_array(jsonb_build_object('id','workflow-operations','version','1.0',
      'schemaDigest',repeat('d',64),'implementationRevision','operations-r1')),
    'releaseRevision','release-r1','executionMode','atomic_local','createdAt','2026-10-03T00:02:00.000Z',
    'expiresAt','2026-10-03T00:12:00.000Z','status','pending');
  root_body:=jsonb_build_object('id',root_id_value,'actorId',actor_id,
    'idempotencyKey','bf95e7d378057d6dccb2a44f1b63882e2f03f6af19915971f3e4821587af2063',
    'activeExecutionId',v_execution_id,'actionId',action_id,'createdAt','2026-10-03T00:02:00.000Z','status','open');
  receipt_body:=jsonb_build_object('id',v_execution_id,'actionId',action_id,'contractVersion',2,
    'actorId',actor_id,'kind','incident_escalate','outcome','pending','proofs',jsonb_build_array(),
    'createdAt','2026-10-03T00:02:00.000Z','verifiedAt',NULL,'currentStates',jsonb_build_array());

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  operation_batch:=jsonb_build_array(
    jsonb_build_object('kind','insert_unique','table','workflow_teams','constraint','workflow_teams_primary_key',
      'values',jsonb_build_object('id',team_id),
      'row',jsonb_build_object('id',team_id,'rowVersion',1,'body',jsonb_build_object(
        'id',team_id,'name','Demo operations','active',true,'department','operations'))),
    jsonb_build_object('kind','insert_unique','table','pending_actions','constraint','pending_actions_primary_key',
      'values',jsonb_build_object('id',action_id),
      'row',jsonb_build_object('id',action_id,'rowVersion',1,'body',action_body)),
    jsonb_build_object('kind','insert_unique','table','action_idempotency_roots',
      'constraint','action_idempotency_roots_key_unique',
      'values',jsonb_build_object('idempotencyKey',action_body->>'idempotencyKey'),
      'row',jsonb_build_object('id',root_id_value,'rowVersion',1,'body',root_body)),
    jsonb_build_object('kind','insert_unique','table','action_executions',
      'constraint','action_executions_root_attempt_unique',
      'values',jsonb_build_object('rootId',root_id_value,'attempt',1),
      'row',jsonb_build_object('id',v_execution_id,'rowVersion',1,'body',receipt_body))
  );
  SELECT public.nexus_workflow_commit(current_revision,operation_batch) INTO returned_revision;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF returned_revision<>current_revision+1
    OR NOT EXISTS (SELECT 1 FROM public.action_executions e WHERE e.id=v_execution_id
      AND e.root_id=root_id_value AND e.attempt=1 AND e.workflow_contract_version=2) THEN
    RAISE EXCEPTION 'incident escalation receipt did not persist as a marker-two execution';
  END IF;

  event_body:=jsonb_build_object('id',event_id,'incidentId',incident_id,'teamId',team_id,
    'actorId',actor_id,'stage','team_requested','lifecycleId',lifecycle_id,'executionId',v_execution_id,
    'createdAt','2026-10-03T00:03:00.000Z');
  INSERT INTO public.incident_escalation_events(id,row_version,body)
  VALUES (event_id,1,event_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  BEGIN
    INSERT INTO public.incident_escalation_events(id,row_version,body)
    VALUES ('workflow-pg-incident-missing-execution',1,jsonb_build_object(
      'id','workflow-pg-incident-missing-execution','incidentId',incident_id,'teamId',team_id,
      'actorId',actor_id,'stage','team_requested','lifecycleId','workflow-pg-incident-lifecycle-missing',
      'executionId','workflow-pg-absent-execution','createdAt','2026-10-03T00:04:00.000Z'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_missing_execution:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  FOR invalid_reference IN
    SELECT * FROM (VALUES
      ('incident','incidentId','workflow-pg-absent-incident'),
      ('team','teamId','workflow-pg-absent-team'),
      ('actor','actorId','workflow-pg-absent-actor')
    ) AS invalid_refs(kind,body_field,missing_id)
  LOOP
    invalid_id:='workflow-pg-incident-missing-'||invalid_reference.kind;
    reference_rejected:=false;
    BEGIN
      INSERT INTO public.incident_escalation_events(id,row_version,body)
      VALUES (invalid_id,1,jsonb_set(
        jsonb_set(
          jsonb_set(event_body,'{id}',to_jsonb(invalid_id),false),
          ARRAY[invalid_reference.body_field],to_jsonb(invalid_reference.missing_id),false),
        '{lifecycleId}',to_jsonb('workflow-pg-incident-invalid-'||invalid_reference.kind),false));
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN foreign_key_violation THEN
      reference_rejected:=true;
    END;
    SET CONSTRAINTS ALL DEFERRED;
    IF NOT reference_rejected OR EXISTS (
      SELECT 1 FROM public.incident_escalation_events WHERE id=invalid_id
    ) THEN
      RAISE EXCEPTION 'incident event did not reject missing % reference',invalid_reference.kind;
    END IF;
  END LOOP;
  BEGIN
    INSERT INTO public.incident_escalation_events(id,row_version,body)
    VALUES ('workflow-pg-incident-invalid-stage',1,jsonb_build_object(
      'id','workflow-pg-incident-invalid-stage','incidentId',incident_id,'teamId',team_id,
      'actorId',actor_id,'stage','another_stage','lifecycleId','workflow-pg-incident-lifecycle-invalid',
      'executionId',v_execution_id,'createdAt','2026-10-03T00:05:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_invalid_stage:=true;
  END;
  IF NOT rejected_missing_execution OR NOT rejected_invalid_stage
    OR NOT EXISTS (SELECT 1 FROM public.incident_escalation_events AS event_row WHERE event_row.id=event_id
      AND event_row.incident_id='workflow-pg-escalation-incident'
      AND event_row.team_id='demo_operations' AND event_row.actor_id='workflow-pg-actor'
      AND event_row.stage='team_requested' AND event_row.execution_id=v_execution_id)
    OR EXISTS (SELECT 1 FROM public.incident_escalation_events AS invalid_event WHERE invalid_event.id IN
      ('workflow-pg-incident-missing-execution','workflow-pg-incident-missing-incident',
       'workflow-pg-incident-missing-team','workflow-pg-incident-missing-actor',
       'workflow-pg-incident-invalid-stage')) THEN
    RAISE EXCEPTION 'incident event failed required parent FKs or team_requested state enforcement';
  END IF;
END
$case$;
\echo CASE PASS: incident team_requested event requires an existing execution and rejects other stages

DO $case$
DECLARE
  action_id constant text:='workflow-pg-root-cycle-action';
  root_id_value constant text:='workflow-pg-root-cycle-root';
  v_execution_id constant text:='workflow-pg-root-cycle-execution';
  actor_id constant text:='workflow-pg-actor';
  idempotency_key constant text:=repeat('9',64);
  current_revision bigint;
  revision_after_root bigint;
  revision_after_legacy_attempt bigint;
  returned_revision bigint;
  action_body jsonb;
  root_body jsonb;
  legacy_execution_body jsonb;
  receipt_body jsonb;
  rejected_legacy_execution boolean:=false;
BEGIN
  SELECT payload INTO action_body FROM public.pending_actions WHERE id='workflow-pg-action';
  action_body:=jsonb_set(action_body,'{id}',to_jsonb(action_id),false);
  action_body:=jsonb_set(action_body,'{idempotencyKey}',to_jsonb(idempotency_key),false);
  action_body:=jsonb_set(action_body,'{payloadHash}',to_jsonb(repeat('8',64)),false);
  root_body:=jsonb_build_object('id',root_id_value,'actorId',actor_id,
    'idempotencyKey',idempotency_key,'activeExecutionId',v_execution_id,'actionId',action_id,
    'createdAt','2026-10-03T00:08:00.000Z','status','open');
  legacy_execution_body:=jsonb_build_object('id',v_execution_id,'actionId',action_id,
    'actorId',actor_id,'kind','investigation_create','status','pending',
    'createdAt','2026-10-03T00:08:00.000Z');
  receipt_body:=jsonb_build_object('id',v_execution_id,'actionId',action_id,'contractVersion',2,
    'actorId',actor_id,'kind','investigation_create','outcome','pending','proofs',jsonb_build_array(),
    'createdAt','2026-10-03T00:08:00.000Z','verifiedAt',NULL,'currentStates',jsonb_build_array());

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(
    jsonb_build_object('kind','insert_unique','table','pending_actions','constraint','pending_actions_primary_key',
      'values',jsonb_build_object('id',action_id),
      'row',jsonb_build_object('id',action_id,'rowVersion',1,'body',action_body)),
    jsonb_build_object('kind','insert_unique','table','action_idempotency_roots',
      'constraint','action_idempotency_roots_key_unique','values',jsonb_build_object('idempotencyKey',idempotency_key),
      'row',jsonb_build_object('id',root_id_value,'rowVersion',1,'body',root_body))
  )) INTO returned_revision;
  SELECT revision INTO revision_after_root FROM public.appmeta WHERE singleton=1;
  IF returned_revision<>revision_after_root
    OR NOT EXISTS (SELECT 1 FROM public.action_idempotency_roots
      WHERE id=root_id_value AND active_execution_id=v_execution_id
        AND active_execution_contract_version=2 AND row_version=1) THEN
    RAISE EXCEPTION 'V2 root was not represented before its execution existed';
  END IF;

  BEGIN
    PERFORM public.nexus_commit(revision_after_root,jsonb_build_array(jsonb_build_object(
      'table','action_executions','id',v_execution_id,'payload',legacy_execution_body)));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_legacy_execution:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT revision INTO revision_after_legacy_attempt FROM public.appmeta WHERE singleton=1;
  IF NOT rejected_legacy_execution OR revision_after_legacy_attempt<>revision_after_root
    OR NOT EXISTS (SELECT 1 FROM public.action_idempotency_roots
      WHERE id=root_id_value AND active_execution_id=v_execution_id AND active_execution_contract_version=2)
    OR EXISTS (SELECT 1 FROM public.action_executions AS legacy_row WHERE legacy_row.id=v_execution_id) THEN
    RAISE EXCEPTION 'legacy V1 execution satisfied the marker-two root FK or changed its root';
  END IF;

  SELECT public.nexus_workflow_commit(revision_after_root,jsonb_build_array(jsonb_build_object(
    'kind','insert_unique','table','action_executions','constraint','action_executions_root_attempt_unique',
    'values',jsonb_build_object('rootId',root_id_value,'attempt',1),
    'row',jsonb_build_object('id',v_execution_id,'rowVersion',1,'body',receipt_body))))
    INTO returned_revision;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF returned_revision<>(SELECT revision FROM public.appmeta WHERE singleton=1)
    OR NOT EXISTS (SELECT 1 FROM public.action_executions e WHERE e.id=v_execution_id
      AND e.root_id=root_id_value AND e.attempt=1
        AND e.workflow_contract_version=2 AND e.payload->>'contractVersion'='2')
    OR NOT EXISTS (SELECT 1 FROM public.action_idempotency_roots
      WHERE id=root_id_value AND active_execution_id=v_execution_id
        AND active_execution_contract_version=2) THEN
    RAISE EXCEPTION 'marker-two receipt did not close the deferred root/execution cycle';
  END IF;
END
$case$;
\echo CASE PASS: deferred V2 root rejects V1 execution and preserves root until the marker-two receipt arrives

DO $case$
DECLARE
  branch_id constant text:='workflow-pg-ordered-cas-branch';
  product_id constant text:='workflow-pg-restock-product';
  first_id constant text:='workflow-pg-restock-first';
  lifecycle_one constant text:='workflow-pg-restock-lifecycle-1';
  lifecycle_two constant text:='workflow-pg-restock-lifecycle-2';
  current_revision bigint;
  returned_revision bigint;
  revision_before_duplicate bigint;
  duplicate_open_rejected boolean:=false;
  duplicate_closed_lifecycle_rejected boolean:=false;
  first_version bigint;
  first_status text;
BEGIN
  INSERT INTO public.products(id,payload) VALUES (product_id,jsonb_build_object(
    'id',product_id,'name','Synthetic restock product','category','operations','active',true));
  INSERT INTO public.inventory_snapshots(id,payload) VALUES
    ('workflow-pg-restock-snapshot-1',jsonb_build_object('id','workflow-pg-restock-snapshot-1',
      'branchId',branch_id,'productId',product_id,'date','2026-10-01','onHand',1,'minimum',4,
      'observedAt','2026-10-01T05:00:00.000Z','updatedAt','2026-10-01T05:00:00.000Z')),
    ('workflow-pg-restock-snapshot-2',jsonb_build_object('id','workflow-pg-restock-snapshot-2',
      'branchId',branch_id,'productId',product_id,'date','2026-10-02','onHand',1,'minimum',4,
      'observedAt','2026-10-02T05:00:00.000Z','updatedAt','2026-10-02T05:00:00.000Z')),
    ('workflow-pg-restock-snapshot-3',jsonb_build_object('id','workflow-pg-restock-snapshot-3',
      'branchId',branch_id,'productId',product_id,'date','2026-10-03','onHand',1,'minimum',4,
      'observedAt','2026-10-03T05:00:00.000Z','updatedAt','2026-10-03T05:00:00.000Z'));

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'kind','insert_unique','table','restock_requests','constraint','restock_requests_primary_key',
    'values',jsonb_build_object('id',first_id),
    'row',jsonb_build_object('id',first_id,'rowVersion',1,'body',jsonb_build_object(
      'id',first_id,'rowVersion',1,'branchId',branch_id,'productId',product_id,
      'inventorySnapshotId','workflow-pg-restock-snapshot-1','ownerIdentityId','workflow-pg-sender',
      'replenishmentLifecycleId',lifecycle_one,'quantity',8,'status','open','dueDate','2026-10-10',
      'priority','normal','reason','Restore the synthetic stock minimum.','createdAt','2026-10-03T00:00:00.000Z')))))
    INTO returned_revision;
  IF returned_revision<>current_revision+1 THEN RAISE EXCEPTION 'initial restock insert did not commit'; END IF;

  SELECT revision INTO revision_before_duplicate FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.restock_requests(id,row_version,body)
    VALUES ('workflow-pg-restock-open-duplicate',1,jsonb_build_object(
      'id','workflow-pg-restock-open-duplicate','rowVersion',1,'branchId',branch_id,'productId',product_id,
      'inventorySnapshotId','workflow-pg-restock-snapshot-2','ownerIdentityId','workflow-pg-sender',
      'replenishmentLifecycleId',lifecycle_two,'quantity',8,'status','open','dueDate','2026-10-10',
      'priority','normal','reason','Direct duplicate-open SQL probe.','createdAt','2026-10-03T00:01:00.000Z'));
  EXCEPTION WHEN unique_violation THEN
    duplicate_open_rejected:=true;
  END;
  SELECT row_version,status INTO first_version,first_status FROM public.restock_requests WHERE id=first_id;
  IF NOT duplicate_open_rejected
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.restock_requests WHERE id='workflow-pg-restock-open-duplicate')
    OR first_version<>1 OR first_status<>'open' THEN
    RAISE EXCEPTION 'native open-product index did not reject a second open row across fresh snapshots';
  END IF;

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'kind','cas','table','restock_requests','id',first_id,
    'expected',jsonb_build_object('rowVersion',1,'state','open'),
    'next',jsonb_build_object('id',first_id,'rowVersion',2,'body',jsonb_build_object(
      'id',first_id,'rowVersion',2,'branchId',branch_id,'productId',product_id,
      'inventorySnapshotId','workflow-pg-restock-snapshot-1','ownerIdentityId','workflow-pg-sender',
      'replenishmentLifecycleId',lifecycle_one,'quantity',8,'status','cancelled','dueDate','2026-10-10',
      'priority','normal','reason','Restore the synthetic stock minimum.','createdAt','2026-10-03T00:00:00.000Z')))))
    INTO returned_revision;
  IF returned_revision<>current_revision+1
    OR (SELECT row_version FROM public.restock_requests WHERE id=first_id)<>2
    OR (SELECT status FROM public.restock_requests WHERE id=first_id)<>'cancelled' THEN
    RAISE EXCEPTION 'restock request did not close through versioned CAS';
  END IF;

  SELECT revision INTO revision_before_duplicate FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(
      revision_before_duplicate,
      jsonb_build_array(jsonb_build_object(
        'kind','insert_unique','table','restock_requests','constraint','restock_requests_primary_key',
        'values',jsonb_build_object('id','workflow-pg-restock-same-lifecycle'),
        'row',jsonb_build_object('id','workflow-pg-restock-same-lifecycle','rowVersion',1,'body',jsonb_build_object(
          'id','workflow-pg-restock-same-lifecycle','rowVersion',1,'branchId',branch_id,'productId',product_id,
          'inventorySnapshotId','workflow-pg-restock-snapshot-2','ownerIdentityId','workflow-pg-sender',
          'replenishmentLifecycleId',lifecycle_one,'quantity',8,'status','open','dueDate','2026-10-10',
          'priority','normal','reason','Closed lifecycle reuse probe.','createdAt','2026-10-03T00:02:00.000Z'))))
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_closed_lifecycle_rejected:=true;
  END;
  IF NOT duplicate_closed_lifecycle_rejected
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.restock_requests WHERE id='workflow-pg-restock-same-lifecycle') THEN
    RAISE EXCEPTION 'all-time branch/product/lifecycle key allowed reuse after closure';
  END IF;

  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'kind','insert_unique','table','restock_requests','constraint','restock_requests_open_product_unique',
    'values',jsonb_build_object('branchId',branch_id,'productId',product_id),
    'row',jsonb_build_object('id','workflow-pg-restock-next-lifecycle','rowVersion',1,'body',jsonb_build_object(
      'id','workflow-pg-restock-next-lifecycle','rowVersion',1,'branchId',branch_id,'productId',product_id,
      'inventorySnapshotId','workflow-pg-restock-snapshot-3','ownerIdentityId','workflow-pg-sender',
      'replenishmentLifecycleId',lifecycle_two,'quantity',8,'status','open','dueDate','2026-10-10',
      'priority','normal','reason','Start the next synthetic replenishment lifecycle.','createdAt','2026-10-03T00:03:00.000Z')))))
    INTO returned_revision;
  IF returned_revision<>current_revision+1
    OR (SELECT status FROM public.restock_requests WHERE id='workflow-pg-restock-next-lifecycle')<>'open'
    OR (SELECT replenishment_lifecycle_id FROM public.restock_requests WHERE id='workflow-pg-restock-next-lifecycle')<>lifecycle_two THEN
    RAISE EXCEPTION 'new lifecycle did not open after the prior lifecycle closed';
  END IF;
END
$case$;
\echo CASE PASS: restock open uniqueness ignores snapshots and permits a new lifecycle after closure

DO $case$
DECLARE
  v_branch_id constant text:='workflow-pg-ordered-cas-branch';
  v_side_effect_id constant text:='workflow-pg-rpc-wrong-state-side-effect';
  current_revision bigint;
  after_revision bigint;
  branch_version bigint;
  branch_body jsonb;
  after_branch_body jsonb;
  after_branch_version bigint;
  wrong_state_rejected boolean:=false;
BEGIN
  SELECT source_branch.row_version,source_branch.payload
    INTO branch_version,branch_body
  FROM public.branches AS source_branch WHERE source_branch.id=v_branch_id;
  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;

  BEGIN
    PERFORM public.nexus_workflow_commit(current_revision,jsonb_build_array(
      jsonb_build_object('kind','insert_unique','table','branches','constraint','branches_primary_key',
        'values',jsonb_build_object('id',v_side_effect_id),
        'row',jsonb_build_object('id',v_side_effect_id,'rowVersion',1,'body',jsonb_build_object(
          'id',v_side_effect_id,'name','Must roll back with wrong-state CAS','region','east'))),
      jsonb_build_object('kind','cas','table','branches','id',v_branch_id,
        'expected',jsonb_build_object('rowVersion',branch_version,'state','active'),
        'next',jsonb_build_object('id',v_branch_id,'rowVersion',branch_version+1,
          'body',jsonb_set(branch_body,'{name}',to_jsonb('Must not commit'::text),false)))
    ));
  EXCEPTION WHEN serialization_failure THEN
    wrong_state_rejected:=true;
  END;

  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  SELECT source_branch.row_version,source_branch.payload
    INTO after_branch_version,after_branch_body
  FROM public.branches AS source_branch WHERE source_branch.id=v_branch_id;
  IF NOT wrong_state_rejected OR after_revision<>current_revision
    OR after_branch_version<>branch_version OR after_branch_body IS DISTINCT FROM branch_body
    OR EXISTS (SELECT 1 FROM public.branches AS side_effect WHERE side_effect.id=v_side_effect_id) THEN
    RAISE EXCEPTION 'correct-version wrong-state CAS did not reject and roll back the complete RPC batch';
  END IF;
END
$case$;
\echo CASE PASS: workflow RPC rejects correct-version wrong-state CAS atomically

DO $case$
DECLARE
  unknown_row_id constant text:='workflow-pg-rpc-unknown-table-row';
  unsupported_row_id constant text:='workflow-pg-rpc-unsupported-unique-row';
  current_revision bigint;
  after_revision bigint;
  unknown_table_rejected boolean:=false;
  unsupported_unique_rejected boolean:=false;
BEGIN
  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
      'kind','insert_unique','table','workflow_pg_unknown_table','constraint','workflow_pg_unknown_table_primary_key',
      'values',jsonb_build_object('id',unknown_row_id),
      'row',jsonb_build_object('id',unknown_row_id,'rowVersion',1,'body',jsonb_build_object('id',unknown_row_id)))));
  EXCEPTION WHEN SQLSTATE '22023' THEN
    unknown_table_rejected:=true;
  END;
  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF NOT unknown_table_rejected OR after_revision<>current_revision
    OR EXISTS (SELECT 1 FROM public.branches AS unknown_table_side_effect WHERE unknown_table_side_effect.id=unknown_row_id) THEN
    RAISE EXCEPTION 'unknown-table workflow operation was accepted or had side effects';
  END IF;

  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  BEGIN
    PERFORM public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
      'kind','insert_unique','table','branches','constraint','branches_unsupported_unique',
      'values',jsonb_build_object('id',unsupported_row_id),
      'row',jsonb_build_object('id',unsupported_row_id,'rowVersion',1,'body',jsonb_build_object(
        'id',unsupported_row_id,'name','Unsupported constraint probe','region','east')))));
  EXCEPTION WHEN SQLSTATE '22023' THEN
    unsupported_unique_rejected:=true;
  END;
  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF NOT unsupported_unique_rejected OR after_revision<>current_revision
    OR EXISTS (SELECT 1 FROM public.branches AS unsupported_side_effect WHERE unsupported_side_effect.id=unsupported_row_id) THEN
    RAISE EXCEPTION 'unsupported unique-constraint workflow operation was accepted or had side effects';
  END IF;
END
$case$;
\echo CASE PASS: workflow RPC rejects unknown tables and unsupported unique constraints

DO $case$
DECLARE
  v_actor_id constant text:='workflow-pg-actor';
  v_session_id constant text:='workflow-pg-session';
  v_conversation_id constant text:='workflow-pg-conversation';
  v_legacy_action_id constant text:='workflow-pg-v1-effect-action';
  v_legacy_execution_id constant text:='workflow-pg-v1-effect-execution';
  v_effect_id constant text:='workflow-pg-effect-from-v1-execution';
  legacy_action_body jsonb;
  legacy_execution_body jsonb;
  current_revision bigint;
  returned_revision bigint;
  revision_before_effect bigint;
  revision_after_effect bigint;
  rejected_v1_execution_reference boolean:=false;
BEGIN
  legacy_action_body:=jsonb_build_object(
    'id',v_legacy_action_id,'actorId',v_actor_id,'sessionId',v_session_id,
    'conversationId',v_conversation_id,'turnId','workflow-pg-v1-effect-turn',
    'mode','scripted_demo','modeRevision',0,
    'payload',jsonb_build_object('kind','demo_update','scenario','baseline'),
    'payloadHash',repeat('c',64),'packs',jsonb_build_array(),'actionContractVersion',1,
    'createdAt','2026-10-03T00:20:00.000Z','expiresAt','2026-10-03T00:30:00.000Z',
    'status','pending','preview','Synthetic legacy action for execution-reference conformance.');
  legacy_execution_body:=jsonb_build_object(
    'id',v_legacy_execution_id,'actionId',v_legacy_action_id,'actorId',v_actor_id,
    'kind','demo_update','status','pending','results',jsonb_build_array(),
    'createdAt','2026-10-03T00:20:00.000Z','verifiedAt',NULL);

  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(
    jsonb_build_object('table','pending_actions','id',v_legacy_action_id,'payload',legacy_action_body),
    jsonb_build_object('table','action_executions','id',v_legacy_execution_id,'payload',legacy_execution_body)
  )) INTO returned_revision;
  SELECT appmeta_row.revision INTO revision_before_effect
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF returned_revision<>revision_before_effect
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS legacy_action
      WHERE legacy_action.id=v_legacy_action_id AND legacy_action.workflow_contract_version IS NULL
        AND legacy_action.payload=legacy_action_body)
    OR NOT EXISTS (SELECT 1 FROM public.action_executions AS legacy_execution
      WHERE legacy_execution.id=v_legacy_execution_id
        AND legacy_execution.workflow_contract_version IS NULL
        AND legacy_execution.payload=legacy_execution_body
        AND legacy_execution.payload->>'actionId'=v_legacy_action_id
        AND legacy_execution.payload->>'status'='pending') THEN
    RAISE EXCEPTION 'legacy V1 receipt control fixture did not persist as markerless history';
  END IF;

  BEGIN
    INSERT INTO public.incident_escalation_events(id,row_version,body)
    VALUES (v_effect_id,1,jsonb_build_object(
      'id',v_effect_id,'incidentId','workflow-pg-escalation-incident','teamId','demo_operations',
      'actorId',v_actor_id,'stage','team_requested','lifecycleId','workflow-pg-incident-v1-effect-lifecycle',
      'executionId',v_legacy_execution_id,'createdAt','2026-10-03T00:21:00.000Z'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected_v1_execution_reference:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT appmeta_row.revision INTO revision_after_effect
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF NOT rejected_v1_execution_reference OR revision_after_effect<>revision_before_effect
    OR EXISTS (SELECT 1 FROM public.incident_escalation_events AS effect_row WHERE effect_row.id=v_effect_id)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS legacy_action
      WHERE legacy_action.id=v_legacy_action_id AND legacy_action.workflow_contract_version IS NULL
        AND legacy_action.payload=legacy_action_body)
    OR NOT EXISTS (SELECT 1 FROM public.action_executions AS legacy_execution
      WHERE legacy_execution.id=v_legacy_execution_id
        AND legacy_execution.workflow_contract_version IS NULL
        AND legacy_execution.payload=legacy_execution_body
        AND legacy_execution.payload->>'actionId'=v_legacy_action_id) THEN
    RAISE EXCEPTION 'new V2 incident effect accepted a V1 receipt or changed existing history';
  END IF;
END
$case$;
\echo CASE PASS: new V2 incident effects reject legacy V1 execution references

DO $case$
DECLARE
  v_actor_id constant text:='workflow-pg-actor';
  v_legacy_audit_id constant text:='workflow-pg-v1-audit-control';
  v_null_correlation_id constant text:='workflow-pg-audit-null-correlation';
  v_missing_correlation_id constant text:='workflow-pg-audit-missing-correlation';
  legacy_audit_body jsonb;
  null_correlation_body jsonb;
  protected_missing_correlation_body jsonb;
  current_revision bigint;
  returned_revision bigint;
  after_revision bigint;
  rejected_null_presence boolean:=false;
  rejected_missing_protected_correlation boolean:=false;
BEGIN
  legacy_audit_body:=jsonb_build_object(
    'id',v_legacy_audit_id,'actorId',v_actor_id,'category','workflow_conformance',
    'summary','Valid legacy audit control without a correlation identifier.',
    'createdAt','2026-10-03T00:22:00.000Z');
  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','audit_events','id',v_legacy_audit_id,'payload',legacy_audit_body))) INTO returned_revision;
  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF returned_revision<>after_revision
    OR NOT EXISTS (SELECT 1 FROM public.audit_events AS legacy_audit
      WHERE legacy_audit.id=v_legacy_audit_id
        AND legacy_audit.workflow_contract_version IS NULL
        AND legacy_audit.correlation_id IS NULL) THEN
    RAISE EXCEPTION 'valid V1 audit control without correlationId was rejected or marked V2';
  END IF;

  null_correlation_body:=legacy_audit_body||jsonb_build_object('id',v_null_correlation_id,'correlationId',NULL::jsonb);
  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  rejected_null_presence:=false;
  BEGIN
    PERFORM public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
      'table','audit_events','id',v_null_correlation_id,'payload',null_correlation_body)));
  EXCEPTION WHEN check_violation THEN
    rejected_null_presence:=true;
  END;
  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF NOT rejected_null_presence OR after_revision<>current_revision
    OR EXISTS (SELECT 1 FROM public.audit_events AS null_audit WHERE null_audit.id=v_null_correlation_id)
    OR NOT EXISTS (SELECT 1 FROM public.audit_events AS legacy_audit
      WHERE legacy_audit.id=v_legacy_audit_id AND legacy_audit.workflow_contract_version IS NULL) THEN
    RAISE EXCEPTION 'markerless legacy RPC accepted a present-null correlationId or changed the V1 control';
  END IF;

  protected_missing_correlation_body:=jsonb_build_object(
    'id',v_missing_correlation_id,'actorId',v_actor_id,'category','workflow_conformance',
    'summary','Protected V2 audit missing its required correlation identifier.',
    'createdAt','2026-10-03T00:23:00.000Z');
  SELECT appmeta_row.revision INTO current_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  rejected_missing_protected_correlation:=false;
  BEGIN
    PERFORM public.nexus_workflow_commit(current_revision,jsonb_build_array(jsonb_build_object(
      'kind','insert_unique','table','audit_events','constraint','audit_events_primary_key',
      'values',jsonb_build_object('id',v_missing_correlation_id),
      'row',jsonb_build_object('id',v_missing_correlation_id,'rowVersion',1,
        'body',protected_missing_correlation_body))));
  EXCEPTION WHEN check_violation THEN
    rejected_missing_protected_correlation:=true;
  END;
  SELECT appmeta_row.revision INTO after_revision
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  IF NOT rejected_missing_protected_correlation OR after_revision<>current_revision
    OR EXISTS (SELECT 1 FROM public.audit_events AS missing_audit WHERE missing_audit.id=v_missing_correlation_id)
    OR NOT EXISTS (SELECT 1 FROM public.audit_events AS legacy_audit
      WHERE legacy_audit.id=v_legacy_audit_id AND legacy_audit.workflow_contract_version IS NULL) THEN
    RAISE EXCEPTION 'protected V2 audit without correlationId was accepted or changed the V1 control';
  END IF;
END
$case$;
\echo CASE PASS: audit correlation separates valid V1 control from protected or present-null V2 rows

DO $case$
DECLARE
  v_director_identity_id constant text:='workflow-pg-recipient-identity';
  v_org_unit_a constant text:='workflow-pg-org';
  v_org_unit_b constant text:='workflow-pg-responsibility-org-b';
  v_purpose constant text:='director_onboarding';
  v_responsibility_a_id constant text:='workflow-pg-director-responsibility-a';
  v_responsibility_b_id constant text:='workflow-pg-director-responsibility-b';
  v_duplicate_id constant text:='workflow-pg-director-responsibility-duplicate';
  director_role text;
  active_unique_index_definition text;
  responsibility_a_body jsonb;
  responsibility_b_body jsonb;
  duplicate_body jsonb;
  revision_before_duplicate bigint;
  revision_after_duplicate bigint;
  active_count integer;
  duplicate_rejected boolean:=false;
BEGIN
  SELECT identity_row.role INTO director_role
  FROM public.directory_identities AS identity_row
  WHERE identity_row.id=v_director_identity_id;
  IF director_role<>'hr_director' THEN
    RAISE EXCEPTION 'responsibility fixture identity is not the existing director identity';
  END IF;

  SELECT index_meta.indexdef INTO active_unique_index_definition
  FROM pg_catalog.pg_indexes AS index_meta
  WHERE index_meta.schemaname='public' AND index_meta.tablename='responsibilities'
    AND index_meta.indexname='responsibilities_open_identity_purpose_unique';
  IF active_unique_index_definition IS NULL
    OR position('(identity_id, purpose, org_unit_id)' in lower(active_unique_index_definition))=0
    OR position('where' in lower(active_unique_index_definition))=0
    OR position('active' in lower(active_unique_index_definition))=0 THEN
    RAISE EXCEPTION 'responsibilities active index does not key identity/purpose/org-unit';
  END IF;

  INSERT INTO public.org_units(id,row_version,body)
  VALUES (v_org_unit_b,1,jsonb_build_object(
    'id',v_org_unit_b,'parentOrgUnitId',v_org_unit_a,
    'name','Workflow PostgreSQL responsibility unit B','active',true,
    'kind','department','createdAt','2026-10-03T00:24:00.000Z'));

  responsibility_a_body:=jsonb_build_object(
    'id',v_responsibility_a_id,'identityId',v_director_identity_id,'orgUnitId',v_org_unit_a,
    'purpose',v_purpose,'branchIds',jsonb_build_array(),'active',true,'rowVersion',1);
  responsibility_b_body:=jsonb_build_object(
    'id',v_responsibility_b_id,'identityId',v_director_identity_id,'orgUnitId',v_org_unit_b,
    'purpose',v_purpose,'branchIds',jsonb_build_array(),'active',true,'rowVersion',1);
  INSERT INTO public.responsibilities(id,row_version,body)
  VALUES (v_responsibility_a_id,1,responsibility_a_body);
  INSERT INTO public.responsibilities(id,row_version,body)
  VALUES (v_responsibility_b_id,1,responsibility_b_body);

  SELECT count(*)::integer INTO active_count
  FROM public.responsibilities AS active_responsibility
  WHERE active_responsibility.identity_id=v_director_identity_id
    AND active_responsibility.purpose=v_purpose AND active_responsibility.active IS TRUE
    AND active_responsibility.org_unit_id IN (v_org_unit_a,v_org_unit_b);
  IF active_count<>2
    OR NOT EXISTS (SELECT 1 FROM public.responsibilities AS responsibility_a
      WHERE responsibility_a.id=v_responsibility_a_id AND responsibility_a.row_version=1
        AND responsibility_a.body=responsibility_a_body)
    OR NOT EXISTS (SELECT 1 FROM public.responsibilities AS responsibility_b
      WHERE responsibility_b.id=v_responsibility_b_id AND responsibility_b.row_version=1
        AND responsibility_b.body=responsibility_b_body) THEN
    RAISE EXCEPTION 'director could not hold the same active purpose in two org units';
  END IF;

  duplicate_body:=jsonb_build_object(
    'id',v_duplicate_id,'identityId',v_director_identity_id,'orgUnitId',v_org_unit_a,
    'purpose',v_purpose,'branchIds',jsonb_build_array(),'active',true,'rowVersion',1);
  SELECT appmeta_row.revision INTO revision_before_duplicate
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  BEGIN
    INSERT INTO public.responsibilities(id,row_version,body)
    VALUES (v_duplicate_id,1,duplicate_body);
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected:=true;
  END;
  SELECT appmeta_row.revision INTO revision_after_duplicate
  FROM public.appmeta AS appmeta_row WHERE appmeta_row.singleton=1;
  SELECT count(*)::integer INTO active_count
  FROM public.responsibilities AS active_responsibility
  WHERE active_responsibility.identity_id=v_director_identity_id
    AND active_responsibility.purpose=v_purpose AND active_responsibility.active IS TRUE
    AND active_responsibility.org_unit_id IN (v_org_unit_a,v_org_unit_b);
  IF NOT duplicate_rejected OR revision_after_duplicate<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.responsibilities AS duplicate_row WHERE duplicate_row.id=v_duplicate_id)
    OR active_count<>2
    OR NOT EXISTS (SELECT 1 FROM public.responsibilities AS responsibility_a
      WHERE responsibility_a.id=v_responsibility_a_id AND responsibility_a.row_version=1
        AND responsibility_a.body=responsibility_a_body)
    OR NOT EXISTS (SELECT 1 FROM public.responsibilities AS responsibility_b
      WHERE responsibility_b.id=v_responsibility_b_id AND responsibility_b.row_version=1
        AND responsibility_b.body=responsibility_b_body) THEN
    RAISE EXCEPTION 'same-unit duplicate changed revision or an existing director responsibility';
  END IF;
END
$case$;
\echo CASE PASS: active director responsibility is unique per org unit and purpose

\if :{?KEEP_CONFORMANCE_ROWS}
COMMIT;
\echo CONFORMANCE: fixtures committed in the owned database for the populated migration fingerprint
\else
ROLLBACK;
\echo CONFORMANCE: SQL fixtures rolled back; no business rows remain
\endif

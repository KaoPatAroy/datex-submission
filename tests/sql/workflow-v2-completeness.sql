-- Local PostgreSQL proof for the additive workflow completeness migration.
-- This runs after the 30-case workflow-v2-conformance.sql file in an owned DB.
-- It does not prove hosted Supabase Auth, Data API, policy, or deployment behavior.
\set ON_ERROR_STOP 1
\echo CONFORMANCE: workflow completeness projections, native ownership, and historical quarantine

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

DO $case$
DECLARE
  legacy_states jsonb;
  legacy_received_read_only boolean;
  legacy_waived_read_only boolean;
  rejected_received_insert boolean:=false;
  rejected_waived_insert boolean:=false;
  rejected_received_update boolean:=false;
  rejected_waived_update boolean:=false;
  revision_before_rejected bigint;
BEGIN
  SELECT definition->'legacyReadOnlyStates' INTO legacy_states
  FROM nexus_private.workflow_manifest WHERE table_name='onboarding_documents';
  IF legacy_states IS DISTINCT FROM '["missing","received","waived","withdrawn","replaced"]'::jsonb
    OR NOT EXISTS (SELECT 1 FROM public.onboarding_documents
      WHERE id='workflow-pg-completeness-legacy-received' AND status='received'
        AND request_id='workflow-pg-completeness-legacy-request'
        AND employee_id='workflow-pg-assigned-employee')
    OR NOT EXISTS (SELECT 1 FROM public.onboarding_documents
      WHERE id='workflow-pg-completeness-legacy-waived' AND status='waived'
        AND request_id='workflow-pg-completeness-legacy-request'
        AND employee_id='workflow-pg-assigned-employee') THEN
    RAISE EXCEPTION 'pre-migration received/waived documents or their read-only metadata were not preserved';
  END IF;

  SELECT nexus_private.workflow_legacy_read_only(d.body,m.definition)
    INTO legacy_received_read_only
  FROM public.onboarding_documents d
  CROSS JOIN nexus_private.workflow_manifest m
  WHERE d.id='workflow-pg-completeness-legacy-received' AND m.table_name='onboarding_documents';
  SELECT nexus_private.workflow_legacy_read_only(d.body,m.definition)
    INTO legacy_waived_read_only
  FROM public.onboarding_documents d
  CROSS JOIN nexus_private.workflow_manifest m
  WHERE d.id='workflow-pg-completeness-legacy-waived' AND m.table_name='onboarding_documents';
  IF NOT legacy_received_read_only OR NOT legacy_waived_read_only THEN
    RAISE EXCEPTION 'legacy received/waived documents were not classified as read-only';
  END IF;

  INSERT INTO public.onboarding_documents(id,row_version,body)
  VALUES ('workflow-pg-completeness-accepted-document',1,jsonb_build_object(
    'id','workflow-pg-completeness-accepted-document','rowVersion',1,
    'requestId','workflow-pg-completeness-legacy-request','employeeId','workflow-pg-assigned-employee',
    'documentType','signed_contract','status','accepted','policyVersion','1.0',
    'classification','internal','contentDigest',repeat('a',64),
    'createdAt','2026-10-03T00:42:00.000Z','withdrawnAt',NULL));

  SELECT revision INTO revision_before_rejected FROM public.appmeta WHERE singleton=1;
  BEGIN
    UPDATE public.onboarding_documents
    SET row_version=row_version+1,
        body=jsonb_set(jsonb_set(body,'{rowVersion}','2'::jsonb),'{status}','"accepted"'::jsonb)
    WHERE id='workflow-pg-completeness-legacy-received';
  EXCEPTION WHEN check_violation THEN
    rejected_received_update:=true;
  END;
  BEGIN
    UPDATE public.onboarding_documents
    SET row_version=row_version+1,
        body=jsonb_set(jsonb_set(body,'{rowVersion}','2'::jsonb),'{status}','"accepted"'::jsonb)
    WHERE id='workflow-pg-completeness-legacy-waived';
  EXCEPTION WHEN check_violation THEN
    rejected_waived_update:=true;
  END;
  BEGIN
    INSERT INTO public.onboarding_documents(id,row_version,body)
    VALUES ('workflow-pg-completeness-new-received',1,jsonb_build_object(
      'id','workflow-pg-completeness-new-received','rowVersion',1,
      'requestId','workflow-pg-completeness-legacy-request','employeeId','workflow-pg-assigned-employee',
      'documentType','legacy-received-probe','status','received','policyVersion','1.0',
      'classification','internal','contentDigest',repeat('b',64),'createdAt','2026-10-03T00:43:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_received_insert:=true;
  END;
  BEGIN
    INSERT INTO public.onboarding_documents(id,row_version,body)
    VALUES ('workflow-pg-completeness-new-waived',1,jsonb_build_object(
      'id','workflow-pg-completeness-new-waived','rowVersion',1,
      'requestId','workflow-pg-completeness-legacy-request','employeeId','workflow-pg-assigned-employee',
      'documentType','legacy-waived-probe','status','waived','policyVersion','1.0',
      'classification','internal','contentDigest',repeat('c',64),'createdAt','2026-10-03T00:44:00.000Z'));
  EXCEPTION WHEN check_violation THEN
    rejected_waived_insert:=true;
  END;

  IF NOT rejected_received_update OR NOT rejected_waived_update
    OR NOT rejected_received_insert OR NOT rejected_waived_insert
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR EXISTS (SELECT 1 FROM public.onboarding_documents WHERE id IN
      ('workflow-pg-completeness-new-received','workflow-pg-completeness-new-waived'))
    OR NOT EXISTS (SELECT 1 FROM public.onboarding_documents WHERE id='workflow-pg-completeness-accepted-document'
      AND status='accepted' AND row_version=1 AND body->>'status'='accepted') THEN
    RAISE EXCEPTION 'new document writes were not accepted-only or legacy rows changed during rejected writes';
  END IF;
END
$case$;
-- A new onboarding task must begin open, even when its other write fields and FKs are valid.
\echo CASE DETAIL: onboarding task completed-at-create rejection
DO $case$
DECLARE
  rejected_terminal_task boolean:=false;
  task_id constant text:='workflow-pg-completeness-terminal-onboarding-task';
  request_body_before jsonb;
  request_version_before bigint;
  revision_before bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.action_executions
    WHERE id='workflow-pg-execution' AND workflow_contract_version=2) THEN
    RAISE EXCEPTION 'onboarding task initial-state fixture lacks a V2 execution';
  END IF;
  SELECT body,row_version INTO request_body_before,request_version_before
  FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request';
  revision_before:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.onboarding_tasks(id,row_version,body)
    VALUES (task_id,1,jsonb_build_object(
      'id',task_id,'rowVersion',1,'requestId','workflow-pg-completeness-legacy-request',
      'employeeId','workflow-pg-assigned-employee','ownerIdentityId','workflow-pg-sender',
      'templateId','hr_welcome','status','completed','dueDate','2026-10-08',
      'reason','Reject a completed task at creation.','priority','normal',
      'executionId','workflow-pg-execution','title','Terminal onboarding task probe',
      'createdAt','2026-10-03T00:45:00.000Z','completedAt','2026-10-03T00:45:00.000Z'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    rejected_terminal_task:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected_terminal_task
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR EXISTS (SELECT 1 FROM public.onboarding_tasks WHERE id=task_id)
    OR (SELECT body FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM request_body_before
    OR (SELECT row_version FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM request_version_before THEN
    RAISE EXCEPTION 'completed onboarding task was accepted initially or changed its request/revision';
  END IF;
END
$case$;
-- Returned requests are terminal, but their employee/lifecycle may start a new draft.
DO $case$
DECLARE
  request_definition jsonb;
  open_index_unique boolean;
  open_index_predicate text;
  open_index_definition text;
  initial_body jsonb;
  returned_body jsonb;
  reopen_body jsonb;
  new_draft_body jsonb;
  duplicate_body jsonb;
  returned_body_before_reopen jsonb;
  returned_version_before_reopen bigint;
  draft_body_before_duplicate jsonb;
  draft_version_before_duplicate bigint;
  revision_before_reopen bigint;
  revision_before_duplicate bigint;
  rejected_reopen boolean:=false;
  rejected_duplicate boolean:=false;
  new_draft_id constant text:='workflow-pg-completeness-onboarding-new-draft';
  duplicate_draft_id constant text:='workflow-pg-completeness-onboarding-duplicate-open';
BEGIN
  SELECT definition INTO request_definition
  FROM nexus_private.workflow_manifest WHERE table_name='onboarding_requests';
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(request_definition->'unique') AS unique_def(value)
      WHERE unique_def.value->>'name'='onboarding_requests_open_employee_lifecycle_unique'
        AND unique_def.value->>'openOnly'='true'
        AND unique_def.value->'fields'='["employeeId","lifecycleId"]'::jsonb
        AND unique_def.value->'openStates'='["draft","manager_review_pending","director_approval_pending","director_approved","onboarding_in_progress"]'::jsonb)
    OR request_definition->'permittedTransitions'->'returned_for_revision' IS DISTINCT FROM '[]'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(request_definition->'unique') AS unique_def(value)
      WHERE unique_def.value->>'name'='onboarding_requests_open_employee_lifecycle_unique'
        AND unique_def.value->'openStates' ? 'returned_for_revision') THEN
    RAISE EXCEPTION 'returned onboarding state is not terminal/outside the open employee-lifecycle key';
  END IF;
  SELECT native_index.indisunique,pg_get_expr(native_index.indpred,native_index.indrelid),
    pg_get_indexdef(native_index.indexrelid)
  INTO open_index_unique,open_index_predicate,open_index_definition
  FROM pg_catalog.pg_index native_index
  WHERE native_index.indexrelid=to_regclass('public.onboarding_requests_open_employee_lifecycle_unique');
  IF open_index_unique IS DISTINCT FROM true OR open_index_predicate IS NULL
    OR open_index_definition IS NULL OR position('employee_id' in open_index_definition)=0
    OR position('lifecycle_id' in open_index_definition)=0 THEN
    RAISE EXCEPTION 'onboarding employee-lifecycle partial unique index is missing';
  END IF;

  SELECT body INTO initial_body FROM public.onboarding_requests
  WHERE id='workflow-pg-completeness-legacy-request';
  IF initial_body IS NULL OR initial_body->>'state'<>'manager_review_pending' THEN
    RAISE EXCEPTION 'preseeded onboarding request is not at the expected manager-review state';
  END IF;
  returned_body:=jsonb_set(
    jsonb_set(
      jsonb_set(initial_body,'{rowVersion}','2'::jsonb),
      '{state}','"returned_for_revision"'::jsonb),
    '{updatedAt}',to_jsonb('2026-10-03T00:57:00.000Z'::text));
  UPDATE public.onboarding_requests
  SET row_version=2,body=returned_body
  WHERE id='workflow-pg-completeness-legacy-request';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT body,row_version INTO returned_body_before_reopen,returned_version_before_reopen
  FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request';
  IF returned_version_before_reopen<>2 OR returned_body_before_reopen->>'state'<>'returned_for_revision' THEN
    RAISE EXCEPTION 'manager return did not persist as the expected terminal onboarding state';
  END IF;

  revision_before_reopen:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  reopen_body:=jsonb_set(
    jsonb_set(
      jsonb_set(returned_body_before_reopen,'{rowVersion}','3'::jsonb),
      '{state}','"manager_review_pending"'::jsonb),
    '{updatedAt}',to_jsonb('2026-10-03T00:58:00.000Z'::text));
  BEGIN
    UPDATE public.onboarding_requests SET row_version=3,body=reopen_body
    WHERE id='workflow-pg-completeness-legacy-request';
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    rejected_reopen:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected_reopen
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_reopen
    OR (SELECT body FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM returned_body_before_reopen
    OR (SELECT row_version FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM returned_version_before_reopen THEN
    RAISE EXCEPTION 'returned onboarding request reopened or changed body/version/revision';
  END IF;

  new_draft_body:=jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(initial_body,'{id}',to_jsonb(new_draft_id)),
          '{rowVersion}','1'::jsonb),
        '{state}','"draft"'::jsonb),
      '{createdAt}',to_jsonb('2026-10-03T00:59:00.000Z'::text)),
    '{updatedAt}',to_jsonb('2026-10-03T00:59:00.000Z'::text));
  INSERT INTO public.onboarding_requests(id,row_version,body)
  VALUES (new_draft_id,1,new_draft_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT body,row_version INTO draft_body_before_duplicate,draft_version_before_duplicate
  FROM public.onboarding_requests WHERE id=new_draft_id;
  IF draft_version_before_duplicate<>1 OR draft_body_before_duplicate->>'state'<>'draft' THEN
    RAISE EXCEPTION 'new draft for the returned employee/lifecycle did not persist';
  END IF;

  duplicate_body:=jsonb_set(
    jsonb_set(
      jsonb_set(new_draft_body,'{id}',to_jsonb(duplicate_draft_id)),
      '{state}','"manager_review_pending"'::jsonb),
    '{updatedAt}',to_jsonb('2026-10-03T01:00:00.000Z'::text));
  revision_before_duplicate:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.onboarding_requests(id,row_version,body)
    VALUES (duplicate_draft_id,1,duplicate_body);
  EXCEPTION WHEN unique_violation THEN
    rejected_duplicate:=true;
  END;
  IF NOT rejected_duplicate
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.onboarding_requests WHERE id=duplicate_draft_id)
    OR (SELECT body FROM public.onboarding_requests WHERE id=new_draft_id)
      IS DISTINCT FROM draft_body_before_duplicate
    OR (SELECT row_version FROM public.onboarding_requests WHERE id=new_draft_id)
      IS DISTINCT FROM draft_version_before_duplicate
    OR (SELECT body FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM returned_body_before_reopen
    OR (SELECT row_version FROM public.onboarding_requests WHERE id='workflow-pg-completeness-legacy-request')
      IS DISTINCT FROM returned_version_before_reopen THEN
    RAISE EXCEPTION 'duplicate open onboarding lifecycle changed a request body/version or revision';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: accepted documents, terminal returns, fresh lifecycle drafts, and task creation states are enforced

-- A fresh action execution cannot begin in terminal verified_success state.
\echo CASE DETAIL: verified receipt cannot be inserted as an initial execution state
DO $case$
DECLARE
  terminal_id constant text:='workflow-pg-completeness-terminal-execution';
  terminal_body jsonb;
  action_body_before jsonb;
  root_body_before jsonb;
  action_version_before bigint;
  root_version_before bigint;
  revision_before bigint;
  rejected_terminal boolean:=false;
  terminal_sqlstate text;
  terminal_message text;
  incident_a constant text:='workflow-pg-completeness-incident-a';
  incident_b constant text:='workflow-pg-completeness-incident-b';
  lifecycle_a constant text:='workflow-pg-completeness-lifecycle-a';
  lifecycle_b constant text:='workflow-pg-completeness-lifecycle-b';
  event_a constant text:='workflow-pg-completeness-incident-event-a';
  event_invalid_marker constant text:='workflow-pg-completeness-invalid-marker-event';
  event_invalid_evidence constant text:='workflow-pg-completeness-invalid-evidence-event';
  v2_execution constant text:='workflow-pg-incident-execution';
  v1_execution constant text:='workflow-pg-v1-effect-execution';
  event_body jsonb;
  rejected_marker boolean:=false;
  rejected_evidence boolean:=false;
  rejected_wrong_case boolean:=false;
  revision_before_rejected bigint;
BEGIN
  SELECT payload,row_version INTO action_body_before,action_version_before
  FROM public.pending_actions WHERE id='workflow-pg-action' AND workflow_contract_version=2;
  SELECT body,row_version INTO root_body_before,root_version_before
  FROM public.action_idempotency_roots WHERE id='workflow-pg-root';
  IF action_body_before IS NULL OR root_body_before IS NULL
    OR action_body_before->>'id'<>'workflow-pg-action'
    OR root_body_before->>'actionId'<>'workflow-pg-action' THEN
    RAISE EXCEPTION 'terminal receipt initial-state fixture is not a linked V2 action/root';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.action_executions
    WHERE id=v2_execution AND workflow_contract_version=2
      AND payload->>'kind'='incident_escalate')
    OR NOT EXISTS (SELECT 1 FROM public.action_executions
      WHERE id=v1_execution AND workflow_contract_version IS NULL) THEN
    RAISE EXCEPTION 'incident proof fixture did not preserve distinct V1 and V2 execution markers';
  END IF;
  terminal_body:=jsonb_build_object(
    'id',terminal_id,'actionId','workflow-pg-action','contractVersion',2,
    'actorId','workflow-pg-actor','kind','investigation_create','outcome','verified_success',
    'proofs',jsonb_build_array(jsonb_build_object(
      'targetId','workflow-pg-completeness-terminal-target',
      'ref',jsonb_build_object('table','investigation_cases','id','workflow-pg-case'),
      'outcome','verified_success','executionId',terminal_id,'observedRowVersion',1,
      'checkedAt','2026-10-03T00:48:00.000Z','mismatchCodes',jsonb_build_array())),
    'createdAt','2026-10-03T00:48:00.000Z','verifiedAt','2026-10-03T00:49:00.000Z',
    'currentStates',jsonb_build_array());

  INSERT INTO public.incidents(id,payload) VALUES
    (incident_a,jsonb_build_object('id',incident_a,'rowVersion',1,
      'branchId','workflow-pg-ordered-cas-branch','date','2026-10-02','status','open',
      'escalationStage','un_escalated','escalationLifecycleId',lifecycle_a,'escalationEventId',NULL,
      'title','Completeness incident A','kind','operations','startedAt','2026-10-02T08:00:00.000Z',
      'endedAt',NULL,'updatedAt','2026-10-03T00:45:00.000Z')),
    (incident_b,jsonb_build_object('id',incident_b,'rowVersion',1,
      'branchId','workflow-pg-ordered-cas-branch','date','2026-10-02','status','open',
      'escalationStage','un_escalated','escalationLifecycleId',lifecycle_b,'escalationEventId',NULL,
      'title','Completeness incident B','kind','operations','startedAt','2026-10-02T08:01:00.000Z',
      'endedAt',NULL,'updatedAt','2026-10-03T00:45:00.000Z'));

  revision_before:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
    VALUES (terminal_id,1,2,'workflow-pg-root',99,terminal_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    terminal_sqlstate:=SQLSTATE;
    terminal_message:=SQLERRM;
    rejected_terminal:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  revision_before_rejected:=revision_before;
  BEGIN
    INSERT INTO public.incident_escalation_events(id,row_version,body)
    VALUES (event_invalid_marker,1,jsonb_build_object(
      'id',event_invalid_marker,'incidentId',incident_a,'teamId','demo_operations',
      'actorId','workflow-pg-actor','stage','team_requested','lifecycleId',lifecycle_a,
      'executionId',v1_execution,'reason','Reject legacy V1 effect proof.',
      'evidenceIds',jsonb_build_array('incident-evidence-legacy'),'createdAt','2026-10-03T00:46:00.000Z'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_marker:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  BEGIN
    INSERT INTO public.incident_escalation_events(id,row_version,body)
    VALUES (event_invalid_evidence,1,jsonb_build_object(
      'id',event_invalid_evidence,'incidentId',incident_a,'teamId','demo_operations',
      'actorId','workflow-pg-actor','stage','team_requested','lifecycleId',lifecycle_a,
      'executionId',v2_execution,'reason','Reject malformed typed evidence.',
      'evidenceIds',jsonb_build_array('invalid/evidence-id'),'createdAt','2026-10-03T00:46:30.000Z'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_evidence:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT rejected_terminal OR terminal_sqlstate IS DISTINCT FROM '23514'
    OR terminal_message IS DISTINCT FROM 'Invalid workflow creation state'
    OR NOT rejected_marker OR NOT rejected_evidence
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR revision_before_rejected<>revision_before
    OR EXISTS (SELECT 1 FROM public.action_executions WHERE id=terminal_id)
    OR (SELECT payload FROM public.pending_actions WHERE id='workflow-pg-action') IS DISTINCT FROM action_body_before
    OR (SELECT row_version FROM public.pending_actions WHERE id='workflow-pg-action') IS DISTINCT FROM action_version_before
    OR (SELECT body FROM public.action_idempotency_roots WHERE id='workflow-pg-root') IS DISTINCT FROM root_body_before
    OR (SELECT row_version FROM public.action_idempotency_roots WHERE id='workflow-pg-root') IS DISTINCT FROM root_version_before
    OR EXISTS (SELECT 1 FROM public.incident_escalation_events WHERE id IN (event_invalid_marker,event_invalid_evidence)) THEN
    RAISE EXCEPTION 'legacy effect marker or malformed evidence rejection changed incident history';
  END IF;

  event_body:=jsonb_build_object(
    'id',event_a,'incidentId',incident_a,'teamId','demo_operations','actorId','workflow-pg-actor',
    'stage','team_requested','lifecycleId',lifecycle_a,'executionId',v2_execution,
    'reason','Escalate the reviewed synthetic incident.','evidenceIds',jsonb_build_array('incident-evidence-01'),
    'createdAt','2026-10-03T00:47:00.000Z');
  INSERT INTO public.incident_escalation_events(id,row_version,body)
  VALUES (event_a,1,event_body);
  UPDATE public.incidents
  SET row_version=2,
      payload=jsonb_set(
        jsonb_set(
          jsonb_set(payload,'{rowVersion}','2'::jsonb),
          '{escalationStage}','"team_requested"'::jsonb),
        '{escalationEventId}',to_jsonb(event_a))
  WHERE id=incident_a;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  revision_before_rejected:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    UPDATE public.incidents
    SET row_version=2,
        payload=jsonb_set(
          jsonb_set(
            jsonb_set(payload,'{rowVersion}','2'::jsonb),
            '{escalationStage}','"team_requested"'::jsonb),
          '{escalationEventId}',to_jsonb(event_a))
    WHERE id=incident_b;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_wrong_case:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  IF NOT rejected_wrong_case
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR NOT EXISTS (SELECT 1 FROM public.incidents WHERE id=incident_a AND row_version=2
      AND escalation_stage='team_requested' AND escalation_lifecycle_id=lifecycle_a AND escalation_event_id=event_a)
    OR NOT EXISTS (SELECT 1 FROM public.incident_escalation_events WHERE id=event_a
      AND incident_id=incident_a AND lifecycle_id=lifecycle_a AND workflow_incident_proof_id=incident_a
      AND execution_id=v2_execution AND reason='Escalate the reviewed synthetic incident.'
      AND evidence_ids='["incident-evidence-01"]'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM public.incidents WHERE id=incident_b AND row_version=1
      AND escalation_stage='un_escalated' AND escalation_lifecycle_id=lifecycle_b AND escalation_event_id IS NULL) THEN
    RAISE EXCEPTION 'incident effect did not bind one V2 execution to its same-incident lifecycle or wrong-case rollback';
  END IF;
END
$case$;
-- A verified V2 receipt is terminal and cannot be inserted as a fresh execution.
DO $case$
DECLARE
  terminal_id constant text:='workflow-pg-completeness-terminal-execution';
  terminal_body jsonb;
  action_body_before jsonb;
  root_body_before jsonb;
  action_version_before bigint;
  root_version_before bigint;
  revision_before bigint;
  rejected_terminal boolean:=false;
  terminal_sqlstate text;
  terminal_message text;
BEGIN
  SELECT payload,row_version INTO action_body_before,action_version_before
  FROM public.pending_actions WHERE id='workflow-pg-action' AND workflow_contract_version=2;
  SELECT body,row_version INTO root_body_before,root_version_before
  FROM public.action_idempotency_roots WHERE id='workflow-pg-root';
  IF action_body_before IS NULL OR root_body_before IS NULL
    OR action_body_before->>'id'<>'workflow-pg-action'
    OR root_body_before->>'actionId'<>'workflow-pg-action' THEN
    RAISE EXCEPTION 'terminal receipt initial-state fixture is not a linked V2 action/root';
  END IF;

  terminal_body:=jsonb_build_object(
    'id',terminal_id,'actionId','workflow-pg-action','contractVersion',2,
    'actorId','workflow-pg-actor','kind','investigation_create','outcome','verified_success',
    'proofs',jsonb_build_array(jsonb_build_object(
      'targetId','workflow-pg-completeness-terminal-target',
      'ref',jsonb_build_object('table','investigation_cases','id','workflow-pg-case'),
      'outcome','verified_success','executionId',terminal_id,'observedRowVersion',1,
      'checkedAt','2026-10-03T00:48:00.000Z','mismatchCodes',jsonb_build_array())),
    'createdAt','2026-10-03T00:48:00.000Z','verifiedAt','2026-10-03T00:49:00.000Z',
    'currentStates',jsonb_build_array());
  revision_before:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.action_executions(id,row_version,workflow_contract_version,root_id,attempt,payload)
    VALUES (terminal_id,1,2,'workflow-pg-root',99,terminal_body);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    terminal_sqlstate:=SQLSTATE;
    terminal_message:=SQLERRM;
    rejected_terminal:=true;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  IF NOT rejected_terminal OR terminal_sqlstate IS DISTINCT FROM '23514'
    OR terminal_message IS DISTINCT FROM 'Invalid workflow creation state'
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR EXISTS (SELECT 1 FROM public.action_executions WHERE id=terminal_id)
    OR (SELECT payload FROM public.pending_actions WHERE id='workflow-pg-action')
      IS DISTINCT FROM action_body_before
    OR (SELECT row_version FROM public.pending_actions WHERE id='workflow-pg-action')
      IS DISTINCT FROM action_version_before
    OR (SELECT body FROM public.action_idempotency_roots WHERE id='workflow-pg-root')
      IS DISTINCT FROM root_body_before
    OR (SELECT row_version FROM public.action_idempotency_roots WHERE id='workflow-pg-root')
      IS DISTINCT FROM root_version_before THEN
    RAISE EXCEPTION 'terminal verified receipt was accepted initially or changed action/root/revision';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: new executions start pending and incident effects require typed evidence and same-incident lifecycle pointers

DO $case$
DECLARE
  v_employee_snapshot jsonb;
  child_count integer;
  v_case_id constant text:='workflow-pg-completeness-offboarding-case';
  v_plan_id constant text:='workflow-pg-completeness-offboarding-plan';
BEGIN
  SELECT jsonb_build_object('id',id,'name',name,'branchId',branch_id,'active',active,'rowVersion',row_version)
    INTO v_employee_snapshot
  FROM public.employees WHERE id='workflow-pg-assigned-employee';
  IF v_employee_snapshot IS NULL THEN RAISE EXCEPTION 'offboarding employee fixture is missing'; END IF;

  INSERT INTO public.offboarding_cases(id,row_version,body)
  VALUES (v_case_id,1,jsonb_build_object(
    'id',v_case_id,'rowVersion',1,'employeeId','workflow-pg-assigned-employee',
    'ownerIdentityId','workflow-pg-sender','status','active',
    'lifecycleId','workflow-pg-completeness-offboarding-lifecycle','lastDay','2026-10-20',
    'reason','Prepare the synthetic employee departure.','createdAt','2026-10-03T00:48:00.000Z',
    'updatedAt','2026-10-03T00:48:00.000Z'));
  INSERT INTO public.offboarding_plans(id,row_version,body)
  VALUES (v_plan_id,1,jsonb_build_object(
    'id',v_plan_id,'rowVersion',1,'caseId',v_case_id,'purpose','completeness_assignment_snapshot',
    'status','prepared','executionId',NULL,'employeeSnapshot',v_employee_snapshot,
    'assetAssignmentIds',jsonb_build_array('workflow-pg-assignment-two'),
    'createdAt','2026-10-03T00:49:00.000Z','completedAt',NULL));

  SELECT count(*)::integer INTO child_count
  FROM public.workflow_offboarding_plan_assignments
  WHERE plan_id=v_plan_id AND assignment_id='workflow-pg-assignment-two';
  IF child_count<>1
    OR NOT EXISTS (SELECT 1 FROM public.offboarding_plans p
      WHERE p.id=v_plan_id AND p.employee_snapshot=v_employee_snapshot
        AND p.asset_assignment_ids='["workflow-pg-assignment-two"]'::jsonb
        AND p.body->'employeeSnapshot'=p.employee_snapshot
        AND p.body->'assetAssignmentIds'=p.asset_assignment_ids)
    OR NOT EXISTS (SELECT 1 FROM public.asset_assignments a
      WHERE a.id='workflow-pg-assignment-two' AND a.employee_id='workflow-pg-assigned-employee') THEN
    RAISE EXCEPTION 'offboarding snapshot or native asset-assignment child projection is incomplete';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: offboarding plan preserves an exact employee snapshot and normalizes its owned assignments

DO $case$
DECLARE
  v_employee_snapshot jsonb;
  stale_snapshot jsonb;
  rejected_wrong_owner boolean:=false;
  rejected_stale_snapshot boolean:=false;
  revision_before_rejected bigint;
  wrong_plan constant text:='workflow-pg-completeness-wrong-owner-plan';
  stale_plan constant text:='workflow-pg-completeness-stale-snapshot-plan';
BEGIN
  SELECT jsonb_build_object('id',id,'name',name,'branchId',branch_id,'active',active,'rowVersion',row_version)
    INTO v_employee_snapshot
  FROM public.employees WHERE id='workflow-pg-assigned-employee';
  stale_snapshot:=v_employee_snapshot||jsonb_build_object(
    'rowVersion',(v_employee_snapshot->>'rowVersion')::bigint+1);

  INSERT INTO public.assets(id,row_version,body)
  VALUES ('workflow-pg-completeness-wrong-owner-asset',1,jsonb_build_object(
    'id','workflow-pg-completeness-wrong-owner-asset','rowVersion',1,
    'assetTag','workflow-pg-completeness-wrong-owner-tag','status','available',
    'serialNumber','workflow-pg-completeness-wrong-owner-serial','kind','laptop','model','SQL fixture'));
  INSERT INTO public.asset_assignments(id,row_version,body)
  VALUES ('workflow-pg-completeness-wrong-owner-assignment',1,jsonb_build_object(
    'id','workflow-pg-completeness-wrong-owner-assignment','rowVersion',1,
    'assetId','workflow-pg-completeness-wrong-owner-asset','employeeId','workflow-pg-offboarding-employee-2',
    'status','assigned','assignedAt','2026-10-03T00:50:00.000Z'));

  revision_before_rejected:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.offboarding_plans(id,row_version,body)
    VALUES (wrong_plan,1,jsonb_build_object(
      'id',wrong_plan,'rowVersion',1,'caseId','workflow-pg-completeness-offboarding-case',
      'purpose','wrong_employee_asset','status','prepared','executionId',NULL,
      'employeeSnapshot',v_employee_snapshot,
      'assetAssignmentIds',jsonb_build_array('workflow-pg-completeness-wrong-owner-assignment'),
      'createdAt','2026-10-03T00:51:00.000Z','completedAt',NULL));
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_wrong_owner:=true;
  END;
  BEGIN
    INSERT INTO public.offboarding_plans(id,row_version,body)
    VALUES (stale_plan,1,jsonb_build_object(
      'id',stale_plan,'rowVersion',1,'caseId','workflow-pg-completeness-offboarding-case',
      'purpose','stale_employee_snapshot','status','prepared','executionId',NULL,
      'employeeSnapshot',stale_snapshot,'assetAssignmentIds',jsonb_build_array('workflow-pg-assignment-two'),
      'createdAt','2026-10-03T00:52:00.000Z','completedAt',NULL));
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_stale_snapshot:=true;
  END;

  IF NOT rejected_wrong_owner OR NOT rejected_stale_snapshot
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR EXISTS (SELECT 1 FROM public.offboarding_plans WHERE id IN (wrong_plan,stale_plan))
    OR EXISTS (SELECT 1 FROM public.workflow_offboarding_plan_assignments
      WHERE plan_id IN (wrong_plan,stale_plan))
    OR NOT EXISTS (SELECT 1 FROM public.workflow_offboarding_plan_assignments
      WHERE plan_id='workflow-pg-completeness-offboarding-plan'
        AND assignment_id='workflow-pg-assignment-two') THEN
    RAISE EXCEPTION 'wrong-owner assignment or stale employee snapshot was not rejected atomically';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: offboarding rejects wrong-owner assignments and stale employee snapshots without side effects

DO $case$
DECLARE
  case_body jsonb;
  valid_body jsonb;
  invalid_body jsonb;
  rejected_date boolean:=false;
  rejected_priority boolean:=false;
  rejected_reason boolean:=false;
  rejected_profile_assignee boolean:=false;
  rejected_legacy_update boolean:=false;
  revision_before_rejected bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mock_tickets
    WHERE id='workflow-pg-completeness-legacy-profile-ticket'
      AND workflow_contract_version IS NULL AND assignee_id IS NULL AND row_version IS NULL
      AND payload->>'assigneeId'='workflow-pg-actor'
      AND employee_assignee_id IS NULL AND legacy_assignee_quarantined=1) THEN
    RAISE EXCEPTION 'pre-migration profile-assignee ticket was not preserved in quarantine';
  END IF;

  case_body:=jsonb_build_object(
    'id','workflow-pg-case','rowVersion',1,
    'branchId','workflow-pg-ordered-cas-branch','ownerIdentityId','workflow-pg-sender',
    'status','open','businessDate','2026-10-27','dueDate','2026-10-28',
    'reason','Seed the synthetic case required by ticket projections.','priority','normal',
    'sourceIds',jsonb_build_array(),
    'unansweredQuestion','Validate the synthetic investigation case relationship.',
    'executionId',NULL,'lifecycleId','workflow-pg-completeness-case-lifecycle');
  IF NOT EXISTS (SELECT 1 FROM public.investigation_cases
    WHERE id='workflow-pg-case' AND row_version=1
      AND body=case_body
      AND branch_id='workflow-pg-ordered-cas-branch'
      AND owner_identity_id='workflow-pg-sender' AND status='open'
      AND business_date='2026-10-27') THEN
    RAISE EXCEPTION 'pre-migration ticket case parent was not preserved with its branch, owner, body, and open state';
  END IF;

  valid_body:=jsonb_build_object(
    'id','workflow-pg-completeness-new-employee-ticket','rowVersion',1,
    'branchId','workflow-pg-ordered-cas-branch','assigneeId','workflow-pg-assigned-employee',
    'title','Employee-assigned synthetic ticket','reason','Review the synthetic investigation evidence.',
    'unansweredQuestion','Which operational source needs follow-up?','sourceIds',jsonb_build_array(),
    'status','open','operationKey','workflow-pg-completeness-new-employee-ticket-op',
    'createdAt','2026-10-03T00:53:00.000Z','ownerIdentityId','workflow-pg-sender',
    'caseId','workflow-pg-case','executionId','workflow-pg-execution',
    'dueDate','2026-10-07','priority','high');
  INSERT INTO public.mock_tickets(id,row_version,workflow_contract_version,payload)
  VALUES ('workflow-pg-completeness-new-employee-ticket',1,2,valid_body);

  revision_before_rejected:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  invalid_body:=jsonb_set(jsonb_set(valid_body,'{id}',to_jsonb('workflow-pg-completeness-bad-date'::text)),
    '{operationKey}',to_jsonb('workflow-pg-completeness-bad-date-op'::text));
  invalid_body:=jsonb_set(invalid_body,'{dueDate}',to_jsonb('2026-02-30'::text));
  BEGIN
    INSERT INTO public.mock_tickets(id,row_version,workflow_contract_version,payload)
    VALUES ('workflow-pg-completeness-bad-date',1,2,invalid_body);
  EXCEPTION WHEN check_violation THEN rejected_date:=true;
  END;
  invalid_body:=jsonb_set(jsonb_set(valid_body,'{id}',to_jsonb('workflow-pg-completeness-bad-priority'::text)),
    '{operationKey}',to_jsonb('workflow-pg-completeness-bad-priority-op'::text));
  invalid_body:=jsonb_set(invalid_body,'{priority}',to_jsonb('urgent'::text));
  BEGIN
    INSERT INTO public.mock_tickets(id,row_version,workflow_contract_version,payload)
    VALUES ('workflow-pg-completeness-bad-priority',1,2,invalid_body);
  EXCEPTION WHEN check_violation THEN rejected_priority:=true;
  END;
  invalid_body:=jsonb_set(jsonb_set(valid_body,'{id}',to_jsonb('workflow-pg-completeness-blank-reason'::text)),
    '{operationKey}',to_jsonb('workflow-pg-completeness-blank-reason-op'::text));
  invalid_body:=jsonb_set(invalid_body,'{reason}',to_jsonb('   '::text));
  BEGIN
    INSERT INTO public.mock_tickets(id,row_version,workflow_contract_version,payload)
    VALUES ('workflow-pg-completeness-blank-reason',1,2,invalid_body);
  EXCEPTION WHEN check_violation THEN rejected_reason:=true;
  END;
  invalid_body:=jsonb_set(jsonb_set(valid_body,'{id}',to_jsonb('workflow-pg-completeness-profile-assignee'::text)),
    '{operationKey}',to_jsonb('workflow-pg-completeness-profile-assignee-op'::text));
  invalid_body:=jsonb_set(invalid_body,'{assigneeId}',to_jsonb('workflow-pg-actor'::text));
  BEGIN
    INSERT INTO public.mock_tickets(id,row_version,workflow_contract_version,payload)
    VALUES ('workflow-pg-completeness-profile-assignee',1,2,invalid_body);
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN rejected_profile_assignee:=true;
  END;
  BEGIN
    UPDATE public.mock_tickets
    SET row_version=row_version+1,payload=jsonb_set(payload,'{title}',to_jsonb('blocked legacy rewrite'::text))
    WHERE id='workflow-pg-completeness-legacy-profile-ticket';
  EXCEPTION WHEN check_violation THEN rejected_legacy_update:=true;
  END;

  IF NOT rejected_date OR NOT rejected_priority OR NOT rejected_reason
    OR NOT rejected_profile_assignee OR NOT rejected_legacy_update
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR EXISTS (SELECT 1 FROM public.mock_tickets WHERE id IN (
      'workflow-pg-completeness-bad-date','workflow-pg-completeness-bad-priority',
      'workflow-pg-completeness-blank-reason','workflow-pg-completeness-profile-assignee'))
    OR NOT EXISTS (SELECT 1 FROM public.mock_tickets
      WHERE id='workflow-pg-completeness-new-employee-ticket'
        AND workflow_contract_version=2 AND assignee_id IS NULL
        AND employee_assignee_id='workflow-pg-assigned-employee'
        AND due_date='2026-10-07' AND priority='high'
        AND payload->>'reason'='Review the synthetic investigation evidence.')
    OR NOT EXISTS (SELECT 1 FROM public.mock_tickets
      WHERE id='workflow-pg-completeness-legacy-profile-ticket'
        AND workflow_contract_version IS NULL AND assignee_id IS NULL AND row_version IS NULL
        AND payload->>'assigneeId'='workflow-pg-actor'
        AND employee_assignee_id IS NULL AND legacy_assignee_quarantined=1) THEN
    RAISE EXCEPTION 'typed ticket fields or employee-only assignee quarantine failed';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- Discount amount writes require a nonnegative safe integer and preserve the
-- source opportunity, row, and revision when a probe is rejected.
\echo CASE DETAIL: discount amount required/nonnegative/safe-integer boundary
DO $case$
DECLARE
  discount_definition jsonb;
  discount_base_body jsonb;
  valid_body jsonb;
  amount_probe jsonb;
  probe_id text;
  probe_body jsonb;
  probe_accepted boolean;
  unexpected_probes text:='';
  opportunity_body_before jsonb;
  opportunity_version_before bigint;
  revision_before_rejected bigint;
BEGIN
  SELECT definition INTO discount_definition
  FROM nexus_private.workflow_manifest WHERE table_name='discount_requests';
  IF discount_definition IS NULL
    OR NOT (discount_definition->'bodyFields' ? 'baseAmountSatang')
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(discount_definition->'columns') AS column_def(value)
      WHERE column_def.value->>'column'='base_amount_satang'
        AND column_def.value->>'bodyField'='baseAmountSatang'
        AND column_def.value->>'type'='integer'
        AND column_def.value->>'nullable'='false')
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(discount_definition->'bodyGuards') AS guard_def(value)
      WHERE guard_def.value->>'field'='baseAmountSatang'
        AND guard_def.value->>'kind'='nonnegative_integer')
    OR NOT nexus_private.workflow_body_guard(
      to_jsonb(0::bigint),'{"kind":"nonnegative_integer"}'::jsonb,false)
    OR NOT nexus_private.workflow_body_guard(
      to_jsonb(9007199254740991::bigint),'{"kind":"nonnegative_integer"}'::jsonb,false)
    OR nexus_private.workflow_body_guard(
      to_jsonb((-1)::bigint),'{"kind":"nonnegative_integer"}'::jsonb,false)
    OR nexus_private.workflow_body_guard(
      to_jsonb(1.5::numeric),'{"kind":"nonnegative_integer"}'::jsonb,false)
    OR nexus_private.workflow_body_guard(
      to_jsonb(9007199254740992::bigint),'{"kind":"nonnegative_integer"}'::jsonb,false) THEN
    RAISE EXCEPTION 'discount baseAmountSatang projection or safe-integer guard is incomplete';
  END IF;

  SELECT opportunity.body,opportunity.row_version
    INTO opportunity_body_before,opportunity_version_before
  FROM public.crm_opportunities AS opportunity
  WHERE opportunity.id='workflow-pg-discount-opportunity-2';
  IF opportunity_body_before IS NULL THEN
    RAISE EXCEPTION 'discount amount fixture opportunity is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.discount_requests
    WHERE opportunity_id='workflow-pg-discount-opportunity-2' AND status='manager_review_pending') THEN
    RAISE EXCEPTION 'discount amount fixture opportunity already has an open request';
  END IF;
  discount_base_body:=jsonb_build_object(
    'id','workflow-pg-completeness-discount-probe-base','rowVersion',1,
    'opportunityId','workflow-pg-discount-opportunity-2','ownerIdentityId','workflow-pg-sender',
    'status','manager_review_pending','discountBasisPoints',500,
    'expiresAt','2026-10-10T05:00:00.000Z',
    'reason','Validate the requested synthetic discount amount.',
    'executionId',NULL,'createdAt','2026-10-03T00:54:00.000Z');
  revision_before_rejected:=(SELECT revision FROM public.appmeta WHERE singleton=1);

  FOR amount_probe IN
    SELECT probe.value
    FROM jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('id','workflow-pg-completeness-discount-missing',
        'body',jsonb_set(discount_base_body,'{id}',to_jsonb('workflow-pg-completeness-discount-missing'::text))),
      jsonb_build_object('id','workflow-pg-completeness-discount-negative',
        'body',jsonb_set(jsonb_set(discount_base_body,'{id}',to_jsonb('workflow-pg-completeness-discount-negative'::text)),
          '{baseAmountSatang}',to_jsonb((-1)::bigint),true)),
      jsonb_build_object('id','workflow-pg-completeness-discount-fractional',
        'body',jsonb_set(jsonb_set(discount_base_body,'{id}',to_jsonb('workflow-pg-completeness-discount-fractional'::text)),
          '{baseAmountSatang}',to_jsonb(1.5::numeric),true)),
      jsonb_build_object('id','workflow-pg-completeness-discount-unsafe',
        'body',jsonb_set(jsonb_set(discount_base_body,'{id}',to_jsonb('workflow-pg-completeness-discount-unsafe'::text)),
          '{baseAmountSatang}',to_jsonb(9007199254740992::bigint),true))
    )) AS probe(value)
  LOOP
    probe_id:=amount_probe->>'id';
    probe_body:=amount_probe->'body';
    probe_accepted:=false;
    BEGIN
      INSERT INTO public.discount_requests(id,row_version,body)
      VALUES (probe_id,1,probe_body);
      probe_accepted:=true;
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='rollback accepted discount amount probe';
    EXCEPTION
      WHEN check_violation THEN
        NULL;
      WHEN SQLSTATE 'P0001' THEN
        IF probe_accepted THEN
          unexpected_probes:=unexpected_probes||CASE WHEN unexpected_probes='' THEN '' ELSE ',' END||probe_id;
        END IF;
    END;
  END LOOP;

  IF unexpected_probes<>'' OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR EXISTS (SELECT 1 FROM public.discount_requests WHERE id IN (
      'workflow-pg-completeness-discount-missing','workflow-pg-completeness-discount-negative',
      'workflow-pg-completeness-discount-fractional','workflow-pg-completeness-discount-unsafe'))
    OR (SELECT body FROM public.crm_opportunities WHERE id='workflow-pg-discount-opportunity-2')
      IS DISTINCT FROM opportunity_body_before
    OR (SELECT row_version FROM public.crm_opportunities WHERE id='workflow-pg-discount-opportunity-2')
      IS DISTINCT FROM opportunity_version_before THEN
    RAISE EXCEPTION 'invalid discount amounts changed a row or revision, or were accepted: %',unexpected_probes;
  END IF;

  valid_body:=jsonb_set(jsonb_set(discount_base_body,'{id}',
    to_jsonb('workflow-pg-completeness-discount-max-safe'::text)),
    '{baseAmountSatang}',to_jsonb(9007199254740991::bigint),true);
  INSERT INTO public.discount_requests(id,row_version,body)
  VALUES ('workflow-pg-completeness-discount-max-safe',1,valid_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM public.discount_requests
    WHERE id='workflow-pg-completeness-discount-max-safe' AND row_version=1
      AND base_amount_satang=9007199254740991
      AND body->>'baseAmountSatang'='9007199254740991') THEN
    RAISE EXCEPTION 'maximum safe nonnegative discount amount did not persist through its typed projection';
  END IF;
END
$case$;

-- Historical assigned rows and new open rows share the active case key.
\echo CASE DETAIL: branch review assigned/open active-case index and state rules
DO $case$
DECLARE
  branch_definition jsonb;
  index_unique boolean;
  index_predicate text;
  index_definition text;
  historical_id constant text:='workflow-pg-completeness-branch-review-historical-assigned';
  same_case_open_id constant text:='workflow-pg-completeness-branch-review-open-vs-assigned';
  other_case_id constant text:='workflow-pg-completeness-branch-review-other-case';
  fresh_assigned_id constant text:='workflow-pg-completeness-branch-review-fresh-assigned';
  first_id constant text:='workflow-pg-completeness-branch-review-first';
  duplicate_id constant text:='workflow-pg-completeness-branch-review-duplicate';
  replacement_id constant text:='workflow-pg-completeness-branch-review-replacement';
  historical_case_body jsonb;
  historical_assignment_body jsonb;
  other_case_body jsonb;
  same_case_open_body jsonb;
  fresh_assigned_body jsonb;
  first_body jsonb;
  duplicate_body jsonb;
  replacement_body jsonb;
  historical_case_body_before jsonb;
  historical_assignment_body_before jsonb;
  first_body_before jsonb;
  historical_case_version_before bigint;
  historical_assignment_version_before bigint;
  first_version_before bigint;
  revision_before_same_case_open bigint;
  revision_before_fresh_assigned bigint;
  revision_before_duplicate bigint;
  revision_before_open_to_assigned bigint;
  rejected_same_case_open boolean:=false;
  rejected_fresh_assigned boolean:=false;
  rejected_duplicate boolean:=false;
  rejected_open_to_assigned boolean:=false;
  fresh_assigned_sqlstate text;
  fresh_assigned_message text;
  transition_sqlstate text;
  transition_message text;
BEGIN
  SELECT definition INTO branch_definition
  FROM nexus_private.workflow_manifest WHERE table_name='branch_review_assignments';
  IF branch_definition IS NULL
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branch_definition->'unique') AS unique_def(value)
      WHERE unique_def.value->>'name'='branch_review_assignments_open_case_unique'
        AND unique_def.value->>'openOnly'='true'
        AND unique_def.value->'fields'='["caseId"]'::jsonb
        AND jsonb_array_length(unique_def.value->'openStates')=2
        AND unique_def.value->'openStates' @> '["assigned","open"]'::jsonb)
    OR branch_definition->'insertStates' IS DISTINCT FROM '["open"]'::jsonb
    OR COALESCE((branch_definition->'permittedTransitions'->'open') ? 'assigned',false) THEN
    RAISE EXCEPTION 'branch review descriptor must preserve assigned/open active states while allowing only fresh open rows';
  END IF;
  SELECT native_index.indisunique,pg_get_expr(native_index.indpred,native_index.indrelid),
    pg_get_indexdef(native_index.indexrelid)
  INTO index_unique,index_predicate,index_definition
  FROM pg_catalog.pg_index native_index
  WHERE native_index.indexrelid=to_regclass('public.branch_review_assignments_open_case_unique');
  IF index_unique IS DISTINCT FROM true OR index_predicate IS NULL OR index_definition IS NULL
    OR position('assigned' in lower(index_predicate))=0
    OR position('open' in lower(index_predicate))=0
    OR position('case_id' in lower(index_definition))=0 THEN
    RAISE EXCEPTION 'branch review native unique index must cover assigned and open case rows';
  END IF;

  historical_case_body:=jsonb_build_object(
    'id','workflow-pg-case','rowVersion',1,
    'branchId','workflow-pg-ordered-cas-branch','ownerIdentityId','workflow-pg-sender',
    'status','open','businessDate','2026-10-27','dueDate','2026-10-28',
    'reason','Seed the synthetic case required by ticket projections.','priority','normal',
    'sourceIds',jsonb_build_array(),
    'unansweredQuestion','Validate the synthetic investigation case relationship.',
    'executionId',NULL,'lifecycleId','workflow-pg-completeness-case-lifecycle');
  historical_assignment_body:=jsonb_build_object(
    'id',historical_id,'rowVersion',1,'branchId','workflow-pg-ordered-cas-branch',
    'caseId','workflow-pg-case','ownerIdentityId','workflow-pg-sender','status','assigned',
    'reason','Preserve the synthetic historical assigned review.','executionId',NULL,
    'createdAt','2026-10-03T00:54:30.000Z');
  SELECT body,row_version INTO historical_case_body_before,historical_case_version_before
  FROM public.investigation_cases WHERE id='workflow-pg-case';
  SELECT body,row_version INTO historical_assignment_body_before,historical_assignment_version_before
  FROM public.branch_review_assignments WHERE id=historical_id;
  IF historical_case_version_before IS DISTINCT FROM 1
    OR historical_case_body_before IS DISTINCT FROM historical_case_body
    OR historical_assignment_version_before IS DISTINCT FROM 1
    OR historical_assignment_body_before IS DISTINCT FROM historical_assignment_body
    OR NOT EXISTS (SELECT 1 FROM public.branch_review_assignments AS historical
      WHERE historical.id=historical_id AND historical.case_id='workflow-pg-case'
        AND historical.status='assigned' AND historical.row_version=1)
    OR (SELECT count(*) FROM public.branch_review_assignments AS active_review
      WHERE active_review.case_id='workflow-pg-case' AND active_review.status IN ('assigned','open'))<>1 THEN
    RAISE EXCEPTION 'pre-migration assigned review and case parent were not preserved exactly';
  END IF;

  same_case_open_body:=jsonb_build_object(
    'id',same_case_open_id,'rowVersion',1,'branchId','workflow-pg-ordered-cas-branch',
    'caseId','workflow-pg-case','ownerIdentityId','workflow-pg-sender','status','open',
    'dueDate','2026-10-09','priority','high','executionId','workflow-pg-execution',
    'reason','Try a new open review for the historically assigned case.','createdAt','2026-10-03T00:55:00.000Z');
  revision_before_same_case_open:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.branch_review_assignments(id,row_version,body)
    VALUES (same_case_open_id,1,same_case_open_body);
  EXCEPTION WHEN unique_violation THEN
    rejected_same_case_open:=true;
  END;
  IF NOT rejected_same_case_open
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_same_case_open
    OR EXISTS (SELECT 1 FROM public.branch_review_assignments WHERE id=same_case_open_id)
    OR (SELECT body FROM public.branch_review_assignments WHERE id=historical_id)
      IS DISTINCT FROM historical_assignment_body_before
    OR (SELECT row_version FROM public.branch_review_assignments WHERE id=historical_id)
      IS DISTINCT FROM historical_assignment_version_before
    OR (SELECT body FROM public.investigation_cases WHERE id='workflow-pg-case')
      IS DISTINCT FROM historical_case_body_before
    OR (SELECT row_version FROM public.investigation_cases WHERE id='workflow-pg-case')
      IS DISTINCT FROM historical_case_version_before THEN
    RAISE EXCEPTION 'new open review for assigned case changed historical body/version or revision';
  END IF;

  IF EXISTS (SELECT 1 FROM public.investigation_cases WHERE id=other_case_id) THEN
    RAISE EXCEPTION 'different-case branch review fixture ID already exists';
  END IF;
  other_case_body:=jsonb_build_object(
    'id',other_case_id,'rowVersion',1,'branchId','workflow-pg-ordered-cas-branch',
    'ownerIdentityId','workflow-pg-sender','status','open','businessDate','2026-10-28',
    'dueDate','2026-10-29','reason','Seed a different synthetic branch-review case.',
    'priority','normal','sourceIds',jsonb_build_array(),
    'unansweredQuestion','Validate a second synthetic investigation case.',
    'executionId',NULL,'lifecycleId','workflow-pg-completeness-other-case-lifecycle');
  INSERT INTO public.investigation_cases(id,row_version,body)
  VALUES (other_case_id,1,other_case_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM public.investigation_cases
      WHERE id=other_case_id AND row_version=1 AND body=other_case_body
        AND branch_id='workflow-pg-ordered-cas-branch'
        AND owner_identity_id='workflow-pg-sender' AND status='open') THEN
    RAISE EXCEPTION 'different-case parent did not persist with valid native branch and owner references';
  END IF;

  fresh_assigned_body:=jsonb_build_object(
    'id',fresh_assigned_id,'rowVersion',1,'branchId','workflow-pg-ordered-cas-branch',
    'caseId',other_case_id,'ownerIdentityId','workflow-pg-sender','status','assigned',
    'dueDate','2026-10-10','priority','high','executionId','workflow-pg-execution',
    'reason','A fresh branch review cannot start assigned.','createdAt','2026-10-03T00:55:30.000Z');
  revision_before_fresh_assigned:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.branch_review_assignments(id,row_version,body)
    VALUES (fresh_assigned_id,1,fresh_assigned_body);
  EXCEPTION WHEN check_violation THEN
    fresh_assigned_sqlstate:=SQLSTATE;
    fresh_assigned_message:=SQLERRM;
    rejected_fresh_assigned:=true;
  END;
  IF NOT rejected_fresh_assigned OR fresh_assigned_sqlstate IS DISTINCT FROM '23514'
    OR fresh_assigned_message IS NULL
    OR fresh_assigned_message NOT IN ('Invalid workflow status','Invalid workflow creation state')
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_fresh_assigned
    OR EXISTS (SELECT 1 FROM public.branch_review_assignments WHERE id=fresh_assigned_id)
    OR (SELECT body FROM public.branch_review_assignments WHERE id=historical_id)
      IS DISTINCT FROM historical_assignment_body_before
    OR (SELECT row_version FROM public.branch_review_assignments WHERE id=historical_id)
      IS DISTINCT FROM historical_assignment_version_before THEN
    RAISE EXCEPTION 'fresh assigned review was accepted or changed preserved history/revision';
  END IF;

  first_body:=jsonb_build_object(
    'id',first_id,'rowVersion',1,'branchId','workflow-pg-ordered-cas-branch',
    'caseId',other_case_id,'ownerIdentityId','workflow-pg-sender','status','open',
    'dueDate','2026-10-11','priority','high','executionId','workflow-pg-execution',
    'reason','Review the synthetic branch case.','createdAt','2026-10-03T00:56:00.000Z');
  INSERT INTO public.branch_review_assignments(id,row_version,body)
  VALUES (first_id,1,first_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT body,row_version INTO first_body_before,first_version_before
  FROM public.branch_review_assignments WHERE id=first_id;
  IF first_version_before IS DISTINCT FROM 1 OR first_body_before IS DISTINCT FROM first_body
    OR NOT EXISTS (SELECT 1 FROM public.branch_review_assignments
      WHERE id=first_id AND case_id=other_case_id AND status='open') THEN
    RAISE EXCEPTION 'open review on a different case was not accepted';
  END IF;

  duplicate_body:=jsonb_set(first_body,'{id}',to_jsonb(duplicate_id));
  revision_before_duplicate:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.branch_review_assignments(id,row_version,body)
    VALUES (duplicate_id,1,duplicate_body);
  EXCEPTION WHEN unique_violation THEN
    rejected_duplicate:=true;
  END;
  IF NOT rejected_duplicate
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.branch_review_assignments WHERE id=duplicate_id)
    OR (SELECT body FROM public.branch_review_assignments WHERE id=first_id) IS DISTINCT FROM first_body_before
    OR (SELECT row_version FROM public.branch_review_assignments WHERE id=first_id) IS DISTINCT FROM first_version_before THEN
    RAISE EXCEPTION 'duplicate open branch review changed an existing body/version or revision';
  END IF;

  revision_before_open_to_assigned:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    UPDATE public.branch_review_assignments
    SET row_version=2,
        body=jsonb_set(jsonb_set(body,'{rowVersion}','2'::jsonb),'{status}','"assigned"'::jsonb)
    WHERE id=first_id;
  EXCEPTION WHEN check_violation THEN
    transition_sqlstate:=SQLSTATE;
    transition_message:=SQLERRM;
    rejected_open_to_assigned:=true;
  END;
  IF NOT rejected_open_to_assigned OR transition_sqlstate IS DISTINCT FROM '23514'
    OR transition_message IS DISTINCT FROM 'Invalid workflow transition'
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_open_to_assigned
    OR (SELECT body FROM public.branch_review_assignments WHERE id=first_id) IS DISTINCT FROM first_body_before
    OR (SELECT row_version FROM public.branch_review_assignments WHERE id=first_id) IS DISTINCT FROM first_version_before THEN
    RAISE EXCEPTION 'open review transitioned to assigned or changed its body/version/revision';
  END IF;

  UPDATE public.branch_review_assignments
  SET row_version=2,
      body=jsonb_set(jsonb_set(body,'{rowVersion}','2'::jsonb),'{status}','"cancelled"'::jsonb)
  WHERE id=first_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  replacement_body:=jsonb_set(jsonb_set(first_body,'{id}',to_jsonb(replacement_id)),
    '{createdAt}',to_jsonb('2026-10-03T00:57:00.000Z'::text));
  INSERT INTO public.branch_review_assignments(id,row_version,body)
  VALUES (replacement_id,1,replacement_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT EXISTS (SELECT 1 FROM public.branch_review_assignments
      WHERE id=historical_id AND row_version=1 AND status='assigned'
        AND body=historical_assignment_body_before)
    OR NOT EXISTS (SELECT 1 FROM public.investigation_cases
      WHERE id='workflow-pg-case' AND row_version=historical_case_version_before
        AND body=historical_case_body_before)
    OR NOT EXISTS (SELECT 1 FROM public.branch_review_assignments
      WHERE id=first_id AND row_version=2 AND status='cancelled')
    OR NOT EXISTS (SELECT 1 FROM public.branch_review_assignments
      WHERE id=replacement_id AND row_version=1 AND status='open')
    OR (SELECT count(*) FROM public.branch_review_assignments AS active_review
      WHERE active_review.case_id='workflow-pg-case' AND active_review.status IN ('assigned','open'))<>1
    OR (SELECT count(*) FROM public.branch_review_assignments AS active_review
      WHERE active_review.case_id=other_case_id AND active_review.status IN ('assigned','open'))<>1 THEN
    RAISE EXCEPTION 'branch review active-case uniqueness or historical assigned preservation failed';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- Reminder uniqueness is the exact contract/expiry/milestone triple.
\echo CASE DETAIL: contract reminder permits a changed expiry and rejects the exact triple
DO $case$
DECLARE
  reminder_definition jsonb;
  index_unique boolean;
  index_predicate text;
  index_definition text;
  v_contract_id constant text:='workflow-pg-completeness-reminder-contract';
  first_id constant text:='workflow-pg-completeness-reminder-first';
  second_id constant text:='workflow-pg-completeness-reminder-second';
  duplicate_id constant text:='workflow-pg-completeness-reminder-duplicate';
  contract_body jsonb;
  first_body jsonb;
  second_body jsonb;
  duplicate_body jsonb;
  first_body_before jsonb;
  second_body_before jsonb;
  contract_body_before jsonb;
  first_version_before bigint;
  second_version_before bigint;
  contract_version_before bigint;
  revision_before_duplicate bigint;
  rejected_duplicate boolean:=false;
BEGIN
  SELECT definition INTO reminder_definition
  FROM nexus_private.workflow_manifest WHERE table_name='contract_reminders';
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(reminder_definition->'unique') AS unique_def(value)
      WHERE unique_def.value->>'name'='contract_reminders_contract_milestone_unique'
        AND unique_def.value->'fields'='["contractId","expiresAt","milestone"]'::jsonb
        AND NOT (unique_def.value ? 'openOnly')) THEN
    RAISE EXCEPTION 'contract reminder uniqueness descriptor is not the exact expiry/milestone triple';
  END IF;
  SELECT native_index.indisunique,pg_get_expr(native_index.indpred,native_index.indrelid),
    pg_get_indexdef(native_index.indexrelid)
  INTO index_unique,index_predicate,index_definition
  FROM pg_catalog.pg_index native_index
  WHERE native_index.indexrelid=to_regclass('public.contract_reminders_contract_milestone_unique');
  IF index_unique IS DISTINCT FROM true OR index_predicate IS NOT NULL OR index_definition IS NULL
    OR position('contract_id' in index_definition)=0
    OR position('expires_at' in index_definition)=0
    OR position('milestone' in index_definition)=0 THEN
    RAISE EXCEPTION 'contract reminder native unique index does not cover the contract/expiry/milestone triple';
  END IF;
  IF EXISTS (SELECT 1 FROM public.employment_contracts
    WHERE employee_id='workflow-pg-assigned-employee' AND status IN ('draft','active')) THEN
    RAISE EXCEPTION 'contract reminder fixture employee already has an open contract';
  END IF;

  contract_body:=jsonb_build_object(
    'id',v_contract_id,'rowVersion',1,'employeeId','workflow-pg-assigned-employee',
    'status','active','startDate','2026-01-01','endDate',NULL,
    'contractType','standard','policyVersion','1.0','createdAt','2026-10-03T00:57:00.000Z');
  INSERT INTO public.employment_contracts(id,row_version,body)
  VALUES (v_contract_id,1,contract_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT body,row_version INTO contract_body_before,contract_version_before
  FROM public.employment_contracts WHERE id=v_contract_id;

  first_body:=jsonb_build_object(
    'id',first_id,'rowVersion',1,'contractId',v_contract_id,'milestone','contract_expiry_30_days',
    'expiresAt','2026-10-31T00:00:00.000Z','status','pending',
    'ownerIdentityId','workflow-pg-sender','dueDate','2026-10-01','priority','normal',
    'reason','Send the first synthetic contract reminder.','executionId','workflow-pg-execution',
    'createdAt','2026-10-03T00:58:00.000Z','sentAt',NULL);
  second_body:=jsonb_set(
    jsonb_set(jsonb_set(first_body,'{id}',to_jsonb(second_id)),
      '{expiresAt}',to_jsonb('2026-11-01T00:00:00.000Z'::text)),
    '{dueDate}',to_jsonb('2026-10-02'::text));
  INSERT INTO public.contract_reminders(id,row_version,body)
  VALUES (first_id,1,first_body),(second_id,1,second_body);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT body,row_version INTO first_body_before,first_version_before
  FROM public.contract_reminders WHERE id=first_id;
  SELECT body,row_version INTO second_body_before,second_version_before
  FROM public.contract_reminders WHERE id=second_id;
  IF NOT EXISTS (SELECT 1 FROM public.contract_reminders
       WHERE id=first_id AND contract_id=v_contract_id AND milestone='contract_expiry_30_days'
        AND expires_at='2026-10-31T00:00:00.000Z')
    OR NOT EXISTS (SELECT 1 FROM public.contract_reminders
       WHERE id=second_id AND contract_id=v_contract_id AND milestone='contract_expiry_30_days'
        AND expires_at='2026-11-01T00:00:00.000Z') THEN
    RAISE EXCEPTION 'same contract/milestone with a different expiry was not accepted';
  END IF;

  duplicate_body:=jsonb_set(first_body,'{id}',to_jsonb(duplicate_id));
  revision_before_duplicate:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.contract_reminders(id,row_version,body)
    VALUES (duplicate_id,1,duplicate_body);
  EXCEPTION WHEN unique_violation THEN
    rejected_duplicate:=true;
  END;
  IF NOT rejected_duplicate
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_duplicate
    OR EXISTS (SELECT 1 FROM public.contract_reminders WHERE id=duplicate_id)
    OR (SELECT body FROM public.contract_reminders WHERE id=first_id) IS DISTINCT FROM first_body_before
    OR (SELECT row_version FROM public.contract_reminders WHERE id=first_id) IS DISTINCT FROM first_version_before
    OR (SELECT body FROM public.contract_reminders WHERE id=second_id) IS DISTINCT FROM second_body_before
    OR (SELECT row_version FROM public.contract_reminders WHERE id=second_id) IS DISTINCT FROM second_version_before
    OR (SELECT body FROM public.employment_contracts WHERE id=v_contract_id) IS DISTINCT FROM contract_body_before
    OR (SELECT row_version FROM public.employment_contracts WHERE id=v_contract_id) IS DISTINCT FROM contract_version_before THEN
    RAISE EXCEPTION 'duplicate contract/expiry/milestone changed reminder/contract body, version, or revision';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: ticket/discount typing, onboarding/branch lifecycle uniqueness, and contract reminder triple are enforced

DO $case$
DECLARE
  missing_columns integer;
  proof_generated boolean;
  document_definition jsonb;
  event_definition jsonb;
  plan_definition jsonb;
BEGIN
  SELECT count(*)::integer INTO missing_columns
  FROM (VALUES
    ('incidents','escalation_stage','text'),
    ('incidents','escalation_lifecycle_id','text'),
    ('incidents','escalation_event_id','text'),
    ('incident_escalation_events','reason','text'),
    ('incident_escalation_events','evidence_ids','jsonb'),
    ('offboarding_plans','employee_snapshot','jsonb'),
    ('offboarding_plans','asset_assignment_ids','jsonb'),
    ('mock_tickets','employee_assignee_id','text'),
    ('branch_review_assignments','due_date','text'),
    ('branch_review_assignments','priority','text'),
    ('branch_review_assignments','execution_id','text'),
    ('onboarding_tasks','reason','text'),
    ('onboarding_tasks','priority','text'),
    ('onboarding_tasks','execution_id','text'),
    ('it_disable_requests','effective_date','text'),
    ('it_disable_requests','reason','text'),
    ('contract_reminders','owner_identity_id','text'),
    ('contract_reminders','due_date','text'),
    ('contract_reminders','priority','text'),
    ('contract_reminders','reason','text'),
    ('policy_acknowledgement_tasks','owner_identity_id','text'),
    ('policy_acknowledgement_tasks','priority','text'),
    ('policy_acknowledgement_tasks','reason','text')
  ) AS expected(table_name,column_name,data_type)
  LEFT JOIN information_schema.columns actual
    ON actual.table_schema='public' AND actual.table_name=expected.table_name
      AND actual.column_name=expected.column_name
  WHERE actual.column_name IS NULL OR actual.data_type<>expected.data_type OR actual.is_nullable<>'YES';

  SELECT is_generated='ALWAYS' AND data_type='text' INTO proof_generated
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='incident_escalation_events'
    AND column_name='workflow_incident_proof_id';
  SELECT definition INTO document_definition FROM nexus_private.workflow_manifest WHERE table_name='onboarding_documents';
  SELECT definition INTO event_definition FROM nexus_private.workflow_manifest WHERE table_name='incident_escalation_events';
  SELECT definition INTO plan_definition FROM nexus_private.workflow_manifest WHERE table_name='offboarding_plans';

  IF missing_columns<>0 OR proof_generated IS DISTINCT FROM true
    OR NOT (document_definition->'legacyReadOnlyStates' ? 'received')
    OR NOT (document_definition->'legacyReadOnlyStates' ? 'waived')
    OR NOT (event_definition->'requiredWriteFields' ? 'reason')
    OR NOT (event_definition->'requiredWriteFields' ? 'evidenceIds')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(plan_definition->'normalizedChildren') AS child(value)
      WHERE child.value->>'table'='workflow_offboarding_plan_assignments'
        AND child.value->>'arrayBodyField'='assetAssignmentIds')
    OR (SELECT workflow_contract_version FROM public.action_executions
      WHERE id='workflow-pg-v1-effect-execution') IS NOT NULL
    OR (SELECT workflow_contract_version FROM public.action_executions
      WHERE id='workflow-pg-incident-execution') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'new nullable projections, effect proof metadata, or legacy/V2 execution markers are incomplete';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: nullable typed projections and V1/V2 effect markers match the installed manifest

DO $case$
DECLARE
  rls_enabled boolean;
  has_policy boolean;
  rejected_unprojected_child boolean:=false;
  rejected_child_delete boolean:=false;
  revision_before_rejected bigint;
BEGIN
  SELECT c.relrowsecurity INTO rls_enabled
  FROM pg_catalog.pg_class c
  WHERE c.oid='public.workflow_offboarding_plan_assignments'::regclass;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='workflow_offboarding_plan_assignments') INTO has_policy;
  IF rls_enabled IS DISTINCT FROM true OR has_policy
    OR has_table_privilege('anon','public.workflow_offboarding_plan_assignments','SELECT')
    OR has_table_privilege('anon','public.workflow_offboarding_plan_assignments','INSERT')
    OR has_table_privilege('authenticated','public.workflow_offboarding_plan_assignments','SELECT')
    OR has_table_privilege('authenticated','public.workflow_offboarding_plan_assignments','INSERT')
    OR NOT has_table_privilege('service_role','public.workflow_offboarding_plan_assignments','SELECT')
    OR has_table_privilege('service_role','public.workflow_offboarding_plan_assignments','INSERT')
    OR has_table_privilege('service_role','public.workflow_offboarding_plan_assignments','UPDATE')
    OR has_table_privilege('service_role','public.workflow_offboarding_plan_assignments','DELETE') THEN
    RAISE EXCEPTION 'new normalized child RLS or server-only read grants are incomplete';
  END IF;

  revision_before_rejected:=(SELECT revision FROM public.appmeta WHERE singleton=1);
  BEGIN
    INSERT INTO public.workflow_offboarding_plan_assignments(plan_id,assignment_id)
    VALUES ('workflow-pg-completeness-offboarding-plan','workflow-pg-completeness-wrong-owner-assignment');
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    rejected_unprojected_child:=true;
  END;
  BEGIN
    DELETE FROM public.workflow_offboarding_plan_assignments
    WHERE plan_id='workflow-pg-completeness-offboarding-plan'
      AND assignment_id='workflow-pg-assignment-two';
  EXCEPTION WHEN check_violation THEN
    rejected_child_delete:=true;
  END;
  IF NOT rejected_unprojected_child OR NOT rejected_child_delete
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before_rejected
    OR EXISTS (SELECT 1 FROM public.workflow_offboarding_plan_assignments
      WHERE plan_id='workflow-pg-completeness-offboarding-plan'
        AND assignment_id='workflow-pg-completeness-wrong-owner-assignment')
    OR NOT EXISTS (SELECT 1 FROM public.workflow_offboarding_plan_assignments
      WHERE plan_id='workflow-pg-completeness-offboarding-plan'
        AND assignment_id='workflow-pg-assignment-two') THEN
    RAISE EXCEPTION 'native child ownership guard allowed an unprojected row or changed immutable assignment history';
  END IF;
END
$case$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\echo CASE PASS: normalized offboarding child has RLS, server-only read grants, and immutable native ownership

\if :{?KEEP_COMPLETENESS_ROWS}
COMMIT;
\echo CONFORMANCE: completeness fixtures committed for the populated reapply proof
\else
ROLLBACK;
\echo CONFORMANCE: completeness SQL fixtures rolled back
\endif

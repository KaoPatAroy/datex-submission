\set ON_ERROR_STOP 1

-- Runner precondition: start from the original 010001 schema, seed exactly
-- the nine synthetic V1 rows, apply 010002, then run this file as the pending_actions
-- table owner or a superuser so the TRUNCATE guard (not a privilege error) is exercised.
-- V1-only fixture for the original id/payload schema. The runner seeds the
-- nine historical rows and applies the standalone guard before this file.
CREATE TEMP TABLE v1_historical_snapshot ON COMMIT PRESERVE ROWS AS
SELECT action_row.id,action_row.payload,to_jsonb(action_row) AS row_image
FROM public.pending_actions AS action_row;

CREATE TEMP TABLE v1_action_template(body jsonb NOT NULL) ON COMMIT PRESERVE ROWS;
INSERT INTO pg_temp.v1_action_template(body)
VALUES (jsonb_build_object(
  'id','workflow-pg-v1-template','actorId','workflow-pg-v1-test-actor',
  'sessionId','workflow-pg-v1-test-session','conversationId','workflow-pg-v1-test-conversation',
  'turnId','workflow-pg-v1-template-turn','mode','live_ai','modeRevision',0,
  'payload',jsonb_build_object(
    'kind','dashboard_create',
    'spec',jsonb_build_object(
      'title','Original dashboard','description','Standalone V1 SQL fixture.',
      'scope',jsonb_build_object('region','east','date',CURRENT_DATE::text,
        'branchIds',jsonb_build_array('workflow-pg-v1-test-branch')),
      'widgets',jsonb_build_array(jsonb_build_object(
        'type','metric','title','Net sales','metric','net_sales')))),
  'payloadHash','workflow-pg-v1-template-hash','evidenceVersion',NULL,
  'packs',jsonb_build_array(),'actionContractVersion',1,
  'approvalScope',jsonb_build_object('region','east','date',CURRENT_DATE::text,
    'branchIds',jsonb_build_array('workflow-pg-v1-test-branch')),
  'approvalDisplay',jsonb_build_object('artifactTitle','Original dashboard'),
  'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt','2099-01-01T00:00:00.000Z',
  'status','pending','preview','Review the dashboard request.'));

\echo CASE DETAIL: nine historical V1 rows and standalone guard are present
DO $case$
DECLARE
  historical_count integer;
  bad_historical_count integer;
  payload_digest text;
  row_image_digest text;
BEGIN
  SELECT count(*)::integer INTO historical_count FROM pg_temp.v1_historical_snapshot;
  SELECT md5(string_agg(action_row.id||':'||action_row.payload::text,E'\n' ORDER BY action_row.id COLLATE "C")),
    md5(string_agg(jsonb_build_object('id',action_row.id,'payload',action_row.payload)::text,
      E'\n' ORDER BY action_row.id COLLATE "C"))
  INTO payload_digest,row_image_digest
  FROM public.pending_actions AS action_row;
  SELECT count(*)::integer INTO bad_historical_count
  FROM (VALUES
    ('workflow-pg-v1-historical-completed-01','completed'),
    ('workflow-pg-v1-historical-completed-02','completed'),
    ('workflow-pg-v1-historical-completed-03','completed'),
    ('workflow-pg-v1-historical-completed-04','completed'),
    ('workflow-pg-v1-historical-completed-05','completed'),
    ('workflow-pg-v1-historical-completed-06','completed'),
    ('workflow-pg-v1-historical-completed-07','completed'),
    ('workflow-pg-v1-historical-completed-08','completed'),
    ('workflow-pg-v1-historical-pending-01','pending')
  ) AS expected(id,status)
  LEFT JOIN public.pending_actions AS action_row ON action_row.id=expected.id
  WHERE action_row.id IS NULL
    OR action_row.payload->>'id' IS DISTINCT FROM expected.id
    OR action_row.payload->>'actionContractVersion' IS DISTINCT FROM '1'
    OR action_row.payload->>'status' IS DISTINCT FROM expected.status
    OR COALESCE(to_jsonb(action_row)->'row_version','null'::jsonb)<>'null'::jsonb
    OR COALESCE(to_jsonb(action_row)->'workflow_contract_version','null'::jsonb)<>'null'::jsonb;
  IF historical_count<>9 OR bad_historical_count<>0
    OR payload_digest IS DISTINCT FROM 'dc2c5cca4cd75a4d83021ba8927cb335'
    OR row_image_digest IS DISTINCT FROM '4503d2159ffdb8ff09015f631942a02f'
    OR EXISTS (SELECT 1 FROM public.pending_actions AS action_row
      WHERE NOT (action_row.id=ANY(ARRAY[
        'workflow-pg-v1-historical-completed-01','workflow-pg-v1-historical-completed-02',
        'workflow-pg-v1-historical-completed-03','workflow-pg-v1-historical-completed-04',
        'workflow-pg-v1-historical-completed-05','workflow-pg-v1-historical-completed-06',
        'workflow-pg-v1-historical-completed-07','workflow-pg-v1-historical-completed-08',
        'workflow-pg-v1-historical-pending-01']::text[])))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_proc AS guard_proc ON guard_proc.oid=trigger_row.tgfoid
      WHERE trigger_row.tgrelid='public.pending_actions'::regclass
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname='standalone_pending_action_v1_guard'
        AND guard_proc.oid='nexus_private.standalone_pending_action_v1_guard()'::regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid='public.pending_actions'::regclass
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname='standalone_pending_action_v1_truncate_guard')
    OR to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)') IS NULL
    OR to_regprocedure('nexus_private.standalone_pending_action_v1_utf16_length(text)') IS NULL THEN
    RAISE EXCEPTION 'V1 baseline rows or standalone insert/update/delete/truncate guard are incomplete';
  END IF;
END
$case$;
\echo CASE PASS: nine pre-existing V1 actions preserve their identities and historical statuses

\echo CASE DETAIL: valid markerless pending insert and A-to-B superseding batch
DO $case$
DECLARE
  template_body jsonb;
  valid_id constant text:='workflow-pg-v1-standalone-valid';
  action_a_id constant text:='workflow-pg-v1-standalone-a';
  action_b_id constant text:='workflow-pg-v1-standalone-b';
  valid_body jsonb;
  action_a jsonb;
  action_a_stale jsonb;
  action_b jsonb;
  revision_before bigint;
  revision_after bigint;
  revision_replay bigint;
  action_a_before jsonb;
  action_a_after jsonb;
BEGIN
  SELECT body INTO STRICT template_body FROM pg_temp.v1_action_template;
  valid_body:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(valid_id),true),
      '{turnId}',to_jsonb('turn-'||valid_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||valid_id),true);
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  INSERT INTO public.pending_actions(id,payload) VALUES (valid_id,valid_body);
  IF NOT EXISTS (SELECT 1 FROM public.pending_actions AS action_row
      WHERE action_row.id=valid_id AND action_row.payload=valid_body
        AND action_row.payload->>'status'='pending'
        AND COALESCE(to_jsonb(action_row)->'row_version','null'::jsonb)='null'::jsonb
        AND COALESCE(to_jsonb(action_row)->'workflow_contract_version','null'::jsonb)='null'::jsonb)
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<=revision_before THEN
    RAISE EXCEPTION 'valid V1 pending action did not persist markerless with no native version';
  END IF;

  action_a:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(action_a_id),true),
      '{turnId}',to_jsonb('turn-'||action_a_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||action_a_id),true);
  action_b:=jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(template_body,'{id}',to_jsonb(action_b_id),true),
          '{turnId}',to_jsonb('turn-'||action_b_id),true),
        '{payloadHash}',to_jsonb('payload-hash-'||action_b_id),true),
      '{payload,spec,title}',to_jsonb('Revised dashboard'::text),true),
    '{approvalDisplay,artifactTitle}',to_jsonb('Revised dashboard'::text),true)
    || jsonb_build_object('predecessorActionId',action_a_id,
      'revisionDiff',jsonb_build_array('Changed the dashboard title.'));
  action_a_stale:=action_a||jsonb_build_object(
    'status','stale','supersededByActionId',action_b_id,'staleReason','superseded');
  INSERT INTO public.pending_actions(id,payload) VALUES (action_a_id,action_a);
  SELECT payload INTO STRICT action_a_before FROM public.pending_actions WHERE id=action_a_id;
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(revision_before,jsonb_build_array(
    jsonb_build_object('table','pending_actions','id',action_b_id,'payload',action_b),
    jsonb_build_object('table','pending_actions','id',action_a_id,'payload',action_a_stale)))
  INTO revision_after;
  SELECT payload INTO STRICT action_a_after FROM public.pending_actions WHERE id=action_a_id;
  IF revision_after<>(SELECT revision FROM public.appmeta WHERE singleton=1)
    OR revision_after<=revision_before
    OR action_a_after IS DISTINCT FROM action_a_stale
    OR (action_a_after-ARRAY['status','rowVersion','supersededByActionId','staleReason'])
      IS DISTINCT FROM (action_a_before-ARRAY['status','rowVersion','supersededByActionId','staleReason'])
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS successor
      WHERE successor.id=action_b_id AND successor.payload=action_b
        AND successor.payload->>'status'='pending'
        AND successor.payload->>'predecessorActionId'=action_a_id
        AND successor.payload->'revisionDiff'='["Changed the dashboard title."]'::jsonb) THEN
    RAISE EXCEPTION 'V1 A-to-B revision was not atomic or changed the predecessor approval envelope';
  END IF;
  SELECT public.nexus_commit(revision_after,jsonb_build_array(
    jsonb_build_object('table','pending_actions','id',action_a_id,'payload',action_a_stale)))
  INTO revision_replay;
  IF revision_replay<>(SELECT revision FROM public.appmeta WHERE singleton=1)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions
      WHERE id=action_a_id AND payload=action_a_stale)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions
      WHERE id=action_b_id AND payload=action_b) THEN
    RAISE EXCEPTION 'identical V1 stale predecessor replay changed the A-to-B pair';
  END IF;
END
$case$;
\echo CASE PASS: V1 accepts a valid pending insert and atomically supersedes A with B

\echo CASE DETAIL: child upsert, claim/completion and idempotent cancellation
DO $case$
DECLARE
  template_body jsonb;
  action_b_id constant text:='workflow-pg-v1-standalone-b';
  action_c_id constant text:='workflow-pg-v1-standalone-c';
  action_d_id constant text:='workflow-pg-v1-standalone-d';
  action_e_id constant text:='workflow-pg-v1-standalone-unclassified-stale';
  action_b jsonb;
  action_b_claimed jsonb;
  action_b_completed jsonb;
  action_c jsonb;
  action_c_stale jsonb;
  action_d jsonb;
  action_d_cancelled jsonb;
  action_e jsonb;
  action_e_stale jsonb;
  current_revision bigint;
  returned_revision bigint;
BEGIN
  SELECT body INTO STRICT template_body FROM pg_temp.v1_action_template;
  SELECT payload INTO STRICT action_b FROM public.pending_actions WHERE id=action_b_id;
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_b_id,'payload',action_b)))
  INTO returned_revision;
  IF NOT EXISTS (SELECT 1 FROM public.pending_actions
      WHERE id=action_b_id AND payload=action_b) THEN
    RAISE EXCEPTION 'identical V1 child conflict upsert changed the child body';
  END IF;
  action_b_claimed:=action_b||jsonb_build_object('status','claimed');
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_b_id,'payload',action_b_claimed)))
  INTO returned_revision;
  action_b_completed:=action_b_claimed||jsonb_build_object('status','completed');
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_b_id,'payload',action_b_completed)))
  INTO returned_revision;
  IF NOT EXISTS (SELECT 1 FROM public.pending_actions
      WHERE id=action_b_id AND payload=action_b_completed
        AND payload->>'status'='completed'
        AND payload->>'predecessorActionId'='workflow-pg-v1-standalone-a'
        AND payload->'revisionDiff'='["Changed the dashboard title."]'::jsonb) THEN
    RAISE EXCEPTION 'V1 child claim/completion did not preserve its lineage';
  END IF;

  action_c:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(action_c_id),true),
      '{turnId}',to_jsonb('turn-'||action_c_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||action_c_id),true);
  action_d:=jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(template_body,'{id}',to_jsonb(action_d_id),true),
        '{turnId}',to_jsonb('turn-'||action_d_id),true),
      '{payloadHash}',to_jsonb('payload-hash-'||action_d_id),true),
    '{predecessorActionId}',to_jsonb(action_c_id),true)
    || jsonb_build_object('revisionDiff',jsonb_build_array('Clarified the dashboard request.'));
  action_c_stale:=action_c||jsonb_build_object(
    'status','stale','supersededByActionId',action_d_id,'staleReason','superseded');
  INSERT INTO public.pending_actions(id,payload) VALUES (action_c_id,action_c);
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(
    jsonb_build_object('table','pending_actions','id',action_d_id,'payload',action_d),
    jsonb_build_object('table','pending_actions','id',action_c_id,'payload',action_c_stale)))
  INTO returned_revision;
  action_d_cancelled:=action_d||jsonb_build_object(
    'status','stale','staleReason','user_cancelled');
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_d_id,'payload',action_d_cancelled)))
  INTO returned_revision;
  SELECT public.nexus_commit(returned_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_d_id,'payload',action_d_cancelled)))
  INTO current_revision;
  IF current_revision<>(SELECT revision FROM public.appmeta WHERE singleton=1)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS cancelled
      WHERE cancelled.id=action_d_id AND cancelled.payload=action_d_cancelled
        AND cancelled.payload->>'status'='stale'
        AND cancelled.payload->>'staleReason'='user_cancelled'
        AND NOT (cancelled.payload ? 'supersededByActionId'))
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS predecessor
      WHERE predecessor.id=action_c_id AND predecessor.payload=action_c_stale) THEN
    RAISE EXCEPTION 'V1 cancellation or identical stale replay changed lineage';
  END IF;

  action_e:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(action_e_id),true),
      '{turnId}',to_jsonb('turn-'||action_e_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||action_e_id),true);
  INSERT INTO public.pending_actions(id,payload) VALUES (action_e_id,action_e);
  action_e_stale:=action_e||jsonb_build_object('status','stale');
  SELECT revision INTO current_revision FROM public.appmeta WHERE singleton=1;
  SELECT public.nexus_commit(current_revision,jsonb_build_array(jsonb_build_object(
    'table','pending_actions','id',action_e_id,'payload',action_e_stale)))
  INTO returned_revision;
  IF returned_revision<>(SELECT revision FROM public.appmeta WHERE singleton=1)
    OR NOT EXISTS (SELECT 1 FROM public.pending_actions AS stale_row
      WHERE stale_row.id=action_e_id AND stale_row.payload=action_e_stale
        AND stale_row.payload->>'status'='stale'
        AND NOT (stale_row.payload ? 'staleReason')
        AND NOT (stale_row.payload ? 'supersededByActionId')) THEN
    RAISE EXCEPTION 'V1 pending-to-stale transition without optional stale metadata was not preserved';
  END IF;
END
$case$;
\echo CASE PASS: V1 child upserts allow claim/completion and idempotent cancellation replay

\echo CASE DETAIL: lineage presence/nulls, initial statuses and V1-to-V2 promotion
DO $case$
DECLARE
  template_body jsonb;
  invalid_candidates jsonb;
  candidate record;
  candidate_id text;
  candidate_body jsonb;
  existing_v1_body jsonb;
  promoted_body jsonb;
  existing_v1_row jsonb;
  checked_candidates integer:=0;
  rejected boolean;
  revision_before bigint;
BEGIN
  SELECT body INTO STRICT template_body FROM pg_temp.v1_action_template;
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  invalid_candidates:=jsonb_build_array(
    jsonb_build_object('id','workflow-pg-v1-predecessor-only',
      'patch',jsonb_build_object('predecessorActionId','workflow-pg-v1-missing-diff-parent')),
    jsonb_build_object('id','workflow-pg-v1-diff-only',
      'patch',jsonb_build_object('revisionDiff',jsonb_build_array('No predecessor.'))),
    jsonb_build_object('id','workflow-pg-v1-null-predecessor',
      'patch',jsonb_build_object('predecessorActionId',NULL)),
    jsonb_build_object('id','workflow-pg-v1-null-diff',
      'patch',jsonb_build_object('revisionDiff',NULL)),
    jsonb_build_object('id','workflow-pg-v1-both-null',
      'patch',jsonb_build_object('predecessorActionId',NULL,'revisionDiff',NULL)),
    jsonb_build_object('id','workflow-pg-v1-empty-diff',
      'patch',jsonb_build_object('predecessorActionId','workflow-pg-v1-empty-diff-parent','revisionDiff',jsonb_build_array())),
    jsonb_build_object('id','workflow-pg-v1-pending-stale-reason',
      'patch',jsonb_build_object('staleReason','expired')),
    jsonb_build_object('id','workflow-pg-v1-pending-successor',
      'patch',jsonb_build_object('supersededByActionId','workflow-pg-v1-successor-without-reason')),
    jsonb_build_object('id','workflow-pg-v1-pending-superseded-reason',
      'patch',jsonb_build_object('staleReason','superseded')),
    jsonb_build_object('id','workflow-pg-v1-unknown-stale-reason',
      'patch',jsonb_build_object('status','stale','staleReason','not_a_reason')),
    jsonb_build_object('id','workflow-pg-v1-fresh-stale',
      'patch',jsonb_build_object('status','stale','staleReason','expired')),
    jsonb_build_object('id','workflow-pg-v1-fresh-claimed',
      'patch',jsonb_build_object('status','claimed')),
    jsonb_build_object('id','workflow-pg-v1-fresh-completed',
      'patch',jsonb_build_object('status','completed')),
    jsonb_build_object('id','workflow-pg-v1-promotion',
      'patch',jsonb_build_object('actionContractVersion',2)));
  IF jsonb_array_length(invalid_candidates)=0 THEN
    RAISE EXCEPTION 'invalid V1 action candidate fixture is empty';
  END IF;
  FOR candidate IN
    SELECT value FROM jsonb_array_elements(invalid_candidates) AS invalid(value)
  LOOP
    checked_candidates:=checked_candidates+1;
    candidate_id:=candidate.value->>'id';
    candidate_body:=jsonb_set(
      jsonb_set(
        jsonb_set(template_body,'{id}',to_jsonb(candidate_id),true),
        '{turnId}',to_jsonb('turn-'||candidate_id),true),
      '{payloadHash}',to_jsonb('payload-hash-'||candidate_id),true)
      || candidate.value->'patch';
    rejected:=false;
    BEGIN
      INSERT INTO public.pending_actions(id,payload) VALUES (candidate_id,candidate_body);
    EXCEPTION WHEN check_violation THEN
      rejected:=true;
    END;
    IF NOT rejected OR EXISTS (SELECT 1 FROM public.pending_actions WHERE id=candidate_id) THEN
      RAISE EXCEPTION 'standalone V1 guard accepted invalid pending-action body %',candidate_id;
    END IF;
  END LOOP;
  IF checked_candidates<>jsonb_array_length(invalid_candidates)
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before THEN
    RAISE EXCEPTION 'invalid V1 candidate probes were vacuous or changed appmeta revision';
  END IF;

  SELECT to_jsonb(action_row),action_row.payload
    INTO STRICT existing_v1_row,existing_v1_body
  FROM public.pending_actions AS action_row
  WHERE action_row.id='workflow-pg-v1-standalone-valid';
  promoted_body:=existing_v1_body||jsonb_build_object('actionContractVersion',2);
  rejected:=false;
  BEGIN
    UPDATE public.pending_actions
    SET payload=promoted_body WHERE id='workflow-pg-v1-standalone-valid';
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row
      WHERE action_row.id='workflow-pg-v1-standalone-valid') IS DISTINCT FROM existing_v1_row THEN
    RAISE EXCEPTION 'an existing V1 action was promoted to V2 or changed its row image/revision';
  END IF;
  rejected:=false;
  BEGIN
    PERFORM public.nexus_commit(revision_before,jsonb_build_array(jsonb_build_object(
      'table','pending_actions','id','workflow-pg-v1-standalone-valid','payload',promoted_body)));
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row
      WHERE action_row.id='workflow-pg-v1-standalone-valid') IS DISTINCT FROM existing_v1_row THEN
    RAISE EXCEPTION 'nexus_commit promoted a V1 action to V2 or changed its row image/revision';
  END IF;
END
$case$;
\echo CASE PASS: V1 rejects malformed lineage presence/nulls, fresh nonpending inserts, and V1-to-V2 promotion

\echo CASE DETAIL: invalid transitions and immutable approval-envelope writes
DO $case$
DECLARE
  pending_id constant text:='workflow-pg-v1-standalone-valid';
  completed_child_id constant text:='workflow-pg-v1-standalone-b';
  original_body jsonb;
  original_row jsonb;
  changed_body jsonb;
  rejected boolean;
  revision_before bigint;
BEGIN
  SELECT to_jsonb(action_row) INTO STRICT original_row
  FROM public.pending_actions AS action_row WHERE action_row.id=pending_id;
  original_body:=original_row->'payload';
  changed_body:=original_body||jsonb_build_object('status','completed');
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    UPDATE public.pending_actions SET payload=changed_body WHERE id=pending_id;
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=pending_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'direct pending-to-completed V1 transition changed status or appmeta revision';
  END IF;
  rejected:=false;
  BEGIN
    PERFORM public.nexus_commit(revision_before,jsonb_build_array(jsonb_build_object(
      'table','pending_actions','id',pending_id,'payload',changed_body)));
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=pending_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'nexus_commit pending-to-completed V1 transition changed status or appmeta revision';
  END IF;

  SELECT to_jsonb(action_row) INTO STRICT original_row
  FROM public.pending_actions AS action_row WHERE action_row.id=completed_child_id;
  original_body:=original_row->'payload';
  changed_body:=original_body||jsonb_build_object('status','pending');
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    UPDATE public.pending_actions SET payload=changed_body WHERE id=completed_child_id;
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=completed_child_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'completed V1 child action reopened or changed its full row image';
  END IF;

  SELECT to_jsonb(action_row) INTO STRICT original_row
  FROM public.pending_actions AS action_row WHERE action_row.id=pending_id;
  original_body:=original_row->'payload';
  changed_body:=original_body||jsonb_build_object('approvalScope',
    jsonb_build_object('region','west','date',CURRENT_DATE::text,
      'branchIds',jsonb_build_array('workflow-pg-v1-test-branch')));
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    UPDATE public.pending_actions SET payload=changed_body WHERE id=pending_id;
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=pending_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'direct approval-scope tampering changed the V1 approval or revision';
  END IF;

  changed_body:=original_body||jsonb_build_object('payloadHash','tampered-v1-payload-hash');
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    PERFORM public.nexus_commit(revision_before,jsonb_build_array(jsonb_build_object(
      'table','pending_actions','id',pending_id,'payload',changed_body)));
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=pending_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'nexus_commit payload-hash tampering changed the V1 approval or revision';
  END IF;

  changed_body:=original_body||jsonb_build_object('approvalDisplay',
    jsonb_build_object('artifactTitle','Tampered display'));
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    UPDATE public.pending_actions SET payload=changed_body WHERE id=pending_id;
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=pending_id)
      IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'direct approval-display tampering changed the V1 approval or revision';
  END IF;
END
$case$;
\echo CASE PASS: V1 rejects invalid status changes and immutable approval-envelope writes

\echo CASE DETAIL: direct delete, RPC delete, and table truncate are denied atomically
DO $case$
DECLARE
  target_id constant text:='workflow-pg-v1-standalone-valid';
  delete_id constant text:='workflow-pg-v1-standalone-a';
  rows_before jsonb;
  revision_before bigint;
  rejected boolean;
BEGIN
  IF has_table_privilege(current_user,'public.pending_actions','TRUNCATE') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'V1 guard conformance requires table-owner or superuser TRUNCATE privilege';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(action_row) ORDER BY action_row.id),'[]'::jsonb)
    INTO rows_before FROM public.pending_actions AS action_row;
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  rejected:=false;
  BEGIN
    DELETE FROM public.pending_actions WHERE id=target_id;
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT COALESCE(jsonb_agg(to_jsonb(action_row) ORDER BY action_row.id),'[]'::jsonb)
        FROM public.pending_actions AS action_row) IS DISTINCT FROM rows_before THEN
    RAISE EXCEPTION 'direct V1 delete removed rows or changed appmeta revision';
  END IF;

  rejected:=false;
  BEGIN
    PERFORM public.nexus_commit(revision_before,jsonb_build_array(jsonb_build_object(
      'table','pending_actions','id',delete_id,'payload','null'::jsonb)));
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT COALESCE(jsonb_agg(to_jsonb(action_row) ORDER BY action_row.id),'[]'::jsonb)
        FROM public.pending_actions AS action_row) IS DISTINCT FROM rows_before THEN
    RAISE EXCEPTION 'V1 nexus_commit delete removed rows or changed appmeta revision';
  END IF;

  rejected:=false;
  BEGIN
    EXECUTE 'TRUNCATE TABLE public.pending_actions';
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR (SELECT COALESCE(jsonb_agg(to_jsonb(action_row) ORDER BY action_row.id),'[]'::jsonb)
        FROM public.pending_actions AS action_row) IS DISTINCT FROM rows_before THEN
    RAISE EXCEPTION 'V1 truncate removed rows or changed appmeta revision';
  END IF;
END
$case$;
\echo CASE PASS: V1 DELETE and TRUNCATE attempts roll back without rows or advancing revision

\echo CASE DETAIL: later failure rolls back an earlier nexus_commit batch insert
DO $case$
DECLARE
  template_body jsonb;
  original_id constant text:='workflow-pg-v1-batch-original';
  candidate_id constant text:='workflow-pg-v1-batch-candidate';
  original_body jsonb;
  candidate_body jsonb;
  rejected_body jsonb;
  stored_row_before jsonb;
  revision_before bigint;
  rejected boolean:=false;
BEGIN
  SELECT body INTO STRICT template_body FROM pg_temp.v1_action_template;
  original_body:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(original_id),true),
      '{turnId}',to_jsonb('turn-'||original_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||original_id),true);
  candidate_body:=jsonb_set(
    jsonb_set(
      jsonb_set(template_body,'{id}',to_jsonb(candidate_id),true),
      '{turnId}',to_jsonb('turn-'||candidate_id),true),
    '{payloadHash}',to_jsonb('payload-hash-'||candidate_id),true);
  INSERT INTO public.pending_actions(id,payload) VALUES (original_id,original_body);
  SELECT to_jsonb(action_row) INTO STRICT stored_row_before
  FROM public.pending_actions AS action_row WHERE action_row.id=original_id;
  rejected_body:=original_body||jsonb_build_object('approvalScope',
    jsonb_build_object('region','north','date',CURRENT_DATE::text,
      'branchIds',jsonb_build_array('workflow-pg-v1-test-branch')));
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  BEGIN
    PERFORM public.nexus_commit(revision_before,jsonb_build_array(
      jsonb_build_object('table','pending_actions','id',candidate_id,'payload',candidate_body),
      jsonb_build_object('table','pending_actions','id',original_id,'payload',rejected_body)));
  EXCEPTION WHEN check_violation THEN rejected:=true;
  END;
  IF NOT rejected OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>revision_before
    OR EXISTS (SELECT 1 FROM public.pending_actions WHERE id=candidate_id)
    OR (SELECT to_jsonb(action_row) FROM public.pending_actions AS action_row WHERE action_row.id=original_id)
      IS DISTINCT FROM stored_row_before THEN
    RAISE EXCEPTION 'rejected V1 batch changed earlier row, inserted candidate, or advanced revision';
  END IF;
END
$case$;
\echo CASE PASS: V1 nexus_commit batch rejection rolls back prior writes and appmeta revision

\echo CASE DETAIL: legacy history remains untouched by all V1 guard probes
DO $case$
DECLARE
  changed_rows integer;
BEGIN
  SELECT count(*)::integer INTO changed_rows
  FROM pg_temp.v1_historical_snapshot AS before_row
  LEFT JOIN public.pending_actions AS current_row ON current_row.id=before_row.id
  WHERE current_row.id IS NULL OR current_row.payload IS DISTINCT FROM before_row.payload
    OR to_jsonb(current_row) IS DISTINCT FROM before_row.row_image;
  IF changed_rows<>0
    OR (SELECT count(*) FROM pg_temp.v1_historical_snapshot)<>9 THEN
    RAISE EXCEPTION 'V1 behavior probes changed one or more of the nine historical action rows';
  END IF;
END
$case$;
\echo CASE PASS: all nine historical V1 action rows remain unchanged after conformance writes

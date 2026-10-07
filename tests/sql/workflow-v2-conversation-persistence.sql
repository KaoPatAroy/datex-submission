-- Local PostgreSQL SQL conformance only. This does not prove hosted Supabase
-- Auth, Data API, policy, or deployment behavior.
\set ON_ERROR_STOP 1
\echo CONFORMANCE: forward conversation identity projections, guards, and CAS

BEGIN;

DO $case$
DECLARE
  native_columns integer;
  valid_indexes integer;
  active_chat_guards integer;
  strict_guard boolean;
  message_manifest_valid boolean;
BEGIN
  SELECT count(*) INTO native_columns
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='public.conversation_messages'::regclass
    AND a.attname IN ('turn_id','session_id')
    AND a.atttypid='text'::regtype
    AND NOT a.attnotnull AND NOT a.atthasdef AND a.attgenerated=''
    AND a.attnum>0 AND NOT a.attisdropped;

  SELECT count(*) INTO valid_indexes
  FROM (
    SELECT c.relname,
      array_agg(a.attname::text ORDER BY k.position) AS key_columns
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
    WHERE n.nspname='public' AND t.relname='conversation_messages'
      AND c.relname IN (
        'wf_conversation_messages_turn_id_lookup',
        'wf_conversation_messages_session_id_lookup',
        'workflow_conversation_messages_identity_lookup')
      AND i.indisvalid AND i.indisready AND NOT i.indisunique
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=i.indnatts
    GROUP BY c.relname
  ) indexes
  WHERE (relname='wf_conversation_messages_turn_id_lookup' AND key_columns=ARRAY['turn_id','id']::text[])
     OR (relname='wf_conversation_messages_session_id_lookup' AND key_columns=ARRAY['session_id','id']::text[])
     OR (relname='workflow_conversation_messages_identity_lookup'
       AND key_columns=ARRAY['actor_id','conversation_id','session_id','turn_id','id']::text[]);

  SELECT count(*) INTO active_chat_guards
  FROM pg_catalog.pg_trigger t
  WHERE t.tgname='workflow_chat_guard' AND t.tgenabled IN ('O','A')
    AND t.tgrelid IN ('public.conversations'::regclass,'public.conversation_messages'::regclass);
  SELECT p.prosecdef INTO strict_guard
  FROM pg_catalog.pg_proc p
  WHERE p.oid='nexus_private.workflow_chat_guard()'::regprocedure;

  SELECT EXISTS (
    SELECT 1
    FROM nexus_private.workflow_manifest m
    WHERE m.table_name='conversation_messages'
      AND m.definition->'columns' @> '[{"column":"turn_id","bodyField":"turnId","type":"text","nullable":true,"queryable":true},{"column":"session_id","bodyField":"sessionId","type":"text","nullable":true,"queryable":true}]'::jsonb
      AND m.definition->'bodyFields' ?& ARRAY['turnId','sessionId','pendingActionIds']
      AND NOT m.definition ? 'markerColumn'
      AND m.definition->'markerlessV2Discriminators'='[]'::jsonb
  ) INTO message_manifest_valid;

  IF native_columns<>2 OR valid_indexes<>3 OR active_chat_guards<>2
    OR strict_guard IS DISTINCT FROM true OR NOT message_manifest_valid THEN
    RAISE EXCEPTION 'conversation native identity columns, lookup indexes, strict guards, or manifest are incomplete: columns %, indexes %, guards %, security-definer guard %, manifest %',
      native_columns,valid_indexes,active_chat_guards,strict_guard,message_manifest_valid;
  END IF;
END
$case$;
\echo CASE PASS: nullable native identity columns, exact lookup indexes, active strict guards, and manifest projections are installed

DO $case$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM public.conversation_messages
      WHERE id='workflow-pg-conversation-legacy-user'
        AND turn_id='workflow-pg-conversation-legacy-turn'
        AND session_id='workflow-pg-conversation-legacy-session'
        AND payload->>'turnId'='workflow-pg-conversation-legacy-turn'
        AND payload->>'sessionId'='workflow-pg-conversation-legacy-session'
        AND NOT payload ? 'contractVersion'
        AND NOT payload ? 'workflowContractVersion'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.conversation_messages
      WHERE id='workflow-pg-conversation-legacy-assistant'
        AND turn_id IS NULL AND session_id IS NULL
        AND NOT payload ? 'turnId' AND NOT payload ? 'sessionId'
        AND NOT payload ? 'contractVersion'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.conversations
      WHERE id='workflow-pg-conversation-legacy-root'
        AND NOT payload ? 'createdAt' AND row_version=1
    ) THEN
    RAISE EXCEPTION 'explicit historical identity was not backfilled exactly or absent identity/createdAt was inferred';
  END IF;
END
$case$;
\echo CASE PASS: explicit historical turn and session values backfill while missing identities and createdAt remain absent

DO $case$
DECLARE
  before_revision bigint;
  rejected_conversation boolean:=false;
  rejected_message boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.conversations(id,row_version,payload)
    VALUES ('workflow-pg-conversation-invalid-body',1,jsonb_build_object(
      'id','workflow-pg-conversation-invalid-body','actorId','workflow-pg-conversation-actor',
      'rowVersion',1,'title','Invalid body','createdAt','2026-10-04T02:02:00.000Z',
      'fabricatedV2Marker',2));
  EXCEPTION WHEN check_violation THEN
    rejected_conversation:=true;
  END;
  BEGIN
    INSERT INTO public.conversation_messages(id,row_version,payload)
    VALUES ('workflow-pg-conversation-invalid-message-body',1,jsonb_build_object(
      'id','workflow-pg-conversation-invalid-message-body','rowVersion',1,
      'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',
      'role','assistant','text','Invalid message body','mode','scripted_demo','modeRevision',0,
      'createdAt','2026-10-04T02:02:01.000Z','fabricatedV2Marker',2));
  EXCEPTION WHEN check_violation THEN
    rejected_message:=true;
  END;
  IF NOT rejected_conversation OR NOT rejected_message
    OR EXISTS (SELECT 1 FROM public.conversations WHERE id='workflow-pg-conversation-invalid-body')
    OR EXISTS (SELECT 1 FROM public.conversation_messages WHERE id='workflow-pg-conversation-invalid-message-body')
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'strict persisted-body guards accepted an unsupported field or changed row/revision state';
  END IF;
END
$case$;
\echo CASE PASS: conversation and message body guards reject fabricated fields without changing rows or revision

DO $case$
DECLARE
  before_revision bigint;
  turn_contradiction_rejected boolean:=false;
  session_contradiction_rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  BEGIN
    INSERT INTO public.conversation_messages(id,row_version,payload,turn_id) VALUES (
      'workflow-pg-conversation-contradictory-turn',1,jsonb_build_object(
        'id','workflow-pg-conversation-contradictory-turn','rowVersion',1,
        'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',
        'role','assistant','text','Contradictory native projection','mode','scripted_demo','modeRevision',0,
        'createdAt','2026-10-04T02:03:00.000Z','turnId','workflow-pg-conversation-valid-turn',
        'sessionId','workflow-pg-conversation-valid-session'),
      'workflow-pg-conversation-wrong-turn');
  EXCEPTION WHEN check_violation THEN
    turn_contradiction_rejected:=true;
  END;
  BEGIN
    INSERT INTO public.conversation_messages(id,row_version,payload,session_id) VALUES (
      'workflow-pg-conversation-contradictory-session',1,jsonb_build_object(
        'id','workflow-pg-conversation-contradictory-session','rowVersion',1,
        'conversationId','workflow-pg-conversation-legacy-root','actorId','workflow-pg-conversation-actor',
        'role','assistant','text','Contradictory native projection','mode','scripted_demo','modeRevision',0,
        'createdAt','2026-10-04T02:03:01.000Z','turnId','workflow-pg-conversation-valid-turn',
        'sessionId','workflow-pg-conversation-valid-session'),
      'workflow-pg-conversation-wrong-session');
  EXCEPTION WHEN check_violation THEN
    session_contradiction_rejected:=true;
  END;
  IF NOT turn_contradiction_rejected OR NOT session_contradiction_rejected
    OR EXISTS (SELECT 1 FROM public.conversation_messages WHERE id IN (
      'workflow-pg-conversation-contradictory-turn','workflow-pg-conversation-contradictory-session'))
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>before_revision THEN
    RAISE EXCEPTION 'contradictory native turn_id or session_id projection was accepted or left partial state';
  END IF;
END
$case$;
\echo CASE PASS: contradictory native turn_id and session_id projections are rejected independently and atomically

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  conversation_id constant text:='workflow-pg-conversation-legacy-root';
  before_revision bigint;
  after_enrichment_revision bigint;
  returned_revision bigint;
  original_body jsonb;
  enriched_body jsonb;
  before_failed_update jsonb;
  failed_update_rejected boolean:=false;
BEGIN
  SELECT revision INTO before_revision FROM public.appmeta WHERE singleton=1;
  SELECT payload INTO original_body FROM public.conversations WHERE id=conversation_id;
  enriched_body:=original_body || jsonb_build_object(
    'createdAt','2026-10-04T02:04:00.000Z','rowVersion',2);
  SELECT public.nexus_workflow_commit(before_revision,jsonb_build_array(jsonb_build_object(
    'kind','cas','table','conversations','id',conversation_id,
    'expected',jsonb_build_object('rowVersion',1,'state',NULL),
    'next',jsonb_build_object('id',conversation_id,'rowVersion',2,'body',enriched_body)
  ))) INTO returned_revision;
  SELECT revision INTO after_enrichment_revision FROM public.appmeta WHERE singleton=1;
  IF returned_revision<>before_revision+1 OR after_enrichment_revision<>returned_revision
    OR (SELECT payload->>'createdAt' FROM public.conversations WHERE id=conversation_id)<>'2026-10-04T02:04:00.000Z'
    OR (SELECT row_version FROM public.conversations WHERE id=conversation_id)<>2 THEN
    RAISE EXCEPTION 'the one-time historical createdAt enrichment did not commit by expected-version CAS';
  END IF;

  SELECT payload INTO before_failed_update FROM public.conversations WHERE id=conversation_id;
  BEGIN
    PERFORM public.nexus_workflow_commit(after_enrichment_revision,jsonb_build_array(jsonb_build_object(
      'kind','cas','table','conversations','id',conversation_id,
      'expected',jsonb_build_object('rowVersion',2,'state',NULL),
      'next',jsonb_build_object('id',conversation_id,'rowVersion',3,'body',
        before_failed_update || jsonb_build_object('createdAt','2026-10-04T02:05:00.000Z','rowVersion',3))
    )));
  EXCEPTION WHEN check_violation THEN
    failed_update_rejected:=true;
  END;
  IF NOT failed_update_rejected
    OR (SELECT payload FROM public.conversations WHERE id=conversation_id) IS DISTINCT FROM before_failed_update
    OR (SELECT row_version FROM public.conversations WHERE id=conversation_id)<>2
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>after_enrichment_revision THEN
    RAISE EXCEPTION 'createdAt was changed a second time or the rejected CAS changed conversation/revision state';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: historical createdAt accepts one valid enrichment and rejects every later change

SET LOCAL ROLE service_role;
DO $case$
DECLARE
  actor_id constant text:='workflow-pg-conversation-actor';
  conversation_id constant text:='workflow-pg-conversation-rpc-root';
  message_id constant text:='workflow-pg-conversation-rpc-assistant';
  revision_before bigint;
  inserted_revision bigint;
  updated_revision bigint;
  stale_cas_rejected boolean:=false;
  conversation_body jsonb;
  message_body jsonb;
BEGIN
  SELECT revision INTO revision_before FROM public.appmeta WHERE singleton=1;
  conversation_body:=jsonb_build_object(
    'id',conversation_id,'actorId',actor_id,'rowVersion',1,'title','RPC conversation',
    'pinned',false,'createdAt','2026-10-04T02:06:00.000Z','updatedAt','2026-10-04T02:06:00.000Z');
  message_body:=jsonb_build_object(
    'id',message_id,'rowVersion',1,'conversationId',conversation_id,'actorId',actor_id,
    'role','assistant','text','Persisted by the guarded RPC','mode','scripted_demo','modeRevision',0,
    'createdAt','2026-10-04T02:06:01.000Z','turnId','workflow-pg-conversation-rpc-turn',
    'sessionId','workflow-pg-conversation-rpc-session','pendingActionIds',jsonb_build_array());
  SELECT public.nexus_workflow_commit(revision_before,jsonb_build_array(
    jsonb_build_object('kind','insert_unique','table','conversations','constraint','conversations_primary_key',
      'values',jsonb_build_object('id',conversation_id),
      'row',jsonb_build_object('id',conversation_id,'rowVersion',1,'body',conversation_body)),
    jsonb_build_object('kind','insert_unique','table','conversation_messages','constraint','conversation_messages_primary_key',
      'values',jsonb_build_object('id',message_id),
      'row',jsonb_build_object('id',message_id,'rowVersion',1,'body',message_body))
  )) INTO inserted_revision;
  IF inserted_revision<>revision_before+1
    OR (SELECT payload FROM public.conversations WHERE id=conversation_id) IS DISTINCT FROM conversation_body
    OR (SELECT payload FROM public.conversation_messages WHERE id=message_id) IS DISTINCT FROM message_body
    OR (SELECT turn_id FROM public.conversation_messages WHERE id=message_id)<>'workflow-pg-conversation-rpc-turn'
    OR (SELECT session_id FROM public.conversation_messages WHERE id=message_id)<>'workflow-pg-conversation-rpc-session' THEN
    RAISE EXCEPTION 'guarded RPC insert/readback did not persist conversation/message bodies and native identity';
  END IF;

  conversation_body:=conversation_body || jsonb_build_object(
    'rowVersion',2,'title','RPC conversation after CAS','updatedAt','2026-10-04T02:06:02.000Z');
  SELECT public.nexus_workflow_commit(inserted_revision,jsonb_build_array(jsonb_build_object(
    'kind','cas','table','conversations','id',conversation_id,
    'expected',jsonb_build_object('rowVersion',1,'state',NULL),
    'next',jsonb_build_object('id',conversation_id,'rowVersion',2,'body',conversation_body)
  ))) INTO updated_revision;
  IF updated_revision<>inserted_revision+1
    OR (SELECT payload FROM public.conversations WHERE id=conversation_id) IS DISTINCT FROM conversation_body
    OR (SELECT row_version FROM public.conversations WHERE id=conversation_id)<>2 THEN
    RAISE EXCEPTION 'guarded RPC CAS did not return and persist the new conversation version';
  END IF;

  BEGIN
    PERFORM public.nexus_workflow_commit(updated_revision,jsonb_build_array(jsonb_build_object(
      'kind','cas','table','conversations','id',conversation_id,
      'expected',jsonb_build_object('rowVersion',1,'state',NULL),
      'next',jsonb_build_object('id',conversation_id,'rowVersion',2,'body',conversation_body)
    )));
  EXCEPTION WHEN serialization_failure THEN
    stale_cas_rejected:=true;
  END;
  IF NOT stale_cas_rejected
    OR (SELECT revision FROM public.appmeta WHERE singleton=1)<>updated_revision
    OR (SELECT payload FROM public.conversations WHERE id=conversation_id) IS DISTINCT FROM conversation_body
    OR (SELECT row_version FROM public.conversations WHERE id=conversation_id)<>2 THEN
    RAISE EXCEPTION 'stale guarded RPC CAS did not roll back without changing the persisted row or revision';
  END IF;
END
$case$;
RESET ROLE;
\echo CASE PASS: guarded RPC insert, native identity readback, version CAS, and stale-CAS rollback converge correctly

DO $case$
DECLARE
  forward_rows integer;
  forward_digest text;
  predecessor_rows integer;
  manifest_valid boolean;
BEGIN
  SELECT count(*),min(definition_digest) INTO forward_rows,forward_digest
  FROM nexus_private.workflow_projection_migrations
  WHERE id='202610040001_workflow_conversation_persistence';
  SELECT count(*) INTO predecessor_rows
  FROM nexus_private.workflow_projection_migrations
  WHERE id='202610030002_workflow_projection_completeness';
  SELECT EXISTS (
    SELECT 1 FROM nexus_private.workflow_manifest
    WHERE table_name='conversations'
      AND definition->'bodyFields' ?& ARRAY['createdAt','lastAnalysis','lastScope']
      AND NOT definition ? 'markerColumn'
      AND definition->'markerlessV2Discriminators'='[]'::jsonb
  ) AND EXISTS (
    SELECT 1 FROM nexus_private.workflow_manifest
    WHERE table_name='conversation_messages'
      AND definition->'columns' @> '[{"column":"turn_id","bodyField":"turnId","type":"text","nullable":true,"queryable":true},{"column":"session_id","bodyField":"sessionId","type":"text","nullable":true,"queryable":true}]'::jsonb
      AND definition->'bodyFields' ?& ARRAY['turnId','sessionId','pendingActionIds']
      AND NOT definition ? 'markerColumn'
      AND definition->'markerlessV2Discriminators'='[]'::jsonb
  ) INTO manifest_valid;
  IF forward_rows<>1 OR forward_digest !~ '^[a-f0-9]{32}$'
    OR predecessor_rows<>1 OR NOT manifest_valid THEN
    RAISE EXCEPTION 'forward ledger or markerless shared conversation manifest is incomplete: forward rows %, digest %, predecessor rows %, manifest %',
      forward_rows,forward_digest,predecessor_rows,manifest_valid;
  END IF;
END
$case$;
\echo CASE PASS: forward ledger is unique and the preceding completeness history remains installed without a shared-table V2 marker

COMMIT;

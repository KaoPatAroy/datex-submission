'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Actor, Analysis, ConversationMessage, Evidence, Mode, SourceRef, TurnArtifact } from '@/lib/contracts';
import { evidenceWarningText, sourceDisplayName } from '@/lib/presentation/source-names';
import { displayBranchNames } from '@/lib/presentation/branch-names';
import { limitRetailClaims, retailEvidenceCoverage } from '@/lib/packs/retail/coverage';
import { Icon } from '@/components/icons';
import styles from './workspace.module.css';
import WorkCatalog, { catalogSelection, type CatalogEntry, type CatalogViewStatus } from './work-catalog';
import { actorScope } from './product-labels';
import FollowUpPrompts from './follow-up-prompts';
import { ShowcaseCards, ShowcaseChips } from './demo-guide';
import { unsupportedDemoHeading, type ShowcaseItem } from '@/lib/demo/showcase';
import demoStyles from './demo-guide.module.css';
import { ArtifactPreview } from './artifact-preview';
import { ArtifactActions, ClarificationChips, StagedProposalCard } from './router-panels';
import { ReceiptCard } from './router-receipts';
import { composerGuidance, receiptsForMessage, type ConversationReceipt } from './conversation-ui';
import { clarificationChoices, proposalsForTurn, type ArtifactOperation, type RouterProposalView } from './router-ui';
import type { TurnChoice } from '@/lib/contracts';

/** Router-era chat extras. All optional: absent props render nothing extra. */
export type RouterUiProps = {
  proposals: readonly RouterProposalView[];
  onReviewProposal: (proposal: RouterProposalView) => void;
  /** Set when the pending-proposal fetch FAILED (distinct from an empty list). */
  proposalsError?: string | null;
  onRetryProposals?: () => void;
  /** Structured clarification pick: the choice and the assistant message that offered it. */
  onChoose: (message: LocalMessage, choice: TurnChoice) => void;
  onArtifact: (message: LocalMessage, artifact: TurnArtifact, operation: ArtifactOperation) => void;
  artifactBusy?: { artifactId: string; operation: ArtifactOperation } | null;
  artifactNotice?: { artifactId: string; tone: 'ok' | 'error'; text: string } | null;
};

export type LocalMessage = ConversationMessage & {
  local?: true;
  clarification?: boolean;
  evidence?: Evidence;
  sources?: SourceRef[];
  responseAnalysis?: Analysis;
  /** Server-compiled, authorized artifact previews (chart/table/CSV) for this answer. Never client-authored. */
  artifacts?: TurnArtifact[];
  requestKey?: string;
  delivery?: 'waiting' | 'streaming' | 'stopped' | 'interrupted' | 'rejected';
  progress?: string;
};

export type TurnRecovery = {
  message: string;
  conversationId?: string;
  turnId?: string;
  requestKey?: string;
  requestConversationId?: string;
  assistantMessageId?: string;
  partialText?: string;
  interruptedBy?: 'stop' | 'connection';
  recoveryStatus?: 'in_progress' | 'failed' | 'unavailable';
  errorMessage: string;
  startedAt: string;
  previousMessageIds: string[];
  failedResponse: boolean;
  statusChecked: boolean;
};

type Props = {
  messages: LocalMessage[];
  catalog: CatalogEntry[];
  catalogStatus: CatalogViewStatus;
  onCatalogRetry: () => Promise<unknown>;
  businessDate: string;
  pendingCount: number;
  conversationKey: string;
  actor: Actor;
  actorDisplayName: string;
  currentMode: Mode;
  busy: boolean;
  draft: string;
  setDraft: (value: string) => void;
  catalogEntryId?: string;
  onCatalogEntryIdChange?: (catalogEntryId?: string) => void;
  onSend: (message: string) => Promise<boolean>;
  recovery: TurnRecovery | null;
  onRecover: () => void;
  onRefresh: () => void;
  recoveryChecking: boolean;
  onNewQuestion: () => void;
  continueConversation?: boolean;
  rejection: string | null;
  blockedDraft: boolean;
  chatEnabled: boolean;
  suggestionsEnabled: boolean;
  onEvidence: (id: string, sourceTarget?: string) => void;
  onChooseWork: () => void;
  onStop?: () => void;
  renderAction: (message: LocalMessage) => ReactNode;
  completionNotice: { turnId: string; text: string } | null;
  demoGuide?: ReactNode;
  onShowcase: (item: ShowcaseItem) => void;
  onOpenDemoGuide: () => void;
  aiUnavailable: boolean;
  aiUnavailableStatus?: 'unavailable' | 'not_configured';
  onSwitchToDemo: () => void;
  onDismissAIUnavailable: () => void;
  modeBusy: boolean;
  routerUi?: RouterUiProps;
  routerReceipts?: readonly ConversationReceipt[];
};


export function displaySyntheticNames(text: string) {
  return displayBranchNames(text)
    .replace(/\bDemo Employee (\d+)\b/g, (_match, employee: string) => `พนักงานสาธิต ${employee}`);
}

export function sourceDisplayDetail(source: SourceRef) {
  if (source.system === 'hr' && source.detail === 'Synthetic employee lookup snapshot; observedAt uses employee updatedAt metadata.') {
    return 'ข้อมูลพนักงานสังเคราะห์ เวลาที่แสดงอ้างอิงจากเวลาอัปเดตข้อมูลพนักงาน';
  }
  if (source.system === 'hr' && source.detail === 'Synthetic employee lookup snapshot; observedAt is the retrieval time because source updatedAt metadata is unavailable.') {
    return 'ข้อมูลพนักงานสังเคราะห์ เวลาที่แสดงคือเวลาที่ดึงข้อมูล เนื่องจากต้นทางไม่ระบุเวลาอัปเดต';
  }
  return displaySyntheticNames(source.detail);
}

function Claims({ claims, sources, onSource }: { claims: Analysis['facts']; sources: SourceRef[]; onSource: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? claims : claims.slice(0, 4);
  return <>{visible.map((claim, index) => <div className={styles.claim} key={index}><p>{displaySyntheticNames(claim.text)}</p>{claim.sourceIds.length > 0 && <div className={styles.attribution}>อ้างอิงจาก {citationLinks(claim.sourceIds, sources).map((link, sourceIndex) => {
    const separator = sourceIndex > 0 ? ' และ ' : '';
    if (!link.target) return <span key={link.key}>{separator}{link.label}</span>;
    const target = link.target;
    return <span key={link.key}>{separator}<a href={`#${target}`} onClick={(event) => { event.preventDefault(); onSource(target); }}>{link.label}</a></span>;
  })}</div>}</div>)}{claims.length > 4 && <button className="text-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'แสดงน้อยลง' : `ดูทั้งหมด ${claims.length} รายการ`}</button>}</>;
}

/** Display-only citation links: every distinct source record keeps its own link target; only an identical display + target is deduplicated.
 * Several records of one system are numbered ("ยอดขาย", "ยอดขาย (2)") so each link stays distinguishable. Ids and data are unchanged. */
function citationLinks(ids: readonly string[], sources: readonly SourceRef[]) {
  const seen = new Set<string>();
  const perSystem = new Map<string, number>();
  const links: Array<{ key: string; label: string; target: string | null }> = [];
  for (const id of ids) {
    const source = sources.find((entry) => entry.id === id);
    const target = source ? `source-${encodeURIComponent(id)}` : null;
    const name = source ? sourceDisplayName(source.system) : 'ต้นทางที่ยังไม่พร้อม';
    const dedupeKey = `${name}|${target ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!target) { links.push({ key: `missing:${id}`, label: name, target }); continue; }
    const count = (perSystem.get(name) ?? 0) + 1;
    perSystem.set(name, count);
    links.push({ key: id, label: count > 1 ? `${name} (${count})` : name, target });
  }
  return links;
}

function EvidenceSummary({ evidence }: { evidence: Evidence }) {
  const coverage = retailEvidenceCoverage(evidence);
  const number = (value: number, digits = 2) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: digits }).format(value);
  return <><dl className={styles.metricStrip}><div><dt>ยอดขายสุทธิ</dt><dd>{coverage.display.sales ? <>{number(evidence.totals.netSales)} <small>บาท</small></> : 'ข้อมูลไม่ครบ'}</dd></div><div><dt>เป้าหมาย</dt><dd>{coverage.display.target ? <>{number(evidence.totals.target)} <small>บาท</small></> : 'ข้อมูลไม่ครบ'}</dd></div><div><dt>ทำได้</dt><dd>{!coverage.salesComplete || !coverage.targetComplete ? 'เทียบไม่ได้' : evidence.totals.achievement === null ? 'ไม่มีข้อมูล' : coverage.display.achievement ? `${number(evidence.totals.achievement, 1)}%` : 'ข้อมูลไม่ครบ'}</dd></div><div><dt>{coverage.display.gap && evidence.totals.gap < 0 ? 'ต่ำกว่าเป้า' : 'ส่วนต่างจากเป้า'}</dt><dd>{coverage.display.gap ? <>{number(Math.abs(evidence.totals.gap))} <small>บาท</small></> : 'เทียบไม่ได้'}</dd></div></dl><p className={styles.evidenceScope}>{({ all: 'ทุกภูมิภาค', east: 'ภาคตะวันออก', central: 'ภาคกลาง', south: 'ภาคใต้' } as Record<string, string>)[evidence.scope.region] ?? evidence.scope.region} · {evidence.branches.length} สาขา · ข้อมูล ณ {new Date(evidence.asOf).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</p>{evidence.warnings.length > 0 && <p className={styles.evidenceScope}>หลักฐานมีข้อจำกัด {evidence.warnings.length} รายการ · อ่านรายละเอียดหลังคำตอบ</p>}</>;
}

function InlineEvidence({ message, onSource }: { message: LocalMessage; onSource: (target: string) => void }) {
  const evidence = message.evidence;
  const analysis = message.responseAnalysis ?? message.analysis;
  const visibleAnalysis = evidence && analysis ? limitRetailClaims(evidence, analysis) : analysis;
  const sources = evidence?.sources ?? message.sources ?? [];
  const groups = visibleAnalysis ? [
    { key: 'facts', label: 'ข้อเท็จจริง', icon: 'check', claims: visibleAnalysis.facts },
    { key: 'relationships', label: 'ความเชื่อมโยง', icon: 'branch', claims: visibleAnalysis.relationships },
    { key: 'hypotheses', label: 'ข้อสันนิษฐาน', icon: 'spark', claims: visibleAnalysis.hypotheses },
    { key: 'missing', label: 'หลักฐานที่ยังขาด', icon: 'alert', claims: visibleAnalysis.missingEvidence },
  ] : [];
  return <>{groups.map((group) => <details className={styles.claimGroup} key={`${message.id}-${group.key}`} open={group.key === 'facts'}><summary><Icon name={group.icon} size={16} /><strong>{group.label}</strong><span>{group.claims.length}</span></summary>{group.claims.length ? <Claims claims={group.claims} sources={sources} onSource={onSource} /> : <p className={styles.evidenceScope}>ยังไม่มีรายการในหมวดนี้</p>}</details>)}</>;
}

export default function ChatThread(props: Props) {
  const { messages, busy, draft, setDraft, recovery, recoveryChecking, chatEnabled } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followingRef = useRef(true);
  const presentedTurnRef = useRef<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const last = messages.at(-1);
  const empty = messages.length === 0;
  const suggestionAuthority = JSON.stringify([props.actor.id, props.actor.sessionId, props.actor.role, props.actor.active, [...props.actor.regions].sort(), [...props.actor.permissions].sort(), props.actor.mode, props.actor.modeRevision]);
  const announcement = busy ? last?.progress || 'กำลังตรวจคำขอ…' : recoveryChecking ? 'กำลังตรวจสถานะคำขอเดิม…' : last?.delivery === 'stopped' ? 'หยุดการตอบแล้ว คำตอบนี้อาจยังไม่สมบูรณ์' : last?.delivery === 'interrupted' ? 'การตอบถูกขัดจังหวะ ข้อความนี้อาจยังไม่สมบูรณ์' : props.completionNotice && last?.turnId === props.completionNotice.turnId ? `คำตอบจาก DaTex: ${displaySyntheticNames(props.completionNotice.text)}` : '';

  useEffect(() => {
    followingRef.current = true;
    const container = scrollRef.current;
    if (container) container.scrollTop = empty ? 0 : container.scrollHeight;
  }, [props.conversationKey, empty]);

  useEffect(() => {
    const container = scrollRef.current;
    const reading = readingRef.current;
    if (!container || !reading) return;
    const follow = () => {
      if (empty) container.scrollTop = 0;
      else if (followingRef.current) container.scrollTop = container.scrollHeight;
      else setShowLatest(container.scrollHeight - container.scrollTop - container.clientHeight > 80);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(reading);
    follow();
    return () => observer.disconnect();
  }, [empty]);

  useEffect(() => {
    const notice = props.completionNotice;
    if (!notice || busy || last?.delivery || last?.turnId !== notice.turnId || presentedTurnRef.current === notice.turnId) return;
    presentedTurnRef.current = notice.turnId;
    const container = scrollRef.current;
    const answer = readingRef.current?.querySelector<HTMLElement>('[data-message-role="assistant"]:last-child');
    // A reader who scrolled away keeps their place. Otherwise start at the conclusion,
    // rather than the bottom of a long answer's facts and disclosures.
    if (container && answer && followingRef.current) {
      followingRef.current = false;
      container.scrollTop += answer.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      setShowLatest(container.scrollHeight - container.scrollTop - container.clientHeight > 80);
    }
  }, [props.completionNotice, busy, last?.delivery, last?.turnId]);

  function jumpToLatest() {
    followingRef.current = true;
    setShowLatest(false);
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy || !chatEnabled || recovery || props.blockedDraft) return;
    jumpToLatest();
    await props.onSend(message);
  }

  function prefill(value: string) {
    if (busy || recovery || recoveryChecking || !chatEnabled) return;
    props.onCatalogEntryIdChange?.(undefined);
    setDraft(value);
    composerRef.current?.focus();
  }

  function prefillCatalog(entry: CatalogEntry) {
    if (busy || recovery || recoveryChecking || !chatEnabled) return;
    const selection = catalogSelection(entry);
    props.onCatalogEntryIdChange?.(selection.catalogEntryId);
    setDraft(selection.message);
    composerRef.current?.focus();
  }

  return <section className={styles.chatThread} data-empty={empty} aria-label="บทสนทนากับ DaTex">
    <div className={styles.srOnly} role="status" aria-label="สถานะคำตอบ" aria-live="polite" aria-atomic="true">{announcement}</div>
    <div className={styles.conversationScroll} ref={scrollRef} onScroll={() => {
      const container = scrollRef.current;
      if (!container) return;
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      followingRef.current = nearBottom;
      setShowLatest(!empty && !nearBottom);
    }}>
      <div className={styles.reading} ref={readingRef}>
        {props.demoGuide}
        {messages.length === 0 && <div className={styles.chatEmpty}>
          <h1>วันนี้มีเรื่องไหนให้ช่วย?</h1>
          <p>ค้นข้อมูล วิเคราะห์ และเตรียมงานให้ตรวจสอบก่อนยืนยัน</p>
          <div className={styles.emptyScope}><span>{actorScope(props.actor)}</span>{props.pendingCount > 0 && <span>รอตรวจและยืนยัน {props.pendingCount} รายการ</span>}{props.currentMode === 'scripted_demo' && <button className={styles.emptyGuide} type="button" onClick={props.onOpenDemoGuide}>คู่มือโหมดสาธิต</button>}</div>
          <div className={styles.suggestions} aria-label="คำถามแนะนำ">{props.currentMode === 'scripted_demo' ? (!props.demoGuide && <ShowcaseCards role={props.actor.role} disabled={busy || Boolean(recovery) || !chatEnabled || props.modeBusy} onTry={props.onShowcase} />) : <WorkCatalog status={props.catalogStatus} onRetry={props.onCatalogRetry} entries={props.catalog} featured disabled={busy || Boolean(recovery) || !chatEnabled} onSelect={prefillCatalog} />}</div>
        </div>}
        {messages.map((message) => {
          const assistant = message.role === 'assistant';
          const complete = !message.delivery;
          const hasEvidence = complete && (message.evidence || message.responseAnalysis || message.analysis || message.sources?.length);
          const text = assistant ? displaySyntheticNames(message.text) : message.text;
          const paragraphBreak = assistant && complete && message.evidence ? /\r?\n\s*\r?\n/.exec(text) : null;
          const lead = paragraphBreak ? text.slice(0, paragraphBreak.index) : text;
          const continuation = paragraphBreak ? text.slice(paragraphBreak.index + paragraphBreak[0].length) : '';
          return <article key={message.id} className={assistant ? styles.assistantMessage : styles.userMessage} data-message-id={message.id} data-message-role={message.role} data-delivery={message.delivery ?? 'complete'} data-turn-id={message.turnId} aria-label={assistant ? 'คำตอบจาก DaTex' : 'ข้อความของคุณ'}>
            {assistant && <div className={styles.assistantLabel}><span className={styles.smallBrand}><Icon name="nexus" size={15} /></span><strong>DaTex</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</time>{message.mode === 'scripted_demo' && <span className={styles.demoLabel}>โหมดสาธิต</span>}</div>}
            {message.text && <div className={assistant ? styles.assistantText : styles.userBubble} data-answer-lead={assistant ? '' : undefined}>{lead}</div>}
            {assistant && complete && message.evidence && <EvidenceSummary evidence={message.evidence} />}
            {continuation && <div className={styles.assistantText} data-answer-continuation>{continuation}</div>}
            {assistant && complete && message.artifacts?.map(item => <div key={`${item.id}:${item.revision}`}><ArtifactPreview spec={item.spec} {...(message.local ? {} : { drillUrl: (field: string, value: string) => `/api/artifacts/${encodeURIComponent(item.id)}/drilldown?revision=${item.revision}&field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}` })} />{props.routerUi && !message.local && <ArtifactActions artifact={item} busy={props.routerUi.artifactBusy?.artifactId === item.id ? props.routerUi.artifactBusy.operation : null} notice={props.routerUi.artifactNotice?.artifactId === item.id ? props.routerUi.artifactNotice : null} onAction={(artifact, operation) => props.routerUi?.onArtifact(message, artifact, operation)} />}</div>)}
            {assistant && complete && message.receiptCards?.map((card, index) => <ReceiptCard key={`${message.id}:receipt:${index}`} item={{ id: `${message.id}:receipt:${index}`, actionId: 'dashboard.manage', completedAt: Date.parse(card.verifiedAt) || 0, receipt: card }} />)}
            {assistant && complete && props.routerReceipts && receiptsForMessage(message, props.routerReceipts).map(item => <ReceiptCard key={item.id} item={item} />)}
            {assistant && complete && Boolean(message.evidence?.warnings.length) && <div className={styles.incomplete} data-evidence-warnings><strong>หลักฐานมีข้อจำกัด</strong><ul>{message.evidence?.warnings.map((warning, index) => <li key={index}>{evidenceWarningText(warning)}</li>)}</ul></div>}
            {assistant && (message.delivery === 'waiting' || message.delivery === 'streaming') && <p className={styles.progress}><span className={styles.progressDot} aria-hidden="true" />{message.progress || 'กำลังตรวจคำขอ…'}</p>}
            {assistant && message.delivery === 'stopped' && <div className={styles.incomplete}><strong>หยุดการตอบแล้ว</strong><p>คำตอบนี้อาจยังไม่สมบูรณ์</p></div>}
            {assistant && message.delivery === 'interrupted' && <div className={styles.incomplete}><strong>การตอบถูกขัดจังหวะ</strong><p>ข้อความนี้อาจยังไม่สมบูรณ์<br />ตรวจสถานะคำขอเดิมก่อนสรุปผล</p></div>}
            {assistant && message.delivery === 'rejected' && <div className={styles.incomplete}><strong>ยังส่งคำขอนี้ไม่ได้</strong><p>{message.progress}</p></div>}
            {assistant && hasEvidence && <div className={styles.inlineEvidence}><InlineEvidence message={message} onSource={(target) => props.onEvidence(message.id, target)} /><button className={`text-button ${styles.messageDetails}`} type="button" onClick={() => props.onEvidence(message.id)}><Icon name="book" size={15} /> รายละเอียดแหล่งข้อมูล</button></div>}
            {assistant && !hasEvidence && <button className="text-button" type="button" onClick={() => props.onEvidence(message.id)}><Icon name="book" size={15} />ดูรายละเอียดคำตอบ</button>}
            {assistant && complete && props.routerUi?.proposalsError && last?.id === message.id && <div className="error-banner" role="alert" data-staged-load-error>{props.routerUi.proposalsError}{props.routerUi.onRetryProposals && <> <button className="btn btn-small" type="button" onClick={props.routerUi.onRetryProposals}>ลองอีกครั้ง</button></>}</div>}
            {assistant && complete && props.routerUi && proposalsForTurn(props.routerUi.proposals, message.turnId).map(item => <StagedProposalCard key={item.id} proposal={item} onReview={props.routerUi!.onReviewProposal} disabled={busy} />)}
            {assistant && complete && props.routerUi && <ClarificationChips choices={clarificationChoices(message, last?.id === message.id)} disabled={busy || Boolean(recovery) || recoveryChecking || !chatEnabled} onChoose={choice => props.routerUi?.onChoose(message, choice)} />}
            {assistant && complete && message.hint === 'switch_to_demo' && props.currentMode === 'live_ai' && last?.id === message.id && <div className={styles.recoveryActions} data-switch-to-demo><button className="btn btn-small btn-primary" type="button" disabled={busy || props.modeBusy || Boolean(recovery)} onClick={props.onSwitchToDemo}>สลับเป็นโหมดสาธิต</button></div>}
            {assistant && complete && props.renderAction(message)}
            {assistant && complete && message.mode === 'scripted_demo' && props.currentMode === 'scripted_demo' && message.text.startsWith(unsupportedDemoHeading) && <ShowcaseChips role={props.actor.role} disabled={busy || Boolean(recovery) || !chatEnabled || props.modeBusy} onSelect={item => props.onShowcase(item)} />}
            {assistant && complete && last?.id === message.id && !busy && !recovery && !recoveryChecking && chatEnabled && props.suggestionsEnabled && props.actor.active && <FollowUpPrompts key={`${suggestionAuthority}:${message.conversationId}:${message.id}`} conversationId={message.conversationId} afterMessageId={message.id} onSelect={prefill} />}
          </article>;
        })}
      </div>
    </div>
    <div className={styles.composerRegion}>
      {props.currentMode === 'live_ai' && props.aiUnavailable && <div className={demoStyles.availability} role="status" aria-label="Live AI ไม่พร้อมใช้งาน"><p>{props.aiUnavailableStatus === 'not_configured' ? 'Live AI ยังไม่ได้เปิดใช้งานในระบบนี้ คุณสามารถลองโหมดสาธิตด้วยข้อมูลตัวอย่างได้' : 'Live AI ยังตอบไม่ได้ในขณะนี้ คุณสามารถลองโหมดสาธิตด้วยข้อมูลตัวอย่างได้'}</p><div><button className="btn btn-small btn-primary" type="button" disabled={busy || props.modeBusy || recoveryChecking || Boolean(recovery && (!recovery.statusChecked || recovery.recoveryStatus !== 'failed'))} aria-describedby={recovery && (!recovery.statusChecked || recovery.recoveryStatus !== 'failed') ? 'availability-recovery-reason' : undefined} onClick={props.onSwitchToDemo}>สลับเป็นโหมดสาธิต</button>{recovery && (!recovery.statusChecked || recovery.recoveryStatus !== 'failed') && <span id="availability-recovery-reason">ตรวจสถานะคำขอเดิมก่อน หากระบบยืนยันว่าคำขอล้มเหลวแล้ว จึงเปลี่ยนโหมดได้</span>}<button className="btn btn-small" type="button" onClick={props.onDismissAIUnavailable}>ปิดไปก่อน</button></div></div>}
      {!empty && showLatest && <div className={styles.latestRow}><button className={styles.latestButton} type="button" onClick={jumpToLatest}><Icon name="arrow" size={14} />ไปข้อความล่าสุด</button></div>}
      {recovery && <div className={styles.recovery} role="status"><strong>ตรวจสถานะคำขอเดิมก่อนส่งอีกครั้ง</strong><p>{recovery.errorMessage}</p><div className={styles.recoveryActions}><button className="btn btn-small" type="button" disabled={recoveryChecking || busy} onClick={props.onRefresh}>{recoveryChecking ? 'กำลังตรวจสถานะ…' : 'ตรวจสถานะคำขอเดิม'}</button>{!recovery.requestKey && recovery.turnId && recovery.statusChecked && <button className="btn btn-small" type="button" disabled={busy || recoveryChecking} onClick={props.onRecover}>{props.currentMode === 'live_ai' ? 'สลับโหมดสาธิตและกู้คืน' : 'กู้คืนคำขอเดิม'}</button>}{recovery.statusChecked && (recovery.requestKey ? recovery.recoveryStatus === 'failed' : !recovery.turnId) && <button className="btn btn-small" type="button" disabled={busy || recoveryChecking} onClick={props.onNewQuestion}>{props.continueConversation ? 'ถามต่อในบทสนทนาเดิม' : 'เริ่มคำถามใหม่'}</button>}</div></div>}
      {props.rejection && <div className={styles.recovery} role="alert"><strong>ยังส่งคำขอนี้ไม่ได้</strong><p>{props.rejection}</p></div>}
      <form className={styles.composer} onSubmit={submit}>
        <textarea ref={composerRef} data-chat-composer aria-label="ข้อความถึง DaTex" placeholder={chatEnabled ? 'พิมพ์คำถาม หรือระบุรายการที่ต้องการให้เตรียม…' : 'โปรไฟล์นี้ยังไม่มีสิทธิ์ใช้ผู้ช่วย'} value={draft} onChange={(event) => { props.onCatalogEntryIdChange?.(undefined); setDraft(event.target.value); }} disabled={!chatEnabled || Boolean(recovery)} rows={2} maxLength={8000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && !recovery && !props.blockedDraft) event.currentTarget.form?.requestSubmit(); } }} />
        <div className={styles.composerBottom}><button className={styles.chooseWork} type="button" disabled={busy || Boolean(recovery)} onClick={props.onChooseWork}><Icon name="grid" size={17} />ดูงานที่ทำได้</button><div className={styles.sendGroup}>{busy ? <button className="btn" type="button" onClick={props.onStop} disabled={!props.onStop}><span className={styles.stopMark} aria-hidden="true" />หยุดการตอบ</button> : <button className="btn btn-primary" type="submit" disabled={!chatEnabled || Boolean(recovery) || props.blockedDraft || !draft.trim()}><Icon name="send" size={17} />ส่ง</button>}</div></div>
      </form>
      <div className={styles.composerTip}><span>{props.blockedDraft ? 'ไม่ส่งคำขอเดิมซ้ำ โปรดพิมพ์คำถามใหม่' : composerGuidance}</span><span>Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่</span></div>
    </div>
  </section>;
}

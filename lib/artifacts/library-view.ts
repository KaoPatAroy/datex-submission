/**
 * Client-safe view model of the Results library (no server imports). A Result is one artifact with its immutable revisions;
 * the library only adds display metadata (title, pin, archive) that never touches an evidence version.
 */
export const RESULT_KIND_LABEL: Record<string, string> = {
  table: 'ตาราง', ranking: 'ตารางอันดับ', chart: 'กราฟ', executive_brief: 'สรุปสำหรับผู้บริหาร', csv_export: 'ไฟล์ CSV',
};
/** The type filter groups the five registered artifact kinds under the user-facing names (Chart, Table, Ranking, Executive Brief, CSV). */
export const RESULT_KINDS = ['chart', 'table', 'ranking', 'executive_brief', 'csv_export'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];
export type ResultSection = 'saved' | 'recent' | 'archived';

export interface ResultItem {
  id: string;
  /** What the library shows: the owner's display title, else the title the version was made with. */
  title: string;
  originalTitle: string;
  renamed: boolean;
  kind: ResultKind;
  latestRevision: number;
  revisions: number[];
  savedRevision: number | null;
  savedAt: string | null;
  /** The owner has saved SOME revision (Saved collection identity). Does NOT mean the latest revision is saved: see `latestSaved`. */
  saved: boolean;
  /** The latest revision is the saved one. false + saved = a newer draft exists beside the saved revision. */
  latestSaved: boolean;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
  /** Conversation the Result came from (title only; never an id). */
  origin: string | null;
  /** The owner's own origin conversation (set only when it still exists and is theirs): lets the UI open it. Navigation only, never displayed. */
  originConversationId?: string | null;
  section: ResultSection;
}

export type ResultSort = 'newest' | 'oldest';
/** One bounded server page of the library. `total` counts the items matching the filter (archive/status/search are applied BEFORE paging). */
export interface ResultsPage { items: ResultItem[]; total: number; limit: number; nextCursor: string | null;
  /** true when the owner holds more Results than the server scans for one listing; `total` is then a lower bound. */
  truncated: boolean }
export const RESULTS_PAGE_LIMIT = 50;
export interface ResultFilter { query?: string; kind?: ResultKind | 'all'; section?: ResultSection | 'all'; sort?: ResultSort }

/**
 * Which owner controls a Result card offers. PC-10: share management (list + revoke an exact grant) stays available for an ARCHIVED Result,
 * which can still hold active shares; new shares and Dashboard adds are only offered for active Results.
 */
export function resultCardActions(item: Pick<ResultItem, 'kind' | 'archived'>): { share: boolean; addToDashboard: boolean; manageShares: boolean } {
  return { share: !item.archived && ['chart', 'table', 'ranking', 'executive_brief'].includes(item.kind),
    addToDashboard: !item.archived && ['chart', 'table', 'ranking'].includes(item.kind), manageShares: true };
}

/** Plain case-insensitive text match over the owner's own metadata (title, original title, type name, origin). Not an intent parser. */
export function matchesQuery(item: ResultItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('th-TH');
  if (!needle) return true;
  return [item.title, item.originalTitle, RESULT_KIND_LABEL[item.kind] ?? item.kind, item.origin ?? ''].some(text => text.toLocaleLowerCase('th-TH').includes(needle));
}

/** Filter + order: pinned first, then by time (newest by default). Pure and shared by the UI and tests. */
export function filterResults(items: readonly ResultItem[], filter: ResultFilter = {}): ResultItem[] {
  const direction = filter.sort === 'oldest' ? 1 : -1;
  return items
    .filter(item => (filter.kind ?? 'all') === 'all' || item.kind === filter.kind)
    .filter(item => (filter.section ?? 'all') === 'all' || item.section === filter.section)
    .filter(item => matchesQuery(item, filter.query ?? ''))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || direction * a.updatedAt.localeCompare(b.updatedAt));
}

/** Recent Results are grouped by calendar day relative to `now` (caller passes a date in the viewer's time zone). */
export function dayGroup(updatedAt: string, now: Date): 'today' | 'yesterday' | 'older' {
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) return 'older';
  const diff = Math.round((day(now) - day(updated)) / 86_400_000);
  return diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : 'older';
}

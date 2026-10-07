import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVERSATION_TITLE, isDefaultConversationTitle, MAX_CONVERSATION_TITLE_LENGTH, titleFromFirstMessage } from '../lib/core/conversations';

describe('titleFromFirstMessage', () => {
  it('collapses whitespace and keeps short text intact', () => {
    expect(titleFromFirstMessage('  ยอดขาย\n  ภาคตะวันออก  วันนี้ ')).toBe('ยอดขาย ภาคตะวันออก วันนี้');
  });
  it('returns undefined for blank input', () => {
    expect(titleFromFirstMessage(' \n\t ')).toBeUndefined();
  });
  it('truncates by code points with an ellipsis within the max length', () => {
    const title = titleFromFirstMessage('ก'.repeat(300))!;
    expect([...title]).toHaveLength(MAX_CONVERSATION_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('ก'.repeat(MAX_CONVERSATION_TITLE_LENGTH - 1) + '…');
  });
  it('never splits a surrogate pair and satisfies the 120-unit schema bound', () => {
    const title = titleFromFirstMessage('😀'.repeat(200))!;
    expect(title.length).toBeLessThanOrEqual(MAX_CONVERSATION_TITLE_LENGTH);
    expect(title).toBe(title.trim());
    expect([...title].every(point => point === '😀' || point === '…')).toBe(true);
  });
  it('leaves exactly-max text without an ellipsis', () => {
    expect(titleFromFirstMessage('a'.repeat(MAX_CONVERSATION_TITLE_LENGTH))).toBe('a'.repeat(MAX_CONVERSATION_TITLE_LENGTH));
  });
});

describe('isDefaultConversationTitle', () => {
  it('only treats unset or default titles as replaceable', () => {
    expect(isDefaultConversationTitle(undefined)).toBe(true);
    expect(isDefaultConversationTitle('')).toBe(true);
    expect(isDefaultConversationTitle(DEFAULT_CONVERSATION_TITLE)).toBe(true);
    expect(isDefaultConversationTitle('My rename')).toBe(false);
  });
});

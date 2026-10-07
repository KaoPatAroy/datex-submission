import { describe, expect, it } from 'vitest';
import { catalogSelection } from '../components/biztania/work-catalog';

describe('work-catalog selection', () => {
  it('keeps the server catalog id beside the unchanged composer text', () => {
    expect(catalogSelection({ id: 'retail.sales-analysis', prompt: 'Review sales as written.' })).toEqual({
      message: 'Review sales as written.',
      catalogEntryId: 'retail.sales-analysis',
    });
  });
});

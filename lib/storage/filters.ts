export type RowFilter = Record<string, string | string[]>;

const FILTER_KEYS = new Set([
  'id',
  'branchId',
  'date',
  'region',
  'actorId',
  'ownerId',
  'sessionId',
  'conversationId',
  'recipientId',
  'dashboardId',
  'employeeId',
  'operationKey',
  'status'
]);
export const MAX_FILTER_VALUES = 1_000;
const MAX_FILTER_VALUE_LENGTH = 300;

export function validateRowFilter(input: unknown): RowFilter | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Store filter must be an object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Store filter must be a plain object');

  const normalized: RowFilter = Object.create(null) as RowFilter;
  let totalValues = 0;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !FILTER_KEYS.has(key)) throw new Error('Store filter contains an unsupported field');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('Store filter values must be data properties');
    const value: unknown = descriptor.value;
    if (typeof value === 'string') {
      if (value.length > MAX_FILTER_VALUE_LENGTH) throw new Error('Store filter value exceeds the length limit');
      totalValues += 1;
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > MAX_FILTER_VALUES) throw new Error('Store filter contains too many values');
      const values: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') throw new Error('Store filter values must be strings');
        if (item.length > MAX_FILTER_VALUE_LENGTH) throw new Error('Store filter value exceeds the length limit');
        values.push(item);
      }
      totalValues += values.length;
      normalized[key] = values;
    } else {
      throw new Error('Store filter values must be strings or string arrays');
    }
    if (totalValues > MAX_FILTER_VALUES) throw new Error('Store filter contains too many values');
  }
  return normalized;
}

export function hasEmptyFilterValue(filter: RowFilter | undefined): boolean {
  return Boolean(filter && Object.values(filter).some((value) => Array.isArray(value) && value.length === 0));
}

export function matchesValidatedRowFilter(row: unknown, filter: RowFilter | undefined): boolean {
  if (!filter) return true;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
  const record = row as Record<string, unknown>;
  for (const [key, expected] of Object.entries(filter)) {
    if (Array.isArray(expected)) {
      if (expected.length === 0 || typeof record[key] !== 'string' || !expected.includes(record[key] as string)) return false;
    } else if (record[key] !== expected) {
      return false;
    }
  }
  return true;
}

export function matchesRowFilter(row: unknown, input: unknown): boolean {
  return matchesValidatedRowFilter(row, validateRowFilter(input));
}

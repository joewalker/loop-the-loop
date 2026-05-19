import type { BugzillaTask } from '../bugzilla.js';
import {
  assertKnownProperties,
  assertOptionalBoolean,
  assertOptionalString,
  assertOptionalStringArray,
  assertRequiredString,
  isRecord,
} from '../util/config.js';

/**
 * Normalize Bugzilla task config values loaded from JSON.
 */
export function normalizeBugzillaTaskConfig(config: unknown): BugzillaTask {
  assertBugzillaTaskConfig(config);

  return {
    ...config,
    search: normalizeBugzillaSearchParams(config.search),
  };
}

/**
 * Assert that an unknown value has the runtime shape required for a Bugzilla
 * task config.
 */
function assertBugzillaTaskConfig(
  value: unknown,
): asserts value is BugzillaTask {
  if (!isRecord(value)) {
    throw new Error('bugzilla task config must be an object');
  }

  if (
    !('promptTemplate' in value) ||
    typeof value['promptTemplate'] !== 'string'
  ) {
    throw new Error('bugzilla.promptTemplate must be a string');
  }

  const search = value['search'];
  if (!isRecord(search)) {
    throw new Error('bugzilla.search must be an object');
  }

  assertBugzillaSearchParams(search);
}

/**
 * Normalize Bugzilla search parameters loaded from JSON.
 */
function normalizeBugzillaSearchParams(
  search: BugzillaTask['search'],
): BugzillaTask['search'] {
  if (search.change === undefined) {
    return search;
  }

  return {
    ...search,
    change: {
      ...search.change,
      from: parseDateField(search.change.from, 'search.change.from'),
      to: parseDateField(search.change.to, 'search.change.to'),
    },
  };
}

/**
 * Assert that Bugzilla search params loaded from config use the expected
 * runtime field shapes.
 */
function assertBugzillaSearchParams(search: Record<string, unknown>): void {
  assertKnownProperties(
    search,
    // Keep this list in sync with SearchParams in bugzilla-types.ts and the
    // bugzillaSearchParams schema definition.
    [
      'advanced',
      'assignedTo',
      'bugFields',
      'bugSeverity',
      'bugStatus',
      'change',
      'components',
      'dryRun',
      'ids',
      'keywords',
      'logQuery',
      'product',
    ],
    'bugzilla.search',
  );

  assertOptionalBoolean(search, 'dryRun', 'bugzilla.search.dryRun');
  assertOptionalBoolean(search, 'logQuery', 'bugzilla.search.logQuery');
  assertOptionalString(search, 'product', 'bugzilla.search.product');
  assertOptionalString(search, 'assignedTo', 'bugzilla.search.assignedTo');
  assertOptionalPositiveIntegerArray(search, 'ids', 'bugzilla.search.ids');
  assertOptionalStringArray(search, 'components', 'bugzilla.search.components');
  assertOptionalStringArray(search, 'bugStatus', 'bugzilla.search.bugStatus');
  assertOptionalStringArray(search, 'keywords', 'bugzilla.search.keywords');
  assertOptionalStringArray(
    search,
    'bugSeverity',
    'bugzilla.search.bugSeverity',
  );
  assertOptionalStringArray(search, 'bugFields', 'bugzilla.search.bugFields');

  if ('advanced' in search) {
    assertBugzillaAdvancedClauses(search['advanced']);
  }

  if ('change' in search) {
    assertBugzillaChangeClause(search['change']);
  }
}

/**
 * Assert that an optional object property is an array of positive integers.
 */
function assertOptionalPositiveIntegerArray(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) {
    return;
  }

  const array = value[key];
  // v8 ignore start
  if (!Array.isArray(array)) {
    throw new Error(`${field} must be an array of positive integers`);
  }
  // v8 ignore end

  const someNotInts = array.some(item => {
    return typeof item !== 'number' || !Number.isInteger(item) || item < 1;
  });
  if (someNotInts) {
    throw new Error(`${field} must be an array of positive integers`);
  }
}

/**
 * Assert that a Bugzilla advanced search value is an array of valid clauses.
 */
function assertBugzillaAdvancedClauses(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('bugzilla.search.advanced must be an array');
  }

  value.forEach((clause, index) => {
    const prefix = `bugzilla.search.advanced[${index}]`;
    if (!isRecord(clause)) {
      throw new Error(`${prefix} must be an object`);
    }

    assertKnownProperties(clause, ['field', 'matchType', 'value'], prefix);
    assertRequiredString(clause, 'field', `${prefix}.field`);
    assertRequiredString(clause, 'matchType', `${prefix}.matchType`);
    assertRequiredString(clause, 'value', `${prefix}.value`);
  });
}

/**
 * Assert that a Bugzilla change search value is a valid clause.
 */
function assertBugzillaChangeClause(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('bugzilla.search.change must be an object');
  }

  assertKnownProperties(
    value,
    ['field', 'from', 'to', 'value'],
    'bugzilla.search.change',
  );
  assertRequiredString(value, 'field', 'bugzilla.search.change.field');
  assertRequiredDateField(value, 'from', 'bugzilla.search.change.from');
  assertRequiredDateField(value, 'to', 'bugzilla.search.change.to');
  assertRequiredString(value, 'value', 'bugzilla.search.change.value');
}

/**
 * Assert that an object property is a Date or a string parseDateField can
 * validate later.
 */
function assertRequiredDateField(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) {
    throw new Error(`${field} must be a yyyy-MM-dd date string`);
  }

  const fieldValue = value[key];
  if (!(fieldValue instanceof Date) && typeof fieldValue !== 'string') {
    throw new Error(`${field} must be a yyyy-MM-dd date string`);
  }
}

/**
 * Parse a JSON date field as a UTC yyyy-MM-dd date.
 */
function parseDateField(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }

  // istanbul ignore if
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a yyyy-MM-dd date string`);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    throw new Error(
      `${field} must be a valid yyyy-MM-dd date string: ${value}`,
    );
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `${field} must be a valid yyyy-MM-dd date string: ${value}`,
    );
  }

  return date;
}

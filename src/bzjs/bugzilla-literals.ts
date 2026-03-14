export const BugStatus = Object.freeze({
  unconfirmed: 'UNCONFIRMED',
  new: 'NEW',
  assigned: 'ASSIGNED',
  reopened: 'REOPENED',
  resolved: 'RESOLVED',
  verified: 'VERIFIED',
  closed: 'CLOSED',
} as const);

export type BugStatusEnum = (typeof BugStatus)[keyof typeof BugStatus];

export const MatchType = Object.freeze({
  /** is equal to */
  equals: 'equals',
  /** is not equal to */
  notequals: 'notequals',
  /** is equal to any of the strings */
  anyexact: 'anyexact',
  /** contains the string */
  substring: 'substring',
  /** contains the string (exact case) */
  casesubstring: 'casesubstring',
  /** does not contain the string */
  notsubstring: 'notsubstring',
  /** contains any of the strings */
  anywordssubstr: 'anywordssubstr',
  /** contains all of the strings */
  allwordssubstr: 'allwordssubstr',
  /** contains none of the strings */
  nowordssubstr: 'nowordssubstr',
  /** matches regular expression */
  regexp: 'regexp',
  /** does not match regular expression */
  notregexp: 'notregexp',
  /** is less than */
  lessthan: 'lessthan',
  /** is less than or equal to */
  lessthaneq: 'lessthaneq',
  /** is greater than */
  greaterthan: 'greaterthan',
  /** is greater than or equal to */
  greaterthaneq: 'greaterthaneq',
  /** contains any of the words */
  anywords: 'anywords',
  /** contains all of the words */
  allwords: 'allwords',
  /** contains none of the words */
  nowords: 'nowords',
  /** ever changed */
  everchanged: 'everchanged',
  /** changed before */
  changedbefore: 'changedbefore',
  /** changed after */
  changedafter: 'changedafter',
  /** changed from */
  changedfrom: 'changedfrom',
  /** changed to */
  changedto: 'changedto',
  /** changed by */
  changedby: 'changedby',
  /** matches */
  matches: 'matches',
  /** does not match */
  notmatches: 'notmatches',
  /** is empty */
  isempty: 'isempty',
  /** is not empty */
  isnotempty: 'isnotempty',
} as const);

export type MatchTypeEnum = (typeof MatchType)[keyof typeof MatchType];

export const CF = Object.freeze({
  Empty: '---',
  Yes: 'yes',
} as const);

export type CFValue = (typeof CF)[keyof typeof CF];

export const CFQAWhiteboard = Object.freeze({
  Empty: '',
  QANotActionable: 'qa-not-actionable',
  QATriaged: '[qa-triaged]',
} as const);

export type CFQAWhiteboardValue =
  (typeof CFQAWhiteboard)[keyof typeof CFQAWhiteboard];

export const CFStatus = Object.freeze({
  Affected: 'affected',
  Empty: '---',
  Wontfix: 'wontfix',
  Unaffected: 'unaffected',
  Fixed: 'fixed',
} as const);

export type CFStatusValue = (typeof CFStatus)[keyof typeof CFStatus];

export const Priority = Object.freeze({
  Empty: '--',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
} as const);

export type PriorityValue = (typeof Priority)[keyof typeof Priority];

export const Classification = Object.freeze({
  Components: 'Components',
} as const);

export type ClassificationValue =
  (typeof Classification)[keyof typeof Classification];

export const Platform = Object.freeze({
  All: 'All',
  Desktop: 'Desktop',
  Unspecified: 'Unspecified',
  X8664: 'x86_64',
} as const);

export type PlatformValue = (typeof Platform)[keyof typeof Platform];

export const Product = Object.freeze({
  Core: 'Core',
} as const);

export type ProductValue = (typeof Product)[keyof typeof Product];

export const Type = Object.freeze({
  Defect: 'defect',
  Enhancement: 'enhancement',
  Task: 'task',
} as const);

export type TypeValue = (typeof Type)[keyof typeof Type];

import type { BugFieldValue } from './bug-fields.js';
import type { BugStatusEnum, MatchTypeEnum } from './bugzilla-literals.js';

export interface BugzillaConstructorOptions {
  readonly origin?: string;
  readonly apiKey?: string;
}

export type QueryParam = readonly [key: string, value: string];

/**
 *
 */
export interface QueryParams {
  /**
   * Write the queries to stdout just before they're sent
   */
  readonly logQuery?: boolean;

  /**
   * Only fetch a subset of the available bug fields from bug endpoints.
   */
  readonly bugFields?: ReadonlyArray<BugFieldValue>;
}

/**
 * @see index.js#search
 */
export interface SearchParams extends QueryParams {
  /**
   * Don't actually query bugzilla, instead return an empty set
   */
  readonly dryRun?: boolean;

  /**
   * This is an 'OR' criteria so any of these keywords must match
   */
  readonly components?: ReadonlyArray<string>;

  /**
   * This is an 'OR' criteria so any of these keywords must match
   */
  readonly bugStatus?: ReadonlyArray<BugStatusEnum>;

  /**
   * Detecting changes in bugs
   */
  readonly change?: {
    readonly field: string;
    readonly from: Date;
    readonly to: Date;
    readonly value: string;
  };

  /**
   * This is an 'OR' criteria so any of these keywords must match
   */
  readonly keywords?: ReadonlyArray<string>;

  /**
   * Restrict the search to a single product (component names can be
   * duplicated across different products (e.g. 'Untriaged'))
   */
  readonly product?: string;

  /**
   *
   */
  readonly assignedTo?: string;

  /**
   * For advanced searches
   * TODO: We can AND/OR these searches, but there is no syntax for that
   */
  readonly advanced?: ReadonlyArray<{
    readonly field: string;
    readonly matchType: MatchTypeEnum;
    readonly value: string;
  }>;

  /**
   * S1, S2, S3, etc
   */
  readonly bugSeverity?: ReadonlyArray<string>;
}

export interface BugReply<TBug = Bug> {
  readonly bugs: ReadonlyArray<TBug>;
}

export interface BugCommentsReply {
  readonly bugs: Readonly<Record<string, BugCommentThread>>;
}

export interface BugCommentThread {
  readonly comments: ReadonlyArray<BugComment>;
}

export interface BugComment {
  readonly id: number;
  readonly bug_id: number;
  readonly attachment_id?: number | null;
  readonly count?: number;
  readonly creator: string;
  readonly creation_time: IsoDateString;
  readonly is_private: boolean;
  readonly tags?: ReadonlyArray<string>;
  readonly text: string;
  readonly [key: string]: unknown;
}

/**
 * ISO 8601 date string returned by the Bugzilla REST API.
 */
export type IsoDateString = string;

/**
 * The wire-format bug record returned by the Bugzilla REST API.
 */
export interface Bug {
  readonly id: number;
  readonly summary: string;
  readonly product: string;
  readonly component: string;
  readonly severity: string;
  readonly status: string;
  readonly assigned_to: string;
  readonly whiteboard: string;
  readonly blocks?: ReadonlyArray<number>;
  readonly creation_time?: IsoDateString;
  readonly creator?: string;
  readonly creator_detail?: Detail;
  readonly depends_on?: ReadonlyArray<number>;
  readonly flags?: ReadonlyArray<Flag>;
  readonly keywords?: ReadonlyArray<string>;
  readonly last_change_time?: IsoDateString;
  readonly resolution?: string;
  readonly see_also?: ReadonlyArray<string>;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export interface Detail {
  readonly name: string;
  readonly email: string;
  readonly nick: string;
  readonly real_name: string;
  readonly id: number;
  readonly [key: string]: unknown;
}

export interface Flag {
  readonly id: number;
  readonly status: string;
  readonly name: string;
  readonly creation_date: IsoDateString;
  readonly modification_date: IsoDateString;
  readonly requestee?: string;
  readonly setter: string;
  readonly type_id: number;
  readonly [key: string]: unknown;
}

export interface AttachmentReply {
  readonly attachments: Readonly<Record<string, AttachmentMeta>>;
  readonly bugs: Readonly<Record<string, ReadonlyArray<AttachmentMeta>>>;
}

export interface AttachmentMeta {
  readonly content_type: string;
  readonly is_obsolete: boolean;
  readonly bug_id: number;
  readonly size: number;
  readonly is_private: boolean;
  readonly flags: ReadonlyArray<AttachmentFlags>;
  readonly creation_time: IsoDateString;
  readonly id: number;
  readonly is_patch: boolean;
  readonly attacher?: string;
  readonly creator: string;
  readonly creator_detail?: AttachmentCreatorDetail;
  readonly summary?: string;
  readonly last_change_time: IsoDateString;
  readonly description: string;
  readonly data?: string;
  readonly file_name: string;
  readonly [key: string]: unknown;
}

export type AttachmentCreatorDetail = Detail;

export type AttachmentFlags = Flag;

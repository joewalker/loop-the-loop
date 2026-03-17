import type { BugFieldValue } from './bug-fields.js';
import { toResponseFieldName } from './bug-fields.js';
import type {
  AttachmentReply,
  Bug,
  BugCommentsReply,
  BugReply,
  BugzillaConstructorOptions,
  QueryParam,
  QueryParams,
  SearchParams,
} from './bugzilla-types.js';
export { BugField } from './bug-fields.js';
export { BugStatus, MatchType } from './bugzilla-literals.js';
export {
  CF,
  CFQAWhiteboard,
  CFStatus,
  Classification,
  Platform,
  Priority,
  Product,
  Type,
} from './bugzilla-literals.js';

/**
 * Formats a Date as 'yyyy-MM-dd' for Bugzilla query parameters.
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Construct a single Bugzilla query parameter tuple.
 */
function createQueryParam(key: string, value: string): QueryParam {
  return [key, value];
}

/**
 * Append repeated query parameters using the same key.
 */
function appendRepeatedQueryParams(
  queryParams: Array<QueryParam>,
  key: string,
  values: ReadonlyArray<string>,
): void {
  for (const value of values) {
    queryParams.push(createQueryParam(key, value));
  }
}

/**
 * Append the selected Bugzilla fields for bug endpoints.
 */
function appendBugFieldSelection(
  queryParams: Array<QueryParam>,
  bugFields: ReadonlyArray<BugFieldValue> | undefined,
): void {
  if (bugFields == null || bugFields.length === 0) {
    return;
  }

  const responseNames = bugFields.map(toResponseFieldName);
  queryParams.push(createQueryParam('include_fields', responseNames.join(',')));
}

/**
 * The real implementation
 */
export class Bugzilla {
  readonly origin: string;
  readonly #apiKey: string | undefined;

  /**
   *
   */
  constructor(options: BugzillaConstructorOptions = {}) {
    const { origin = 'https://bugzilla.mozilla.org', apiKey } = options;

    this.origin = origin;
    this.#apiKey = apiKey;
  }

  /**
   *
   */
  async getBug(
    id: number,
    options: QueryParams & { readonly bugFields: ReadonlyArray<BugFieldValue> },
  ): Promise<Partial<Bug>>;
  async getBug(id: number, options?: QueryParams): Promise<Bug>;
  async getBug(id: number, options: QueryParams = {}): Promise<Partial<Bug>> {
    const queryParams: Array<QueryParam> = [];
    appendBugFieldSelection(queryParams, options.bugFields);

    const reply = await this.#query<BugReply<Bug | Partial<Bug>>>(
      `/rest/bug/${id}`,
      queryParams,
      options.logQuery,
    );

    if (reply.bugs.length !== 1) {
      throw new Error(`Found ${reply.bugs.length} bugs matching ${id}`);
    }

    const [bug] = reply.bugs;
    if (bug == null) {
      throw new Error(`Found ${reply.bugs.length} bugs matching ${id}`);
    }

    return bug;
  }

  /**
   *
   */
  async comments(
    id: number,
    options: QueryParams = {},
  ): Promise<BugCommentsReply> {
    return this.#query<BugCommentsReply>(
      `/rest/bug/${id}/comment`,
      [],
      options.logQuery,
    );
  }

  /**
   *
   */
  async attachments(
    id: number,
    options: QueryParams = {},
  ): Promise<AttachmentReply> {
    return this.#query<AttachmentReply>(
      `/rest/bug/${id}/attachment`,
      [],
      options.logQuery,
    );
  }

  /**
   *
   */
  async search(
    params: SearchParams & {
      readonly bugFields: ReadonlyArray<BugFieldValue>;
    },
  ): Promise<ReadonlyArray<Partial<Bug>>>;
  async search(params: SearchParams): Promise<ReadonlyArray<Bug>>;
  async search(params: SearchParams): Promise<ReadonlyArray<Partial<Bug>>> {
    /**
     * Here we collect the search parameters as bugzilla wants them (as opposed
     * to the input which is as we want to specify them) but they're not
     * formatted for transmission over the internet (urlencoded, etc). Using an
     * array of tuples instead of an object allows repeated params
     */
    const queryParams: Array<QueryParam> = [];

    if (params.product != null) {
      queryParams.push(createQueryParam('product', params.product));
    }

    appendBugFieldSelection(queryParams, params.bugFields);

    if (params.components != null) {
      appendRepeatedQueryParams(queryParams, 'component', params.components);
    }

    if (params.bugStatus != null) {
      appendRepeatedQueryParams(queryParams, 'bug_status', params.bugStatus);
    }

    if (params.keywords != null) {
      queryParams.push(
        createQueryParam('keywords', params.keywords.join(', ')),
      );
      queryParams.push(createQueryParam('keywords_type', 'anywords'));
    }

    if (params.assignedTo != null) {
      queryParams.push(createQueryParam('email1', params.assignedTo));
      queryParams.push(createQueryParam('emailassigned_to1', '1'));
      queryParams.push(createQueryParam('emailtype1', 'exact'));
    }

    if (params.change != null) {
      queryParams.push(createQueryParam('chfield', params.change.field));
      queryParams.push(
        createQueryParam('chfieldfrom', formatDate(params.change.from)),
      );
      queryParams.push(
        createQueryParam('chfieldto', formatDate(params.change.to)),
      );
      queryParams.push(createQueryParam('chfieldvalue', params.change.value));
    }

    if (params.advanced != null) {
      for (let i = 0; i < params.advanced.length; i++) {
        queryParams.push(
          createQueryParam(`f${i + 1}`, params.advanced[i].field),
        );
        queryParams.push(
          createQueryParam(`o${i + 1}`, params.advanced[i].matchType),
        );
        queryParams.push(
          createQueryParam(`v${i + 1}`, params.advanced[i].value),
        );
      }
      queryParams.push(createQueryParam('query_format', 'advanced'));
    }

    if (params.bugSeverity != null) {
      appendRepeatedQueryParams(
        queryParams,
        'bug_severity',
        params.bugSeverity,
      );
    }

    if (params.dryRun) {
      return [];
    }

    const reply = await this.#query<BugReply<Bug | Partial<Bug>>>(
      `/rest/bug`,
      queryParams,
      params.logQuery,
    );
    return reply.bugs;
  }

  /**
   *
   */
  async getTeams(logQuery = false): Promise<ReadonlyArray<string>> {
    return this.#query<ReadonlyArray<string>>(
      `/rest/config/component_teams`,
      [],
      logQuery,
    );
  }

  /**
   *
   */
  async getComponentsForTeam(
    team: string,
    logQuery = false,
  ): Promise<Record<string, unknown>> {
    const encodedTeam = encodeURIComponent(team);
    return this.#query<Record<string, unknown>>(
      `/rest/config/component_teams/${encodedTeam}`,
      [],
      logQuery,
    );
  }

  /**
   * @param baseUrl This doesn't include any query parameters or the origin.
   * Example usage '/rest/bug'
   * @param queryParams This is the query parameters as bugzilla wants them
   * but they're not formatted for transmission over the internet (urlencoded,
   * etc). Using an array of tuples instead of an object allows repeated params
   */
  async #query<T = unknown>(
    baseUrl: string,
    queryParams: ReadonlyArray<QueryParam> = [],
    logQuery = false,
  ): Promise<T> {
    const outputParams = queryParams.map(([key, value]) => {
      return `${key}=${encodeURIComponent(value)}`;
    });
    const url = `${this.origin}${baseUrl}?${outputParams.join('&')}`;

    const headers: Record<string, string> = {};
    if (this.#apiKey != null) {
      headers['X-BUGZILLA-API-KEY'] = this.#apiKey;
    }

    if (logQuery) {
      // eslint-disable-next-line no-console
      console.log(url);
    }

    const response = await fetch(url, { headers });
    const text = await response.text();

    if (!response.ok) {
      let message = `Bugzilla API error ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: boolean; message?: string };
        if (body.message) {
          message += `: ${body.message}`;
        }
      } catch {
        if (text.length > 0) {
          message += `: ${text}`;
        }
      }
      throw new Error(message);
    }

    try {
      return JSON.parse(text) as T;
    } catch (ex) {
      console.error(text);
      throw ex;
    }
  }
}

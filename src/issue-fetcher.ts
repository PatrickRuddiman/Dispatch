/**
 * @deprecated This module is deprecated. Use `./datasource.js` instead.
 *
 * All types and interfaces have been moved to `src/datasource.ts` as part of
 * the unified Datasource abstraction. This file re-exports them for backwards
 * compatibility and will be removed in a future release.
 */

export type { IssueDetails, IssueFetchOptions } from "./datasource.js";

/** @deprecated Use `DatasourceName` from `./datasource.js` instead. */
export type IssueSourceName = "github" | "azdevops";

/**
 * @deprecated Use `Datasource` from `./datasource.js` instead.
 *
 * The `IssueFetcher` interface has been superseded by the `Datasource`
 * interface which adds `list()` and `create()` methods and supports
 * local markdown files as a datasource backend.
 */
export interface IssueFetcher {
  readonly name: string;
  fetch(issueId: string, opts?: import("./datasource.js").IssueFetchOptions): Promise<import("./datasource.js").IssueDetails>;
  update?(issueId: string, title: string, body: string, opts?: import("./datasource.js").IssueFetchOptions): Promise<void>;
  close?(issueId: string, opts?: import("./datasource.js").IssueFetchOptions): Promise<void>;
}

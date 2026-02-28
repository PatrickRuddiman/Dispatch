/**
 * @deprecated This module is deprecated. Use `../datasources/index.js` instead.
 *
 * The issue fetcher registry has been replaced by the Datasource registry.
 * All exports are re-exported from the new location for backwards compatibility
 * and will be removed in a future release.
 */

import { getDatasource, detectDatasource, DATASOURCE_NAMES } from "../datasources/index.js";
import type { Datasource } from "../datasources/interface.js";
import type { IssueSourceName, IssueFetcher } from "../issue-fetcher.js";

/**
 * @deprecated Use `DATASOURCE_NAMES` from `../datasources/index.js` instead.
 */
export const ISSUE_SOURCE_NAMES = DATASOURCE_NAMES.filter(
  (n): n is "github" | "azdevops" => n === "github" || n === "azdevops"
) as IssueSourceName[];

/**
 * @deprecated Use `getDatasource()` from `../datasources/index.js` instead.
 */
export function getIssueFetcher(name: IssueSourceName): IssueFetcher {
  const ds = getDatasource(name);
  return {
    name: ds.name,
    fetch: ds.fetch.bind(ds),
    update: ds.update.bind(ds),
    close: ds.close.bind(ds),
  };
}

/**
 * @deprecated Use `detectDatasource()` from `../datasources/index.js` instead.
 */
export async function detectIssueSource(
  cwd: string
): Promise<IssueSourceName | null> {
  const result = await detectDatasource(cwd);
  if (result === "github" || result === "azdevops") return result;
  return null;
}

/**
 * @deprecated This module is deprecated. Use `../datasources/azdevops.js` instead.
 *
 * The Azure DevOps issue fetcher has been replaced by the Azure DevOps datasource.
 * This file re-exports for backwards compatibility and will be removed
 * in a future release.
 */

import { datasource } from "../datasources/azdevops.js";
import type { IssueFetcher } from "../issue-fetcher.js";

/** @deprecated Use `datasource` from `../datasources/azdevops.js` instead. */
export const fetcher: IssueFetcher = {
  name: datasource.name,
  fetch: datasource.fetch.bind(datasource),
  update: datasource.update.bind(datasource),
  close: datasource.close.bind(datasource),
};

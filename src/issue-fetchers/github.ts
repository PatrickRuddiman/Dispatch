/**
 * @deprecated This module is deprecated. Use `../datasources/github.js` instead.
 *
 * The GitHub issue fetcher has been replaced by the GitHub datasource.
 * This file re-exports for backwards compatibility and will be removed
 * in a future release.
 */

import { datasource } from "../datasources/github.js";
import type { IssueFetcher } from "../issue-fetcher.js";

/** @deprecated Use `datasource` from `../datasources/github.js` instead. */
export const fetcher: IssueFetcher = {
  name: datasource.name,
  fetch: datasource.fetch.bind(datasource),
  update: datasource.update.bind(datasource),
  close: datasource.close.bind(datasource),
};

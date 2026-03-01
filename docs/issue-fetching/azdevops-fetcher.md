# Azure DevOps Fetcher

> **Deprecated.** The file `src/issue-fetchers/azdevops.ts` is now a thin shim
> that delegates all calls to `src/datasources/azdevops.ts` via `.bind()`. It
> contains no business logic. The actual Azure DevOps implementation lives in
> the datasource layer. See the
> [Deprecated Compatibility Layer](../deprecated-compat/overview.md) for
> details.

The Azure DevOps fetcher (`src/issue-fetchers/azdevops.ts`) was the original
implementation for retrieving work items from Azure DevOps. It has been
replaced by the [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md),
which provides the same functionality plus additional operations (`list` and
`create`). The fetcher module now exists only as a backwards-compatible shim
that delegates all calls to the datasource layer via `.bind()`.

For all prerequisites, authentication setup, field mappings, CLI commands,
troubleshooting guidance, and implementation details, see the
**[Azure DevOps Datasource](../datasource-system/azdevops-datasource.md)**
documentation.

## Related documentation

- [Azure DevOps Datasource](../datasource-system/azdevops-datasource.md) --
  Canonical reference for Azure DevOps integration (prerequisites,
  authentication, field mappings, troubleshooting)
- [Deprecated Compatibility Layer](../deprecated-compat/overview.md) --
  Migration guidance and removal assessment for the old fetcher interface
- [Issue Fetching Overview](./overview.md) -- Architecture and data flow of
  the deprecated fetcher system
- [Datasource Overview](../datasource-system/overview.md) -- The datasource
  abstraction that supersedes this fetcher interface
- [Spec Generation](../spec-generation/overview.md) -- How the spec pipeline
  uses datasources to fetch Azure DevOps work items for spec generation

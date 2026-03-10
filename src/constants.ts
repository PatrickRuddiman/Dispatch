/**
 * OAuth client IDs and related constants for device-flow authentication.
 *
 * These are public client identifiers — not secrets — bundled so that users
 * do not need to register their own OAuth applications.
 */

/** GitHub OAuth App client ID. */
export const GITHUB_CLIENT_ID = "Ov23liUMP1Oyg811IF58";

/** Azure AD application (client) ID. */
export const AZURE_CLIENT_ID = "150a3098-01dd-4126-8b10-5e7f77492e5c";

/**
 * Azure AD tenant ID — "organizations" restricts sign-in to work/school
 * (Entra ID) accounts.  Azure DevOps does not support personal Microsoft
 * accounts for API access, so "common" cannot be used here.
 */
export const AZURE_TENANT_ID = "organizations";

/** Azure DevOps default API scope. */
export const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

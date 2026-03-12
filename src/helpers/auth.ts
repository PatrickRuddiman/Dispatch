/**
 * OAuth device-flow authentication helpers for GitHub and Azure DevOps.
 *
 * Tokens are cached at ~/.dispatch/auth.json (mode 0o600) so users only
 * need to authenticate once per platform until tokens expire.
 */

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { Octokit } from "@octokit/rest";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { DeviceCodeCredential } from "@azure/identity";
import * as azdev from "azure-devops-node-api";
import open from "open";

import { log } from "./logger.js";
import {
  GITHUB_CLIENT_ID,
  AZURE_CLIENT_ID,
  AZURE_TENANT_ID,
  AZURE_DEVOPS_SCOPE,
} from "../constants.js";
import {
  getGitRemoteUrl,
  parseGitHubRemoteUrl,
  parseAzDevOpsRemoteUrl,
} from "../datasources/index.js";
import type { DatasourceName } from "../datasources/interface.js";

interface AuthCache {
  github?: { token: string };
  azure?: { token: string; expiresAt: string };
}

const AUTH_PATH = join(homedir(), ".dispatch", "auth.json");

/** Five-minute buffer (ms) used to refresh Azure tokens before they expire. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Optional callback for routing auth prompts into the TUI. */
let authPromptHandler: ((message: string) => void) | null = null;

/**
 * Register a handler for auth device-code prompts.
 * When set, prompts are routed to this handler instead of `log.info()`.
 * Pass `null` to clear the handler.
 */
export function setAuthPromptHandler(handler: ((message: string) => void) | null): void {
  authPromptHandler = handler;
}

async function loadAuthCache(): Promise<AuthCache> {
  try {
    const raw = await readFile(AUTH_PATH, "utf-8");
    return JSON.parse(raw) as AuthCache;
  } catch {
    return {};
  }
}

async function saveAuthCache(cache: AuthCache): Promise<void> {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(cache, null, 2) + "\n", "utf-8");
  if (process.platform !== "win32") {
    try {
      await chmod(AUTH_PATH, 0o600);
    } catch {
      // chmod may fail on restricted filesystems; token was already written
    }
  }
}

/**
 * Return an authenticated Octokit instance for the GitHub API.
 *
 * On first use the user is guided through the OAuth device-flow; the
 * resulting token is cached for subsequent calls.
 */
export async function getGithubOctokit(): Promise<Octokit> {
  const cache = await loadAuthCache();

  if (cache.github?.token) {
    return new Octokit({ auth: cache.github.token });
  }

  const auth = createOAuthDeviceAuth({
    clientId: GITHUB_CLIENT_ID,
    clientType: "oauth-app",
    scopes: ["repo"],
    onVerification(verification) {
      const msg = `Enter code ${verification.user_code} at ${verification.verification_uri}`;
      if (authPromptHandler) {
        authPromptHandler(msg);
      } else {
        log.info(msg);
      }
      open(verification.verification_uri).catch(() => {});
    },
  });

  const authentication = await auth({ type: "oauth" });

  cache.github = { token: authentication.token };
  await saveAuthCache(cache);

  return new Octokit({ auth: authentication.token });
}

/**
 * Return an authenticated Azure DevOps `WebApi` connection for the given org.
 *
 * On first use (or when the cached token is about to expire) the user is
 * guided through the Azure device-code flow; the token is cached for
 * subsequent calls.
 */
export async function getAzureConnection(
  orgUrl: string,
): Promise<azdev.WebApi> {
  const cache = await loadAuthCache();

  if (cache.azure?.token && cache.azure.expiresAt) {
    const expiresAt = new Date(cache.azure.expiresAt).getTime();
    if (expiresAt - Date.now() > EXPIRY_BUFFER_MS) {
      return new azdev.WebApi(
        orgUrl,
        azdev.getBearerHandler(cache.azure.token),
      );
    }
  }

  const credential = new DeviceCodeCredential({
    tenantId: AZURE_TENANT_ID,
    clientId: AZURE_CLIENT_ID,
    userPromptCallback(deviceCodeInfo) {
      // Azure DevOps only supports work/school accounts — prepend a note
      // so users don't attempt to sign in with a personal Microsoft account.
      const note = "Azure DevOps requires a work or school account (personal Microsoft accounts are not supported).";
      const msg = `${note}\n${deviceCodeInfo.message}`;
      if (authPromptHandler) {
        authPromptHandler(msg);
      } else {
        log.info(msg);
      }
      open(deviceCodeInfo.verificationUri).catch(() => {});
    },
  });

  const accessToken = await credential.getToken(AZURE_DEVOPS_SCOPE);
  if (!accessToken) {
    throw new Error(
      "Azure device-code authentication did not return a token. Please try again.",
    );
  }

  cache.azure = {
    token: accessToken.token,
    expiresAt: new Date(accessToken.expiresOnTimestamp).toISOString(),
  };
  await saveAuthCache(cache);

  return new azdev.WebApi(
    orgUrl,
    azdev.getBearerHandler(accessToken.token),
  );
}

/**
 * Ensure the user is authenticated for the given datasource before pipeline
 * work begins. For cached/valid tokens this resolves instantly; for new or
 * expired credentials it triggers the device-code flow while stdout is still
 * free (before the TUI or batch output takes over).
 *
 * This is a shared entry point used by both the dispatch and spec pipelines.
 */
export async function ensureAuthReady(
  source: DatasourceName | undefined,
  cwd: string,
  org?: string,
): Promise<void> {
  if (source === "github") {
    const remoteUrl = await getGitRemoteUrl(cwd);
    if (remoteUrl && parseGitHubRemoteUrl(remoteUrl)) {
      await getGithubOctokit();
    } else if (!remoteUrl) {
      log.warn("No git remote found — skipping GitHub pre-authentication");
    } else {
      log.warn("Remote URL is not a GitHub repository — skipping GitHub pre-authentication");
    }
  } else if (source === "azdevops") {
    let orgUrl = org;
    if (!orgUrl) {
      const remoteUrl = await getGitRemoteUrl(cwd);
      if (remoteUrl) {
        const parsed = parseAzDevOpsRemoteUrl(remoteUrl);
        if (parsed) orgUrl = parsed.orgUrl;
        else log.warn("Remote URL is not an Azure DevOps repository — skipping Azure pre-authentication");
      } else {
        log.warn("No git remote found — skipping Azure DevOps pre-authentication");
      }
    }
    if (orgUrl) await getAzureConnection(orgUrl);
  }
}

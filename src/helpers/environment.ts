/**
 * Runtime environment detection for OS-aware agent prompts.
 *
 * Detects the host operating system and produces a formatted text block
 * that can be injected into agent system prompts so they know to run
 * commands directly instead of writing intermediate scripts.
 */

export interface EnvironmentInfo {
  /** Raw Node.js platform string (e.g. "win32", "linux", "darwin"). */
  platform: string;
  /** Human-readable OS name. */
  os: string;
  /** Default shell description for the platform. */
  shell: string;
}

/**
 * Detect the runtime environment from `process.platform`.
 */
export function getEnvironmentInfo(): EnvironmentInfo {
  const platform = process.platform;
  switch (platform) {
    case "win32":
      return { platform, os: "Windows", shell: "cmd.exe/PowerShell" };
    case "darwin":
      return { platform, os: "macOS", shell: "zsh/bash" };
    default:
      return { platform, os: "Linux", shell: "bash" };
  }
}

/**
 * Format environment information as a prompt text block.
 *
 * Returns a multi-line string describing the host OS, default shell,
 * and an instruction to run commands directly.
 */
export function formatEnvironmentPrompt(): string {
  const env = getEnvironmentInfo();
  return [
    `## Environment`,
    `- **Operating System:** ${env.os}`,
    `- **Default Shell:** ${env.shell}`,
    `- Always run commands directly in the shell. Do NOT write intermediate scripts (e.g. .bat, .ps1, .py files) unless the task explicitly requires creating a script.`,
  ].join("\n");
}

/** Alias used by the dispatcher module. */
export const getEnvironmentBlock = formatEnvironmentPrompt;

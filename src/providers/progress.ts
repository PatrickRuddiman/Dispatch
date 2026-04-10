import type { ProviderPromptOptions } from "./interface.js";

const ANSI_PATTERN = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export function sanitizeProgressText(raw: string, maxLength = 120): string {
  const text = raw
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return maxLength <= 0 ? "" : "…";
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** A lightweight progress reporter that de-duplicates successive identical messages. */
export interface ProgressReporter {
  /** Emit a progress text snapshot, de-duplicating against the previous value. */
  emit(raw?: string | null): void;
  /** Reset the last-emitted value so the next identical message is re-emitted. */
  reset(): void;
}

export function createProgressReporter(onProgress?: ProviderPromptOptions["onProgress"]): ProgressReporter {
  let last: string | undefined;

  return {
    emit(raw?: string | null) {
      if (!onProgress) return;

      const text = sanitizeProgressText(raw ?? "");
      if (!text || text === last) return;

      last = text;
      try {
        onProgress({ text });
      } catch {
        // Ignore callback errors from callers.
      }
    },

    reset() {
      last = undefined;
    },
  };
}

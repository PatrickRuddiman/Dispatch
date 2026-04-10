/**
 * Shared agent result types — provides a generic `AgentResult<T>` that all
 * agent implementations can use as their return type, ensuring consistent
 * error handling, duration tracking, and payload access across the pipeline.
 *
 * Concrete data type aliases (`PlannerData`, `ExecutorData`, `SpecData`)
 * define the domain-specific payload shape for each agent role.
 */

import type { DispatchResult } from "../dispatcher.js";

/**
 * Machine-readable error classification codes.
 *
 * Used by orchestration code to decide on retry strategies, logging levels,
 * and user-facing messages without parsing error strings.
 */
export type AgentErrorCode =
  | "TIMEOUT"
  | "NO_RESPONSE"
  | "VALIDATION_FAILED"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

/**
 * Generic result type returned by all agents.
 *
 * Discriminated on `success` so that TypeScript automatically narrows
 * `data` to `T` (non-null) in the `success: true` branch, and to `null`
 * in the `success: false` branch — eliminating the need for non-null
 * assertions (`!`) at call sites.
 */
export type AgentResult<T> =
  | {
      /** Operation succeeded; payload is guaranteed non-null. */
      success: true;
      /** Domain-specific payload. */
      data: T;
      /** Always absent on success — present only to allow `result.error` access without narrowing. */
      error?: never;
      /** Always absent on success. */
      errorCode?: never;
      /** Elapsed wall-clock time in milliseconds. */
      durationMs?: number;
    }
  | {
      /** Operation failed; no usable payload was produced. */
      success: false;
      /** Always `null` on failure. */
      data: null;
      /** Human-readable error message. */
      error?: string;
      /** Machine-readable error classification. */
      errorCode?: AgentErrorCode;
      /** Elapsed wall-clock time in milliseconds. */
      durationMs?: number;
    };

// ---------------------------------------------------------------------------
// Concrete data types — one per agent role
// ---------------------------------------------------------------------------

/** Domain payload for the planner agent. */
export interface PlannerData {
  /** The system prompt produced for the executor agent. */
  prompt: string;
}

/** Domain payload for the executor agent. */
export interface ExecutorData {
  /** The underlying dispatch result. */
  dispatchResult: DispatchResult;
}

/** Domain payload for the spec agent. */
export interface SpecData {
  /** The cleaned spec content. */
  content: string;
  /** Whether the spec passed structural validation. */
  valid: boolean;
  /** Validation failure reason, if any. */
  validationReason?: string;
}

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
 * `T` is the domain-specific payload — `null` when the operation failed
 * before producing useful output.
 */
export interface AgentResult<T> {
  /** Domain-specific payload, or `null` on failure. */
  data: T | null;
  /** Whether the operation completed successfully. */
  success: boolean;
  /** Human-readable error message, if the operation failed. */
  error?: string;
  /** Machine-readable error classification. */
  errorCode?: AgentErrorCode;
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number;
}

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

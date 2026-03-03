/**
 * Custom error for operations that are not supported by a given implementation.
 *
 * Thrown when a caller invokes a method that the underlying implementation
 * does not support (e.g., git lifecycle methods on a non-git datasource).
 * The `operation` property identifies which method was called, aiding
 * diagnostics and error handling.
 */
export class UnsupportedOperationError extends Error {
  /** The name of the operation that is not supported. */
  readonly operation: string;

  constructor(operation: string, message?: string) {
    const msg = message ?? `Operation not supported: ${operation}`;
    super(msg);
    this.name = "UnsupportedOperationError";
    this.operation = operation;
  }
}

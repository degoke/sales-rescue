/**
 * A business-rule refusal. Tools return `code`, `message` and `details` to the agent; `internal`
 * (upstream bodies, network causes) is for our logs only and never reaches the model.
 */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public internal: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const fail = (code: string, message: string, details?: Record<string, unknown>, internal?: Record<string, unknown>): never => {
  throw new DomainError(code, message, details, internal);
};

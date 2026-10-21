export class ClaimLineageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ClaimLineageError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new ClaimLineageError(code, message, details);
}

export class LinterError extends Error {
  constructor(msg: string, cause: Error) {
    super(msg, { cause });

    this.stack = cause.stack;

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, LinterError.prototype);
  }
}

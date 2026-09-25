const ASSERTION_ERROR_NAME = "AssertLedgerBunAssertionError";
const ASSERTION_ERROR_MESSAGE = "AssertLedger assertSame failed";
const issuedErrors = new WeakSet();
const addIssuedError = WeakSet.prototype.add.bind(issuedErrors);
const hasIssuedError = WeakSet.prototype.has.bind(issuedErrors);

class AssertLedgerBunAssertionError extends Error {
  constructor() {
    super(ASSERTION_ERROR_MESSAGE);
    this.name = ASSERTION_ERROR_NAME;
  }
}

export function assertSame(actual, expected) {
  if (!Object.is(actual, expected)) {
    const error = new AssertLedgerBunAssertionError();
    addIssuedError(error);
    throw error;
  }
}

/** @internal Identifies an error instance issued by this helper. */
export function isAssertSameFailure(error) {
  return typeof error === "object" && error !== null && hasIssuedError(error);
}

const ASSERTION_ERROR_NAME = "AssertLedgerBunAssertionError";
const ASSERTION_ERROR_MESSAGE = "AssertLedger assertSame failed";

class AssertLedgerBunAssertionError extends Error {
  constructor() {
    super(ASSERTION_ERROR_MESSAGE);
    this.name = ASSERTION_ERROR_NAME;
  }
}

export function assertSame(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new AssertLedgerBunAssertionError();
  }
}

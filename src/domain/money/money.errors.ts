export class InvalidMoneyError extends Error {
  override readonly name = "InvalidMoneyError";
}

export class CurrencyMismatchError extends Error {
  override readonly name = "CurrencyMismatchError";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

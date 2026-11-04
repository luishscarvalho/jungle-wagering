import { CurrencyMismatchError, InvalidMoneyError } from "./money.errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function assertValidCurrency(currency: string): void {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError("Invalid currency: expected 3 uppercase letters");
  }
}

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contract input: only non-negative decimal strings with exactly 2 places. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    // Error messages do not echo the amount, since they can end up in logs.
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError("Invalid amount: expected a non-negative decimal string with exactly 2 places");
    }
    assertValidCurrency(currency);
    return new Money(BigInt(amount.replace(".", "")), currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinor(0n, currency);
  }

  /** For domain and persistence use. Unlike from(), accepts negative values. */
  static fromMinor(minor: bigint, currency: string): Money {
    if (typeof minor !== "bigint") {
      throw new InvalidMoneyError("Invalid minor units: expected a bigint");
    }
    assertValidCurrency(currency);
    return new Money(minor, currency);
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Answers "same value?", so a different currency is false, not an error. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const sign = this.minor < 0n ? "-" : "";
    const digits = (this.minor < 0n ? -this.minor : this.minor).toString().padStart(3, "0");
    return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

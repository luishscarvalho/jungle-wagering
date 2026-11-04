import { describe, expect, test } from "bun:test";
import { Money, type MoneyProps } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/money/money.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each([
    ["0.00", 0n],
    ["0.05", 5n],
    ["0.50", 50n],
    ["1.00", 100n],
    ["25.00", 2500n],
    ["25.50", 2550n],
    ["1000.99", 100099n],
  ])("parses %s as %d minor units", (amount, minor) => {
    expect(brl(amount).minorUnits).toBe(minor);
  });

  test.each([
    ["no decimal places", "25"],
    ["one decimal place", "25.5"],
    ["three decimal places", "25.000"],
    ["trailing separator", "25."],
    ["leading zero", "025.00"],
    ["double zero", "00.00"],
    ["missing integer part", ".50"],
    ["empty", ""],
    ["blank", "   "],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative Infinity", "-Infinity"],
    ["scientific notation", "1e3"],
    ["scientific notation with places", "1.00e3"],
    ["plus sign", "+25.00"],
    ["negative", "-25.00"],
    ["negative zero", "-0.00"],
    ["leading space", " 25.00"],
    ["trailing space", "25.00 "],
    ["inner space", "25 .00"],
    ["trailing newline", "25.00\n"],
    ["comma separator", "25,00"],
    ["thousands separator", "1,000.00"],
    ["hex", "0x10.00"],
    ["non-ASCII digits", "٢٥.٠٠"],
  ])("rejects %s", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    ["number", 25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 2500n],
    ["null", null],
    ["undefined", undefined],
  ])("rejects a non-string amount: %s", (_label, amount) => {
    const props = { amount, currency: "BRL" } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "Brl", "BR", "BRLL", "B1L", " BRL", "BRL ", "BRL\n", "ÁÉÍ"])(
    "rejects currency %j",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    },
  );

  test("rejects a non-string currency", () => {
    const props = { amount: "1.00", currency: undefined } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test("does not echo the rejected amount in the error message", () => {
    expect(() => brl("123456.789")).not.toThrow("123456.789");
  });
});

describe("Money.zero", () => {
  test("creates a zero value", () => {
    const zero = Money.zero("BRL");
    expect(zero.minorUnits).toBe(0n);
    expect(zero.currency).toBe("BRL");
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test("rejects an invalid currency", () => {
    expect(() => Money.zero("brl")).toThrow(InvalidMoneyError);
  });
});

describe("Money.fromMinor", () => {
  test("accepts positive, zero and negative values", () => {
    expect(Money.fromMinor(2500n, "BRL").equals(brl("25.00"))).toBe(true);
    expect(Money.fromMinor(0n, "BRL").isZero()).toBe(true);
    expect(Money.fromMinor(-2500n, "BRL").isNegative()).toBe(true);
  });

  test("rejects an invalid currency", () => {
    expect(() => Money.fromMinor(1n, "brl")).toThrow(InvalidMoneyError);
  });

  test("rejects a number at runtime", () => {
    expect(() => Money.fromMinor(2500 as unknown as bigint, "BRL")).toThrow(InvalidMoneyError);
  });
});

describe("arithmetic", () => {
  test("add", () => {
    expect(brl("10.10").add(brl("0.20")).toJSON().amount).toBe("10.30");
  });

  test("subtract", () => {
    expect(brl("10.30").subtract(brl("0.20")).toJSON().amount).toBe("10.10");
  });

  test("subtract can go negative", () => {
    const result = brl("1.00").subtract(brl("1.50"));
    expect(result.minorUnits).toBe(-50n);
    expect(result.isNegative()).toBe(true);
  });

  test("negate flips the sign both ways", () => {
    expect(brl("25.00").negate().minorUnits).toBe(-2500n);
    expect(brl("25.00").negate().negate().equals(brl("25.00"))).toBe(true);
  });

  test("negating zero stays zero", () => {
    const negated = Money.zero("BRL").negate();
    expect(negated.isZero()).toBe(true);
    expect(negated.isNegative()).toBe(false);
    expect(negated.toJSON().amount).toBe("0.00");
  });

  test("has no binary floating point drift", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });
});

describe("immutability", () => {
  test("operations do not change their operands", () => {
    const a = brl("10.00");
    const b = brl("3.00");
    a.add(b);
    a.subtract(b);
    a.negate();
    expect(a.minorUnits).toBe(1000n);
    expect(b.minorUnits).toBe(300n);
  });

  test("instances are frozen at runtime", () => {
    const money = brl("10.00") as unknown as { minor: bigint; currency: string };
    expect(() => {
      money.minor = 1n;
    }).toThrow(TypeError);
    expect(() => {
      money.currency = "USD";
    }).toThrow(TypeError);
  });
});

describe("comparisons", () => {
  test("isZero, isPositive and isNegative are exclusive", () => {
    const cases: [Money, boolean, boolean, boolean][] = [
      [brl("0.00"), true, false, false],
      [brl("0.01"), false, true, false],
      [brl("0.01").negate(), false, false, true],
    ];
    for (const [money, zero, positive, negative] of cases) {
      expect(money.isZero()).toBe(zero);
      expect(money.isPositive()).toBe(positive);
      expect(money.isNegative()).toBe(negative);
    }
  });

  test("isLessThan", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").negate().isLessThan(brl("0.00"))).toBe(true);
  });

  test("equals compares value and currency", () => {
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(brl("1.01"))).toBe(false);
    expect(brl("1.00").equals(usd("1.00"))).toBe(false);
  });
});

describe("currency conflict", () => {
  test.each([
    ["add", () => brl("1.00").add(usd("1.00"))],
    ["subtract", () => brl("1.00").subtract(usd("1.00"))],
    ["isLessThan", () => brl("1.00").isLessThan(usd("1.00"))],
  ])("%s throws CurrencyMismatchError", (_label, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });

  test("the error names both currencies", () => {
    try {
      brl("1.00").add(usd("1.00"));
      throw new Error("expected add to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(error).toMatchObject({ name: "CurrencyMismatchError", expected: "BRL", actual: "USD" });
    }
  });
});

describe("serialization", () => {
  test.each([
    [0n, "0.00"],
    [5n, "0.05"],
    [50n, "0.50"],
    [100n, "1.00"],
    [2550n, "25.50"],
    [-5n, "-0.05"],
    [-50n, "-0.50"],
    [-100n, "-1.00"],
    [-2550n, "-25.50"],
  ])("%d minor units serialize with 2 places as %s", (minor, amount) => {
    expect(Money.fromMinor(minor, "BRL").toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test("JSON.stringify uses toJSON", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test("toString includes amount and currency", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
    expect(brl("25.00").negate().toString()).toBe("-25.00 BRL");
  });

  test("toJSON round-trips through from", () => {
    const money = brl("1234.56");
    expect(Money.from(money.toJSON()).equals(money)).toBe(true);
  });
});

describe("large values", () => {
  const large = "99999999999999999.99";

  test("parse and serialize without loss", () => {
    const money = brl(large);
    expect(money.minorUnits).toBe(9999999999999999999n);
    expect(money.toJSON().amount).toBe(large);
  });

  test("keep exact arithmetic beyond Number.MAX_SAFE_INTEGER", () => {
    const sum = brl(large).add(brl("0.01"));
    expect(sum.toJSON().amount).toBe("100000000000000000.00");
    expect(sum.subtract(brl("0.01")).toJSON().amount).toBe(large);
    expect(brl(large).negate().toJSON().amount).toBe(`-${large}`);
  });

  test("round-trip through minor units", () => {
    const money = brl(large);
    expect(Money.fromMinor(money.minorUnits, money.currency).equals(money)).toBe(true);
  });
});

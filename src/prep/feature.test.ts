import { describe, it, expect } from "vitest";
import { isPrepEnabled, PREP_FLAG_NAME } from "./feature";

describe("FEATURE_PREP flag", () => {
  it("is off when unset (production default)", () => {
    expect(isPrepEnabled({})).toBe(false);
  });

  it("is off for empty or whitespace values", () => {
    expect(isPrepEnabled({ [PREP_FLAG_NAME]: "" })).toBe(false);
    expect(isPrepEnabled({ [PREP_FLAG_NAME]: "   " })).toBe(false);
  });

  it("is off for explicit falsy strings", () => {
    for (const v of ["0", "false", "off", "no", "maybe", "tru"]) {
      expect(isPrepEnabled({ [PREP_FLAG_NAME]: v }), v).toBe(false);
    }
  });

  it("is on only for 1, true or on, case-insensitively", () => {
    for (const v of ["1", "true", "on", "TRUE", " On ", "1 "]) {
      expect(isPrepEnabled({ [PREP_FLAG_NAME]: v }), v).toBe(true);
    }
  });
});

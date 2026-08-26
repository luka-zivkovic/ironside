import { describe, expect, it } from "vitest";
import { canonicalizeUsageKeys } from "../src/usage-keys.js";

describe("canonicalizeUsageKeys", () => {
  it("maps every known alias vocabulary to the canonical keys", () => {
    expect(canonicalizeUsageKeys({ input: 1, output: 2, total: 3 })).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3
    });
    expect(canonicalizeUsageKeys({ promptTokens: 4, completionTokens: 5, totalTokens: 9 })).toEqual({
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9
    });
    expect(canonicalizeUsageKeys({ prompt_tokens: 6, completion_tokens: 7 })).toEqual({
      input_tokens: 6,
      output_tokens: 7
    });
  });

  it("passes already-canonical and unknown provider-specific keys through unchanged", () => {
    expect(
      canonicalizeUsageKeys({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        reasoning_output_tokens: 8
      })
    ).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      reasoning_output_tokens: 8
    });
  });

  it("a canonical key present in the source wins over an alias mapping to the same target, regardless of key order", () => {
    expect(canonicalizeUsageKeys({ input: 999, input_tokens: 10 })).toEqual({ input_tokens: 10 });
    expect(canonicalizeUsageKeys({ input_tokens: 10, input: 999 })).toEqual({ input_tokens: 10 });
  });

  it("two different aliases targeting the same canonical key: first in key order wins (malformed input, pinned for determinism)", () => {
    expect(canonicalizeUsageKeys({ promptTokens: 1, prompt_tokens: 2 })).toEqual({ input_tokens: 1 });
    expect(canonicalizeUsageKeys({ prompt_tokens: 2, promptTokens: 1 })).toEqual({ input_tokens: 2 });
  });

  it("empty in, empty out", () => {
    expect(canonicalizeUsageKeys({})).toEqual({});
  });
});

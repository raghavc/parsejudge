import { describe, expect, it } from "vitest";
import { isRetryableResponse } from "../src/http.ts";

describe("isRetryableResponse", () => {
  it("retries AWS throttles that arrive as HTTP 400", () => {
    expect(
      isRetryableResponse(400, '{"__type":"ProvisionedThroughputExceededException","Message":"Provisioned rate exceeded"}'),
    ).toBe(true);
    expect(isRetryableResponse(400, '{"__type":"com.amazonaws#ThrottlingException"}')).toBe(true);
  });

  it("does not retry other 400s", () => {
    expect(isRetryableResponse(400, '{"__type":"InvalidParameterException","Message":"bad"}')).toBe(false);
    expect(isRetryableResponse(400, "ProvisionedThroughputExceededException")).toBe(false);
  });

  it("keeps status-based retries", () => {
    expect(isRetryableResponse(429, "")).toBe(true);
    expect(isRetryableResponse(503, "")).toBe(true);
  });
});

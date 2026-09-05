import { describe, expect, it } from "vitest";
import { buildTransactionsRedirectPath } from "./page";

describe("buildTransactionsRedirectPath", () => {
  it("redirects to the transactions tab with no extra params when none were given", () => {
    expect(buildTransactionsRedirectPath({})).toBe("/app/dashboard?tab=transactions");
  });

  it("carries type/categoryId/page over unchanged", () => {
    expect(buildTransactionsRedirectPath({ type: "income", categoryId: "3", page: "2" })).toBe(
      "/app/dashboard?tab=transactions&type=income&categoryId=3&page=2"
    );
  });

  it("omits only the params that were absent", () => {
    expect(buildTransactionsRedirectPath({ categoryId: "5" })).toBe("/app/dashboard?tab=transactions&categoryId=5");
  });
});

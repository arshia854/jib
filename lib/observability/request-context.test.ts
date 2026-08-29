import { describe, it, expect } from "vitest";
import { getRequestId, runWithRequestContext } from "@/lib/observability/request-context";

describe("request-context", () => {
  it("returns undefined outside any runWithRequestContext scope", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("returns the requestId inside a runWithRequestContext scope", () => {
    runWithRequestContext({ requestId: "req-1" }, () => {
      expect(getRequestId()).toBe("req-1");
    });
  });

  it("returns undefined again once the scope has exited", () => {
    runWithRequestContext({ requestId: "req-1" }, () => {});
    expect(getRequestId()).toBeUndefined();
  });

  it("is visible to nested async calls inside the same scope", async () => {
    async function inner() {
      await Promise.resolve();
      return getRequestId();
    }

    const result = await runWithRequestContext({ requestId: "req-async" }, () => inner());
    expect(result).toBe("req-async");
  });

  it("keeps concurrent overlapping scopes isolated from each other", async () => {
    async function run(id: string, delayMs: number) {
      return runWithRequestContext({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return getRequestId();
      });
    }

    const [a, b] = await Promise.all([run("req-a", 20), run("req-b", 5)]);
    expect(a).toBe("req-a");
    expect(b).toBe("req-b");
  });

  it("propagates the return value of fn", () => {
    const result = runWithRequestContext({ requestId: "req-x" }, () => 42);
    expect(result).toBe(42);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const world = { start: vi.fn(async () => {}) };

vi.mock("workflow/runtime", () => ({
  getWorld: vi.fn(() => world),
  healthCheck: vi.fn(async () => ({ healthy: true, latencyMs: 5 })),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(),
}));

import { getWorld, healthCheck } from "workflow/runtime";
import { reportError } from "@/lib/observability/report-error";
import { startWorkflowWorld } from "@/lib/workflows/start-world";

beforeEach(() => {
  vi.clearAllMocks();
  world.start.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startWorkflowWorld", () => {
  it("starts the world so interrupted runs get re-enqueued", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await startWorkflowWorld();

    expect(world.start).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a start failure instead of throwing, and skips the warm-up", async () => {
    vi.stubEnv("NODE_ENV", "development");
    world.start.mockRejectedValueOnce(new Error("data dir version mismatch"));

    await expect(startWorkflowWorld()).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("tolerates a world with no start()", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(getWorld).mockReturnValueOnce({} as ReturnType<typeof getWorld>);

    await expect(startWorkflowWorld()).resolves.toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("warms up the flow then step routes in development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    await startWorkflowWorld();

    await vi.waitFor(() => expect(healthCheck).toHaveBeenCalledTimes(2));
    expect(vi.mocked(healthCheck).mock.calls.map((call) => call[1])).toEqual(["workflow", "step"]);
  });

  it("does not warm up outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await startWorkflowWorld();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(healthCheck).not.toHaveBeenCalled();
  });
});

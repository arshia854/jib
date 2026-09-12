// @vitest-environment jsdom
// Same jsdom-scoping precedent as add-transaction-form.test.tsx's own
// top-of-file comment.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { TransferForm } from "@/components/transactions/transfer-form";

const accounts = [
  { id: 1, name: "نقدی", type: "cash" },
  { id: 2, name: "پس‌انداز", type: "savings" },
];

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  refreshMock.mockClear();
  vi.unstubAllGlobals();
});

describe("TransferForm - happy path submit", () => {
  it("submits fromAccountId/toAccountId/amount to POST /api/transfers and navigates to the accounts page on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transferGroupId: "g1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TransferForm accounts={accounts} />);

    fireEvent.change(screen.getByPlaceholderText("۰"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: /ثبت انتقال/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/transfers");
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ fromAccountId: 1, toAccountId: 2, amount: 50000 });

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/settings/accounts"));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("shows the server's error message and does not navigate when the request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "دسته‌بندی انتقال بین حساب‌ها برای این کاربر یافت نشد." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TransferForm accounts={accounts} />);

    fireEvent.change(screen.getByPlaceholderText("۰"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: /ثبت انتقال/ }));

    expect(await screen.findByText("دسته‌بندی انتقال بین حساب‌ها برای این کاربر یافت نشد.")).toBeDefined();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("TransferForm - same-account validation", () => {
  // The mutual from/to exclusion filter (each select drops whichever
  // account is currently chosen on the *other* side) means a real two-
  // account form can never actually reach a same-account submit through
  // normal interaction - that filter is exactly what prevents it. The one
  // way this guard is still reachable is the state it's actually
  // defending: a caller rendering the form with only one real account
  // (accounts.length < 2 is normally caught one layer up, by
  // app/app/transfer/page.tsx's own EmptyState gate - see that file) - both
  // selects then default to that single id, and this test exercises the
  // component's own defense-in-depth check for exactly that case, same
  // "belt and suspenders" reasoning as lib/data/transfers.ts's own
  // createTransfer() re-checking what its API route already validated.
  it("rejects submitting when only one account is available (from/to default to the same id), without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<TransferForm accounts={[accounts[0]]} />);

    fireEvent.change(screen.getByPlaceholderText("۰"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: /ثبت انتقال/ }));

    expect(await screen.findByText("حساب مبدا و مقصد نمی‌توانند یکسان باشند.")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

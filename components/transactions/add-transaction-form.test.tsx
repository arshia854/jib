// @vitest-environment jsdom
//
// This is the first component test in the repo - there's no existing
// component-test pattern to follow (only lib/ and API-route unit tests, all
// running under the default `node` environment - see vitest.config.ts). The
// `@vitest-environment jsdom` docblock above scopes jsdom to just this file
// so the rest of the suite keeps running under `node`, and
// @testing-library/react/@testing-library/dom/jsdom were added as
// devDependencies to support it.
//
// fake-indexeddb/auto polyfills IndexedDB, which jsdom itself doesn't
// implement (see lib/offline/transaction-queue.test.ts's own comment) -
// needed here because saveTransaction() now writes to the offline queue
// (lib/offline/transaction-queue.ts) on every create submit.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listQueuedTransactions, deleteQueuedTransaction } from "@/lib/offline/transaction-queue";
import { formatJalaaliDate, formatToman } from "@/lib/format";
import { FALLBACK_EXPENSE_CATEGORY, FALLBACK_INCOME_CATEGORY } from "@/lib/categories";
import { tehranIsoDate } from "@/lib/extract-date";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AddTransactionForm } from "@/components/transactions/add-transaction-form";

const categories = [
  { id: 1, name: "خوراک", icon: "🍔", color: "#f00", type: "expense" },
  { id: 2, name: "حقوق", icon: "💰", color: "#0f0", type: "income" },
];

const accounts = [{ id: 1, name: "نقدی", type: "cash" }];

// Mirrors add-transaction-form.tsx's own TRANSACTION_QUICK_SELECT_OPTIONS
// "دیروز" (yesterday) offset exactly - lets these tests assert against the
// picker's actual quick-select button without hardcoding an arbitrary date.
function yesterdayDate(): string {
  return tehranIsoDate(new Date(), -1);
}

const TODAY_ISO = tehranIsoDate();

function parsedTransaction(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    amount: 50000,
    type: "expense",
    category: "سایر",
    description: "قهوه",
    date: "2026-08-06",
    source: "ai",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The fresh "add" input stage's inline live-preview card (triggered by a
// "پردازش" button that called POST /api/transactions/parse before showing
// results inline) was removed - the input stage now offers only "ثبت
// تراکنش" (quick submit, handleQuickSubmit), which saves immediately with
// no synchronous AI call. The "suggested new category" prompt itself still
// exists and is still covered - just on the full preview stage below
// (isFromSuggestion/isEdit), the only place ParsedTransaction.suggestedCategory
// can still reach the UI.
describe("AddTransactionForm - suggested new category prompt (full preview stage)", () => {
  it("renders the prompt when the transaction carries a suggestedCategory", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction({
          suggestedCategory: { name: "قهوه", parentName: null, reason: "خرید قهوه", icon: "☕" },
        })}
        initialRawInput="۵۰ هزار تومن قهوه خوردم"
      />
    );

    expect(screen.getByText(/براش پیدا نشد — می‌خوای/)).toBeDefined();
    expect(screen.getByRole("button", { name: "بساز" })).toBeDefined();
  });

  it("does not render the prompt when there is no suggestedCategory", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه خوردم"
      />
    );

    expect(screen.queryByText(/براش پیدا نشد — می‌خوای/)).toBeNull();
  });
});

describe("AddTransactionForm - input stage quick submit", () => {
  it("renders one \"ثبت تراکنش\" button and no \"پردازش\" button", () => {
    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    expect(screen.getByRole("button", { name: /ثبت تراکنش/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "پردازش" })).toBeNull();
  });

  it("disables the button until the text has a deterministically-extractable amount", () => {
    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    const button = screen.getByRole("button", { name: /ثبت تراکنش/ });
    expect(button).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    expect(button).toHaveProperty("disabled", false);
  });

  it("submits immediately with no /api/transactions/parse call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/transactions/parse", expect.anything());

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.quick).toBe(true);
  });

  it("shows the detected amount under the text box before submitting", () => {
    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    expect(screen.queryByText(formatToman(50000))).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    expect(screen.getByText(formatToman(50000))).toBeDefined();
  });

  // The full preview form used to flash up (populated with the quick-parse
  // guesses, spinner on "تأیید و ذخیره") for as long as the request took.
  it("stays on the input stage while a quick submit is in flight", async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    expect(screen.getByRole("button", { name: /ثبت تراکنش/ })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "تأیید و ذخیره" })).toBeNull();

    // The never-settling request leaves its offline-queue row behind -
    // clear it so it can't be counted by the queue tests further down.
    const leftover = await listQueuedTransactions();
    await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
  });

  it("falls back to the preview stage with the error when a quick submit is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "دسته‌بندی نامعتبر است." }) })
    );

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    expect(await screen.findByText("دسته‌بندی نامعتبر است.")).toBeDefined();
    expect(screen.getByRole("button", { name: "تأیید و ذخیره" })).toBeDefined();
  });

  it("submits the auto-detected date unchanged when the date field isn't touched", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.date).toBe(TODAY_ISO);
    expect(body.dateIsManual).toBeUndefined();
  });

  it("submits the manually-picked date instead of the auto-detected one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />
    );

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });

    // Native <input type="date"> is gone - pick a date via the Jalali
    // picker's own "دیروز" quick-select option instead.
    expect(container.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(screen.getByText(formatJalaaliDate(TODAY_ISO)));
    fireEvent.click(screen.getByRole("button", { name: "دیروز" }));

    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.date).toBe(yesterdayDate());
    // Tells background enrichment to keep this date rather than re-derive
    // one from the text (which never mentioned it).
    expect(body.dateIsManual).toBe(true);
  });

  it("renders the picked date in Jalali, not Gregorian, on the input stage", () => {
    const { container } = render(
      <AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />
    );

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });

    expect(container.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(screen.getByText(formatJalaaliDate(TODAY_ISO)));
    fireEvent.click(screen.getByRole("button", { name: "دیروز" }));

    const expectedDate = yesterdayDate();
    expect(screen.getByText(formatJalaaliDate(expectedDate))).toBeDefined();
    // The Jalali label is never the raw Gregorian yyyy-mm-dd string.
    expect(screen.queryByText(expectedDate)).toBeNull();
  });

  it("renders no deadline countdown text and the امروز/دیروز/پریروز quick-select buttons", () => {
    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByText(formatJalaaliDate(TODAY_ISO)));

    expect(screen.queryByText(/روز تا موعود|روز از موعود گذشته/)).toBeNull();
    expect(screen.getByRole("button", { name: "امروز" })).toBeDefined();
    expect(screen.getByRole("button", { name: "دیروز" })).toBeDefined();
    expect(screen.getByRole("button", { name: "پریروز" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "۱ ماه" })).toBeNull();
  });

  it("امروز/دیروز/پریروز buttons each set the right date", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });

    const expectedDate = tehranIsoDate(new Date(), -2);

    fireEvent.click(screen.getByText(formatJalaaliDate(TODAY_ISO)));
    fireEvent.click(screen.getByRole("button", { name: "پریروز" }));
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.date).toBe(expectedDate);
  });

  // extractAmount bails on real bank SMS text (several numeric tokens -
  // amount, balance, date/time - not the "exactly one or two" shape it
  // requires), so this exercises the parseBankSms fallback added to
  // buildQuickParsedTransaction/handleQuickSubmit.
  const BANK_SMS = "بانک ملت\nبرداشت: 150,000\nمانده: 2,300,000\n1404/06/21 14:32";

  it("enables the button for a real bank SMS that extractAmount can't parse", () => {
    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    const button = screen.getByRole("button", { name: /ثبت تراکنش/ });
    expect(button).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: BANK_SMS },
    });
    expect(button).toHaveProperty("disabled", false);
  });

  it("submits a bank SMS with the transaction amount (not the balance) and type expense", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: BANK_SMS },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/transactions/parse", expect.anything());

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.amount).toBe(150000);
    expect(body.type).toBe("expense");
    expect(body.quick).toBe(true);
  });

  // A real bank SMS with a واریز (deposit) keyword: extractAmount bails
  // (several numeric tokens), so type comes from parseBankSms's own
  // extractBankType detection - not extractIncomeSignal, which doesn't
  // contain "واریز" and isn't consulted on this branch at all.
  const BANK_INCOME_SMS =
    "بانک تجارت\nحساب:0145059220990\nواریز:2,000,000 ریال\nاز طریق: شتاب\nمانده:134,866 ریال";

  async function quickSubmit(text: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ transaction: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
    const [, requestInit] = fetchMock.mock.calls[0];
    return JSON.parse(requestInit.body as string);
  }

  it("quick-submits plain text with an income keyword as income + the fallback income category", async () => {
    const body = await quickSubmit("واریزی حقوق ۳۰ میلیون");

    expect(body.amount).toBe(30_000_000);
    expect(body.type).toBe("income");
    expect(body.category).toBe(FALLBACK_INCOME_CATEGORY);
    expect(body.quick).toBe(true);
  });

  it("leaves an ordinary expense-like quick-submit as expense + the fallback expense category", async () => {
    const body = await quickSubmit("۵۰ هزار تومن قهوه خوردم");

    expect(body.type).toBe("expense");
    expect(body.category).toBe(FALLBACK_EXPENSE_CATEGORY);
  });

  it("does not treat a bare واریز in typed text as income", async () => {
    const body = await quickSubmit("۵۰۰ هزار به علی واریز کردم");

    expect(body.type).toBe("expense");
    expect(body.category).toBe(FALLBACK_EXPENSE_CATEGORY);
  });

  it("still routes a bank-SMS-shaped income text through parseBankSms's own path", async () => {
    const body = await quickSubmit(BANK_INCOME_SMS);

    expect(body.amount).toBe(200_000);
    expect(body.type).toBe("income");
    expect(body.category).toBe(FALLBACK_INCOME_CATEGORY);
    expect(body.quick).toBe(true);
  });

  // The input-stage box now shows live thousand separators
  // (components/ui/natural-language-amount-textarea.tsx). Everything below
  // this comment is about the half of that feature which isn't visual: what
  // the box shows must never reach `text`, and therefore never reach
  // extractAmount, the disabled-button check, or `rawInput`.
  describe("live thousand separators in the raw-text box", () => {
    function typeInto(value: string) {
      const textarea = screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم") as HTMLTextAreaElement;
      fireEvent.change(textarea, {
        target: { value, selectionStart: value.length, selectionEnd: value.length },
      });
      return textarea;
    }

    it("shows a grouped amount while still enabling the button from the plain value", () => {
      render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

      const button = screen.getByRole("button", { name: /ثبت تراکنش/ });
      expect(button).toHaveProperty("disabled", true);

      const textarea = typeInto("5646132");

      expect(textarea.value).toBe("۵٬۶۴۶٬۱۳۲");
      expect(button).toHaveProperty("disabled", false);
    });

    it("sends a rawInput with no separator in it, and the amount extraction is unchanged", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ transaction: { id: 1 } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

      typeInto("5646132 ناهار خوردم");
      fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
      const [, requestInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body.rawInput).toBe("5646132 ناهار خوردم");
      expect(body.rawInput).not.toMatch(/[,٬]/);
      expect(body.amount).toBe(5646132);
    });

    it("keeps a pasted bank SMS's own commas in rawInput so the amount still parses", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ transaction: { id: 1 } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

      typeInto(BANK_SMS);
      fireEvent.click(screen.getByRole("button", { name: /ثبت تراکنش/ }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions", expect.anything()));
      const [, requestInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body.rawInput).toBe(BANK_SMS);
      expect(body.amount).toBe(150000);
    });
  });
});

describe("AddTransactionForm - preview stage date picker", () => {
  it("renders the picked date in Jalali, not Gregorian, on the preview stage", () => {
    const { container } = render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );

    expect(container.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(screen.getByText(formatJalaaliDate("2026-08-06")));
    fireEvent.click(screen.getByRole("button", { name: "دیروز" }));

    const expectedDate = yesterdayDate();
    expect(screen.getByText(formatJalaaliDate(expectedDate))).toBeDefined();
    expect(screen.queryByText(expectedDate)).toBeNull();
  });

  it("renders no deadline countdown text and the امروز/دیروز/پریروز quick-select buttons", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );

    fireEvent.click(screen.getByText(formatJalaaliDate("2026-08-06")));

    expect(screen.queryByText(/روز تا موعود|روز از موعود گذشته/)).toBeNull();
    expect(screen.getByRole("button", { name: "امروز" })).toBeDefined();
    expect(screen.getByRole("button", { name: "دیروز" })).toBeDefined();
    expect(screen.getByRole("button", { name: "پریروز" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "۱ ماه" })).toBeNull();
  });
});

// The account <select> only exists on the preview stage (the input stage
// has no account field at all - accountId there is just state, defaulted
// via defaultAccountId or set once a bank account is created), so this hint
// only ever needs covering there.
describe("AddTransactionForm - savings account transfer hint (preview stage)", () => {
  const accountsWithSavings = [
    { id: 1, name: "نقدی", type: "cash" },
    { id: 2, name: "پس‌انداز من", type: "savings" },
  ];

  it("shows the /app/transfer hint when a savings account is selected", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accountsWithSavings}
        defaultAccountId={2}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );

    expect(screen.getByText(/صفحه‌ی انتقال داخلی راحت‌تره/)).toBeDefined();
    const link = screen.getByRole("link", { name: "رفتن به انتقال" });
    expect(link.getAttribute("href")).toBe("/app/transfer");
  });

  it("shows no hint for a non-savings account", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accountsWithSavings}
        defaultAccountId={1}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );

    expect(screen.queryByText(/صفحه‌ی انتقال داخلی راحت‌تره/)).toBeNull();
    expect(screen.queryByRole("link", { name: "رفتن به انتقال" })).toBeNull();
  });

  it("shows/hides the hint reactively when switching accounts via the select", () => {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accountsWithSavings}
        defaultAccountId={1}
        initialTransaction={parsedTransaction()}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );

    expect(screen.queryByText(/صفحه‌ی انتقال داخلی راحت‌تره/)).toBeNull();

    fireEvent.change(screen.getByDisplayValue("💵 نقدی"), { target: { value: "2" } });
    expect(screen.getByText(/صفحه‌ی انتقال داخلی راحت‌تره/)).toBeDefined();

    fireEvent.change(screen.getByDisplayValue("🏦 پس‌انداز من"), { target: { value: "1" } });
    expect(screen.queryByText(/صفحه‌ی انتقال داخلی راحت‌تره/)).toBeNull();
  });
});

describe("AddTransactionForm - confidence-aware confirmation hint (Phase 8)", () => {
  function renderPreview(overrides: Partial<ParsedTransaction>) {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction(overrides)}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );
  }

  it("shows the low-confidence hint when categorizationConfidence is low", () => {
    renderPreview({ needsConfirmation: true, categorizationConfidence: "low" });
    expect(screen.getByText("دسته‌بندی را مطمئن نیستم، لطفاً خودت انتخاب کن")).toBeDefined();
  });

  it("shows the existing softer hint when categorizationConfidence is medium", () => {
    renderPreview({ needsConfirmation: true, categorizationConfidence: "medium" });
    expect(screen.getByText("دسته‌بندی پیشنهادی است، لطفاً خودت بررسی کن")).toBeDefined();
  });

  it("shows the bank-sms hint regardless of categorizationConfidence", () => {
    renderPreview({ needsConfirmation: true, source: "bank-sms", categorizationConfidence: "low" });
    expect(screen.getByText("چی خریدی؟ کمکم کن درست دسته‌بندی‌ش کنم 🙂")).toBeDefined();
  });

  it("shows no confirmation hint at all when needsConfirmation is false", () => {
    renderPreview({ needsConfirmation: false, categorizationConfidence: "high" });
    expect(screen.queryByText(/دسته‌بندی را مطمئن نیستم/)).toBeNull();
    expect(screen.queryByText(/دسته‌بندی پیشنهادی است/)).toBeNull();
  });
});

describe("AddTransactionForm - offline transaction queue", () => {
  // Skips straight to the "preview" stage with a ready-to-submit
  // transaction (same mechanism the chat assistant's "ویرایش کن" handoff
  // uses - see app/app/add/page.tsx's parseSuggestionParams) - these tests
  // are about saveTransaction()'s queue behavior, not the parse flow
  // already covered above.
  const initialTransaction = parsedTransaction();

  afterEach(async () => {
    // The IndexedDB store is module-level (like the real one) and persists
    // across tests in this file - clear it so one test's leftover queued
    // item can't be counted by the next test's assertions.
    const leftover = await listQueuedTransactions();
    await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
  });

  function renderReadyToSubmit() {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={initialTransaction}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );
  }

  it("queues the transaction and shows no inline error when the network is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    await waitFor(async () => {
      const queued = await listQueuedTransactions();
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("pending");
      expect(queued[0].payload.amount).toBe(initialTransaction.amount);
      expect(queued[0].payload.category).toBe(initialTransaction.category);
    });
    // The offline case is treated as an optimistic success (see
    // saveTransaction()'s own comment) - no inline error banner, unlike the
    // server-rejection case below.
    expect(screen.queryByText("یه مشکلی پیش اومد، دوباره تلاش کن.")).toBeNull();
  });

  it("removes the queued item once the server confirms the create (online, happy path unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 1 } }) })
    );
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    await waitFor(async () => {
      expect(await listQueuedTransactions()).toHaveLength(0);
    });
  });

  it("removes the queued item and still shows the inline error on a real server-side rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "دسته‌بندی نامعتبر است." }) })
    );
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    expect(await screen.findByText("دسته‌بندی نامعتبر است.")).toBeDefined();
    await waitFor(async () => {
      expect(await listQueuedTransactions()).toHaveLength(0);
    });
  });
});

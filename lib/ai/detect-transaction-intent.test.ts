import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/nvidia-ai";
import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";

describe("detectTransactionIntent", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  it("returns true for a clear past unlogged expense", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": true}');
    const result = await detectTransactionIntent("دیروز ۲۰۰ تومن آبمیوه خوردم یادم رفت ثبت کنم");
    expect(result).toEqual({ isPastUnloggedTransaction: true });
  });

  it("returns false for a general financial question", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": false}');
    const result = await detectTransactionIntent("این ماه بیشتر کجا خرج کردم؟");
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("strips a ```json fence the same way parse-transaction's extractJson does", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('```json\n{"isPastUnloggedTransaction": true}\n```');
    const result = await detectTransactionIntent("پریروز ۵۰ تومن قهوه خوردم، ثبت نکردم");
    expect(result).toEqual({ isPastUnloggedTransaction: true });
  });

  it("fails safe to false on malformed JSON", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("not json at all");
    const result = await detectTransactionIntent("سلام");
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("fails safe to false when the key is missing", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("{}");
    const result = await detectTransactionIntent("سلام");
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("fails safe to false when the upstream call throws", async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new Error("network error"));
    const result = await detectTransactionIntent("سلام");
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("treats any non-true value for the key as false (not just literal false)", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": "yes"}');
    const result = await detectTransactionIntent("سلام");
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });
});

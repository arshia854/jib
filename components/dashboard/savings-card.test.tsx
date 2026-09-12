// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SavingsCard } from "@/components/dashboard/savings-card";

afterEach(() => {
  cleanup();
});

describe("SavingsCard", () => {
  it("renders the given balance formatted the same way balance-card.tsx formats its own (formatToman, Eastern-Arabic digits)", () => {
    render(<SavingsCard balance={2540000} />);

    expect(screen.getByText("۲٬۵۴۰٬۰۰۰ تومان")).toBeDefined();
    expect(screen.getByText("پس‌انداز")).toBeDefined();
  });

  it("renders zero the same way any other amount is rendered, not a blank/omitted state", () => {
    render(<SavingsCard balance={0} />);

    expect(screen.getByText("۰ تومان")).toBeDefined();
  });
});

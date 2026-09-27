// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AmountInput } from "@/components/ui/amount-input";

afterEach(cleanup);

// Small controlled-input wrapper so onChange updates actually re-render the
// component with the new `value`, the way every real call site uses it.
function ControlledAmountInput({
  initial = 0,
  onChange,
}: {
  initial?: number;
  onChange?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AmountInput
      value={value}
      onChange={(next: number) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("AmountInput", () => {
  it("shows commas progressively as digits are typed", () => {
    render(<ControlledAmountInput />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("۵");

    fireEvent.change(input, { target: { value: "50" } });
    expect(input.value).toBe("۵۰");

    fireEvent.change(input, { target: { value: "5000" } });
    expect(input.value).toBe("۵٬۰۰۰");

    fireEvent.change(input, { target: { value: "5000000" } });
    expect(input.value).toBe("۵٬۰۰۰٬۰۰۰");
  });

  it("parses a pasted comma-containing string into a clean number", () => {
    const onChange = vi.fn();
    render(<ControlledAmountInput onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1,000,000" } });

    expect(onChange).toHaveBeenLastCalledWith(1000000);
    expect(input.value).toBe("۱٬۰۰۰٬۰۰۰");
  });

  it("clears and allows retyping", () => {
    const onChange = vi.fn();
    render(<ControlledAmountInput initial={12345} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("۱۲٬۳۴۵");

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith(0);

    fireEvent.change(input, { target: { value: "9" } });
    expect(input.value).toBe("۹");
    expect(onChange).toHaveBeenLastCalledWith(9);
  });

  it("normalizes Eastern Arabic digit input", () => {
    const onChange = vi.fn();
    render(<ControlledAmountInput onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "۱۲۳۴۵۶" } });

    expect(onChange).toHaveBeenLastCalledWith(123456);
    expect(input.value).toBe("۱۲۳٬۴۵۶");
  });

  it("always calls onChange with a clean number, never a comma-containing string", () => {
    const onChange = vi.fn();
    render(<ControlledAmountInput onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "2500000" } });

    for (const call of onChange.mock.calls) {
      expect(typeof call[0]).toBe("number");
    }
    expect(onChange).toHaveBeenLastCalledWith(2500000);
  });

  it("handles leading zeros by normalizing the parsed number", () => {
    const onChange = vi.fn();
    render(<ControlledAmountInput onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "0005" } });

    expect(onChange).toHaveBeenLastCalledWith(5);
    expect(input.value).toBe("۵");
  });
});

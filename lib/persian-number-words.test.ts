import { describe, it, expect } from "vitest";
import { normalizePersianNumberWords } from "@/lib/persian-number-words";

describe("normalizePersianNumberWords", () => {
  it("converts a ones word", () => {
    expect(normalizePersianNumberWords("پنج")).toBe("5");
  });

  it("converts a teens word", () => {
    expect(normalizePersianNumberWords("دوازده")).toBe("12");
  });

  it("converts a tens word", () => {
    expect(normalizePersianNumberWords("سی")).toBe("30");
  });

  it('converts "X و Y" combinations (tens + ones)', () => {
    expect(normalizePersianNumberWords("سی و پنج")).toBe("35");
  });

  it('converts "X و Y" combinations (hundred-scale + tens)', () => {
    expect(normalizePersianNumberWords("صد و بیست")).toBe("120");
  });

  it("converts a compound hundreds word", () => {
    expect(normalizePersianNumberWords("دویست")).toBe("200");
  });

  it("converts a bare صد", () => {
    expect(normalizePersianNumberWords("صد")).toBe("100");
  });

  it("converts a bare scale word", () => {
    expect(normalizePersianNumberWords("هزار")).toBe("1000");
  });

  it("applies هزار as a scale multiplier", () => {
    expect(normalizePersianNumberWords("سه هزار")).toBe("3000");
  });

  it("applies میلیون as a scale multiplier", () => {
    expect(normalizePersianNumberWords("سه میلیون")).toBe("3000000");
  });

  it("composes hundreds + هزار", () => {
    expect(normalizePersianNumberWords("دویست و پنجاه هزار")).toBe("250000");
  });

  it("composes across میلیون and هزار groups", () => {
    expect(normalizePersianNumberWords("یک میلیون و دویست هزار")).toBe("1200000");
  });

  it("leaves an unrelated word containing a number word as a substring untouched", () => {
    expect(normalizePersianNumberWords("سیگار")).toBe("سیگار");
  });

  it("converts only the number-word run inside a longer sentence", () => {
    expect(normalizePersianNumberWords("سی تومن سیگار")).toBe("30 تومن سیگار");
  });

  it("leaves an unrelated و alone (not adjacent to a number word)", () => {
    expect(normalizePersianNumberWords("من و علی")).toBe("من و علی");
  });

  it("stops the run at a trailing و not followed by a number word", () => {
    expect(normalizePersianNumberWords("سی و علی")).toBe("30 و علی");
  });

  it("leaves digit-based numbers untouched", () => {
    expect(normalizePersianNumberWords("۵۰ تومن")).toBe("۵۰ تومن");
  });

  it("leaves plain text with no number words untouched", () => {
    expect(normalizePersianNumberWords("ناهار خوردم")).toBe("ناهار خوردم");
  });

  it("skips conversion entirely when a digit-based number appears anywhere in the text, even alongside an unrelated word that happens to be a number word", () => {
    // "هفتاد" (seventy) here is part of a merchant name, unrelated to the
    // real, digit-based amount later in the text - converting it would
    // manufacture a second, colliding numeric token.
    expect(normalizePersianNumberWords("فروشگاه ناشناخته هفتاد ۵۰ هزار تومن")).toBe(
      "فروشگاه ناشناخته هفتاد ۵۰ هزار تومن"
    );
  });

  describe("word-order validation (rejects non-idiomatic compositions rather than guessing)", () => {
    it('rejects "tens و hundreds" (wrong order - real Persian only ever says it the other way around)', () => {
      expect(normalizePersianNumberWords("پنجاه و صد")).toBe("پنجاه و صد");
    });

    it("rejects a malformed run inside a longer sentence without touching the rest of the sentence", () => {
      expect(normalizePersianNumberWords("دیجی کالا پنجاه و صد تومن")).toBe("دیجی کالا پنجاه و صد تومن");
    });

    it("rejects two ones-tier words joined by و", () => {
      expect(normalizePersianNumberWords("پنج و پنج")).toBe("پنج و پنج");
    });
  });
});

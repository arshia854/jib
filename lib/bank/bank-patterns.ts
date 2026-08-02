import type { BankPattern } from "./types";

/**
 * Bank SMS detection patterns — pure data, no logic here.
 *
 * How to add a new bank:
 * 1. Add a new member to the `Bank` union in `./types.ts`.
 * 2. Append a new `BankPattern` entry below with:
 *    - One dominant rule (score ~100) that is a unique signal for that bank —
 *      the bank's own name, or a structural phrase unique to that bank's SMS
 *      (e.g. "از طریق: شتاب" for Tejarat, "علی عزیز" for Blu).
 *    - Optional low-score (5-10) generic rules as weak corroborating signals.
 *
 * Keyword collisions:
 * Generic keywords (برداشت، مانده، حساب، خرید، موجودی) show up in real SMS
 * from many banks, so they must always carry LOW scores (5-10). A bank's
 * dominant rule must be its single most distinguishing signal, never a
 * generic term shared across banks.
 *
 * Where no confirmed unique phrase exists yet, the bank-name rule is still
 * kept as the dominant (~100) rule, with a `// TODO: verify with real SMS
 * sample` comment above that bank's block as a reminder to revisit once
 * real SMS samples are collected.
 */
export const BANK_PATTERNS: BankPattern[] = [
  // TODO: Mellat detection needs a structural/positional rule, not just
  // keywords — revisit once more real Mellat SMS samples are available
  {
    bank: "mellat",
    rules: [
      { id: "mellat-bank-name", score: 100, keywords: ["بانک ملت"] },
      { id: "mellat-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "mellat-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  {
    bank: "sepah",
    rules: [
      { id: "sepah-bank-name", score: 100, keywords: ["بانک سپه"] },
      {
        id: "sepah-pos-purchase",
        score: 15,
        keywords: ["خرید پایانه فروش"],
      },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "saderat",
    rules: [
      { id: "saderat-bank-name", score: 100, keywords: ["بانک صادرات"] },
      { id: "saderat-pos-terminal", score: 20, keywords: ["پایانه فروش"] },
      { id: "saderat-account-label", score: 5, keywords: ["حساب:"] },
      { id: "saderat-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  {
    bank: "tejarat",
    rules: [
      { id: "tejarat-bank-name", score: 100, keywords: ["بانک تجارت"] },
      { id: "tejarat-via-clause", score: 15, keywords: ["از طریق"] },
      { id: "tejarat-shatab-channel", score: 10, keywords: ["شتاب"] },
    ],
  },
  {
    bank: "refah",
    rules: [
      { id: "refah-bank-name", score: 100, keywords: ["بانک رفاه"] },
      { id: "refah-purchase", score: 5, keywords: ["خرید"] },
      { id: "refah-account", score: 5, keywords: ["حساب"] },
    ],
  },
  {
    bank: "blu",
    rules: [
      { id: "blu-brand-name", score: 100, keywords: ["بلو"] },
      { id: "blu-cash-withdrawal", score: 15, keywords: ["برداشت پول"] },
      { id: "blu-personal-greeting", score: 15, keywords: ["علی عزیز"] },
      {
        id: "blu-account-debit-slang",
        score: 15,
        keywords: ["از حساب شما پرید"],
      },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "melli",
    rules: [
      { id: "melli-bank-name", score: 100, keywords: ["بانک ملی"] },
      { id: "melli-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "melli-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample (possible "SB"/"بام" prefix — confirm before adding)
  {
    bank: "saman",
    rules: [
      { id: "saman-bank-name", score: 100, keywords: ["بانک سامان"] },
      { id: "saman-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "parsian",
    rules: [
      { id: "parsian-bank-name", score: 100, keywords: ["بانک پارسیان"] },
      { id: "parsian-payment", score: 10, keywords: ["پرداخت"] },
      { id: "parsian-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "pasargad",
    rules: [
      { id: "pasargad-bank-name", score: 100, keywords: ["بانک پاسارگاد"] },
      { id: "pasargad-purchase", score: 10, keywords: ["خرید"] },
      { id: "pasargad-available-balance", score: 5, keywords: ["موجودی"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "post",
    rules: [
      { id: "post-bank-name", score: 100, keywords: ["پست بانک"] },
      { id: "post-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "post-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "keshavarzi",
    rules: [
      { id: "keshavarzi-bank-name", score: 100, keywords: ["بانک کشاورزی"] },
      { id: "keshavarzi-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "keshavarzi-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "maskan",
    rules: [
      { id: "maskan-bank-name", score: 100, keywords: ["بانک مسکن"] },
      { id: "maskan-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "maskan-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "ayandeh",
    rules: [
      { id: "ayandeh-bank-name", score: 100, keywords: ["بانک آینده"] },
      { id: "ayandeh-purchase", score: 10, keywords: ["خرید"] },
      { id: "ayandeh-available-balance", score: 5, keywords: ["موجودی"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "shahr",
    rules: [
      { id: "shahr-bank-name", score: 100, keywords: ["بانک شهر"] },
      { id: "shahr-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "shahr-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "karafarin",
    rules: [
      { id: "karafarin-bank-name", score: 100, keywords: ["بانک کارآفرین"] },
      { id: "karafarin-withdrawal", score: 10, keywords: ["برداشت"] },
      { id: "karafarin-balance", score: 5, keywords: ["مانده"] },
    ],
  },
  // TODO: verify with real SMS sample
  {
    bank: "eghtesad-novin",
    rules: [
      {
        id: "eghtesad-novin-bank-name",
        score: 100,
        keywords: ["اقتصاد نوین"],
      },
      { id: "eghtesad-novin-purchase", score: 10, keywords: ["خرید"] },
      { id: "eghtesad-novin-balance", score: 5, keywords: ["مانده"] },
    ],
  },
];

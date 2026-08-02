export type Bank =
  | "mellat"
  | "sepah"
  | "saderat"
  | "tejarat"
  | "refah"
  | "blu"
  | "melli"
  | "saman"
  | "parsian"
  | "pasargad"
  | "post"
  | "keshavarzi"
  | "maskan"
  | "ayandeh"
  | "shahr"
  | "karafarin"
  | "eghtesad-novin"
  | "unknown";

export interface DetectionResult {
  bank: Bank;
  confidence: number;
  matchedRules: string[];
}

export interface BankPattern {
  bank: Bank;
  rules: Rule[];
}

export interface Rule {
  id: string;
  score: number;
  keywords: string[];
}

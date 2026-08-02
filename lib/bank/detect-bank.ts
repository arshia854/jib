import { normalizeText } from "./normalize";
import { BANK_PATTERNS } from "./bank-patterns";
import type { Bank, DetectionResult, Rule, BankPattern } from "./types";

// Minimum winning score to accept a match.
export const MIN_CONFIDENCE_SCORE = 50;
// Minimum score gap between the top two banks needed to avoid ambiguity.
export const TIE_THRESHOLD = 10;

interface BankScore {
  bank: Bank;
  score: number;
  totalPossible: number;
  matchedRuleIds: string[];
}

function ruleMatches(rule: Rule, normalizedText: string): boolean {
  return rule.keywords.some((keyword) => normalizedText.includes(keyword));
}

function scoreBank(pattern: BankPattern, normalizedText: string): BankScore {
  const matchedRules = pattern.rules.filter((rule) =>
    ruleMatches(rule, normalizedText)
  );

  return {
    bank: pattern.bank,
    score: matchedRules.reduce((sum, rule) => sum + rule.score, 0),
    totalPossible: pattern.rules.reduce((sum, rule) => sum + rule.score, 0),
    matchedRuleIds: matchedRules.map((rule) => rule.id),
  };
}

function toUnknownResult(): DetectionResult {
  return { bank: "unknown", confidence: 0, matchedRules: [] };
}

export function detectBank(rawText: string): DetectionResult {
  const normalizedText = normalizeText(rawText);
  const rankedScores = BANK_PATTERNS.map((pattern) =>
    scoreBank(pattern, normalizedText)
  ).sort((a, b) => b.score - a.score);

  const [winner, runnerUp] = rankedScores;
  const isBelowConfidenceFloor = winner.score < MIN_CONFIDENCE_SCORE;
  const isAmbiguousTie = winner.score - runnerUp.score < TIE_THRESHOLD;

  if (isBelowConfidenceFloor || isAmbiguousTie) {
    return toUnknownResult();
  }

  return {
    bank: winner.bank,
    confidence: winner.score / winner.totalPossible,
    matchedRules: winner.matchedRuleIds,
  };
}

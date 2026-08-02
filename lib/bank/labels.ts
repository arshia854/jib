import type { Bank } from "./types";

// Human-readable Persian display names, keyed by the same Bank union used
// throughout lib/bank/ - kept separate from bank-patterns.ts because those
// are detection keywords (e.g. "بلو", not "بانک بلو"), not display labels.
export const BANK_LABELS: Record<Bank, string> = {
  mellat: "بانک ملت",
  sepah: "بانک سپه",
  saderat: "بانک صادرات",
  tejarat: "بانک تجارت",
  refah: "بانک رفاه",
  blu: "بلو",
  melli: "بانک ملی",
  saman: "بانک سامان",
  parsian: "بانک پارسیان",
  pasargad: "بانک پاسارگاد",
  post: "پست بانک",
  keshavarzi: "بانک کشاورزی",
  maskan: "بانک مسکن",
  ayandeh: "بانک آینده",
  shahr: "بانک شهر",
  karafarin: "بانک کارآفرین",
  "eghtesad-novin": "بانک اقتصاد نوین",
  unknown: "نامشخص",
};

export function getBankLabel(bank: Bank): string {
  return BANK_LABELS[bank];
}

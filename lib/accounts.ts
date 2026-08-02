export type AccountType = "cash" | "bank" | "savings" | "credit";

export interface AccountTypeOption {
  value: AccountType;
  label: string;
  icon: string;
}

export const ACCOUNT_TYPES: AccountTypeOption[] = [
  { value: "cash", label: "نقدی", icon: "💵" },
  { value: "bank", label: "حساب بانکی", icon: "💳" },
  { value: "savings", label: "پس‌انداز", icon: "🏦" },
  { value: "credit", label: "کارت اعتباری", icon: "💠" },
];

export function getAccountTypeIcon(type: string): string {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.icon ?? "👛";
}

export function getAccountTypeLabel(type: string): string {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.label ?? type;
}

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

export interface AccountOption {
  id: number;
  name: string;
  type: string;
}

export function findMatchingAccount(accounts: AccountOption[], bankLabel: string): AccountOption | null {
  return accounts.find((a) => a.type === "bank" && a.name === bankLabel) ?? null;
}

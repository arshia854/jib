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

// Default endpoints for the "do this transfer now" shortcut (savings page's
// per-strategy button, dashboard's income-reaction banner): into the first
// savings-type account, out of the first non-savings one. Either can be
// undefined (no savings account yet / only savings accounts), in which case
// callers omit the shortcut rather than linking to a half-filled transfer.
export function pickDefaultTransferAccounts(accounts: AccountOption[]): {
  from: AccountOption | undefined;
  to: AccountOption | undefined;
} {
  return {
    from: accounts.find((a) => a.type !== "savings"),
    to: accounts.find((a) => a.type === "savings"),
  };
}

export function findMatchingAccount(accounts: AccountOption[], bankLabel: string): AccountOption | null {
  return accounts.find((a) => a.type === "bank" && a.name === bankLabel) ?? null;
}

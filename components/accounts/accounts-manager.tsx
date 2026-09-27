"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PlusIcon, EditIcon, TrashIcon, XIcon, CheckIcon, SpinnerIcon, TransferIcon } from "@/components/icons";
import { ACCOUNT_TYPES, getAccountTypeIcon, type AccountType } from "@/lib/accounts";
import { AmountInput } from "@/components/ui/amount-input";

interface Account {
  id: number;
  name: string;
  type: string;
  initialBalance: number;
  transactionCount: number;
}

interface FormState {
  id: number | null;
  name: string;
  type: AccountType;
  initialBalance: string;
}

const EMPTY_FORM: FormState = { id: null, name: "", type: "cash", initialBalance: "0" };

export function AccountsManager({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
  }

  function openEdit(account: Account) {
    setForm({
      id: account.id,
      name: account.name,
      type: account.type as AccountType,
      initialBalance: String(account.initialBalance),
    });
    setError(null);
  }

  async function handleSave() {
    if (!form || !form.name.trim()) {
      setError("نام حساب الزامی است.");
      return;
    }
    const initialBalance = Number(form.initialBalance);
    if (!Number.isFinite(initialBalance)) {
      setError("موجودی اولیه نامعتبر است.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isEdit = form.id !== null;
      const res = await fetch(isEdit ? `/api/accounts/${form.id}` : "/api/accounts", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), type: form.type, initialBalance }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
      setForm(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 px-4 pb-8 pt-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-foreground">حساب‌ها</h1>
        <div className="flex items-center gap-3">
          {/* Phase A3 (docs/roadmap-status.md savings roadmap): entry point
              for creating a transfer - matches add-transaction's own
              button-to-dedicated-route convention (see app/app/transfer/page.tsx
              and components/layout/fab.tsx), placed here rather than as a
              second global FAB since this page already has the account
              list a transfer needs, and is the natural place to think
              "move money between these." */}
          <Link href="/app/transfer" className="flex items-center gap-1 text-xs font-medium text-accent">
            <TransferIcon className="h-3.5 w-3.5" />
            انتقال
          </Link>
          <button onClick={openCreate} className="flex items-center gap-1 text-xs font-medium text-accent">
            <PlusIcon className="h-3.5 w-3.5" />
            افزودن
          </button>
        </div>
      </header>

      {deleteError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{deleteError}</p>}

      <div className="rounded-2xl border border-border bg-surface px-4">
        {accounts.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">حسابی وجود ندارد.</p>
        ) : (
          accounts.map((account, i) => (
            <div
              key={account.id}
              className={["flex items-center gap-3 py-3", i > 0 ? "border-t border-border" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background text-base">
                {getAccountTypeIcon(account.type)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
                <p className="text-xs text-muted">{account.transactionCount} تراکنش</p>
              </div>
              <button
                onClick={() => openEdit(account)}
                aria-label="ویرایش"
                className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-accent"
              >
                <EditIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleDelete(account.id)}
                disabled={deletingId === account.id}
                aria-label="حذف"
                className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-warning disabled:opacity-50"
              >
                {deletingId === account.id ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <TrashIcon className="h-4 w-4" />
                )}
              </button>
            </div>
          ))
        )}
      </div>

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => !saving && setForm(null)}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-surface p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">{form.id ? "ویرایش حساب" : "حساب جدید"}</h2>
              <button onClick={() => setForm(null)} disabled={saving} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="نام حساب"
              className="w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
            />

            <p className="mt-4 mb-2 text-xs text-muted">نوع حساب</p>
            <div className="grid grid-cols-2 gap-2">
              {ACCOUNT_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm({ ...form, type: t.value })}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium ${
                    form.type === t.value ? "bg-primary text-on-primary" : "bg-background text-muted"
                  }`}
                >
                  <span>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            <label className="mt-4 block text-xs text-muted">موجودی اولیه (تومان)</label>
            <AmountInput
              value={Number(form.initialBalance) || 0}
              onChange={(next) => setForm({ ...form, initialBalance: next ? String(next) : "" })}
            />

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {saving ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              ذخیره
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

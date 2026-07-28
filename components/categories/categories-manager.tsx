"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, EditIcon, TrashIcon, XIcon, CheckIcon, SpinnerIcon } from "@/components/icons";
import type { CategoryType } from "@/lib/categories";

interface Category {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
  transactionCount: number;
}

const COLOR_PRESETS = [
  "#1E3A8A",
  "#3B82F6",
  "#10B981",
  "#EF4444",
  "#F97316",
  "#EC4899",
  "#8B5CF6",
  "#06B6D4",
  "#64748B",
  "#94A3B8",
];

interface FormState {
  id: number | null;
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
}

const EMPTY_FORM: FormState = { id: null, name: "", icon: "🏷️", color: COLOR_PRESETS[0], type: "expense" };

export function CategoriesManager({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const expenseCategories = categories.filter((c) => c.type === "expense");
  const incomeCategories = categories.filter((c) => c.type === "income");

  function openCreate(type: CategoryType) {
    setForm({ ...EMPTY_FORM, type });
    setError(null);
  }

  function openEdit(category: Category) {
    setForm({
      id: category.id,
      name: category.name,
      icon: category.icon,
      color: category.color,
      type: category.type as CategoryType,
    });
    setError(null);
  }

  async function handleSave() {
    if (!form || !form.name.trim() || !form.icon.trim()) {
      setError("نام و آیکون الزامی هستند.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isEdit = form.id !== null;
      const res = await fetch(isEdit ? `/api/categories/${form.id}` : "/api/categories", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), icon: form.icon.trim(), color: form.color, type: form.type }),
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
      const res = await fetch(`/api/categories/${id}`, { method: "DELETE" });
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
      <header>
        <h1 className="text-lg font-bold text-foreground">دسته‌بندی‌ها</h1>
      </header>

      {deleteError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{deleteError}</p>}

      <CategorySection
        title="هزینه‌ها"
        categories={expenseCategories}
        onAdd={() => openCreate("expense")}
        onEdit={openEdit}
        onDelete={handleDelete}
        deletingId={deletingId}
      />
      <CategorySection
        title="درآمدها"
        categories={incomeCategories}
        onAdd={() => openCreate("income")}
        onEdit={openEdit}
        onDelete={handleDelete}
        deletingId={deletingId}
      />

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
          onClick={() => !saving && setForm(null)}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-surface p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">
                {form.id ? "ویرایش دسته‌بندی" : "دسته‌بندی جدید"}
              </h2>
              <button onClick={() => setForm(null)} disabled={saving} aria-label="بستن">
                <XIcon className="h-5 w-5 text-muted" />
              </button>
            </div>

            <div className="flex gap-3">
              <input
                type="text"
                value={form.icon}
                onChange={(e) => setForm({ ...form, icon: e.target.value })}
                maxLength={4}
                className="w-16 rounded-xl border border-border bg-background p-3 text-center text-xl outline-none focus:border-accent"
              />
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="نام دسته‌بندی"
                className="flex-1 rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-accent"
              />
            </div>

            <div className="mt-4 flex gap-2">
              {(["expense", "income"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm({ ...form, type: t })}
                  className={`flex-1 rounded-xl py-2 text-sm font-medium ${
                    form.type === t ? "bg-primary text-white" : "bg-background text-muted"
                  }`}
                >
                  {t === "income" ? "درآمد" : "هزینه"}
                </button>
              ))}
            </div>

            <p className="mt-4 mb-2 text-xs text-muted">رنگ</p>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setForm({ ...form, color })}
                  className="relative h-8 w-8 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                  aria-label={color}
                >
                  {form.color === color && <CheckIcon className="absolute inset-0 m-auto h-4 w-4 text-white" />}
                </button>
              ))}
            </div>

            {error && <p className="mt-3 text-xs text-warning">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-white disabled:opacity-50"
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

interface CategorySectionProps {
  title: string;
  categories: Category[];
  onAdd: () => void;
  onEdit: (category: Category) => void;
  onDelete: (id: number) => void;
  deletingId: number | null;
}

function CategorySection({ title, categories, onAdd, onEdit, onDelete, deletingId }: CategorySectionProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <button onClick={onAdd} className="flex items-center gap-1 text-xs font-medium text-accent">
          <PlusIcon className="h-3.5 w-3.5" />
          افزودن
        </button>
      </div>
      <div className="rounded-2xl border border-border bg-surface px-4">
        {categories.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">دسته‌بندی‌ای وجود ندارد.</p>
        ) : (
          categories.map((category, i) => (
            <div key={category.id} className={`flex items-center gap-3 py-3 ${i > 0 ? "border-t border-border" : ""}`}>
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base"
                style={{ backgroundColor: `${category.color}1f` }}
              >
                {category.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{category.name}</p>
                <p className="text-xs text-muted">{category.transactionCount} تراکنش</p>
              </div>
              <button
                onClick={() => onEdit(category)}
                aria-label="ویرایش"
                className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-accent"
              >
                <EditIcon className="h-4 w-4" />
              </button>
              <button
                onClick={() => onDelete(category.id)}
                disabled={deletingId === category.id}
                aria-label="حذف"
                className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-warning disabled:opacity-50"
              >
                {deletingId === category.id ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <TrashIcon className="h-4 w-4" />
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

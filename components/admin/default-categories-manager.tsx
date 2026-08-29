"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, EditIcon, TrashIcon, XIcon, CheckIcon, SpinnerIcon } from "@/components/icons";
import type { CategoryType } from "@/lib/categories";

interface CategoryItem {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

interface CategoryMain extends CategoryItem {
  children: CategoryItem[];
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
  parentId: number | null;
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
}

function emptyForm(type: CategoryType, parentId: number | null = null): FormState {
  return { id: null, parentId, name: "", icon: "🏷️", color: COLOR_PRESETS[0], type };
}

export function DefaultCategoriesManager({ categories }: { categories: CategoryMain[] }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const expenseCategories = categories.filter((c) => c.type === "expense");
  const incomeCategories = categories.filter((c) => c.type === "income");

  function openCreateMain(type: CategoryType) {
    setForm(emptyForm(type));
    setError(null);
  }

  function openCreateSub(main: CategoryMain) {
    setForm(emptyForm(main.type as CategoryType, main.id));
    setError(null);
  }

  function openEdit(item: CategoryItem, parentId: number | null) {
    setForm({
      id: item.id,
      parentId,
      name: item.name,
      icon: item.icon,
      color: item.color,
      type: item.type as CategoryType,
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
      const res = await fetch(
        isEdit ? `/api/admin/default-categories/${form.id}` : "/api/admin/default-categories",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isEdit
              ? { name: form.name.trim(), icon: form.icon.trim(), color: form.color }
              : {
                  name: form.name.trim(),
                  icon: form.icon.trim(),
                  color: form.color,
                  type: form.type,
                  parentId: form.parentId,
                }
          ),
        }
      );
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
      const res = await fetch(`/api/admin/default-categories/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف.");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setDeletingId(null);
    }
  }

  const isNewMain = form !== null && form.id === null && form.parentId === null;

  return (
    <div className="space-y-6 px-4 pb-8 pt-5">
      <p className="text-xs text-muted">
        این دسته‌بندی‌ها به‌صورت خودکار برای هر کاربر جدید در زمان ثبت‌نام ایجاد می‌شوند.
      </p>

      {deleteError && <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">{deleteError}</p>}

      <CategoryTypeSection
        title="هزینه‌ها"
        categories={expenseCategories}
        onAddMain={() => openCreateMain("expense")}
        onAddSub={openCreateSub}
        onEdit={openEdit}
        onDelete={handleDelete}
        deletingId={deletingId}
      />
      <CategoryTypeSection
        title="درآمدها"
        categories={incomeCategories}
        onAddMain={() => openCreateMain("income")}
        onAddSub={openCreateSub}
        onEdit={openEdit}
        onDelete={handleDelete}
        deletingId={deletingId}
      />

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => !saving && setForm(null)}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-surface p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">
                {form.id ? "ویرایش دسته‌بندی" : form.parentId ? "زیردسته جدید" : "دسته‌بندی جدید"}
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

            {isNewMain && (
              <div className="mt-4 flex gap-2">
                {(["expense", "income"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm({ ...form, type: t })}
                    className={`flex-1 rounded-xl py-2 text-sm font-medium ${
                      form.type === t ? "bg-primary text-on-primary" : "bg-background text-muted"
                    }`}
                  >
                    {t === "income" ? "درآمد" : "هزینه"}
                  </button>
                ))}
              </div>
            )}

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

interface CategoryTypeSectionProps {
  title: string;
  categories: CategoryMain[];
  onAddMain: () => void;
  onAddSub: (main: CategoryMain) => void;
  onEdit: (item: CategoryItem, parentId: number | null) => void;
  onDelete: (id: number) => void;
  deletingId: number | null;
}

function CategoryTypeSection({
  title,
  categories,
  onAddMain,
  onAddSub,
  onEdit,
  onDelete,
  deletingId,
}: CategoryTypeSectionProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <button onClick={onAddMain} className="flex items-center gap-1 text-xs font-medium text-accent">
          <PlusIcon className="h-3.5 w-3.5" />
          دسته‌بندی جدید
        </button>
      </div>
      <div className="rounded-2xl border border-border bg-surface px-4">
        {categories.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">دسته‌بندی‌ای وجود ندارد.</p>
        ) : (
          categories.map((main, i) => (
            <div key={main.id} className={i > 0 ? "border-t border-border" : ""}>
              <CategoryRow item={main} onEdit={() => onEdit(main, null)} onDelete={() => onDelete(main.id)} deleting={deletingId === main.id} />
              {main.children.map((child) => (
                <div key={child.id} className="pr-8">
                  <CategoryRow
                    item={child}
                    onEdit={() => onEdit(child, main.id)}
                    onDelete={() => onDelete(child.id)}
                    deleting={deletingId === child.id}
                  />
                </div>
              ))}
              <div className="pr-8 pb-3">
                <button
                  onClick={() => onAddSub(main)}
                  className="flex items-center gap-1 text-xs font-medium text-accent"
                >
                  <PlusIcon className="h-3 w-3" />
                  افزودن زیردسته
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

interface CategoryRowProps {
  item: CategoryItem;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function CategoryRow({ item, onEdit, onDelete, deleting }: CategoryRowProps) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base"
        style={{ backgroundColor: `${item.color}1f` }}
      >
        {item.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
      </div>
      <button
        onClick={onEdit}
        aria-label="ویرایش"
        className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-accent"
      >
        <EditIcon className="h-4 w-4" />
      </button>
      <button
        onClick={onDelete}
        disabled={deleting}
        aria-label="حذف"
        className="shrink-0 rounded-full p-2 text-muted hover:bg-background hover:text-warning disabled:opacity-50"
      >
        {deleting ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <TrashIcon className="h-4 w-4" />}
      </button>
    </div>
  );
}

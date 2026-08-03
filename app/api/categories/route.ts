import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  listCategoriesWithUsage,
  listCategories,
  listCategoriesCreatedSince,
  findCategoryByNameAndType,
  createCategory,
} from "@/lib/data/categories";
import { findSimilarCategory, resolveNewCategoryIcon, type CategoryType } from "@/lib/categories";
import type { CategoryOption } from "@/lib/ai/parse-transaction";
import { rateLimitResponse } from "@/lib/rate-limit";

// The ai-suggestion path never receives a color from the client (see the
// "Required body fields" note below), so newly-created categories there all
// get this same slate-gray - the same generic/miscellaneous tone already
// used for the seeded "سایر" bucket and utility subcategories (prisma/seed.ts).
const AI_SUGGESTION_DEFAULT_COLOR = "#64748B";

// Rolling-24h cap on categories created via source: "ai-suggestion" (the
// auto-create-on-accept flow for the AI's newCategorySuggestion) - bounds
// category sprawl from repeated acceptances. Does not apply to source:
// "manual" (the Settings > Categories screen, components/categories/categories-manager.tsx),
// which keeps its pre-existing, unrestricted contract.
const MAX_CATEGORIES_PER_24H = 10;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// P2002 is Prisma's standard unique-constraint code for its native query
// engine, but this project's driver adapter (@prisma/adapter-libsql, see
// lib/prisma.ts) routes every raw database error through the generic
// P2039 "driver adapter error" wrapper instead - so P2002 alone never
// actually fires here. P2039 also wraps unrelated driver errors (timeouts,
// syntax errors, ...), so it's only treated as a collision when the
// underlying SQLite message confirms a UNIQUE constraint violation.
function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2002") return true;
  return (
    error.code === "P2039" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("UNIQUE constraint failed")
  );
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const type = request.nextUrl.searchParams.get("type");
  const categories = await listCategoriesWithUsage(
    session.userId,
    type === "income" || type === "expense" ? type : undefined
  );
  return NextResponse.json({ categories });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;
  const source: "manual" | "ai-suggestion" = body?.source === "ai-suggestion" ? "ai-suggestion" : "manual";

  if (!name || !type) {
    return NextResponse.json({ error: "نام و نوع دسته‌بندی الزامی هستند." }, { status: 400 });
  }

  // source: "manual" (default) - the exact pre-existing contract used by
  // categories-manager.tsx: client-supplied icon/color, no parentName, no
  // dedup, no rate limit.
  if (source === "manual") {
    const icon = typeof body?.icon === "string" ? body.icon.trim() : "";
    const color = typeof body?.color === "string" ? body.color.trim() : "";

    if (!icon || !color) {
      return NextResponse.json({ error: "همه فیلدها (نام، آیکون، رنگ، نوع) الزامی هستند." }, { status: 400 });
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return NextResponse.json({ error: "رنگ باید به‌صورت کد hex معتبر باشد (مثل #3B82F6)." }, { status: 400 });
    }

    try {
      const category = await createCategory(session.userId, { name, icon, color, type });
      return NextResponse.json({ category }, { status: 201 });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json({ error: "دسته‌بندی با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
      }
      throw error;
    }
  }

  // source: "ai-suggestion" - parentName resolution, forced server-side
  // icon, mandatory dedup, and the rolling 24h rate limit.
  const parentNameRaw = body?.parentName;
  const parentNameValid = parentNameRaw === null || parentNameRaw === undefined || typeof parentNameRaw === "string";
  if (!parentNameValid) {
    return NextResponse.json({ error: "نام دسته والد نامعتبر است." }, { status: 400 });
  }
  const parentName: string | null = typeof parentNameRaw === "string" ? parentNameRaw.trim() : null;

  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentCategories = await listCategoriesCreatedSince(session.userId, since);
  if (recentCategories.length >= MAX_CATEGORIES_PER_24H) {
    const oldest = recentCategories[0].createdAt;
    const retryAfterSeconds = Math.max(
      Math.ceil((oldest.getTime() + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000),
      0
    );
    return rateLimitResponse(
      { allowed: false, remaining: 0, retryAfterSeconds },
      "در ۲۴ ساعت گذشته دسته‌بندی زیادی ساخته‌اید؛ لطفاً از دسته‌های موجود استفاده کنید."
    );
  }

  let parentId: number | null = null;
  if (parentName !== null) {
    const parent = await findCategoryByNameAndType(session.userId, parentName, type);
    if (!parent) {
      return NextResponse.json(
        { error: "دسته‌بندی والد یافت نشد یا با نوع این دسته‌بندی مطابقت ندارد." },
        { status: 400 }
      );
    }
    parentId = parent.id;
  }

  const existingCategories = await listCategories(session.userId);
  const categoryById = new Map(existingCategories.map((c) => [c.id, c]));
  const categoryOptions: CategoryOption[] = existingCategories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
  }));

  const similar = findSimilarCategory({ name, parentName }, categoryOptions, type);
  if (similar) {
    const matchedCategory = existingCategories.find((c) => c.name === similar.name && c.type === similar.type)!;
    return NextResponse.json({ category: matchedCategory, resolvedExisting: true }, { status: 200 });
  }

  const icon = resolveNewCategoryIcon(name);
  try {
    const category = await createCategory(session.userId, {
      name,
      icon,
      color: AI_SUGGESTION_DEFAULT_COLOR,
      type,
      parentId,
    });
    return NextResponse.json({ category, resolvedExisting: false }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "دسته‌بندی با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
    }
    throw error;
  }
}

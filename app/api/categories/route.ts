import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  listCategoriesWithUsage,
  createCategory,
  resolveOrCreateCategoryFromSuggestion,
  CategoryCreationRateLimitedError,
  InvalidParentCategoryError,
  DuplicateCategoryError,
} from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { rateLimitResponse } from "@/lib/rate-limit";
import { MAX_NAME_LENGTH, MAX_ICON_LENGTH } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

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

  if (!name || !type || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "نام و نوع دسته‌بندی الزامی هستند." }, { status: 400 });
  }

  // source: "manual" (default) - the exact pre-existing contract used by
  // categories-manager.tsx: client-supplied icon/color, no parentName, no
  // dedup, no rate limit.
  if (source === "manual") {
    const icon = typeof body?.icon === "string" ? body.icon.trim() : "";
    const color = typeof body?.color === "string" ? body.color.trim() : "";

    if (!icon || !color || icon.length > MAX_ICON_LENGTH) {
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
      // Unhandled/unexpected only - the unique-constraint case above is an
      // already-handled, expected outcome and isn't reported here.
      reportError({
        errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
        route: "categories",
        userId: session.userId,
        message: error instanceof Error ? error.message : "Unexpected error creating category",
        error,
        context: isPrismaErrorCode(error)
          ? { operation: "createCategory", model: "Category", source: "manual", code: error.code }
          : { operation: "createCategory", model: "Category", source: "manual" },
      });
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
  if (parentName !== null && parentName.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "نام دسته والد نامعتبر است." }, { status: 400 });
  }

  try {
    const { category, resolvedExisting } = await resolveOrCreateCategoryFromSuggestion(session.userId, {
      name,
      parentName,
      type,
    });
    return NextResponse.json({ category, resolvedExisting }, { status: resolvedExisting ? 200 : 201 });
  } catch (error) {
    if (error instanceof CategoryCreationRateLimitedError) {
      return rateLimitResponse(
        { allowed: false, remaining: 0, retryAfterSeconds: error.retryAfterSeconds },
        error.message
      );
    }
    if (error instanceof InvalidParentCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DuplicateCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Unhandled/unexpected only - the domain outcomes above are already
    // handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "categories",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error creating category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createCategory", model: "Category", source: "ai-suggestion", code: error.code }
        : { operation: "createCategory", model: "Category", source: "ai-suggestion" },
    });
    throw error;
  }
}

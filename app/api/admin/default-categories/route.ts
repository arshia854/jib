import { NextRequest, NextResponse } from "next/server";
import { listDefaultCategories, createDefaultCategory } from "@/lib/data/admin-categories";
import { NotAdminError } from "@/lib/auth/session";
import type { CategoryType } from "@/lib/categories";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function GET() {
  try {
    const categories = await listDefaultCategories();
    return NextResponse.json({ categories });
  } catch (error) {
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // No userId attached here: this route (like the rest of app/api/admin/*)
    // relies on proxy.ts's own admin gate for authorization rather than
    // calling getSession() itself, so there's no session already in scope -
    // adding a getSession() call solely for observability would mean a new
    // per-request DB read this route doesn't otherwise make. Flagged as a
    // known gap in docs/roadmap-status.md rather than added silently.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/default-categories",
      message: error instanceof Error ? error.message : "Unexpected error listing default categories",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "listDefaultCategories", model: "DefaultCategory", code: error.code }
        : { operation: "listDefaultCategories", model: "DefaultCategory" },
    });
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const icon = typeof body?.icon === "string" ? body.icon.trim() : "";
  const color = typeof body?.color === "string" ? body.color.trim() : "";
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;
  const isTransfer = body?.isTransfer === true;
  const parentId = Number.isInteger(body?.parentId) ? (body.parentId as number) : null;

  if (!name || !icon || !color || !type) {
    return NextResponse.json({ error: "همه فیلدها (نام، آیکون، رنگ، نوع) الزامی هستند." }, { status: 400 });
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return NextResponse.json({ error: "رنگ باید به‌صورت کد hex معتبر باشد (مثل #3B82F6)." }, { status: 400 });
  }

  try {
    const category = await createDefaultCategory({ name, icon, color, type, isTransfer, parentId });
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "دسته‌بندی پیش‌فرض با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
    }
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // No userId attached here - see the GET handler's comment above for why.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/default-categories",
      message: error instanceof Error ? error.message : "Unexpected error creating default category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createDefaultCategory", model: "DefaultCategory", code: error.code }
        : { operation: "createDefaultCategory", model: "DefaultCategory" },
    });
    throw error;
  }
}

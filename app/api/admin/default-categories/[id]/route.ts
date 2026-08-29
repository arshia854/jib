import { NextRequest, NextResponse } from "next/server";
import {
  updateDefaultCategory,
  deleteDefaultCategory,
  DefaultCategoryNotFoundError,
  DefaultCategoryInUseError,
} from "@/lib/data/admin-categories";
import { NotAdminError } from "@/lib/auth/session";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const data: { name?: string; icon?: string; color?: string } = {};
  if (typeof body?.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body?.icon === "string" && body.icon.trim()) data.icon = body.icon.trim();
  if (typeof body?.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(body.color)) data.color = body.color;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const category = await updateDefaultCategory(categoryId, data);
    return NextResponse.json({ category });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "دسته‌بندی پیش‌فرض با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
    }
    if (error instanceof DefaultCategoryNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // No userId attached: this route relies on proxy.ts's own admin gate
    // rather than calling getSession() itself - see
    // app/api/admin/default-categories/route.ts's GET handler comment.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/default-categories/[id]",
      message: error instanceof Error ? error.message : "Unexpected error updating default category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "updateDefaultCategory", model: "DefaultCategory", code: error.code }
        : { operation: "updateDefaultCategory", model: "DefaultCategory" },
    });
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteDefaultCategory(categoryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof DefaultCategoryInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof DefaultCategoryNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // No userId attached - see the PATCH handler's comment above.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/default-categories/[id]",
      message: error instanceof Error ? error.message : "Unexpected error deleting default category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteDefaultCategory", model: "DefaultCategory", code: error.code }
        : { operation: "deleteDefaultCategory", model: "DefaultCategory" },
    });
    throw error;
  }
}

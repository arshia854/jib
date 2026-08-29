import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { updateCategory, deleteCategory, CategoryInUseError, CategoryNotFoundError } from "@/lib/data/categories";
import { MAX_NAME_LENGTH, MAX_ICON_LENGTH } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  if (typeof body?.name === "string" && body.name.trim().length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "نام دسته‌بندی بیش از حد طولانی است." }, { status: 400 });
  }
  if (typeof body?.icon === "string" && body.icon.trim().length > MAX_ICON_LENGTH) {
    return NextResponse.json({ error: "آیکون نامعتبر است." }, { status: 400 });
  }

  const data: { name?: string; icon?: string; color?: string } = {};
  if (typeof body?.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body?.icon === "string" && body.icon.trim()) data.icon = body.icon.trim();
  if (typeof body?.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(body.color)) data.color = body.color;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const category = await updateCategory(session.userId, categoryId, data);
    return NextResponse.json({ category });
  } catch (error) {
    // NOTE (spotted while instrumenting, not fixed here per Phase 12's "no
    // unrelated refactors" rule): this checks error.code === "P2002"
    // directly, but per the Phase 12 audit (docs/roadmap-status.md) and
    // this file's own sibling app/api/categories/route.ts's
    // isUniqueConstraintError() comment, this codebase's driver adapter
    // (@prisma/adapter-libsql) wraps every raw DB error as P2039 instead -
    // P2002 "never actually fires" through it. So this branch is
    // effectively dead today, and a real unique-constraint violation here
    // likely falls through to the generic case below instead of the
    // intended 409. Left exactly as found - behavior-preserving is this
    // sub-task's job, not fixing pre-existing bugs found along the way.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "دسته‌بندی با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
    }
    if (error instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - the two known outcomes above are already
    // handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "categories/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error updating category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "updateCategory", model: "Category", code: error.code }
        : { operation: "updateCategory", model: "Category" },
    });
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteCategory(session.userId, categoryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CategoryInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - the two known outcomes above are already
    // handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "categories/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteCategory", model: "Category", code: error.code }
        : { operation: "deleteCategory", model: "Category" },
    });
    throw error;
  }
}

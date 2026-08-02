import { NextRequest, NextResponse } from "next/server";
import {
  updateDefaultCategory,
  deleteDefaultCategory,
  DefaultCategoryNotFoundError,
  DefaultCategoryInUseError,
} from "@/lib/data/admin-categories";
import { NotAdminError } from "@/lib/auth/session";

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
    throw error;
  }
}

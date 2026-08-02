import { NextRequest, NextResponse } from "next/server";
import { listDefaultCategories, createDefaultCategory } from "@/lib/data/admin-categories";
import { NotAdminError } from "@/lib/auth/session";
import type { CategoryType } from "@/lib/categories";

export async function GET() {
  try {
    const categories = await listDefaultCategories();
    return NextResponse.json({ categories });
  } catch (error) {
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
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
    throw error;
  }
}

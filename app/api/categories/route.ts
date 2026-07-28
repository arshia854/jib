import { NextRequest, NextResponse } from "next/server";
import { listCategoriesWithUsage, createCategory } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type");
  const categories = await listCategoriesWithUsage(type === "income" || type === "expense" ? type : undefined);
  return NextResponse.json({ categories });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const icon = typeof body?.icon === "string" ? body.icon.trim() : "";
  const color = typeof body?.color === "string" ? body.color.trim() : "";
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;

  if (!name || !icon || !color || !type) {
    return NextResponse.json({ error: "همه فیلدها (نام، آیکون، رنگ، نوع) الزامی هستند." }, { status: 400 });
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return NextResponse.json({ error: "رنگ باید به‌صورت کد hex معتبر باشد (مثل #3B82F6)." }, { status: 400 });
  }

  try {
    const category = await createCategory({ name, icon, color, type });
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "دسته‌بندی با این نام و نوع قبلاً وجود دارد." }, { status: 409 });
    }
    throw error;
  }
}

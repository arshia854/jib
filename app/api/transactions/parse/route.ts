import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { parseTransactionWithAI } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return NextResponse.json({ error: "متن تراکنش نمی‌تواند خالی باشد." }, { status: 400 });
  }

  const categories = await listCategories(session.userId);
  const categoryOptions = categories.map((c) => ({ name: c.name, type: c.type as CategoryType }));

  try {
    const parsed = await parseTransactionWithAI(text, categoryOptions);
    return NextResponse.json({ parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطا در پردازش متن.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

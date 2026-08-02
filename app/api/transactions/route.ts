import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listTransactions, createTransaction, InvalidCategoryError, InvalidAccountError } from "@/lib/data/transactions";
import type { CategoryType } from "@/lib/categories";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  const categoryIdParam = params.get("categoryId");
  const from = params.get("from");
  const to = params.get("to");

  const transactions = await listTransactions(session.userId, {
    type: type === "income" || type === "expense" ? type : undefined,
    categoryId: categoryIdParam ? Number(categoryIdParam) : undefined,
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  });

  return NextResponse.json({ transactions });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const amount = Number(body?.amount);
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;
  const categoryName = typeof body?.category === "string" ? body.category : "";
  const accountId = Number(body?.accountId);
  const rawInput = typeof body?.rawInput === "string" ? body.rawInput : "";
  const description = typeof body?.description === "string" ? body.description : undefined;
  const dateInput = typeof body?.date === "string" ? body.date : undefined;

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !type ||
    !categoryName ||
    !rawInput ||
    !Number.isInteger(accountId)
  ) {
    return NextResponse.json({ error: "اطلاعات تراکنش ناقص یا نامعتبر است." }, { status: 400 });
  }

  const date = dateInput && !Number.isNaN(Date.parse(dateInput)) ? new Date(dateInput) : new Date();

  try {
    const transaction = await createTransaction(session.userId, {
      amount: Math.round(amount),
      type,
      categoryName,
      accountId,
      description,
      rawInput,
      date,
    });
    return NextResponse.json({ transaction }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidAccountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

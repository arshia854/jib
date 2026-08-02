import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  deleteTransaction,
  updateTransaction,
  InvalidCategoryError,
  InvalidAccountError,
  TransactionNotFoundError,
} from "@/lib/data/transactions";
import type { CategoryType } from "@/lib/categories";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const transactionId = Number(id);
  if (!Number.isInteger(transactionId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  const amount = Number(body?.amount);
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;
  const categoryName = typeof body?.category === "string" ? body.category : "";
  const accountId = Number(body?.accountId);
  const description = typeof body?.description === "string" ? body.description : undefined;
  const dateInput = typeof body?.date === "string" ? body.date : undefined;

  if (!Number.isFinite(amount) || amount <= 0 || !type || !categoryName || !Number.isInteger(accountId)) {
    return NextResponse.json({ error: "اطلاعات تراکنش ناقص یا نامعتبر است." }, { status: 400 });
  }

  const date = dateInput && !Number.isNaN(Date.parse(dateInput)) ? new Date(dateInput) : new Date();

  try {
    const transaction = await updateTransaction(session.userId, transactionId, {
      amount: Math.round(amount),
      type,
      categoryName,
      accountId,
      description,
      date,
    });
    return NextResponse.json({ transaction });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidAccountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const transactionId = Number(id);
  if (!Number.isInteger(transactionId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteTransaction(session.userId, transactionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

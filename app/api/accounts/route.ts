import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listAccountsWithUsage, createAccount } from "@/lib/data/accounts";
import { ACCOUNT_TYPES } from "@/lib/accounts";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const accounts = await listAccountsWithUsage(session.userId);
  return NextResponse.json({ accounts });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const type = typeof body?.type === "string" ? body.type : "";
  const initialBalanceInput = body?.initialBalance;
  const initialBalance =
    initialBalanceInput === undefined || initialBalanceInput === null ? 0 : Number(initialBalanceInput);

  if (!name || !ACCOUNT_TYPES.some((t) => t.value === type)) {
    return NextResponse.json({ error: "نام و نوع حساب الزامی هستند." }, { status: 400 });
  }
  if (!Number.isFinite(initialBalance)) {
    return NextResponse.json({ error: "موجودی اولیه نامعتبر است." }, { status: 400 });
  }

  const account = await createAccount(session.userId, { name, type, initialBalance: Math.round(initialBalance) });
  return NextResponse.json({ account }, { status: 201 });
}

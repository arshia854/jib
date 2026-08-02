import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { updateAccount, deleteAccount, AccountInUseError, AccountNotFoundError } from "@/lib/data/accounts";
import { ACCOUNT_TYPES } from "@/lib/accounts";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const data: { name?: string; type?: string; initialBalance?: number } = {};
  if (typeof body?.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body?.type === "string" && ACCOUNT_TYPES.some((t) => t.value === body.type)) data.type = body.type;
  if (body?.initialBalance !== undefined && body?.initialBalance !== null) {
    const initialBalance = Number(body.initialBalance);
    if (Number.isFinite(initialBalance)) data.initialBalance = Math.round(initialBalance);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const account = await updateAccount(session.userId, accountId, data);
    return NextResponse.json({ account });
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
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
  const accountId = Number(id);
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteAccount(session.userId, accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

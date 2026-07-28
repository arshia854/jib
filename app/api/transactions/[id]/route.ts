import { NextRequest, NextResponse } from "next/server";
import { deleteTransaction } from "@/lib/data/transactions";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transactionId = Number(id);
  if (!Number.isInteger(transactionId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteTransaction(transactionId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "تراکنش یافت نشد." }, { status: 404 });
  }
}

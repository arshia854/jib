import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

// Flips the opt-in "show total balance in gold/dollar" dashboard toggle
// (User.showBalanceInAssets, see prisma/schema.prisma and
// lib/data/dashboard.ts). Mirrors app/api/facts/route.ts's shape - a small,
// single-purpose settings write, not part of the Assets CRUD routes since
// it's a User-level preference, not an Asset row.
export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "مقدار نامعتبر است." }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { showBalanceInAssets: body.enabled },
  });

  return NextResponse.json({ ok: true, enabled: body.enabled });
}

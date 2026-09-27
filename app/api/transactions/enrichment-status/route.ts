import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

// Cap on how many ids a single poll can ask about - keeps the `in` filter
// bounded regardless of what a client sends (see enrichment-poller.tsx,
// which only ever asks about the currently-rendered page's pending rows,
// always far under this).
const MAX_IDS = 50;

// Lightweight companion to the full-page polling EnrichmentPoller used to
// do (router.refresh() every few seconds) - this returns just the still-
// "pending" subset of the ids the client already knows about, so the
// client can decide on its own whether a real refresh is warranted instead
// of paying for one on every tick.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const idsParam = request.nextUrl.searchParams.get("ids");
  if (!idsParam) {
    return NextResponse.json({ error: "شناسه‌ها ارسال نشده است." }, { status: 400 });
  }

  const rawIds = idsParam.split(",").map((part) => part.trim());
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of rawIds) {
    if (!/^\d+$/.test(raw)) {
      return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  if (ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json({ error: "تعداد شناسه‌ها نامعتبر است." }, { status: 400 });
  }

  const pending = await prisma.transaction.findMany({
    where: { userId: session.userId, id: { in: ids }, enrichmentStatus: "pending" },
    select: { id: true },
  });

  return NextResponse.json(
    { pendingIds: pending.map((t) => t.id) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

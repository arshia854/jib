import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, setSessionCookie } from "@/lib/auth/session";
import { seedDefaultsForUser } from "@/lib/data/onboarding";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const age = Number(body?.age);

  if (!name || name.length > 60) {
    return NextResponse.json({ error: "نام را به‌درستی وارد کنید." }, { status: 400 });
  }
  if (!Number.isInteger(age) || age < 10 || age > 120) {
    return NextResponse.json({ error: "سن را به‌درستی وارد کنید." }, { status: 400 });
  }

  const alreadyOnboarded = session.onboarded;

  await prisma.user.update({ where: { id: session.userId }, data: { name, age } });

  if (!alreadyOnboarded) {
    await seedDefaultsForUser(session.userId);
  }

  await setSessionCookie(session.userId, true);

  return NextResponse.json({ ok: true });
}

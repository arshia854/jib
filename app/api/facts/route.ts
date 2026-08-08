import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getKnownFact } from "@/lib/facts/known-facts";
import { setUserStatedFact } from "@/lib/facts/user-facts";

// Records a single user-stated fact (see lib/facts/known-facts.ts) - used by
// both the post-onboarding question steps (app/onboarding/page.tsx) and the
// Settings page for anyone who skipped or wants to change their answer
// (components/settings/profile-facts-form.tsx). Answering these is always
// optional, so unlike /api/auth/onboarding there's no seeding/session side
// effect here - this only ever writes one UserFact row.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key : "";
  const value = typeof body?.value === "string" ? body.value : "";

  const known = getKnownFact(key);
  if (!known) {
    return NextResponse.json({ error: "کلید نامعتبر است." }, { status: 400 });
  }
  if (!known.allowedValues.includes(value)) {
    return NextResponse.json({ error: "مقدار نامعتبر است." }, { status: 400 });
  }

  const fact = await setUserStatedFact(session.userId, key, value);
  return NextResponse.json({ ok: true, fact });
}

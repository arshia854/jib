import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getMonthlyFinancialProfile } from "@/lib/savings/monthly-profile";
import { suggestAllFormulas } from "@/lib/savings/formulas";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const profile = await getMonthlyFinancialProfile(session.userId);
  const suggestions = suggestAllFormulas(profile);
  return NextResponse.json({ profile, suggestions });
}

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { signOut } from "@/auth";
import { LEGACY_SESSION_COOKIE } from "@/lib/auth/session";

export async function POST() {
  await signOut({ redirect: false });
  // Also clear the pre-NextAuth cookie, in case this user's session predates
  // the migration and is still running on it (see lib/auth/session.ts).
  const store = await cookies();
  store.delete(LEGACY_SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}

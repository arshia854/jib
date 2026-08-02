import { NextRequest, NextResponse } from "next/server";
import {
  setUserBlocked,
  deleteUserAsAdmin,
  AdminUserNotFoundError,
  CannotModifySelfError,
} from "@/lib/data/admin-users";
import { NotAdminError } from "@/lib/auth/session";

// Admin-ness is already enforced in proxy.ts (see /api/admin/* gate) and
// re-checked independently inside setUserBlocked/deleteUserAsAdmin
// themselves (via requireAdminSession) - NotAdminError is only caught here
// as a defensive fallback in case that inner check ever fires.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "block" && action !== "unblock") {
    return NextResponse.json({ error: "عملیات نامعتبر است." }, { status: 400 });
  }

  try {
    const user = await setUserBlocked(userId, action === "block");
    return NextResponse.json({ user });
  } catch (error) {
    if (error instanceof CannotModifySelfError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AdminUserNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteUserAsAdmin(userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CannotModifySelfError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AdminUserNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof NotAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

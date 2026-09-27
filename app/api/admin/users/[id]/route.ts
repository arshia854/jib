import { NextRequest, NextResponse } from "next/server";
import {
  setUserBlocked,
  deleteUserAsAdmin,
  AdminUserNotFoundError,
  CannotModifySelfError,
} from "@/lib/data/admin-users";
import { NotAdminError } from "@/lib/auth/session";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

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
    // No `userId` field attached (that field means the authenticated actor
    // elsewhere in these logs; this route relies on proxy.ts's own admin
    // gate rather than calling getSession() itself, so the acting admin's
    // id isn't available here without an extra DB read - see
    // app/api/admin/default-categories/route.ts's GET handler comment).
    // `userId` from this route's own params - the *target* user being
    // blocked/unblocked, not the actor - is included under context instead,
    // clearly distinguished as targetUserId.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/users/[id]",
      message: error instanceof Error ? error.message : "Unexpected error setting user blocked state",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "setUserBlocked", model: "User", targetUserId: userId, code: error.code }
        : { operation: "setUserBlocked", model: "User", targetUserId: userId },
    });
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
    // No `userId` field attached - see the PATCH handler's comment above.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "admin/users/[id]",
      message: error instanceof Error ? error.message : "Unexpected error deleting user",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteUserAsAdmin", model: "User", targetUserId: userId, code: error.code }
        : { operation: "deleteUserAsAdmin", model: "User", targetUserId: userId },
    });
    throw error;
  }
}

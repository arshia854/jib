import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listConversations, createConversation } from "@/lib/data/conversations";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

// Both handlers are plain per-user DB operations with no AI call behind
// them, so they're deliberately not behind CHAT_USER_RULE (which exists to
// bound NVIDIA NIM spend for POST /api/chat) or any new rule of their own -
// see this change's completion notes for the one abuse case considered
// (empty-conversation spam) and why it's flagged rather than guessed at.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const conversations = await listConversations(session.userId);
  return NextResponse.json({ conversations });
}

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  try {
    const conversation = await createConversation(session.userId);
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "chat/conversations",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error creating conversation",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createConversation", model: "Conversation", code: error.code }
        : { operation: "createConversation", model: "Conversation" },
    });
    throw error;
  }
}

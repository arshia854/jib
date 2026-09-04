import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listMessages, deleteConversation, ConversationNotFoundError } from "@/lib/data/conversations";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    // Ownership-checked inside listMessages() - a conversation belonging to
    // another user throws exactly like a nonexistent one.
    const messages = await listMessages(session.userId, conversationId);
    return NextResponse.json({
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "chat/conversations/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error listing conversation messages",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "listMessages", model: "ChatMessage", code: error.code }
        : { operation: "listMessages", model: "ChatMessage" },
    });
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteConversation(session.userId, conversationId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "chat/conversations/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting conversation",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteConversation", model: "Conversation", code: error.code }
        : { operation: "deleteConversation", model: "Conversation" },
    });
    throw error;
  }
}

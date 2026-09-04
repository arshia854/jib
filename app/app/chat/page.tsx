import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getDefaultAccount } from "@/lib/data/accounts";
import { listConversations, listMessages } from "@/lib/data/conversations";
import { ChatInterface } from "@/components/chat/chat-interface";

export const dynamic = "force-dynamic";

interface PageProps {
  // `new=1` is how the "گفتگوی جدید" header control asks for an empty
  // chat: no conversation is created here, the first send creates one
  // lazily (see ChatInterface.handleSend) so tapping the button and
  // walking away never leaves an empty thread behind.
  searchParams: Promise<{ conversationId?: string; new?: string }>;
}

export default async function ChatPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const [conversations, defaultAccount] = await Promise.all([
    listConversations(session.userId),
    getDefaultAccount(session.userId),
  ]);

  let activeConversationId: number | null = null;
  if (params.new !== "1") {
    const requested = params.conversationId === undefined ? NaN : Number(params.conversationId);
    if (Number.isInteger(requested)) {
      // `conversations` is this user's own list, so membership in it IS
      // the ownership check - another user's (or a nonexistent) id never
      // matches, and is bounced back to the canonical URL rather than
      // rendered as an empty-but-real-looking thread. listMessages()
      // below re-checks ownership independently anyway.
      if (!conversations.some((c) => c.id === requested)) redirect("/app/chat");
      activeConversationId = requested;
    } else {
      // No (or unparseable) id: fall back to the most recently active
      // conversation, which listConversations already sorts first.
      activeConversationId = conversations[0]?.id ?? null;
    }
  }

  const history = activeConversationId === null ? [] : await listMessages(session.userId, activeConversationId);

  const initialMessages = history.map((m) => ({
    id: String(m.id),
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  return (
    <ChatInterface
      // Remounts on every conversation switch, so the interface's own
      // message/suggestion state can never carry over from the thread the
      // user just left.
      key={activeConversationId ?? "new"}
      initialMessages={initialMessages}
      defaultAccountId={defaultAccount.id}
      conversationId={activeConversationId}
      conversations={conversations}
    />
  );
}

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { getDefaultAccount } from "@/lib/data/accounts";
import { ChatInterface } from "@/components/chat/chat-interface";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [history, defaultAccount] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { userId: session.userId },
      orderBy: { timestamp: "asc" },
      take: 50,
    }),
    getDefaultAccount(session.userId),
  ]);

  const initialMessages = history.map((m) => ({
    id: String(m.id),
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  return <ChatInterface initialMessages={initialMessages} defaultAccountId={defaultAccount.id} />;
}

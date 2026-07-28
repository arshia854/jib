import { prisma } from "@/lib/prisma";
import { ChatInterface } from "@/components/chat/chat-interface";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const history = await prisma.chatMessage.findMany({
    orderBy: { timestamp: "asc" },
    take: 50,
  });

  const initialMessages = history.map((m) => ({
    id: String(m.id),
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  return <ChatInterface initialMessages={initialMessages} />;
}

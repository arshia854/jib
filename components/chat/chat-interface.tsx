"use client";

import { useEffect, useRef, useState } from "react";
import { SendIcon, SparklesIcon, SpinnerIcon } from "@/components/icons";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function ChatInterface({ initialMessages }: { initialMessages: Message[] }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMessage, { id: assistantId, role: "assistant", content: "" }]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "خطا در ارتباط با دستیار.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-4">
        <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
          <SparklesIcon className="h-5 w-5 text-accent" />
          دستیار مالی جیب
        </h1>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted">
            سؤالی درباره وضعیت مالی‌ات بپرس؛ مثلاً «این ماه بیشتر کجا خرج کردم؟»
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user" ? "bg-primary-darker text-white" : "border border-border bg-surface text-foreground"
              }`}
            >
              {m.content || (sending && m.role === "assistant" ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : "")}
            </div>
          </div>
        ))}
        {error && <p className="text-center text-xs text-warning">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="پیام خود را بنویسید..."
          disabled={sending}
          className="flex-1 rounded-2xl border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent"
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          aria-label="ارسال"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-dark text-white disabled:opacity-50"
        >
          <SendIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

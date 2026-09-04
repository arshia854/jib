"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SendIcon, SparklesIcon, SpinnerIcon, CheckIcon, XIcon, PlusIcon, ListIcon } from "@/components/icons";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { ConversationListDrawer, type ConversationSummary } from "./conversation-list-drawer";

interface PendingSuggestion {
  transaction: ParsedTransaction;
  rawInput: string;
  status: "pending" | "confirming" | "confirmed" | "dismissed" | "error";
  error?: string;
  // SEC-10 (docs/roadmap-status.md): generated once, when the suggestion
  // itself is created (see handleSend() below) - not per confirm click -
  // so every call to handleConfirmSuggestion() for this same suggestion
  // (a double-tap on "بله", or the "تلاش دوباره" retry after an error)
  // sends the same key, letting the server recognize a retry instead of
  // creating a duplicate transaction.
  idempotencyKey: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Session-state only, same as the rest of `messages` - never persisted as
  // its own DB row (see app/api/chat/route.ts: only `content` above, the
  // plain confirmation text, is saved as a ChatMessage). Absent for every
  // ordinary reply; only set on the one assistant message produced by a
  // suggest_transaction response.
  suggestion?: PendingSuggestion;
}

// Chosen alongside session's confidence gate: the chat suggestion card
// never lets the user fix up a wrong category/amount inline - "ویرایش کن"
// hands off to the real add-transaction form instead (see
// components/transactions/add-transaction-form.tsx's initialTransaction
// prop), so this file stays a thin confirm/dismiss layer, not a second
// parallel editing UI.
function updateSuggestion(
  messages: Message[],
  messageId: string,
  patch: Partial<PendingSuggestion>
): Message[] {
  return messages.map((m) => (m.id === messageId && m.suggestion ? { ...m, suggestion: { ...m.suggestion, ...patch } } : m));
}

// Shown in the empty assistant bubble for the whole span between sending the
// user's message and the first streamed chunk (or the suggest_transaction
// JSON) arriving back - replaces a bare spinner with a labeled state so
// it's clear the assistant is working, not stalled.
function ThinkingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <span className="animate-pulse">در حال فکر کردن</span>
      <span className="flex items-center gap-0.5">
        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
      </span>
    </span>
  );
}

export function ChatInterface({
  initialMessages,
  defaultAccountId,
  conversationId,
  conversations,
}: {
  initialMessages: Message[];
  defaultAccountId: number;
  // Null for a brand-new user, or right after "گفتگوی جدید" - the thread
  // is created lazily by the first send (see handleSend), never by merely
  // opening the screen.
  conversationId: number | null;
  conversations: ConversationSummary[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(conversationId);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Seeded from the server render, then re-read whenever the drawer opens
  // or a delete lands - see refreshConversations() below for why it isn't
  // just router.refresh().
  const [conversationList, setConversationList] = useState(conversations);
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

    // Tracked in local variables, not read back off state: a setState
    // isn't visible to the rest of this same function run, and both the
    // POST below and the finally block need the id we just created rather
    // than the pre-update null.
    let targetConversationId = activeConversationId;
    let createdConversation = false;
    let delivered = false;

    try {
      if (targetConversationId === null) {
        const created = await fetch("/api/chat/conversations", { method: "POST" });
        const createdData = await created.json().catch(() => ({}));
        if (!created.ok) throw new Error(createdData.error || "خطا در ساخت گفتگو.");
        targetConversationId = createdData.conversation.id as number;
        setActiveConversationId(targetConversationId);
        createdConversation = true;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: targetConversationId }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "خطا در ارتباط با دستیار.");
      }

      // suggest_transaction responses come back as a single JSON object
      // (not streamed) - see app/api/chat/route.ts. Everything else is the
      // existing plain-text stream, unchanged.
      if ((res.headers.get("Content-Type") ?? "").includes("application/json")) {
        const data = await res.json();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: data.message,
                  suggestion: {
                    transaction: data.transaction,
                    rawInput: data.rawInput,
                    status: "pending",
                    idempotencyKey: crypto.randomUUID(),
                  },
                }
              : m
          )
        );
        delivered = true;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)));
      }
      delivered = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setSending(false);

      // Point the URL at the thread this send just created, so a manual
      // reload lands back on it instead of the blank "new chat" screen.
      // history.replaceState, never router.replace/refresh: a real
      // navigation would re-run the server page and - via the `key` in
      // app/app/chat/page.tsx - remount this component, dropping a pending
      // transaction suggestion (client-side state only) or the error
      // message from a failed send. The history drawer picks the new
      // thread up by re-fetching the list when it opens instead.
      //
      // Only once a reply actually landed: after a failed first send the
      // created (still empty, still untitled) conversation stays off the
      // URL, and `activeConversationId` already holds it so a retry reuses
      // it rather than creating another.
      if (createdConversation && delivered && targetConversationId !== null) {
        window.history.replaceState(null, "", `/app/chat?conversationId=${targetConversationId}`);
      }
    }
  }

  // Re-reads the history list from the server. Used instead of
  // router.refresh() because refreshing re-runs the server page and, via
  // the `key` in app/app/chat/page.tsx, remounts this component - which
  // would discard a pending transaction suggestion (client-side state
  // only). It also picks up a conversation this session created lazily,
  // which the server render predates.
  async function refreshConversations() {
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) return;
      const data = await res.json();
      setConversationList(data.conversations);
    } catch {
      // Keep whatever list is already on screen - a failed refresh isn't
      // worth an error banner over a list the user can still use.
    }
  }

  function handleOpenHistory() {
    setHistoryOpen(true);
    refreshConversations();
  }

  // Doesn't create anything - just clears the screen and drops back to the
  // lazy-create path above, so opening a new chat and never typing leaves
  // no empty thread behind.
  function handleNewConversation() {
    setHistoryOpen(false);
    router.push("/app/chat?new=1");
  }

  // "بله" - calls the exact same creation endpoint (and so the exact same
  // createTransaction() code path, see lib/data/transactions.ts) manual
  // entry already uses, just tagged source: "assistant-suggestion". Nothing
  // is written before this fires.
  async function handleConfirmSuggestion(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!target?.suggestion || target.suggestion.status !== "pending") return;

    const { transaction, rawInput, idempotencyKey } = target.suggestion;
    setMessages((prev) => updateSuggestion(prev, messageId, { status: "confirming" }));

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: transaction.amount,
          type: transaction.type,
          category: transaction.category,
          description: transaction.description,
          date: transaction.date,
          rawInput,
          accountId: defaultAccountId,
          source: "assistant-suggestion",
          idempotencyKey,
          // See lib/ai/parse-transaction.ts's AssetPurchaseSuggestion and
          // app/api/chat/route.ts's buildConfirmationText, which already
          // told the user this would happen before they said "بله".
          ...(transaction.assetSuggestion
            ? {
                assetPurchase: {
                  type: transaction.assetSuggestion.type,
                  quantity: transaction.assetSuggestion.quantity,
                  purchasePricePerUnit: transaction.assetSuggestion.purchasePricePerUnit,
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ثبت تراکنش.");

      setMessages((prev) => [
        ...updateSuggestion(prev, messageId, { status: "confirmed" }),
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: transaction.assetSuggestion ? "ثبت شد ✅ و به دارایی‌هات هم اضافه شد." : "ثبت شد ✅",
        },
      ]);
    } catch (err) {
      setMessages((prev) =>
        updateSuggestion(prev, messageId, {
          status: "error",
          error: err instanceof Error ? err.message : "خطای ناشناخته رخ داد.",
        })
      );
    }
  }

  // "ویرایش کن" - hands off to the real add/edit transaction form
  // pre-filled with the suggested values (components/transactions/
  // add-transaction-form.tsx's initialTransaction prop, via /app/add's
  // query params). Nothing is written here either - if the user cancels
  // that form, the suggestion is simply discarded, same as any unsaved
  // manual entry.
  function handleEditSuggestion(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!target?.suggestion || target.suggestion.status !== "pending") return;

    const { transaction, rawInput } = target.suggestion;
    setMessages((prev) => updateSuggestion(prev, messageId, { status: "dismissed" }));

    const params = new URLSearchParams({
      fromSuggestion: "1",
      amount: String(transaction.amount),
      type: transaction.type,
      category: transaction.category,
      description: transaction.description,
      date: transaction.date,
      rawInput,
    });
    router.push(`/app/add?${params.toString()}`);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
          <SparklesIcon className="h-5 w-5 text-accent" />
          دستیار مالی جیب
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleNewConversation}
            disabled={sending}
            aria-label="گفتگوی جدید"
            className="rounded-full p-2 text-muted transition-colors hover:bg-surface hover:text-accent disabled:opacity-50"
          >
            <PlusIcon className="h-5 w-5" />
          </button>
          <button
            onClick={handleOpenHistory}
            aria-label="گفتگوهای قبلی"
            className="rounded-full p-2 text-muted transition-colors hover:bg-surface hover:text-accent"
          >
            <ListIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      {historyOpen && (
        <ConversationListDrawer
          conversations={conversationList}
          activeConversationId={activeConversationId}
          onClose={() => setHistoryOpen(false)}
          onConversationsChanged={refreshConversations}
        />
      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted">
            سؤالی درباره وضعیت مالی‌ات بپرس؛ مثلاً «این ماه بیشتر کجا خرج کردم؟»
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.role === "user" ? "items-start" : "items-end"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user" ? "bg-primary text-on-primary" : "border border-border bg-surface text-foreground"
              }`}
            >
              {m.content || (sending && m.role === "assistant" ? <ThinkingIndicator /> : "")}
            </div>

            {m.suggestion && m.suggestion.status !== "dismissed" && (
              <div className="mt-2 flex max-w-[80%] flex-col gap-2">
                {m.suggestion.status === "pending" && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleConfirmSuggestion(m.id)}
                      className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
                    >
                      <CheckIcon className="h-3.5 w-3.5" />
                      بله
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEditSuggestion(m.id)}
                      className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                      ویرایش کن
                    </button>
                  </div>
                )}
                {m.suggestion.status === "confirming" && (
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                    در حال ثبت...
                  </p>
                )}
                {m.suggestion.status === "error" && (
                  <div className="flex flex-col items-end gap-1.5">
                    <p className="text-xs text-warning">{m.suggestion.error}</p>
                    <button
                      type="button"
                      onClick={() => handleConfirmSuggestion(m.id)}
                      className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
                    >
                      تلاش دوباره
                    </button>
                  </div>
                )}
              </div>
            )}
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
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-50"
        >
          <SendIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

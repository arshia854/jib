"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon, TrashIcon, SpinnerIcon } from "@/components/icons";
import { formatJalaaliDate } from "@/lib/format";

export interface ConversationSummary {
  id: number;
  title: string | null;
  // A Date when this comes straight from the server component, an ISO
  // string when it comes back from GET /api/chat/conversations - both are
  // what formatJalaaliDate already accepts, so neither needs converting.
  lastMessageAt: Date | string;
}

// A conversation stays untitled until its first exchange auto-titles it
// (see maybeAutoTitle in lib/data/conversations.ts) - and one whose very
// first send failed can stay that way for good, so this is a real state to
// render, not a theoretical one.
const UNTITLED_LABEL = "گفتگوی بدون عنوان";

export function ConversationListDrawer({
  conversations,
  activeConversationId,
  onClose,
  onConversationsChanged,
}: {
  conversations: ConversationSummary[];
  activeConversationId: number | null;
  onClose: () => void;
  // Re-reads the list from the server after a delete. Owned by
  // ChatInterface rather than this component so the fetch hangs off the
  // "open history" click instead of a mount effect.
  onConversationsChanged: () => Promise<void>;
}) {
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSwitch(id: number) {
    if (id !== activeConversationId) router.push(`/app/chat?conversationId=${id}`);
    onClose();
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف گفتگو.");

      if (id === activeConversationId) {
        // The thread on screen just went away - go back to the canonical
        // URL, which resolves to whatever is now the most recent one (or
        // an empty chat if that was the last).
        router.push("/app/chat");
        onClose();
        return;
      }
      await onConversationsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => deletingId === null && onClose()}
    >
      <div
        className="max-h-[75dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-foreground">گفتگوهای قبلی</h2>
          <button onClick={onClose} disabled={deletingId !== null} aria-label="بستن">
            <XIcon className="h-5 w-5 text-muted" />
          </button>
        </div>

        {error && <p className="mb-3 rounded-xl bg-warning/10 p-3 text-xs text-warning">{error}</p>}

        {conversations.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">هنوز گفتگویی نداری.</p>
        ) : (
          <div className="rounded-2xl border border-border bg-background px-4">
            {conversations.map((conversation, i) => (
              <div
                key={conversation.id}
                className={["flex items-center gap-2 py-3", i > 0 ? "border-t border-border" : ""]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  onClick={() => handleSwitch(conversation.id)}
                  disabled={deletingId !== null}
                  className="min-w-0 flex-1 text-right disabled:opacity-50"
                >
                  <p
                    className={`truncate text-sm ${
                      conversation.id === activeConversationId
                        ? "font-bold text-accent"
                        : "font-medium text-foreground"
                    }`}
                  >
                    {conversation.title ?? UNTITLED_LABEL}
                  </p>
                  <p className="text-xs text-muted">{formatJalaaliDate(conversation.lastMessageAt)}</p>
                </button>

                {confirmingId === conversation.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => handleDelete(conversation.id)}
                      disabled={deletingId !== null}
                      className="rounded-lg bg-warning px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {deletingId === conversation.id ? (
                        <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "حذف"
                      )}
                    </button>
                    <button
                      onClick={() => setConfirmingId(null)}
                      disabled={deletingId !== null}
                      className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted"
                    >
                      انصراف
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingId(conversation.id)}
                    disabled={deletingId !== null}
                    aria-label="حذف گفتگو"
                    className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-surface hover:text-warning disabled:opacity-50"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

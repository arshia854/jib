import "server-only";
import { prisma } from "@/lib/prisma";

// Same "not yours" convention every other module in lib/data uses (see
// AccountNotFoundError in lib/data/accounts.ts, AssetNotFoundError in
// lib/data/assets.ts): a conversation that exists but belongs to someone
// else is indistinguishable from one that doesn't exist at all, both here
// and in the 404 the API routes turn this into - so a guessed id leaks
// nothing about whether it's real.
export class ConversationNotFoundError extends Error {}

// Default page size for a conversation's own message history. A single
// conversation is naturally short (users start a new one rather than
// scrolling a year of context), so this is a generous ceiling rather than
// a paging window - there's no "load older" UI behind it.
export const DEFAULT_MESSAGES_TAKE = 50;

// Auto-generated title length. Matches the SUBSTR(..., 1, 40) in
// prisma/migrations/20260904102636_add_conversation's backfill, so a
// thread titled by the migration and one titled by the app look the same.
const TITLE_MAX_LENGTH = 40;

// Codepoint-wise, not `String.prototype.slice`'s UTF-16 code units: a
// plain slice can cut a surrogate pair in half and leave a lone surrogate
// (a "�" in the history list). Array.from/[...str] iterates codepoints, so
// it never splits one. Deliberately NOT Intl.Segmenter grapheme
// segmentation: this has to stay consistent with the migration backfill's
// SQLite SUBSTR, which counts codepoints too - the residual case
// (a ZWJ emoji sequence split at exactly 40 codepoints, rendering as its
// component emoji) is cosmetic and identical on both paths.
function truncateTitle(text: string): string {
  const trimmed = text.trim();
  const codepoints = [...trimmed];
  if (codepoints.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${codepoints.slice(0, TITLE_MAX_LENGTH).join("")}…`;
}

export interface ConversationSummary {
  id: number;
  title: string | null;
  lastMessageAt: Date;
}

// Deliberately no message preloading: the history drawer only renders a
// title + date per row, so pulling messages here would be an N+1 for data
// nothing displays. The active conversation's messages come from
// listMessages() instead.
export async function listConversations(userId: number): Promise<ConversationSummary[]> {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, title: true, lastMessageAt: true },
  });
}

export async function createConversation(userId: number) {
  return prisma.conversation.create({ data: { userId } });
}

export async function getConversation(userId: number, conversationId: number) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) {
    throw new ConversationNotFoundError("گفتگو یافت نشد.");
  }
  return conversation;
}

// The most recent `take` messages of one conversation, oldest-first for
// display. Note the two-step ordering: `desc` + `take` to select the
// newest N (an `asc` + `take` would return the OLDEST N - the bug this
// replaces in app/app/chat/page.tsx), then reversed in JS so callers get
// them in reading order. `id` is a tiebreaker on `timestamp` so two
// messages written in the same millisecond (a fast assistant reply right
// after the user's message) still order deterministically.
export async function listMessages(userId: number, conversationId: number, take: number = DEFAULT_MESSAGES_TAKE) {
  await getConversation(userId, conversationId);

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take,
  });

  return messages.reverse();
}

export async function deleteConversation(userId: number, conversationId: number) {
  await getConversation(userId, conversationId);
  // Messages go with it via ChatMessage.conversationId's onDelete: Cascade
  // (see prisma/schema.prisma) - no separate deleteMany needed.
  return prisma.conversation.delete({ where: { id: conversationId } });
}

// Bumps the "last activity" sort key the history list is ordered by.
// Separate from Prisma's own @updatedAt, which also moves for a title
// write - see the field comment in prisma/schema.prisma.
export async function touchConversation(conversationId: number) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
}

// Names an as-yet-unnamed conversation after the message that started it.
// `title: null` in the WHERE (not a read-then-write) makes this a single
// atomic statement: the second and every later turn of the same
// conversation matches zero rows and changes nothing, so a title is set
// exactly once and can never be rewritten by a later message - including
// under two concurrent requests.
//
// Takes no userId on purpose: it's only ever reached after the caller has
// already ownership-checked this conversationId (see app/api/chat/route.ts),
// and it writes nothing a caller could use to probe for another user's
// conversation - an id that isn't theirs would only ever have its title
// set, which requires already knowing the id and grants no read back.
export async function maybeAutoTitle(conversationId: number, firstUserMessage: string) {
  const title = truncateTitle(firstUserMessage);
  if (!title) return;

  await prisma.conversation.updateMany({
    where: { id: conversationId, title: null },
    data: { title },
  });
}

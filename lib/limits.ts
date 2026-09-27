// Max-length ceilings for free-text/string request fields, shared across
// app/api routes so the same field concept (a "name", a pasted SMS/text
// blob, ...) isn't bounded by a different, drifting magic number in each
// handler. Purely an input-hardening backstop - none of these are business
// rules, so there's no lib/data validation layer that already owns them.

// app/api/transactions/parse/route.ts's `text` (the SMS-paste / typed
// sentence path) and app/api/transactions/route.ts's `rawInput` (the same
// text, persisted once the parse is accepted) share this ceiling since
// they're the same content at two points in one flow.
//
// Sized off real Iranian bank SMS behavior researched for this change:
// Persian text isn't in the GSM-7 alphabet, so bank SMS always sends as
// UCS-2 - 70 chars for a single segment, ~67 chars/segment once concatenated
// (3 reserved for the concatenation UDH). Carriers/devices reassemble
// concatenated SMS reliably up to roughly 6-8 segments in practice (beyond
// that, segments are commonly dropped or delivered out of order) - see
// https://www.twilio.com/docs/glossary/what-sms-character-limit and
// https://en.wikipedia.org/wiki/Concatenated_SMS. 8 segments x 67 chars ~=
// 536 chars; rounded down to a clean 500, which is already ~4x every real
// bank-SMS fixture in lib/bank/*.test.ts (longest observed: 113 chars) and
// comfortably fits a typed conversational sentence too.
export const MAX_TRANSACTION_TEXT_LENGTH = 500;

// Transaction description - free text, but always either AI-summarized (a
// "max 5 words" prompt instruction, see buildSystemPrompt in
// lib/ai/parse-transaction.ts) or hand-edited from that starting point on
// the preview screen, so real values are short. Generous multiple of that
// to allow for editing, well under MAX_TRANSACTION_TEXT_LENGTH.
export const MAX_DESCRIPTION_LENGTH = 200;

// Account name / category name / category parentName. Matches the existing
// precedent for a person's own display name (app/api/auth/onboarding/route.ts:
// `name.length > 60`).
export const MAX_NAME_LENGTH = 60;

// Category icon. The categories-manager/admin-default-categories-manager
// UIs already cap the input at maxLength={4} (JS UTF-16 code units); this
// is a generous multiple of that to tolerate more complex multi-codepoint
// emoji (skin-tone modifiers, ZWJ sequences) without truncating a
// legitimate icon, while staying far below free-text length.
export const MAX_ICON_LENGTH = 32;

// RFC 5321 (SMTP) reverse-path length bound, the commonly-cited
// practical max for a full email address (64-char local-part + "@" +
// 255-char domain would exceed it; 254 is the figure that actually survives
// the protocol's own length limits end to end).
export const MAX_EMAIL_LENGTH = 254;

// bcrypt (bcryptjs, see lib/auth/password.ts) silently truncates the input
// at 72 *bytes* - anything beyond that is ignored when hashing, so two
// different passwords sharing the same first-72-byte prefix would hash
// identically and authenticate as each other. Enforced as a byte length
// (Buffer.byteLength(password, "utf8")), not a character/`.length` count:
// multi-byte UTF-8 (Persian text, emoji, ...) can hit 72 bytes well before
// 72 characters.
export const MAX_PASSWORD_BYTES = 72;

// GET /api/transactions pagination. Shared (not a local per-file constant
// like admin's own DEFAULT_PAGE_SIZE in lib/data/admin-users.ts/admin-logs.ts)
// because two different files need the identical numbers: the route's own
// query-param parsing/fallback, and lib/data/transactions.ts's listTransactions()
// - which also has a second caller, app/app/transactions/page.tsx, calling it
// directly rather than through the HTTP route.
//
// 20 matches admin's own DEFAULT_PAGE_SIZE precedent and is a reasonable
// mobile list page size. 100 is a hard ceiling enforced inside
// listTransactions() itself (not just at the route) - generous enough for a
// legitimate "give me more per page" request, but still a firm bound on a
// single query's cost regardless of what a caller asks for.
export const DEFAULT_TRANSACTIONS_PAGE_SIZE = 20;
export const MAX_TRANSACTIONS_PAGE_SIZE = 100;

// app/api/chat/route.ts's incoming `message` - deliberately a separate,
// larger ceiling than that same file's own HISTORY_MESSAGE_CHAR_CAP (800),
// not a reuse of it. That 800 figure exists to bound the *compounding* cost
// of up to 16 stored history messages all riding in one prompt at once (16 x
// 800 = 12,800 worst case) while still preserving recent conversational
// flow - it explicitly excludes the current turn for exactly this reason.
// The current message appears exactly once, so the same tight per-message
// budget isn't the right instinct here: truncating it would cut off the one
// piece of content the whole request exists to convey (e.g. a detailed
// question or a multi-sentence description of a purchase), for a cost
// saving that - unlike the history case - isn't multiplied across 16
// messages. 4000 is sized instead as "comfortably larger than any
// legitimate single chat turn" (many times longer than a typed sentence or
// even a pasted bank SMS, see MAX_TRANSACTION_TEXT_LENGTH above) while still
// rejecting pathological input (a pasted wall of text) well short of
// unbounded.
export const MAX_CHAT_MESSAGE_LENGTH = 4000;

// SEC-10: POST /api/transactions's optional client-generated idempotency
// key (crypto.randomUUID() client-side, see components/transactions/
// add-transaction-form.tsx and components/chat/chat-interface.tsx). A
// UUID is 36 characters; 100 is a generous ceiling in the same spirit as
// this file's other caps - well above any legitimate value, still a firm
// bound instead of leaving the column truly unbounded.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 100;

// Phase 18 security review: `Transaction.amount` (prisma/schema.prisma) is
// declared `Int` - Prisma's own scalar for a 32-bit signed integer - but
// neither app/api/transactions/route.ts's POST nor app/api/transactions/[id]
// route.ts's PATCH ever enforced that range before this, only
// `Number.isFinite(amount) && amount > 0`. Confirmed directly (not assumed)
// that this is a real, currently-reachable gap: a probe request with
// amount=99999999999999 (14 nines, ~47000x the Int32 ceiling) was accepted
// with 201 and persisted verbatim - SQLite's own INTEGER storage class has
// no fixed width, and neither the libSQL driver adapter nor Prisma Client
// rejected the out-of-declared-range value client-side before sending it.
// A single such row would badly skew every aggregate the app computes over
// amounts (getTotalBalance's groupBy _sum, spending-summary/dashboard
// totals, category breakdowns) - this is the concrete "absurdly large
// number" failure mode a malicious or fat-fingered client could trigger.
// Bounded at exactly Int32's max (2^31 - 1) rather than a guessed
// currency-sanity figure, since that's the actual contract schema.prisma
// already declares for this column - any value beyond it was never a
// value this schema claimed to support, regardless of what SQLite happens
// to tolerate underneath.
export const MAX_TRANSACTION_AMOUNT = 2_147_483_647;

// Same gap, same fix, for `FinanceAccount.initialBalance` (also declared
// `Int` in prisma/schema.prisma) - app/api/accounts/route.ts's POST and
// app/api/accounts/[id]/route.ts's PATCH only ever checked
// `Number.isFinite(initialBalance)`, no range. Unlike a transaction
// `amount`, a starting balance is legitimately negative (e.g. seeding a
// credit-card account with existing debt), so this bounds the *magnitude*
// on both sides rather than reusing MAX_TRANSACTION_AMOUNT's positive-only
// check - same Int32 ceiling, applied symmetrically.
export const MAX_ACCOUNT_BALANCE_MAGNITUDE = 2_147_483_647;

// Asset.quantity (Float) - app/api/assets/route.ts's POST and
// app/api/assets/[id]/route.ts's PATCH. No natural currency-sized ceiling
// like the Toman fields above (a quantity is grams/dollars/BTC/a bare
// count, not money), so this is just a generous "no legitimate holding
// could plausibly be this large" backstop against a fat-fingered or
// malicious value blowing up downstream arithmetic/display.
export const MAX_ASSET_QUANTITY = 1_000_000_000;

// Asset.purchasePricePerUnit / Asset.currentPricePerUnit (both BigInt, see
// prisma/schema.prisma's comment on Asset for why BigInt and not Int here).
// Bounded well under Number.MAX_SAFE_INTEGER (2^53 - 1, ~9.007 x 10^15) so
// every value that passes this check can still round-trip through a plain
// JS `number` at the API boundary (JSON responses convert the stored
// BigInt to Number - see lib/data/assets.ts) without precision loss, while
// staying orders of magnitude above any realistic per-unit Toman price
// (including a per-BTC price, the whole reason these two fields are BigInt
// in the first place).
export const MAX_ASSET_PRICE_PER_UNIT = 1_000_000_000_000_000;

// Goal.targetAmount (Int, Toman - see prisma/schema.prisma's Goal model,
// app/api/goals/route.ts's POST and app/api/goals/[id]/route.ts's PATCH).
// Same underlying constraint as MAX_TRANSACTION_AMOUNT above - both fields
// are declared `Int` in schema.prisma, so both are actually bounded by
// Int32's max (2^31 - 1) regardless of what SQLite itself tolerates. Kept
// as its own named constant rather than reusing MAX_TRANSACTION_AMOUNT
// directly since a goal target and a single transaction amount are
// different business concepts that happen to share a numeric ceiling for
// now - a future change to one's range (e.g. if transactions ever moved to
// BigInt like Asset's Toman-price fields) shouldn't silently also change
// the other's.
export const MAX_GOAL_TARGET_AMOUNT = 2_147_483_647;

// SavingsStrategy.targetAmount (Int, Toman - see prisma/schema.prisma's
// SavingsStrategy model). Same underlying constraint as
// MAX_TRANSACTION_AMOUNT/MAX_GOAL_TARGET_AMOUNT above - all three fields are
// declared `Int` in schema.prisma, so all three are actually bounded by
// Int32's max (2^31 - 1) regardless of what SQLite itself tolerates. Kept as
// its own named constant rather than reusing MAX_GOAL_TARGET_AMOUNT
// directly, for the same reason that constant isn't a reuse of
// MAX_TRANSACTION_AMOUNT: a savings-strategy target and a goal target are
// different business concepts that happen to share a numeric ceiling for
// now, and this phase has no API route to enforce it with yet regardless.
export const MAX_SAVINGS_STRATEGY_TARGET_AMOUNT = 2_147_483_647;

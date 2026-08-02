# OpenRouter cost estimate

Projected monthly OpenRouter spend for Jib's two AI call sites (transaction
parsing and the financial chat assistant), based on the actual prompts this
codebase builds today, not hypothetical ones.

**Last verified:** 2026-08-01. OpenRouter/provider pricing changes over
time — re-check
[openrouter.ai/google/gemini-2.5-flash/pricing](https://openrouter.ai/google/gemini-2.5-flash/pricing)
before relying on this doc for a real budget decision, and re-run the
numbers if `OPENROUTER_MODEL` (in `.env`) is ever switched away from the
default — every number below is specific to `google/gemini-2.5-flash`.

## Pricing used

| | Price |
|---|---:|
| Input | $0.30 / 1M tokens |
| Output | $2.50 / 1M tokens |

Source: openrouter.ai's own pricing page for `google/gemini-2.5-flash`,
linked above, verified Aug 2026.

## Where AI calls actually happen

Both AI call sites go through `lib/openrouter.ts`. Prompts are Persian, and
Persian tokenizes less efficiently than English (~2-3 chars/token instead
of ~4), so every estimate below uses **2.5 chars/token**, not the coarser
English rule of thumb.

**Transaction parsing (`lib/ai/parse-transaction.ts`) has three tiers, and
only the last one costs money:**

1. `parseBankSms()` (`lib/bank/`) — fully deterministic pasted-bank-SMS
   parser. Resolves bank + amount + type without OpenRouter.
2. `findMerchant()` (`lib/merchant-lookup.ts`) + `extractAmount()` +
   `extractDate()` — if a known merchant (user's learned mappings or the
   global merchant list) matches *and* amount/date extract cleanly from
   the raw text, returns without OpenRouter.
3. Otherwise, falls through to `chatCompletion()` with a system prompt
   (the full category tree) + the user's raw text.

So only the fraction of "add transaction" submissions that miss *both*
deterministic tiers ever reach OpenRouter — see the fast-path hit-rate
assumption below.

**Chat (`app/api/chat/route.ts`) has no fast path** — every sent message
calls `streamChatCompletion()` with: a system prompt + `getFinancialContextSummary()`
(account balance, this month's income/expense, per-category totals, up to
15 recent transactions) + up to the last 16 stored messages (`take: 16`,
user and assistant turns combined) + the new message.

## Measured prompt sizes

These character counts come from reconstructing the actual templates
verbatim — `buildSystemPrompt()` in both routes, `DEFAULT_CATEGORIES` from
`lib/categories.ts`, and the template in `getFinancialContextSummary()`
(`lib/data/chat-context.ts`) — and counting, not eyeballing.

| Prompt piece | Chars | ~Tokens (@2.5 chars/token) |
|---|---:|---:|
| Parse system prompt (fixed rules + full category tree: 10 expense + 3 income top-level categories) | 2,604 | ~1,042 |
| Typical user input (`"۵۰ هزار تومن ناهار خوردم"` — the app's own README example) | 24 | ~10 |
| Typical AI JSON output (amount/type/category/subcategory/confidence/reason) | 201 | ~80 |
| Chat system prompt + financial context (8 categories with monthly activity, 15 recent transactions) | 1,662 | ~665 |
| One history turn, avg of a representative user question + assistant answer | ~139 | ~55 |
| Typical assistant reply | 165 | ~66 |

## Assumptions (tweak these first)

- **Persian tokenization: 2.5 chars/token.** Task-specified range is
  2-3 chars/token for Farsi; this uses the midpoint. Using the denser end
  (2 chars/token) scales every cost below up by ~25% — it does not change
  the overall conclusion.
- **40 transactions logged per user per month** (~1.3/day) — a judgment
  call for an engaged personal-finance-app user, not measured.
- **10 chat messages per user per month** — chat is a secondary feature
  here, not the app's primary loop, so this assumes occasional use
  (roughly one or two short conversations/month).
- **Fast-path hit rate has no production data yet**, so it's modeled as
  two explicit sub-scenarios: **optimistic 70%** and **conservative 30%**
  of transactions resolve deterministically (bank-SMS or merchant match).
  This is the single biggest lever on parse cost — conservative is ~2.3x
  more AI calls than optimistic.
- **Category list = exactly the 13 seeded `DEFAULT_CATEGORIES` entries**
  (10 expense + 3 income top-level, per `lib/data/onboarding.ts`, which
  seeds every new user identically). A user who adds custom categories has
  a larger, slightly costlier system prompt — not modeled.
- **User input length** uses the README's own canonical example (24
  chars). Real input varies; a pasted bank SMS that *fails* deterministic
  parsing (uncommon — falls through to the AI tier) would add on the
  order of dozens more input tokens, not modeled separately since the
  ~1,042-token system prompt already dominates parse input cost.
- **Chat history modeled at the full 16-message cap** (steady-state for
  an ongoing conversation), using ~139 chars/message — the average of one
  representative user question and one representative assistant answer.
  Real message lengths vary considerably; this is a stated judgment call.
- **Financial-context instantiation** (8 active categories, 15 recent
  transactions) is illustrative of a moderately-active account, not
  measured from real user data.
- **No prompt caching is implemented today** — `lib/openrouter.ts` sends
  the full `messages` array fresh on every call. If caching is added
  later, cost would drop further, since the parse system prompt and the
  chat boilerplate are static across calls for a given category set.
- Every call is assumed to succeed on the first try — no retry/error
  spend modeled.
- No OpenRouter-side minimum fees or margin beyond the published
  per-token price (none documented on the verified pricing page).

### Per-call cost (derived from the above)

| AI call type | Input tokens | Output tokens | Cost per call |
|---|---:|---:|---:|
| Transaction parse (AI-fallback tier only) | ~1,051 | ~80 | $0.000516 |
| Chat message | ~1,551 | ~66 | $0.000630 |

## Scenarios

- Monthly active users (MAU): **100 / 1,000 / 10,000**
- 40 transactions/user/month, of which only the AI-fallback fraction
  (1 − fast-path hit rate) incurs a parse call
- 10 chat messages/user/month, always an AI call (no chat fast path)

| MAU | Fast-path scenario | AI parse calls/mo (total) | Chat calls/mo (total) | Monthly OpenRouter cost | Cost / user / month |
|---:|---|---:|---:|---:|---:|
| 100 | Optimistic (70% hit rate) | 1,200 | 1,000 | **$1.25** | $0.0125 |
| 100 | Conservative (30% hit rate) | 2,800 | 1,000 | **$2.08** | $0.0208 |
| 1,000 | Optimistic (70% hit rate) | 12,000 | 10,000 | **$12.50** | $0.0125 |
| 1,000 | Conservative (30% hit rate) | 28,000 | 10,000 | **$20.76** | $0.0208 |
| 10,000 | Optimistic (70% hit rate) | 120,000 | 100,000 | **$125.00** | $0.0125 |
| 10,000 | Conservative (30% hit rate) | 280,000 | 100,000 | **$207.62** | $0.0208 |

## Takeaway

At every launch-relevant scale modeled here, OpenRouter spend on
`google/gemini-2.5-flash` is negligible — even the conservative case at
10,000 MAU lands around **$208/month** (about 2 cents per user), because
the deterministic bank-SMS and merchant fast paths absorb a large share of
parse volume before any AI call happens, and Gemini Flash's per-token
price is very low to begin with. This is not a cost center worth
engineering around at these volumes. The number that would actually change
this conclusion is a switch to a pricier `OPENROUTER_MODEL` (this estimate
is only valid for Gemini 2.5 Flash) or a large jump in chat engagement
(e.g. if chat became a primary, high-frequency feature rather than
occasional use) — worth re-running this estimate if either changes.

# Categorization pipeline audit + archived categories — 2026-09-25

Two parts: **A** replaces the name-based `DEPRECATED_CATEGORY_NAMES` filter
with an `isArchived` flag (implemented in the working tree, **not applied to
live**); **B** is an evidence-based audit of categorization and income/expense
detection, with a ranked list of small fixes.

**No live DB access of any kind happened.** Every probe below ran against
pure functions or the isolated local SQLite test DB (`vitest.config.ts`
forces `TURSO_DATABASE_URL` to it). `prisma migrate diff` and the rehearsals
ran with `TURSO_DATABASE_URL` overridden to a scratch file. The real-data
facts cited (84 median categories, 5/77 users logging, 3 transactions on the
retired category, ~3,371 prompt tokens) are from your earlier approved
aggregate rehearsal, not re-measured.

## TL;DR

- **Part A is written and tested, not applied.** Full suite: 115 files /
  1,393 tests pass (+4 new). Two gaps the name-based filter missed are now
  closed. One is the AI-suggestion "accept" path, which could file a
  transaction under the retired category; the other is the manual pickers.
  **One thing to know before approving the live migration:** the generated
  SQL rebuilds `Category` with `DROP TABLE`, and it only works if every
  statement runs on one connection. Rehearsed offline both ways (§A.5).
- **The biggest categorization errors aren't the LLM's.** They come from the
  deterministic paths that run *before or instead of* the LLM and return
  `confidence: 1`, `needsConfirmation: false`. Merchant-name collisions
  («لپ‌تاپ» → the «تاپ» payment gateway; «دیوار» = "wall"), learned mappings
  with generic keys («خرید»), merchant type overriding refunds, and a loose
  new-category similarity threshold. All reproducible offline, and all
  fixable with small changes that need no usage data.
- **The category tree is ~16% of the prompt**, not the bulk. Trimming it
  isn't worth much. The accuracy risk from the tree is confusable siblings,
  not its length.
- **The 0.8/0.5 thresholds are uncalibrated, and no correction signal is
  persisted anywhere today.** §B.4 designs the smallest instrumentation to
  fix that. At current usage (4 users with ≥10 transactions) it would take a
  long time to yield calibration-grade data, which is another reason to lead
  with the fixes that need none.

---

## Part A — archived categories

### A.1 Every `DEPRECATED_CATEGORY_NAMES` call site (grep, before this change)

| Site | What it did | Now |
|---|---|---|
| `lib/categories.ts:54` | the definition | removed; replaced by `excludeArchived()` |
| `lib/ai/parse-transaction.ts:7, 554` | filtered the list before the prompt, merchant-override validation, AI leaf validation, and `findSimilarCategory` | `excludeArchived(allCategories)` at the same single point |
| `lib/data/onboarding.ts:3, 42` | skipped the child when seeding from `DefaultCategory` | `where: { isArchived: false }` on both mains and children |
| `prisma/default-categories.ts:159` | comment | pointer updated |
| `lib/ai/parse-transaction.test.ts:495–558`, `lib/data/onboarding.test.ts:53–86` | tests | fixtures now set `isArchived: true` |
| `scripts/dry-run-savings-essential-fix.ts:20` | the name appears in a read-only one-off's `TARGET_NAMES`; not a filter | untouched |

**Read paths that should have been filtering and weren't** (all fixed):

1. **`resolveOrCreateCategoryFromSuggestion`** (`lib/data/categories.ts`) is
   used by `POST /api/categories` (`source: "ai-suggestion"`) and by the
   background banner's "accept" (`POST /api/transactions/[id]/suggested-category`).
   It ran `findSimilarCategory` over the *unfiltered* list. An accepted
   «پس‌انداز» suggestion token-overlaps «واریز به حساب پس‌انداز» at ratio 1.0
   (`normalizeText` turns the half-space into a space, so both carry
   `پس`/`انداز`), so it would have landed the transaction on the retired
   category. New test covers it.
2. **The add / batch-add `<select>`s** listed every category, so the retired
   one could still be picked by hand. Also, flipping income/expense defaulted
   to "the first category of that type", which could be an archived one. Both
   now go through `isSelectableCategory()`. Edit mode still shows the
   transaction's current category even if it's archived.
3. **Settings → categories** now labels archived rows «بایگانی‌شده» rather
   than listing them like normal categories that mysteriously never appear in
   the pickers.

### A.2 Design

- **Schema:** `isArchived Boolean @default(false)` on `Category` and on
  `DefaultCategory`. The second one is needed because `prisma/seed.ts` only
  upserts, so the stale default row stays in the live table until it's flagged.
- **Meaning:** "retired from *new* selection", not "invalid". It is
  deliberately **not** enforced in `createTransaction`/`updateTransaction`:
  - An offline-queued create (`lib/offline/transaction-queue.ts`) made before
    an archive would be rejected on replay and lost.
  - Editing an old transaction must be able to keep its category.
- **Archiving a parent retires its subtree** (`excludeArchived`). Otherwise
  its children would stay reachable through merchant overrides and
  `findSimilarCategory` even though the prompt no longer lists them. The
  parent is matched on name *and* type, because «انتقال بین حساب‌ها» exists
  under both types.
- **History is untouched:**
  - Nothing writes to `Transaction`/`MerchantMapping`.
  - `listTransactions` includes the `category` relation, so the real name
    still displays.
  - Reports aggregate by `categoryId`.
  - The transaction filter bar still lists archived categories.
- **Stale learned mappings** pointing at an archived category: `findMerchant`
  still returns them, but `resolveCategoryOverride` validates against the
  filtered list, so they're ignored and the input falls through to the AI.
  No cleanup is needed; the next manual correction overwrites the mapping.
- **`toCategoryOptions()`:** the Category → `CategoryOption` mapping was
  copy-pasted in four places (the parse route, the chat route, the
  enrichment workflow, and suggestion dedup). One copy forgetting
  `isArchived` would silently let archived categories back into the prompt,
  so the four are now one helper.

### A.3 Letting users archive their own categories — scoped, not built

- **API:** `PATCH /api/categories/[id]` accepts `isArchived: boolean`.
  `updateCategory` already takes a partial data object, so this is a few lines
  plus validation and tests.
- **UI:** the natural entry point already exists. `DELETE` returns 409
  `CategoryInUseError` when transactions reference the category; offer
  «بایگانی کن» there instead of a dead-end error, plus «بازگردانی» on archived
  rows. The manager is a flat list, so archiving a *parent* needs a
  confirmation that names the children it also hides.
- **Decision needed:** creating a category whose name matches an archived one
  hits `@@unique([userId, name, type])` and returns 409. Should it unarchive
  instead?
- **Admin:** the same toggle on `DefaultCategory` in `app/app/admin/categories`.
- **Estimate:** M, and independent of everything else. Worth building once
  users actually hit "can't delete, in use". With 5 users logging, not urgent.

### A.4 Rollout order (nothing done yet)

1. With your approval, apply `prisma/migrations/20260925093410_add_category_is_archived`
   to Turso **on a single connection** (§A.5).
2. Record it in `_prisma_migrations` (AGENTS.md step 6). I deliberately did
   **not** add it to `MIGRATION_NAMES` in `scripts/backfill-migration-history.ts`
   yet, so that script can't record a migration that hasn't been applied.
3. Run `npx tsx prisma/archive-retired-categories.ts` (dry run), review the
   output, then run it with `--execute`.
4. Deploy the code.

Why this order:
- Old code never reads the new column (it's additive and defaulted), so
  steps 1–3 are invisible to production.
- The new code has no name filter anymore. Deploying it before step 3 would
  briefly put the retired category back into every existing user's prompt.
- Deploying it before step 1 breaks every Category query with "no such
  column". That's a hard blocker.

### A.5 Migration apply — read this before approving

`migrate diff` generated a **table rebuild** ("RedefineTables":
`CREATE new_Category` → copy → `DROP TABLE "Category"` → rename), not an
`ADD COLUMN`. It's the same shape as the already-applied
`20260806144050_add_category_is_essential`. The file opens with
`PRAGMA foreign_keys=OFF`, which only holds for the connection it runs on.

Rehearsed on a scratch SQLite file containing a `Transaction` and a
`MerchantMapping` that reference the retired category, with FKs enforced (live
Turso enforces them: `PRAGMA foreign_keys = 1`, per
`prisma/refresh-user-categories.ts`):

| Apply mode | Result |
|---|---|
| New connection per statement (the PRAGMA doesn't carry over) | **Fails at statement 5/16** (`DROP TABLE "Category"`: `FOREIGN KEY constraint failed`). No data lost; a stray `new_Category` is left and must be dropped before retrying. |
| All 16 statements on **one** connection | All succeed; `PRAGMA foreign_key_check` finds 0 violations; the transaction still points at the same category id/name; indexes recreated; `isArchived = 0` everywhere. |

**So:** apply it on a single `@libsql/client` connection. Use
`client.executeMultiple(sql)` (what `test/setup/global-setup.ts` already uses)
or one interactive stream. Don't reuse
`scripts/apply-user-role-check-migration.ts`'s per-statement
`client.execute()` loop unless you've confirmed a `libsql://` client keeps one
stream across calls. I couldn't see how the `isEssential` rebuild was actually
applied live.

- No hand-written CHECK or trigger exists on either table, so the rebuild
  can't silently drop one (the `User_role_check` / Assets precedent).
- The alternative is a hand-written two-line
  `ALTER TABLE … ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false`. It's
  equivalent and immune to the FK issue, but it breaks AGENTS.md's "never
  hand-edit `migrate diff` output". Your call; I kept the generated file
  as-is.
- Deviation from AGENTS.md step 2: the "before" schema is the **working-tree**
  `schema.prisma`, not `HEAD`. `schema.prisma` has uncommitted changes (the
  savings/goal/transfer work), and diffing from `HEAD` would have re-emitted
  them in this migration.

### A.6 Backfill script — `prisma/archive-retired-categories.ts`

- Dry run by default; `--execute` to write.
- Checks that the column exists first, and aborts with a clear message on a
  pre-migration DB.
- Lists every row it would flip, with the number of transactions/mappings
  that keep pointing at it.
- The update is keyed on exactly the ids it reported, and it's idempotent.

Rehearsed on the migrated scratch DB:
- Dry run: 1 `Category` + 1 `DefaultCategory` row, 0 writes.
- `--execute`: archived 1 + 1; verification 0/0; references intact.
- Re-run: 0 / 0.
- Pre-migration DB: aborts with the message.

**Not run against live.** Even the dry run needs your go-ahead.

### A.7 Tests

- Affected suites: 161/161.
- Full suite: 115 files / 1,393 tests.
- `tsc` is clean apart from the existing BigInt-literal errors in unrelated
  test files. `eslint` is clean on every touched file.
- New tests: `excludeArchived` ×3 (archived child; archived parent retires the
  subtree; the parent match is type-aware) and one for the suggestion-dedup
  gap.

---

## Part B — categorization quality audit

### B.1 The actual decision flow (from the code)

Entry points: `POST /api/transactions/parse` (live preview), chat's
`trySuggestTransaction`, and `lib/workflows/enrich-transaction.ts`
(quick-submit background). All three call `parseTransactionWithAI`, which
applies `excludeArchived` first.

1. **Bank SMS** (`parseBankSms`: all-or-nothing, detection floor
   `MIN_CONFIDENCE_SCORE` 50%).
   - If a merchant also matches *with the same type* and a valid category,
     that category wins with `needsConfirmation: false`.
   - Otherwise the category is the fallback, `needsConfirmation: true`,
     `categorizationConfidence: "low"`.
   - Extraction confidence is `"high"` iff `bankConfidence >= 1`.
2. **`findMerchant`** checks the user's `MerchantMapping` rows first, then the
   20 global merchants (`lib/merchants.ts`). `findBestMatch` tiers:
   1. exact normalized equality;
   2. contiguous token run (the longest wins);
   3. raw substring, only for candidates of length ≥ 4
      (`MIN_SUBSTRING_MATCH_LENGTH`).

   `keywordOverrides` apply on top of a global match.
3. **Deterministic fast path.** Needs a merchant match, a category valid for
   *the merchant's* type, and non-null `extractAmount`/`extractDate`. Then:
   type comes from the merchant, `confidence: 1`,
   `needsConfirmation: false`, **no AI call**. `extractDate` returns today
   when no date word is present, so in practice this only needs merchant +
   amount.
4. **AI call:** Arvan-hosted, model from `ARVAN_AI_MODEL` (`.env.example`:
   `DeepSeek-V4-Flash`), JSON mode, `max_tokens` 1500, 30 s timeout with one
   retry, **no `temperature` set**. The model's context limit isn't recorded
   anywhere in code or config; I didn't guess one.
5. **Shape gate:** the JSON parses; `amount` is a finite number > 0; `type` is
   `income|expense`; `category` is a string.
6. **`assetPurchase`** gets priced live, forces `type: "expense"`, and
   overrides `amount`.
7. **Merchant override again:** if the merchant's category is valid for the
   AI's type, it wins with `confidence: 1`, no confirmation.
8. **`resolveAiCategory`:** `category` must be top-level and `subcategory`
   must be its child (an invalid subcategory falls back to the parent). A
   fully invalid pair gets effective confidence 0. Then:
   - **≥ 0.80** → assign, `"high"`
   - **≥ 0.50** → assign + `needsConfirmation`, `"medium"`
   - **else** → «سایر هزینه‌ها»/«سایر درآمدها» + `needsConfirmation`, `"low"`
9. **`newCategorySuggestion`:** only accepted with exactly 3 keys. Then
   `findSimilarCategory` tries the same parent first, then all categories,
   using exact → alias → token overlap (**shared ÷ min(size) ≥ 0.5**). A match
   replaces the category, with `needsConfirmation` and `"medium"`.
10. **Downstream gates:**
    - Chat only shows a save card for `type: "expense"` with no
      `suggestedCategory` and `!needsConfirmation` (asset purchases are
      exempt).
    - Quick submit uses `extractIncomeSignal` (3 keywords).
    - A terminal enrichment failure uses `hasStrongIncomeSignal` (9 keywords).

### B.2 Findings

#### F1 — Merchant-name collisions: wrong category, confidence 1, no confirmation, no AI

Probe (`lookupGlobalMerchant` + the extractors, offline):

| Input | Matched merchant (tier 2) | Filed as | Why it's wrong |
|---|---|---|---|
| لپ‌تاپ خریدم ۳۰ میلیون | «تاپ» (payment gateway) | سایر هزینه‌ها | the ZWNJ becomes a space, so «تاپ» is a whole token |
| رنگ کردن دیوار خونه ۲ میلیون | «دیوار» (marketplace) | خرید | «دیوار» = wall; should be تعمیر و نگهداری منزل |
| ترب و پیاز ۵۰ | «ترب» (price site) | خرید | «ترب» = radish; should be میوه و سبزیجات |
| اسنپ مارکت ۴۰۰ تومن | «اسنپ» | تاکسی و اسنپ | grocery |
| اسنپ‌تریپ هتل ۵ میلیون | «اسنپ» | تاکسی و اسنپ | travel/hotel |
| اسنپ دکتر ویزیت ۳۰۰ | «اسنپ» | تاکسی و اسنپ | a doctor's visit |
| با آپ قبض برق دادم ۲۰۰ | «آپ» (gateway) | سایر هزینه‌ها | the AI would have said برق، آب و گاز |

Every row has a valid amount, so all of them take the fast path with no AI
call, and in chat they produce a one-tap save card. The `TODO(matcher)` notes
on «آپ»/«تاپ» ask for "exact whole-token match only", but that's the tier
that bites: «تاپ» *is* a whole token in «لپ تاپ». The gateway entries also map
to the fallback bucket anyway. **A gateway match can only ever do worse than
letting the AI run.**

#### F2 — Learned mappings with generic keys take over unrelated inputs

`updateTransaction` upserts a `MerchantMapping` whenever the category changes.
The key comes from `buildMerchantKey`, which keeps the longest run of
non-digit tokens:

- «خرید ۲۰۰» → `"خرید"`
- «پرداخت ۵۰۰ تومن» → `"پرداخت"`
- «کارت به کارت ۲ میلیون» → `"کارت به کارت"`
- «۲۰۰ تومن اسنپ» → `"تومن اسنپ"` (a currency word leaks in)

Probe on the local test DB: one mapping «خرید ۲۰۰» → پوشاک, then:

| Later input | Result |
|---|---|
| خرید نون ۵۰ | userMapping → پوشاک (tier 2) |
| خریدم دارو ۱۲۰ | userMapping → پوشاک (tier 3 substring) |
| خرید بلیط هواپیما ۳ میلیون | userMapping → پوشاک (tier 2) |

`userMapping` is always rated `"high"`, with no confirmation and the AI
skipped. The mapping also sets **`type`**, so a generic key mapped to an
income category flips direction too. The people this hits are exactly the
ones who correct categories (the 4 active users).

#### F3 — The merchant's type overrides refunds

| Input | Result |
|---|---|
| دیجی کالا پول گوشی رو برگردوند ۲۰ میلیون | expense, خرید, fast path |
| اسنپ ۸۰ تومن برگشت داد | expense, تاکسی و اسنپ, fast path |
| استرداد وجه دیجی‌کالا ۳ میلیون | expense, خرید, fast path |

The merchant's `type` is "never parsed from text" by design. Note that
`hasStrongIncomeSignal` itself lists «استرداد» as an income keyword.

#### F4 — `findSimilarCategory`'s 0.5 threshold merges unrelated categories

The ratio is `shared / min(|A|, |B|)`, so any two-word suggestion that shares
one word with an existing category passes, and «و» counts as a token. Against
the real default tree, 19 plausible suggestions:

| Suggestion | Merged into | |
|---|---|---|
| بلیط بخت آزمایی | سفر / بلیط سفر | ✗ (lottery ticket → travel ticket) |
| اجاره خودرو | مسکن / اجاره | ✗ (car rental → housing rent) |
| بیمه عمر | بیمه / بیمه درمان تکمیلی | ✗ |
| تعمیر موبایل | حمل‌ونقل / تعمیر و سرویس خودرو | ✗ |
| لوازم بچه | خرید / لوازم دیجیتال | ✗ |
| لوازم کمپینگ | خرید / لوازم دیجیتال | ✗ |
| کلاس رقص, کلاس موسیقی | آموزش / دوره و کلاس آنلاین | ✗ |
| لوازم آرایشی | لوازم آرایشی و بهداشتی | ✓ |
| کافه گردی, شهریه مهدکودک, جراحی زیبایی, هدیه عروسی | nearest sibling/parent | arguable |
| کارگر نظافت, پیک موتوری, قمار و شرط بندی, دخانیات, اشتراک نتفلیکس… | (new) / parent | ok |

Four of the wrong merges (بلیط بخت آزمایی, اجاره خودرو, لوازم بچه,
کلاس موسیقی) are names that `NEW_CATEGORY_ICONS` was written for as
"genuinely new". Their icons are effectively dead code.

Where this bites:
- **Parse path:** the wrong category is pre-selected, though flagged for
  confirmation.
- **Accept path (worse):** the user taps "create «بلیط بخت آزمایی»" and
  `resolveOrCreateCategoryFromSuggestion` silently returns
  `resolvedExisting: true` for «بلیط سفر». From the background banner,
  `applySuggestedCategory` then files the transaction there.

**Simulated fix:** drop «و»; require ≥ 2 shared content tokens, or a one-word
suggestion that appears in exactly one category.
- All 8 wrong merges become "new".
- Keeps: لوازم آرایشی → لوازم آرایشی و بهداشتی, باشگاه → اشتراک باشگاه,
  آرایشگاه → آرایشگاه و سالن زیبایی, هدیه تولد → هدیه تولد و مناسبت.
- Loses the 4 "arguable" merges. They degrade to a "create new category?"
  prompt the user can decline, and any of them can be restored through
  `CATEGORY_ALIASES`, which is the intended extension point.

`CATEGORY_ALIASES` has 3 keys, and «دخانیات» isn't in the default tree, so it
only helps users who created that category themselves.

#### F5 — Transfer categories are valid AI targets; savings deposits still count as spending

- «انتقال بین حساب‌ها» appears in **both** the expense and income trees of the
  prompt (probe: 2 occurrences).
- Nothing excludes `isTransfer` categories from the parser or the add-form
  `<select>`, and `createTransaction` doesn't reject them.
- One AI-categorized transaction filed there is a **one-legged transfer**: it's
  excluded from spending/income, but it moves the account balance with no
  counterpart. That breaks the invariant `/app/transfer` maintains.
- The likeliest trigger is exactly the text the deprecation was about
  («ریختم به حساب پس‌اندازم»).

The deprecation's own goal is also only half met. The existing test asserts
that savings-deposit text now falls back to the parent
«پس‌انداز و سرمایه‌گذاری», which is still an expense counted in totals.

#### F6 — The prompt and merchant table have drifted from the category tree

- **Prompt:** «اگر هیچ دسته‌ای مناسب نبود، category را «سایر» … بگذار» (and
  again in the `newCategorySuggestion` rule). No category is named «سایر»;
  they're «سایر هزینه‌ها»/«سایر درآمدها». A model that obeys emits an invalid
  name, which lands in the same bucket but is always forced to `"low"` +
  `needsConfirmation`, whatever its actual confidence.
- **`lib/merchants.ts`** predates the 2026-09-04 tree. Its comments say
  تفریح و سرگرمی's only child is سفر; it now has سینما و کنسرت,
  بازی و اشتراک سرگرمی, کتاب و مجله, and گردش…, and سفر is top-level. Other
  comments say there's no delivery subcategory; «غذای بیرون‌بر» exists now.
  As a result:
  - streaming merchants file under a bare top-level category;
  - the delivery apps file under رستوران و کافه;
  - the «کتاب» keyword → «آموزش» (top-level only), even though
    کتاب و مجله / کتاب و لوازم‌التحریر now exist.
- No test checks that merchant targets are current leaves of the tree.

#### F7 — Few-shot coverage

The 11 contrastive examples are good (سوپرمارکت vs رستوران و کافه, pet food vs
سوپرمارکت, the two «قسط» types…). These confusable pairs in the tree have no
example:

| Pair | Why it's confusable |
|---|---|
| شارژ موبایل (قبوض) vs شارژ ساختمان (مسکن) | «شارژ» means both |
| رستوران و کافه vs غذای بیرون‌بر | delivery vs dine-in |
| کتاب و مجله (تفریح) vs کتاب و لوازم‌التحریر (آموزش) | near-duplicate names under different parents |
| اشتراک نرم‌افزار و سرویس (قبوض) vs بازی و اشتراک سرگرمی (تفریح) | Netflix/Spotify |
| تعمیر و سرویس خودرو vs تعمیر و نگهداری منزل | «تعمیر» |
| سوپرمارکت vs میوه و سبزیجات; vs لوازم آرایشی و بهداشتی | where vs what |
| **Direction:** اجاره (expense) vs اجاره‌ی ملک (income); هدیه (income) vs هدیه و خیریه; سرمایه‌گذاری (income) vs پس‌انداز و سرمایه‌گذاری | only 2 income examples, both clear-cut |
| Savings deposit to own account; refunds | nothing |

#### F8 — Prompt size and latency

Measured on the built system prompt with the 83-category default tree:

| Part | Chars | Share |
|---|---|---|
| Header / schema | 761 | 9% |
| **Category tree** | **1,332** | **16%** |
| Rules | 3,817 | 45% |
| Examples | 2,516 | 30% |
| Total | 8,426 | |

- Removing the entire tree would cut about 16% of the ~3,371 prompt tokens.
  83 names in 25 grouped lines is not a long-context problem for this class
  of model; the accuracy risk is confusable siblings (F7), not list length.
  **Per-user pruning isn't worth it**, and doing it well would need usage
  data.
- What *may* matter: the dynamic parts (the per-user tree and today's date)
  come **before** the static ~75%, which defeats automatic prefix caching if
  the provider does it. **Unverified:** I can't confirm that Arvan's hosting
  caches prefixes, and `TokenUsage` only parses `prompt_tokens`/`completion_tokens`,
  so there's no visibility today.
- No `temperature` is set, so an extraction task runs at the provider's
  default sampling temperature.

#### F9 — The thresholds are uncalibrated, and there's no correction signal

The 0.8/0.5 thresholds are spec constants, and `lib/ai/confidence.ts` itself
says no calibration data exists. The self-reported `confidence` isn't even
logged (`"AI call succeeded"` logs duration and usage only), so its
distribution is unknown. Where a correction could be captured today:

| Correction moment | Captured? |
|---|---|
| Changing the `<select>` in the preview before saving (the most common correction) | **No.** The create payload carries only the final category. |
| Editing after save (`updateTransaction`) | Only as a `MerchantMapping` side effect. The predicted category, source, and confidence aren't stored (`Transaction.source` is only "assistant-suggestion" provenance). |
| Accepting/dismissing a suggested category | **No.** State is cleared, nothing logged. |
| Editing a quick-submit row after AI enrichment | **No.** `enrichmentStatus` is already null, so the edit can't tell it overrode an AI value. |

#### F10 — Income/expense keyword signals

There are **two divergent lists**:
- `extractIncomeSignal` (`lib/extract-transaction-type.ts`, 3 words, runs at
  quick submit);
- `hasStrongIncomeSignal` (`lib/extract-income-signal.ts`, 9 words, runs on
  terminal enrichment failure and in the audit script).

Their comments contradict each other about «واریزی».

| Input | quick (3) | strong (9) | Truth |
|---|---|---|---|
| عیدی به بچه‌ها دادم ۲ میلیون | – | **income** | expense |
| دستمزد لوله‌کش ۸۰۰ | – | **income** | expense |
| پاداش دادم به کارمندم ۵ میلیون | – | **income** | expense |
| حقوق پرستار بچه رو دادم ۱۰ میلیون | **income** | **income** | expense |
| یارانه ۴۰۰ | – | – | income |
| سود سپرده ۲ میلیون | – | – | income |
| اجاره خونه رو گرفتم ۱۵ میلیون | – | – | income (ambiguous) |
| حقوقم ریخت ۳۰ میلیون | – | – | income (a documented trade-off) |

The false-income rows break both files' own bar ("reads as income in
essentially every sentence"). That's the costlier error: it corrupts
`monthIncome` and balances.

The "no expense list" reasoning is still right for *classification*: expense
is already the default, so an expense list can't change anything. But a small
**payer-verb veto** is justified: don't flip to income when there's a
first-person paying verb (دادم، پرداختم، پرداخت کردم، خریدم، فرستادم). That
fixes all four false-income rows. «یارانه» is receive-only and very common,
so it's safe to add, as is the bigram «سود سپرده». Bare «سود» is not safe
(«سود وام دادم» is paying interest).

#### F11 — Asset purchases

- **The merchant fast path skips asset detection completely.** «۱۰ گرم طلا از
  دیجی کالا خریدم» → «خرید», **10,000 toman** (the bare "10" goes through the
  ×1000 rule), no AI call, no `Asset` row, no confirmation.
- **On the AI path, category and `assetPurchase` are decided independently.**
  - `assetPurchase` set with category «خرید» or the fallback: an `Asset` row
    is created, but the money is counted as discretionary spending («خرید» is
    `isEssential: false`, so it shows up as "reducible").
  - Category «خرید طلا و ارز» without `assetPurchase`: an investment recorded
    with no `Asset` row.
- **Jewelry vs investment gold** («دستبند طلا» vs «سکه») has no example.
- **Chat's asset exemption skips `needsConfirmation`**, so a fallback-category
  asset card can be saved in one tap.

### B.3 Ranked fixes

Each row ships independently. None assumes a labeled corpus exists.

| # | Change | Fixes | Expected impact | Effort | Needs usage data? |
|---|---|---|---|---|---|
| 1 | Delete the «آپ»/«تاپ»/زرین‌پال/نکست‌پی gateway entries (they map to the fallback bucket anyway), and require a tier-1 match or context for «دیوار»/«ترب»; skip «اسنپ» when the next token is مارکت/تریپ/دکتر/پی/باکس | F1 | High: removes silent, confirmation-free errors on common words | S | No |
| 2 | Fast-path bail-outs: go to the AI when the text has a refund cue (برگشت، برگردوند، استرداد، عودت) or an asset cue (گرم طلا، سکه، دلار، بیت‌کوین، تتر), or when the global match is tier ≥ 2 | F1, F3, F11 | High | S | No |
| 3 | Merchant-key hygiene: a stopword list (خرید، خریدم، پرداخت، کارت، به، تومن/تومان، هزار، میلیون، ریال…); refuse keys that are empty or stopword-only; no tier-3 substring for user mappings | F2 | High for the users who actually correct things | S | No |
| 4 | Stricter `findSimilarCategory` (drop «و»; ≥ 2 shared tokens, or a unique single-token hit) plus a few aliases for the lost-but-wanted merges | F4 | Medium-high: stops silent re-filing on the accept path | S | No |
| 5 | Exclude `isTransfer` categories from the parser's options and the add-form `<select>` (same mechanism as `excludeArchived`) | F5 | Medium: prevents one-legged transfers | S | No |
| 6 | Income signal: merge into one module/list; add the payer-verb veto, «یارانه», and «سود سپرده» | F10 | Medium (the costlier error class) | S | No |
| 7 | Prompt text: interpolate `FALLBACK_*_CATEGORY` in place of «سایر»; add one rule and one example saying a deposit to your own savings account isn't spending (leave it on the fallback with confirmation; the UI already nudges toward `/app/transfer`) | F6, F5 | Medium | S | No |
| 8 | Refresh `lib/merchants.ts` targets to the current tree (غذای بیرون‌بر, بازی و اشتراک سرگرمی, کتاب و مجله) and add a test that every merchant/override target exists in `DEFAULT_CATEGORIES` with the right parent | F6 | Low-medium; stops future drift | S | No |
| 9 | Instrumentation step 1 (§B.4) | F9 | Makes every other row measurable | S | — |
| 10 | Asset ↔ category consistency: `assetSuggestion` implies a category under «پس‌انداز و سرمایه‌گذاری», otherwise `needsConfirmation`; «خرید طلا و ارز» without an asset gets a hint; chat's asset exemption requires a non-fallback category | F11 | Low-medium | S | No |
| 11 | About 6 targeted few-shots (شارژ, delivery, the direction pairs, refund, savings deposit, jewelry vs investment gold), paid for by trimming the asset-rule prose. Add a small hand-labelled synthetic smoke fixture run by hand against the real model (extend `scripts/benchmark-model-latency.ts`) | F7 | Medium, unmeasured | M | Partly (a smoke test only, not an accuracy measure) |
| 12 | Put the static rules and examples first, then the tree, then the date; log `prompt_tokens_details.cached_tokens` if the provider returns it; set `temperature: 0` for extraction (check that Arvan accepts it first) | F8 | Latency/cost: **unknown until measured**; variance: small | S | Yes, to confirm |
| 13 | Instrumentation step 2 (persist source/confidence) | F9 | Enables calibration | M (migration) | — |
| 14 | Retune 0.8/0.5 | F9 | Unknown | S | **Yes** |
| 15 | User-facing archive UI (§A.3) | — | Low right now | M | No |

**Not recommended now:** per-user tree pruning or top-k category retrieval
(the tree is 16% of the prompt, and choosing a k needs usage data), or a full
prompt rewrite.

### B.4 What needs real usage data, and the smallest instrumentation to get it

**Needs data before acting:**
- threshold retuning (#14);
- whether the few-shot additions (#11) actually help;
- whether a tier-2 global merchant match is trustworthy enough to skip the AI
  (#2 takes the conservative side meanwhile);
- whether the prompt reorder (#12) helps latency.

**Step 1 — S effort, no migration.**
- The client already holds the `ParsedTransaction`. Add
  `prediction: { category, source, categorizationConfidence, needsConfirmation, confidenceBucket }`
  to the create payload (`submitCreateTransaction`).
- Validate every field against closed sets. It's untrusted input.
- `POST /api/transactions` logs one structured event, `categorization_outcome`:
  `{ source, matchTier, categorizationConfidence, confidenceBucket (0.1 steps), needsConfirmation, overridden: predicted !== final }`.
- Never log `rawInput` (Phase 12.4.1). Log category ids rather than names if
  names count as sensitive.
- This captures the preview-stage override, which is invisible today.

**Step 2 — M effort, migration.**
- Persist nullable `categorySource` and `categoryConfidence` on `Transaction`
  at create and at enrichment.
- `updateTransaction` logs `category_corrected { fromSource, fromConfidence }`
  when `categoryId` changes. This covers post-save and post-enrichment
  corrections.

**Step 3 — S effort.** Log suggested-category accept/dismiss with
`resolvedExisting`. That measures F4's silent merges directly.

**What that gives you:**
- override rate per source and tier (validates #1–#3);
- override rate per confidence bucket (the calibration curve for 0.8/0.5);
- the merge-accept rate.

At current volume, expect weeks to months before the per-bucket counts mean
anything.

---

## Appendix — full diff of everything written in this task

Rebuilt against each file's state *immediately before* this task (the
working tree already had unrelated uncommitted changes in several of these
files, so a plain `git diff HEAD` would mix those in). The two new files are
shown as additions.

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -119,6 +119,14 @@
   // newly-created category with no explicit classification isn't silently
   // counted as wasteful spending.
   isEssential Boolean  @default(true)
+  // Retired from *new*-transaction selection only - hidden from the AI
+  // prompt/resolution (lib/ai/parse-transaction.ts), new-category dedup
+  // (lib/data/categories.ts) and the add-transaction pickers, but still a
+  // normal row otherwise: existing Transaction/MerchantMapping rows keep
+  // pointing at it (both FKs are onDelete: Restrict) and keep displaying
+  // its real name. Archiving a top-level category also retires its
+  // children (see excludeArchived in lib/categories.ts).
+  isArchived  Boolean  @default(false)
   createdAt   DateTime @default(now())
 
   userId Int
@@ -422,6 +430,10 @@
   // lib/data/onboarding.ts) - same meaning/default as Category.isEssential
   // above.
   isEssential Boolean  @default(true)
+  // Skipped by onboarding (lib/data/onboarding.ts) - same meaning as
+  // Category.isArchived above. Not copied onto the user's own Category rows:
+  // an archived default is simply never seeded.
+  isArchived  Boolean  @default(false)
   createdAt   DateTime @default(now())
 
   parentId Int?
--- a/lib/categories.ts
+++ b/lib/categories.ts
@@ -39,19 +39,25 @@
 export const FALLBACK_EXPENSE_CATEGORY = "سایر هزینه‌ها";
 export const FALLBACK_INCOME_CATEGORY = "سایر درآمدها";
 
-// "واریز به حساب پس‌انداز" (a child of "پس‌انداز و سرمایه‌گذاری") overlapped
-// with the dedicated /app/transfer flow: recording a savings deposit as an
-// expense in this category still counted as structural spending, which
-// transfer's isTransfer-excluded paired transactions exist specifically to
-// avoid. It's removed from prisma/default-categories.ts so no new user is
-// seeded it, but Transaction.categoryId's onDelete: Restrict means existing
-// users' real Category/Transaction rows referencing it can't be hard-deleted
-// - so it's filtered by name at every point a NEW transaction could still
-// land on it (lib/data/onboarding.ts's seeding, lib/ai/parse-transaction.ts's
-// prompt/resolution) rather than only removed from the seed data, since an
-// existing user's per-user Category table may still physically have this
-// row from before the removal.
-export const DEPRECATED_CATEGORY_NAMES: readonly string[] = ["واریز به حساب پس‌انداز"];
+// Drops every category a NEW transaction must not land on: one flagged
+// Category.isArchived itself, or a child of an archived top-level category
+// (archiving a parent retires its whole subtree - otherwise its children
+// would still be reachable through a merchant override or findSimilarCategory
+// even though formatCategoryTree no longer lists them under any parent).
+// Existing transactions keep pointing at archived rows untouched - this is
+// only ever applied to candidate lists for new selection/suggestion, never
+// to anything that displays history. Replaces the old name-based
+// DEPRECATED_CATEGORY_NAMES list; see prisma/archive-retired-categories.ts
+// for the one-off backfill that flagged its only entry
+// ("واریز به حساب پس‌انداز") on existing users' rows.
+export function excludeArchived<T extends CategoryOption>(categories: T[]): T[] {
+  const archivedTopLevel = new Set(
+    categories.filter((c) => c.isArchived && !c.parentName).map((c) => `${c.type}:${c.name}`)
+  );
+  return categories.filter(
+    (c) => !c.isArchived && !(c.parentName && archivedTopLevel.has(`${c.type}:${c.parentName}`))
+  );
+}
 
 // Below this shared-token ratio (intersection size / size of the shorter
 // name's token set), an overlap is treated as coincidental - e.g. sharing
--- a/lib/ai/parse-transaction.ts
+++ b/lib/ai/parse-transaction.ts
@@ -4,7 +4,7 @@
   resolveNewCategoryIcon,
   FALLBACK_EXPENSE_CATEGORY,
   FALLBACK_INCOME_CATEGORY,
-  DEPRECATED_CATEGORY_NAMES,
+  excludeArchived,
   type CategoryType,
 } from "@/lib/categories";
 import { findMerchant, type MerchantLookupResult, type MerchantMatchSource } from "@/lib/merchant-lookup";
@@ -137,6 +137,9 @@
   // validate the AI's (category, subcategory) pair against the real
   // hierarchy, not just check each name exists somewhere.
   parentName?: string;
+  // Category.isArchived - see excludeArchived in lib/categories.ts, which
+  // parseTransactionWithAI applies before anything else reads this list.
+  isArchived?: boolean;
 }
 
 // Raw shape of the optional assetPurchase key in the AI's JSON response -
@@ -547,11 +550,12 @@
 ): Promise<ParsedTransaction> {
   // Filtered once, here, so every use below (the prompt's category list,
   // merchant-override validation, AI leaf-category validation, new-category
-  // similarity matching) treats a deprecated category name as if it didn't
-  // exist for this user - even though it may still physically be in their
-  // Category table from before the removal (see
-  // lib/categories.ts's DEPRECATED_CATEGORY_NAMES).
-  const categories = allCategories.filter((c) => !DEPRECATED_CATEGORY_NAMES.includes(c.name));
+  // similarity matching) treats an archived category as if it didn't exist
+  // for this user - even though it's still physically in their Category
+  // table, referenced by their existing transactions (see
+  // Category.isArchived in prisma/schema.prisma and excludeArchived in
+  // lib/categories.ts).
+  const categories = excludeArchived(allCategories);
 
   // Bank SMS detection is fully deterministic and purpose-built for this
   // input shape, so it's tried first and, when it resolves, wins outright -
--- a/lib/data/categories.ts
+++ b/lib/data/categories.ts
@@ -1,6 +1,6 @@
 import "server-only";
 import { prisma } from "@/lib/prisma";
-import { findSimilarCategory, resolveNewCategoryIcon, type CategoryType } from "@/lib/categories";
+import { findSimilarCategory, resolveNewCategoryIcon, excludeArchived, type CategoryType } from "@/lib/categories";
 import type { CategoryOption } from "@/lib/ai/parse-transaction";
 import { isUniqueConstraintError } from "@/lib/observability/classify-error";
 
@@ -11,6 +11,24 @@
   });
 }
 
+// Category rows -> the CategoryOption shape parseTransactionWithAI and
+// findSimilarCategory take (parent resolved by name, isArchived carried
+// through for excludeArchived). Shared by every caller that builds one -
+// previously a hand-copied map in each of them, and a copy that forgot
+// isArchived would silently let archived categories back into the AI
+// prompt.
+export function toCategoryOptions(
+  categories: Array<{ id: number; name: string; type: string; parentId: number | null; isArchived: boolean }>
+): CategoryOption[] {
+  const categoryById = new Map(categories.map((c) => [c.id, c]));
+  return categories.map((c) => ({
+    name: c.name,
+    type: c.type as CategoryType,
+    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
+    isArchived: c.isArchived,
+  }));
+}
+
 export async function listCategoriesWithUsage(userId: number, type?: CategoryType) {
   const categories = await listCategories(userId, type);
   const counts = await prisma.transaction.groupBy({
@@ -162,12 +180,12 @@
   }
 
   const existingCategories = await listCategories(userId);
-  const categoryById = new Map(existingCategories.map((c) => [c.id, c]));
-  const categoryOptions: CategoryOption[] = existingCategories.map((c) => ({
-    name: c.name,
-    type: c.type as CategoryType,
-    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
-  }));
+  // Archived categories are never a dedup target - resolving an accepted
+  // suggestion onto one would land a new transaction on a retired category.
+  // This path previously had no deprecated-name filter at all (only
+  // parseTransactionWithAI did): e.g. an accepted "پس‌انداز" suggestion
+  // token-overlaps "واریز به حساب پس‌انداز" at ratio 1.0.
+  const categoryOptions = excludeArchived(toCategoryOptions(existingCategories));
 
   const similar = findSimilarCategory({ name: input.name, parentName: input.parentName }, categoryOptions, input.type);
   if (similar) {
--- a/lib/data/onboarding.ts
+++ b/lib/data/onboarding.ts
@@ -1,6 +1,6 @@
 import "server-only";
 import { prisma } from "@/lib/prisma";
-import { DEFAULT_ACCOUNT, DEPRECATED_CATEGORY_NAMES } from "@/lib/categories";
+import { DEFAULT_ACCOUNT } from "@/lib/categories";
 
 export async function seedDefaultsForUser(userId: number) {
   await prisma.$transaction(async (tx) => {
@@ -13,9 +13,13 @@
 // (see prisma/backfill-categories.ts) can copy DefaultCategory rows into a
 // user's Category table without also re-creating their FinanceAccount.
 export async function seedDefaultCategoriesForUser(userId: number) {
+  // Archived defaults (DefaultCategory.isArchived) are never seeded.
+  // Removing an entry from prisma/default-categories.ts alone doesn't retire
+  // it: prisma/seed.ts only ever upserts, so its already-seeded row stays in
+  // the live DefaultCategory table until it's flagged here.
   const defaultMains = await prisma.defaultCategory.findMany({
-    where: { parentId: null },
-    include: { children: true },
+    where: { parentId: null, isArchived: false },
+    include: { children: { where: { isArchived: false } } },
     orderBy: { id: "asc" },
   });
 
@@ -33,16 +37,9 @@
         },
       });
 
-      // Removing an entry from prisma/default-categories.ts doesn't remove
-      // its already-upserted row from the live DefaultCategory table (see
-      // prisma/seed.ts - it only ever upserts, never deletes stale rows),
-      // so this filters by name here too rather than trusting that table to
-      // stay in sync with the current seed data - see
-      // lib/categories.ts's DEPRECATED_CATEGORY_NAMES.
-      const children = main.children.filter((sub) => !DEPRECATED_CATEGORY_NAMES.includes(sub.name));
-      if (children.length) {
+      if (main.children.length) {
         await tx.category.createMany({
-          data: children.map((sub) => ({
+          data: main.children.map((sub) => ({
             name: sub.name,
             icon: sub.icon,
             color: sub.color,
--- a/app/api/transactions/parse/route.ts
+++ b/app/api/transactions/parse/route.ts
@@ -1,8 +1,7 @@
 import { NextRequest, NextResponse } from "next/server";
 import { getSession } from "@/lib/auth/session";
 import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
-import { listCategories } from "@/lib/data/categories";
-import type { CategoryType } from "@/lib/categories";
+import { listCategories, toCategoryOptions } from "@/lib/data/categories";
 import { checkRateLimit, rateLimitResponse, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
 import { logError } from "@/lib/error-log";
 import { MAX_TRANSACTION_TEXT_LENGTH } from "@/lib/limits";
@@ -54,12 +53,7 @@
   const categoriesStartedAt = Date.now();
   const categories = await listCategories(session.userId);
   const categoriesDuration = Date.now() - categoriesStartedAt;
-  const categoryById = new Map(categories.map((c) => [c.id, c]));
-  const categoryOptions = categories.map((c) => ({
-    name: c.name,
-    type: c.type as CategoryType,
-    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
-  }));
+  const categoryOptions = toCategoryOptions(categories);
 
   try {
     // Passed through as-is, whichever source produced it - including the
--- a/app/api/chat/route.ts
+++ b/app/api/chat/route.ts
@@ -13,8 +13,7 @@
 import { checkRateLimit, rateLimitResponse, CHAT_USER_RULE, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
 import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";
 import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
-import { listCategories } from "@/lib/data/categories";
-import type { CategoryType } from "@/lib/categories";
+import { listCategories, toCategoryOptions } from "@/lib/data/categories";
 import { getAssetTypeOption } from "@/lib/assets";
 import { formatJalaaliDate, formatNumber, formatDecimal } from "@/lib/format";
 import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/limits";
@@ -107,12 +106,7 @@
   }
 
   const categories = await listCategories(userId);
-  const categoryById = new Map(categories.map((c) => [c.id, c]));
-  const categoryOptions = categories.map((c) => ({
-    name: c.name,
-    type: c.type as CategoryType,
-    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
-  }));
+  const categoryOptions = toCategoryOptions(categories);
 
   let parsed: ParsedTransaction;
   try {
--- a/lib/workflows/enrich-transaction.ts
+++ b/lib/workflows/enrich-transaction.ts
@@ -16,9 +16,8 @@
 // must stay limited to plain control flow - see
 // node_modules/workflow/docs/foundations/workflows-and-steps.mdx.
 import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
-import { listCategories } from "@/lib/data/categories";
+import { listCategories, toCategoryOptions } from "@/lib/data/categories";
 import { applyTransactionEnrichment, markEnrichmentFailed } from "@/lib/data/transactions";
-import type { CategoryType } from "@/lib/categories";
 import { reportError } from "@/lib/observability/report-error";
 import { ERROR_TYPES } from "@/lib/observability/error-types";
 import { logger } from "@/lib/observability/logger"; // TEMP-LATENCY
@@ -61,12 +60,7 @@
     }, // TEMP-LATENCY
     "enrichTransactionWorkflow step timing" // TEMP-LATENCY
   ); // TEMP-LATENCY
-  const categoryById = new Map(categories.map((c) => [c.id, c]));
-  const categoryOptions = categories.map((c) => ({
-    name: c.name,
-    type: c.type as CategoryType,
-    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
-  }));
+  const categoryOptions = toCategoryOptions(categories);
 
   // chatCompletion duration + completionTokens are already logged one layer
   // down, inside parseTransactionWithAI itself ("AI call succeeded", see
--- a/components/transactions/transaction-form-shared.tsx
+++ b/components/transactions/transaction-form-shared.tsx
@@ -24,6 +24,18 @@
   icon: string;
   color: string;
   type: string;
+  // Category.isArchived - hidden from the pickers for a new selection (see
+  // isSelectableCategory below). Optional so older/offline-queued shapes
+  // without it read as "not archived".
+  isArchived?: boolean;
+}
+
+// Whether `c` belongs in a transaction form's category <select>: matching
+// type, and not archived - unless it's the value already selected (an edit
+// of an existing transaction filed under a since-archived category must
+// still render that category, not silently swap it for the first option).
+export function isSelectableCategory(c: CategoryOption, type: string | undefined, currentValue: string | undefined) {
+  return c.type === type && (!c.isArchived || c.name === currentValue);
 }
 
 // Shown whenever the add-transaction textarea's automatic live-preview
--- a/components/transactions/add-transaction-form.tsx
+++ b/components/transactions/add-transaction-form.tsx
@@ -21,6 +21,7 @@
   type CreateTransactionPayload,
   getMissingBankAccountLabel,
   getConfirmationHintText,
+  isSelectableCategory,
   AssetPurchaseNotice,
   submitCreateBankAccount,
   submitCreateCategory,
@@ -343,7 +344,7 @@
     setIsCreatingCategory(false);
   }
 
-  const availableCategories = categories.filter((c) => c.type === parsed?.type);
+  const availableCategories = categories.filter((c) => isSelectableCategory(c, parsed?.type, parsed?.category));
   // Exact-match against the label handleCreateBankAccount creates the account with,
   // so this naturally stops matching (and the prompt disappears) once that account exists.
   const missingBankAccountLabel = getMissingBankAccountLabel(parsed, accounts);
@@ -464,7 +465,7 @@
                       setParsed({
                         ...parsed,
                         type: t,
-                        category: categories.find((c) => c.type === t)?.name ?? parsed.category,
+                        category: categories.find((c) => isSelectableCategory(c, t, undefined))?.name ?? parsed.category,
                       })
                     }
                     className={`flex-1 rounded-xl py-2 text-sm font-medium transition-colors ${
--- a/components/transactions/batch-add-transaction-form.tsx
+++ b/components/transactions/batch-add-transaction-form.tsx
@@ -28,6 +28,7 @@
   PARSE_RATE_LIMIT_MESSAGE,
   getMissingBankAccountLabel,
   getConfirmationHintText,
+  isSelectableCategory,
   AssetPurchaseNotice,
   submitCreateBankAccount,
   submitCreateCategory,
@@ -336,7 +337,9 @@
         {rows.map((row, index) => {
           const isStale = row.parsed !== null && row.text !== row.lastParsedText;
           const showPreview = row.parsed !== null && !isStale;
-          const rowCategories = showPreview ? categories.filter((c) => c.type === row.parsed!.type) : [];
+          const rowCategories = showPreview
+            ? categories.filter((c) => isSelectableCategory(c, row.parsed!.type, row.parsed!.category))
+            : [];
           const missingBankAccountLabel = showPreview ? getMissingBankAccountLabel(row.parsed, accounts) : null;
 
           return (
@@ -395,7 +398,7 @@
                               ? {
                                   ...r.parsed,
                                   type: t,
-                                  category: categories.find((c) => c.type === t)?.name ?? r.parsed.category,
+                                  category: categories.find((c) => isSelectableCategory(c, t, undefined))?.name ?? r.parsed.category,
                                 }
                               : r.parsed,
                           }))
--- a/components/categories/categories-manager.tsx
+++ b/components/categories/categories-manager.tsx
@@ -12,6 +12,9 @@
   color: string;
   type: string;
   transactionCount: number;
+  // Category.isArchived - still listed here (its history is real), just
+  // marked, since it no longer appears in the add-transaction pickers.
+  isArchived: boolean;
 }
 
 const COLOR_PRESETS = [
@@ -247,7 +250,9 @@
               </div>
               <div className="min-w-0 flex-1">
                 <p className="truncate text-sm font-medium text-foreground">{category.name}</p>
-                <p className="text-xs text-muted">{category.transactionCount} تراکنش</p>
+                <p className="text-xs text-muted">
+                  {category.transactionCount} تراکنش{category.isArchived ? " · بایگانی‌شده" : ""}
+                </p>
               </div>
               <button
                 onClick={() => onEdit(category)}
--- a/prisma/default-categories.ts
+++ b/prisma/default-categories.ts
@@ -156,8 +156,9 @@
   // expense) was removed from here - it overlapped with the dedicated
   // /app/transfer flow's isTransfer-excluded paired transactions, which
   // exist specifically to keep an internal savings transfer out of
-  // spending totals. See lib/categories.ts's DEPRECATED_CATEGORY_NAMES for
-  // why this is a seed-data removal only, not a live-DB delete.
+  // spending totals. Existing rows for it (per-user Category and the stale
+  // DefaultCategory row) are flagged isArchived rather than deleted - see
+  // prisma/archive-retired-categories.ts for why.
   {
     name: "پس‌انداز و سرمایه‌گذاری", icon: "📈", color: "#10B981", type: "expense", isEssential: true,
     children: [
--- a/lib/categories.test.ts
+++ b/lib/categories.test.ts
@@ -1,5 +1,5 @@
 import { describe, it, expect } from "vitest";
-import { findSimilarCategory, resolveNewCategoryIcon } from "@/lib/categories";
+import { excludeArchived, findSimilarCategory, resolveNewCategoryIcon } from "@/lib/categories";
 import type { CategoryOption } from "@/lib/ai/parse-transaction";
 
 const EXPENSE_CATEGORIES: CategoryOption[] = [
@@ -174,3 +174,36 @@
     expect(resolveNewCategoryIcon("سفر شمال")).toBe("📦");
   });
 });
+
+describe("excludeArchived", () => {
+  it("drops an archived subcategory but keeps its parent and siblings", () => {
+    const categories: CategoryOption[] = [
+      { name: "پس‌انداز و سرمایه‌گذاری", type: "expense" },
+      { name: "واریز به حساب پس‌انداز", type: "expense", parentName: "پس‌انداز و سرمایه‌گذاری", isArchived: true },
+      { name: "خرید طلا و ارز", type: "expense", parentName: "پس‌انداز و سرمایه‌گذاری" },
+    ];
+    expect(excludeArchived(categories).map((c) => c.name)).toEqual(["پس‌انداز و سرمایه‌گذاری", "خرید طلا و ارز"]);
+  });
+
+  it("drops every child of an archived top-level category, even children not flagged themselves", () => {
+    const categories: CategoryOption[] = [
+      { name: "حیوان خانگی", type: "expense", isArchived: true },
+      { name: "دامپزشک", type: "expense", parentName: "حیوان خانگی" },
+      { name: "سلامت", type: "expense" },
+      { name: "دارو", type: "expense", parentName: "سلامت" },
+    ];
+    expect(excludeArchived(categories).map((c) => c.name)).toEqual(["سلامت", "دارو"]);
+  });
+
+  // "انتقال بین حساب‌ها" is seeded under both types with the same name - an
+  // archived parent of one type must not take out a same-named parent's
+  // children under the other type.
+  it("matches an archived parent by type as well as name", () => {
+    const categories: CategoryOption[] = [
+      { name: "مشترک", type: "expense", isArchived: true },
+      { name: "مشترک", type: "income" },
+      { name: "زیرشاخه", type: "income", parentName: "مشترک" },
+    ];
+    expect(excludeArchived(categories).map((c) => `${c.type}:${c.name}`)).toEqual(["income:مشترک", "income:زیرشاخه"]);
+  });
+});
--- a/lib/data/categories.test.ts
+++ b/lib/data/categories.test.ts
@@ -252,6 +252,27 @@
     expect(await prisma.category.count({ where: { userId } })).toBe(countBefore);
   });
 
+  // Without excludeArchived here, "پس‌انداز" token-overlaps the archived
+  // "واریز به حساب پس‌انداز" at ratio 1.0 (normalizeText turns the
+  // half-space into a plain space, so both carry the tokens پس/انداز) and
+  // would resolve onto it - landing the accepted suggestion's transaction on
+  // a retired category.
+  it("never resolves onto an archived category, creating a new one instead", async () => {
+    const archived = await prisma.category.create({
+      data: { userId, name: "واریز به حساب پس‌انداز", icon: "💰", color: "#10B981", type: "expense", isArchived: true },
+    });
+
+    const result = await resolveOrCreateCategoryFromSuggestion(userId, {
+      name: "پس‌انداز",
+      parentName: null,
+      type: "expense",
+    });
+
+    expect(result.resolvedExisting).toBe(false);
+    expect(result.category.id).not.toBe(archived.id);
+    expect(result.category.name).toBe("پس‌انداز");
+  });
+
   it("resolves a valid same-type parentName to the parent's id", async () => {
     const parent = await prisma.category.create({
       data: { userId, name: "دوچرخه‌سواری", icon: "🧾", color: "#3B82F6", type: "expense" },
--- a/lib/ai/parse-transaction.test.ts
+++ b/lib/ai/parse-transaction.test.ts
@@ -493,16 +493,16 @@
   });
 
   // "واریز به حساب پس‌انداز" was removed from prisma/default-categories.ts
-  // (see lib/categories.ts's DEPRECATED_CATEGORY_NAMES) but may still exist
-  // in an existing user's own Category table from before that removal -
-  // these fixtures simulate exactly that user, passing the deprecated name
-  // in the `categories` list the same way lib/data/categories.ts's real
-  // mapping would for such a user.
-  describe("deprecated category exclusion (واریز به حساب پس‌انداز)", () => {
+  // but still exists (flagged Category.isArchived - see
+  // prisma/archive-retired-categories.ts) in an existing user's own Category
+  // table from before that removal - these fixtures simulate exactly that
+  // user, passing the archived row in the `categories` list the same way
+  // lib/data/categories.ts's toCategoryOptions would for such a user.
+  describe("archived category exclusion (واریز به حساب پس‌انداز)", () => {
     const CATEGORIES_WITH_DEPRECATED_SAVINGS: CategoryOption[] = [
       ...CATEGORIES_FULL,
       { name: "پس‌انداز و سرمایه‌گذاری", type: "expense" },
-      { name: "واریز به حساب پس‌انداز", type: "expense", parentName: "پس‌انداز و سرمایه‌گذاری" },
+      { name: "واریز به حساب پس‌انداز", type: "expense", parentName: "پس‌انداز و سرمایه‌گذاری", isArchived: true },
       { name: "خرید طلا و ارز", type: "expense", parentName: "پس‌انداز و سرمایه‌گذاری" },
     ];
 
--- a/lib/data/onboarding.test.ts
+++ b/lib/data/onboarding.test.ts
@@ -50,7 +50,7 @@
     }
   });
 
-  it("never seeds the deprecated \"واریز به حساب پس‌انداز\" category for a new user, even when the DefaultCategory table still has a stale row for it", async () => {
+  it("never seeds an archived DefaultCategory (the retired \"واریز به حساب پس‌انداز\") for a new user", async () => {
     const user = await prisma.user.create({
       data: { phoneNumber: `TEST-ONBOARDING-DEPRECATED-${Date.now()}` },
     });
@@ -59,22 +59,24 @@
     // prisma/default-categories.ts, but prisma/seed.ts's upsert-only logic
     // never deletes a row it stops seeing in the array (see that file's own
     // comment), so an existing DefaultCategory row for it can still be
-    // there. Inserted directly (not via the seed array) specifically to
-    // prove seedDefaultCategoriesForUser's own filter - not just the absence
-    // of this row from the seed data - is what keeps it out.
+    // there - flagged isArchived by prisma/archive-retired-categories.ts.
+    // Inserted directly (not via the seed array) specifically to prove
+    // seedDefaultCategoriesForUser's own isArchived filter - not just the
+    // absence of this row from the seed data - is what keeps it out.
     const parent = await prisma.defaultCategory.findFirst({
       where: { name: "پس‌انداز و سرمایه‌گذاری", type: "expense", parentId: null },
     });
     expect(parent).not.toBeNull();
     const stale = await prisma.defaultCategory.upsert({
       where: { name_type: { name: "واریز به حساب پس‌انداز", type: "expense" } },
-      update: { parentId: parent!.id },
+      update: { parentId: parent!.id, isArchived: true },
       create: {
         name: "واریز به حساب پس‌انداز",
         icon: "💰",
         color: "#10B981",
         type: "expense",
         isEssential: true,
+        isArchived: true,
         parentId: parent!.id,
       },
     });
--- /dev/null
+++ b/prisma/migrations/20260925093410_add_category_is_archived/migration.sql
@@ -0,0 +1,44 @@
+-- RedefineTables
+PRAGMA defer_foreign_keys=ON;
+PRAGMA foreign_keys=OFF;
+CREATE TABLE "new_Category" (
+    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
+    "name" TEXT NOT NULL,
+    "icon" TEXT NOT NULL,
+    "color" TEXT NOT NULL,
+    "type" TEXT NOT NULL,
+    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
+    "isEssential" BOOLEAN NOT NULL DEFAULT true,
+    "isArchived" BOOLEAN NOT NULL DEFAULT false,
+    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
+    "userId" INTEGER NOT NULL,
+    "parentId" INTEGER,
+    CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
+    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
+);
+INSERT INTO "new_Category" ("color", "createdAt", "icon", "id", "isEssential", "isTransfer", "name", "parentId", "type", "userId") SELECT "color", "createdAt", "icon", "id", "isEssential", "isTransfer", "name", "parentId", "type", "userId" FROM "Category";
+DROP TABLE "Category";
+ALTER TABLE "new_Category" RENAME TO "Category";
+CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
+CREATE UNIQUE INDEX "Category_userId_name_type_key" ON "Category"("userId", "name", "type");
+CREATE TABLE "new_DefaultCategory" (
+    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
+    "name" TEXT NOT NULL,
+    "icon" TEXT NOT NULL,
+    "color" TEXT NOT NULL,
+    "type" TEXT NOT NULL,
+    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
+    "isEssential" BOOLEAN NOT NULL DEFAULT true,
+    "isArchived" BOOLEAN NOT NULL DEFAULT false,
+    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
+    "parentId" INTEGER,
+    CONSTRAINT "DefaultCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DefaultCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
+);
+INSERT INTO "new_DefaultCategory" ("color", "createdAt", "icon", "id", "isEssential", "isTransfer", "name", "parentId", "type") SELECT "color", "createdAt", "icon", "id", "isEssential", "isTransfer", "name", "parentId", "type" FROM "DefaultCategory";
+DROP TABLE "DefaultCategory";
+ALTER TABLE "new_DefaultCategory" RENAME TO "DefaultCategory";
+CREATE INDEX "DefaultCategory_parentId_idx" ON "DefaultCategory"("parentId");
+CREATE UNIQUE INDEX "DefaultCategory_name_type_key" ON "DefaultCategory"("name", "type");
+PRAGMA foreign_keys=ON;
+PRAGMA defer_foreign_keys=OFF;
+
--- /dev/null
+++ b/prisma/archive-retired-categories.ts
@@ -0,0 +1,140 @@
+// One-off backfill: flags Category.isArchived / DefaultCategory.isArchived
+// (migration 20260925093410_add_category_is_archived) on every existing row
+// whose name is in RETIRED_CATEGORY_NAMES below - the list lib/categories.ts
+// used to filter by name at each read site (DEPRECATED_CATEGORY_NAMES)
+// before the flag existed. Once this has run, the name list has no other
+// reader: every read path (lib/ai/parse-transaction.ts, lib/data/onboarding.ts,
+// lib/data/categories.ts's suggestion dedup, the add-transaction pickers)
+// filters on the flag instead.
+//
+// Nothing is deleted or re-pointed: Transaction/MerchantMapping rows keep
+// referencing the same Category ids (both FKs are onDelete: Restrict), so
+// history keeps displaying the real name. The only write is flipping a
+// boolean, and the dry run prints every id it would flip - reversing it is
+// the same update with isArchived: false on those ids.
+//
+// PRE-REQUISITE: the migration above must already be applied to the target
+// DB (see AGENTS.md's "Applying a new schema change"). main() checks for the
+// column first and aborts with a clear message rather than a raw
+// "no such column" Prisma error.
+//
+// ORDERING: run this (--execute) after the migration is applied but BEFORE
+// deploying the code that reads isArchived. Old code ignores the column, so
+// flagging early is invisible to it; deploying first would instead briefly
+// put the retired category back into the AI prompt for every existing user,
+// since the old name-based filter is gone from the new code.
+//
+// Idempotent: only rows still at isArchived = false are counted/updated, so
+// a re-run after a successful one reports 0 and writes nothing.
+//
+// Connects the same way lib/prisma.ts does at runtime (TURSO_DATABASE_URL /
+// TURSO_AUTH_TOKEN), same as prisma/backfill-categories.ts and
+// prisma/refresh-user-categories.ts - there is no separate dev DB (see
+// AGENTS.md). Doesn't import any "server-only" module, so no
+// --conditions=react-server flag is needed (unlike refresh-user-categories.ts).
+//
+// Usage:
+//   npx tsx prisma/archive-retired-categories.ts             # dry run: report only
+//   npx tsx prisma/archive-retired-categories.ts --execute   # apply
+import "dotenv/config";
+import { prisma } from "@/lib/prisma";
+
+// Expense-only: the one retired entry is a child of «پس‌انداز و سرمایه‌گذاری»
+// (removed from prisma/default-categories.ts because it overlapped the
+// /app/transfer flow). Matched on (name, type), the same pair Category's
+// own @@unique([userId, name, type]) keys on.
+const RETIRED_CATEGORY_NAMES: ReadonlyArray<{ name: string; type: "income" | "expense" }> = [
+  { name: "واریز به حساب پس‌انداز", type: "expense" },
+];
+
+async function assertColumnExists(table: "Category" | "DefaultCategory") {
+  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
+    `SELECT name FROM pragma_table_info('${table}') WHERE name = 'isArchived'`
+  );
+  if (rows.length === 0) {
+    throw new Error(
+      `${table}.isArchived does not exist on this DB - apply prisma/migrations/20260925093410_add_category_is_archived first (AGENTS.md).`
+    );
+  }
+}
+
+async function main() {
+  const execute = process.argv.includes("--execute");
+  await assertColumnExists("Category");
+  await assertColumnExists("DefaultCategory");
+
+  const retiredFilter = { OR: RETIRED_CATEGORY_NAMES.map(({ name, type }) => ({ name, type })) };
+
+  const [categories, defaultCategories] = await Promise.all([
+    prisma.category.findMany({
+      where: { ...retiredFilter, isArchived: false },
+      select: {
+        id: true,
+        userId: true,
+        name: true,
+        type: true,
+        _count: { select: { transactions: true, merchantMappings: true } },
+      },
+      orderBy: { id: "asc" },
+    }),
+    prisma.defaultCategory.findMany({
+      where: { ...retiredFilter, isArchived: false },
+      select: { id: true, name: true, type: true },
+      orderBy: { id: "asc" },
+    }),
+  ]);
+
+  console.log(`${execute ? "EXECUTING" : "DRY RUN"} - retired names: ${RETIRED_CATEGORY_NAMES.map((r) => r.name).join(", ")}\n`);
+
+  console.log(`Category rows to archive: ${categories.length}`);
+  for (const c of categories) {
+    console.log(
+      `  id ${c.id} (user ${c.userId}) "${c.name}" [${c.type}] - ` +
+        `${c._count.transactions} transaction(s), ${c._count.merchantMappings} merchant mapping(s) keep pointing at it`
+    );
+  }
+  const referencingTransactions = categories.reduce((sum, c) => sum + c._count.transactions, 0);
+  const referencingMappings = categories.reduce((sum, c) => sum + c._count.merchantMappings, 0);
+  console.log(
+    `  total: ${referencingTransactions} transaction(s), ${referencingMappings} merchant mapping(s) reference these rows (unchanged either way)`
+  );
+
+  console.log(`\nDefaultCategory rows to archive: ${defaultCategories.length}`);
+  for (const d of defaultCategories) {
+    console.log(`  id ${d.id} "${d.name}" [${d.type}]`);
+  }
+
+  if (!execute) {
+    console.log("\nDry run only - no writes made. Re-run with --execute to apply.");
+    return;
+  }
+
+  // Keyed on the exact ids reported above (not the name filter again), so
+  // --execute can never touch a row the printed report didn't list.
+  const [categoryResult, defaultResult] = await prisma.$transaction([
+    prisma.category.updateMany({
+      where: { id: { in: categories.map((c) => c.id) }, isArchived: false },
+      data: { isArchived: true },
+    }),
+    prisma.defaultCategory.updateMany({
+      where: { id: { in: defaultCategories.map((d) => d.id) }, isArchived: false },
+      data: { isArchived: true },
+    }),
+  ]);
+  console.log(`\nArchived ${categoryResult.count} Category row(s), ${defaultResult.count} DefaultCategory row(s).`);
+
+  const [remaining, remainingDefaults] = await Promise.all([
+    prisma.category.count({ where: { ...retiredFilter, isArchived: false } }),
+    prisma.defaultCategory.count({ where: { ...retiredFilter, isArchived: false } }),
+  ]);
+  console.log(`Verification: ${remaining} Category / ${remainingDefaults} DefaultCategory row(s) still unarchived (expected 0 / 0).`);
+}
+
+main()
+  .catch((error) => {
+    console.error(error);
+    process.exitCode = 1;
+  })
+  .finally(async () => {
+    await prisma.$disconnect();
+  });
```

# جیب (Jeeb)

A personal finance PWA for the Iranian market. Sign up with your phone number,
add transactions by typing a sentence in natural Persian
("۵۰ هزار تومن ناهار خوردم") and let AI extract the structured data; track
balances, spending by category, and chat with an AI assistant about your
finances.

## Tech stack

- Next.js 16 (App Router, Route Handlers, `proxy.ts`) + TypeScript
- SQLite via Prisma ORM 7 (`@prisma/adapter-better-sqlite3`)
- Tailwind CSS v4
- OpenRouter for all AI calls (transaction parsing + financial chat)
- Phone/OTP auth with JWT session cookies (`jose`)
- PWA: web manifest, installable (with an in-app install prompt), offline
  viewing of previously-loaded pages
- RTL, Persian (Vazirmatn font), Jalali (Shamsi) calendar throughout

## Getting started

```bash
npm install
cp .env.example .env
# edit .env: set OPENROUTER_API_KEY, and AUTH_SECRET (openssl rand -base64 48)

npx prisma migrate dev   # creates dev.db and applies the schema

npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the marketing landing
page; the app itself lives under `/app` and requires signing in from `/login`.

OTP codes are not actually sent anywhere yet — in dev they're printed to the
server console (`[mock SMS] OTP for 0912...: 123456`). Wire up a real
provider (Kavenegar, Ghasedak, ...) in `lib/auth/otp.ts`'s `sendOtpSms`
using the `SMS_PROVIDER_API_KEY` env var. Without `OPENROUTER_API_KEY` set,
everything else works except the two AI-powered routes (add-transaction
parsing and the chat assistant), which fail with a clear Persian error
message pointing at the missing key.

## Project structure

```
app/
  page.tsx                     Marketing landing page (public)
  login/, verify/, onboarding/ Phone/OTP auth flow (public)
  app/                         The actual app (protected by proxy.ts)
    page.tsx                     Dashboard
    add/                         Add Transaction (free text -> AI parse -> confirm)
    transactions/                 Transactions list (filterable)
    categories/                   Categories CRUD
    chat/                         AI financial chat
  api/
    auth/                        send-otp, verify-otp, onboarding, logout
    transactions/parse/          POST: OpenRouter -> structured transaction JSON
    transactions/                GET/POST transactions, [id] DELETE
    categories/                   GET/POST categories, [id] PATCH/DELETE
    chat/                         POST: streams an OpenRouter chat completion
  manifest.ts                    PWA manifest
proxy.ts                        Route protection (Next 16's middleware replacement)
components/
  landing/                      Marketing page sections
  auth/, pwa/                   Auth forms, install prompt
  ...                           App UI, grouped by feature
lib/
  auth/                         Session (JWT/cookies), OTP, phone validation
  data/                         Server-side Prisma query helpers (all user-scoped)
  ai/parse-transaction.ts       Transaction-parsing prompt + validation
  openrouter.ts                  OpenRouter client (chat + streaming)
  format.ts                      Jalali date + Persian number formatting
  prisma.ts                      Prisma client singleton
prisma/schema.prisma            User, Account, Transaction, Category, ChatMessage
public/sw.js                    Service worker (offline page cache)
```

Every model except `User` has a `userId` foreign key — each user's accounts,
categories, transactions and chat history are fully isolated. A new user's
default categories + wallet account are seeded the moment they finish
onboarding (`lib/data/onboarding.ts`), not by a global DB seed.

## Notes and assumptions

This was scaffolded from a written spec (colors, pages, schema) without the
actual Claude Design mockups, which weren't accessible from this environment
(both `claude.ai/design` links given so far 403'd — authenticated resource).
A few implementation choices were made that the real design may want to
override:

- **Auth**: OTP is mocked (console-logged), a JWT session cookie
  (`AUTH_SECRET`) gates `/app/*`, and `/onboarding` is forced for
  first-time signups until name + age are set.
- **Logout**: there's no settings/profile page yet, so logout lives as an
  icon button in the Dashboard header.
- **Install prompt**: a dismissible bottom-sheet card shown inside `/app`
  (never on the public landing page) — real `beforeinstallprompt` flow on
  Android/Chrome, manual Share-sheet instructions on iOS Safari, persisted
  dismissal via `localStorage`.
- **Landing page copy/visuals**: headline, section order, phone-mockup
  illustration, and motion are original since there was no design to match —
  treat these as a strong starting point, not a locked spec.
- **Calendar**: dates display in the Jalali (Shamsi) calendar via
  `jalaali-js`, and "monthly summary" uses Jalali month boundaries — dates are
  still stored in SQLite as standard Gregorian `DateTime`.
- **Numbers**: amounts and dates render with Persian digits
  (`Intl.NumberFormat("fa-IR")`).
- **Single account per user**: each user gets one seeded "کیف پول" (Wallet)
  account; the schema supports more, but there's no account-picker UI yet.
- **Icons**: category icons are plain emoji, and the PWA app icons
  (`public/icons/`, `app/icon.png`) are a generated placeholder wallet glyph
  in the brand colors — swap these once real assets/icon set are available.
- **Offline support**: the service worker caches the app shell and does
  network-first-with-cache-fallback for full page loads, so previously-visited
  pages stay viewable offline. It does not cache Next's client-side RSC
  navigation payloads (that needs a more involved setup, e.g. Serwist).
- **AI model**: defaults to `google/gemini-2.5-flash` via `OPENROUTER_MODEL`
  in `.env` — change it to any OpenRouter model slug.

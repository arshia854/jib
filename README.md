# جیب (Jeeb)

A personal finance PWA for the Iranian market. Sign up with your phone number,
add transactions by typing a sentence in natural Persian
("۵۰ هزار تومن ناهار خوردم") and let AI extract the structured data; track
balances, spending by category, and chat with an AI assistant about your
finances.

## Tech stack

- Next.js 16 (App Router, Route Handlers, `proxy.ts`) + TypeScript
- Turso (libSQL) via Prisma ORM 7 (`@prisma/adapter-libsql`)
- Tailwind CSS v4
- NVIDIA NIM for all AI calls (transaction parsing + financial chat) - an
  OpenAI-compatible API, see `lib/nvidia-ai.ts`
- Phone/OTP + email + Google auth (NextAuth/Auth.js v5) with JWT sessions
- PWA: web manifest, installable (with an in-app install prompt), offline
  viewing of previously-loaded pages
- RTL, Persian (Vazirmatn font), Jalali (Shamsi) calendar throughout

## Getting started

```bash
npm install
cp .env.example .env
# edit .env: set TURSO_DATABASE_URL/TURSO_AUTH_TOKEN, NVIDIA_API_KEY, and
# AUTH_SECRET/OTP_SECRET/LEGACY_SESSION_SECRET (openssl rand -base64 48 each)

npm run dev
```

The database is Turso (libSQL), not a local file - get `TURSO_DATABASE_URL`/
`TURSO_AUTH_TOKEN` for an existing dev database via the Turso CLI
(`turso db show <db-name> --url`, `turso db tokens create <db-name>`), same
as `.env.example` documents. **`npx prisma migrate dev` / `db push` do not
work against this project's database** (Prisma's CLI can't parse a
`libsql://` connection string - see `AGENTS.md` for the root cause and the
actual process for applying schema changes). You don't need any of this
just to run the test suite, though: `npm run test` always points at an
isolated, disposable local SQLite file instead (`test/setup/global-setup.ts`
applies every migration to it automatically), regardless of what's in `.env`.

Open [http://localhost:3000](http://localhost:3000) for the marketing landing
page; the app itself lives under `/app` and requires signing in from `/login`.

OTP codes are sent via Melipayamak's pattern-based SMS API once
`MELIPAYAMAK_USERNAME`, `MELIPAYAMAK_PASSWORD`, and `MELIPAYAMAK_BODY_ID`
are all set (see `.env.example`). Until then - e.g. in dev, or before
Melipayamak authentication is approved - `sendOtpSms` in `lib/auth/otp.ts`
falls back to printing the code to the server console
(`[mock SMS] OTP for 0912...: 123456`) outside of production, and fails
closed in production. Without `NVIDIA_API_KEY` set, everything else works
except the two AI-powered routes (add-transaction parsing and the chat
assistant), which fail with a clear Persian error message pointing at the
missing key.

## Admin access

The admin panel (`/app/admin` - stats, user management, error logs, default
category CRUD) is gated by `User.role` (`"user"` | `"admin"`). There is no
in-app way to grant admin - promoting the first admin (or any user) has to
be done directly against the database:

```bash
npx prisma studio
# open the User table, find the row by phone/email, set role = "admin"
```

Or as a one-off script/query, e.g.:

```bash
npx prisma db execute --stdin <<< "UPDATE \"User\" SET role = 'admin' WHERE id = <id>;"
```

A blocked user (`User.blockedAt` set, via the admin panel's user
management page) is signed out on their next request - enforced in
`lib/auth/session.ts`'s `getSession()`, the same place a deleted user's
session is rejected.

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
    transactions/parse/          POST: NVIDIA NIM -> structured transaction JSON
    transactions/                GET/POST transactions, [id] DELETE
    categories/                   GET/POST categories, [id] PATCH/DELETE
    chat/                         POST: streams an NVIDIA NIM chat completion
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
  nvidia-ai.ts                   NVIDIA NIM client (chat + streaming)
  format.ts                      Jalali date + Persian number formatting
  prisma.ts                      Prisma client singleton
prisma/schema.prisma            User, FinanceAccount, Transaction, Category, ChatMessage, ...
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

- **Auth**: OTP sends via Melipayamak when configured, otherwise falls back
  to console-logging the code; a JWT session cookie (`AUTH_SECRET`) gates
  `/app/*`, and `/onboarding` is forced for first-time signups until name +
  age are set.
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
- **AI model**: defaults to `meta/llama-3.1-70b-instruct` via `NVIDIA_MODEL`
  in `.env` — change it to any model NVIDIA NIM (https://build.nvidia.com)
  serves.

# جیب (Jeeb)

A personal finance PWA for the Iranian market. Add transactions by typing a
sentence in natural Persian ("۵۰ هزار تومن ناهار خوردم") and let AI extract
the structured data; track balances, spending by category, and chat with an
AI assistant about your finances.

## Tech stack

- Next.js 16 (App Router, Route Handlers) + TypeScript
- SQLite via Prisma ORM 7 (`@prisma/adapter-better-sqlite3`)
- Tailwind CSS v4
- OpenRouter for all AI calls (transaction parsing + financial chat)
- PWA: web manifest, installable, offline viewing of previously-loaded pages
- RTL, Persian (Vazirmatn font), Jalali (Shamsi) calendar throughout

## Getting started

```bash
npm install
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys)

npx prisma migrate dev   # creates dev.db and applies the schema
npx prisma db seed       # seeds default categories + a default account

npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without
`OPENROUTER_API_KEY` set, every other part of the app works (dashboard,
transactions, categories) except the two AI-powered routes (add-transaction
parsing and the chat assistant), which fail with a clear Persian error
message pointing at the missing key.

## Project structure

```
app/
  page.tsx                  Dashboard
  add/                      Add Transaction (free text -> AI parse -> confirm)
  transactions/              Transactions list (filterable)
  categories/                Categories CRUD
  chat/                      AI financial chat
  api/
    transactions/parse/      POST: OpenRouter -> structured transaction JSON
    transactions/            GET/POST transactions, [id] DELETE
    categories/               GET/POST categories, [id] PATCH/DELETE
    chat/                      POST: streams an OpenRouter chat completion
  manifest.ts                 PWA manifest
components/                   UI components, grouped by feature
lib/
  data/                       Server-side Prisma query helpers
  ai/parse-transaction.ts     Transaction-parsing prompt + validation
  openrouter.ts                OpenRouter client (chat + streaming)
  format.ts                    Jalali date + Persian number formatting
  prisma.ts                    Prisma client singleton
prisma/schema.prisma          Account, Transaction, Category, ChatMessage
public/sw.js                  Service worker (offline page cache)
```

## Notes and assumptions

This was scaffolded from a written spec (colors, pages, schema) without the
actual Claude Design mockups, which weren't accessible from this environment.
A few implementation choices were made that the real design may want to
override:

- **Calendar**: dates display in the Jalali (Shamsi) calendar via
  `jalaali-js`, and "monthly summary" uses Jalali month boundaries — dates are
  still stored in SQLite as standard Gregorian `DateTime`.
- **Numbers**: amounts and dates render with Persian digits
  (`Intl.NumberFormat("fa-IR")`).
- **Single account**: transactions default to one seeded "کیف پول" (Wallet)
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

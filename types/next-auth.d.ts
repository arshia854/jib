// The `import type {}` on each block (even though unused) is required:
// without at least one top-level import/export, TS treats this file as a
// global script rather than a module, and `declare module "x" { ... }`
// then fails to merge with the real module - it corrupts resolution of
// the whole package instead (breaks the default export, named exports,
// everything) rather than just adding these fields.
import type {} from "next-auth";

declare module "next-auth" {
  interface Session {
    // string, not number: Auth.js's session callback param type intersects
    // this with AdapterSession (used for the "database" strategy), which
    // already declares userId as a string - a numeric override here
    // collapses the intersection to `never`. lib/auth/session.ts converts
    // this to a number for the rest of the app.
    userId: string;
    onboarded: boolean;
  }
}

import type {} from "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    onboarded?: boolean;
  }
}

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getOtpChallengePhone, verifyOtpChallenge, OTP_COOKIE, OTP_TTL_SECONDS } from "@/lib/auth/otp";
import { verifyPassword } from "@/lib/auth/password";
import { checkRateLimit, getClientIp, EMAIL_LOGIN_EMAIL_RULE, EMAIL_LOGIN_IP_RULE, OTP_VERIFY_PHONE_RULE } from "@/lib/rate-limit";
import {
  OtpExpiredError,
  OtpMaxAttemptsError,
  OtpRateLimitedError,
  OtpInvalidFormatError,
  OtpWrongCodeError,
  InvalidEmailPasswordError,
  EmailLoginRateLimitedError,
} from "@/lib/auth/errors";

// Raw shape of the Google ID token payload passed to the `profile` param of
// the signIn callback - only what we actually read from it.
interface GoogleProfile {
  email_verified?: boolean;
}

// Compared against on the email-password provider's "no such user / no
// password set" path, so that path costs one bcrypt compare just like a
// wrong password for a real account does - otherwise the response time
// alone reveals whether an email is registered. Generated once with
// bcryptjs's hashSync at cost 12 (lib/auth/password.ts's SALT_ROUNDS - the
// cost must match real hashes for the timing to match; auth.test.ts checks
// this) and inlined rather than computed at import time, since a cost-12
// hashSync blocks the event loop for over a second and this module is
// imported by every session check. The plaintext is irrelevant; the
// result of the compare is always discarded.
export const DUMMY_PASSWORD_HASH = "$2b$12$Dd5DroovH7yvMJunnGrfbeyBpexWL/bLf8DpPT1KYyhsX/48ZTYn.";

// Extracted out of the Credentials({...}) config below (Phase 16) purely so
// it's directly unit-testable - NextAuth's own `NextAuth({...})` call gives
// no way to reach back into a provider's `authorize()` closure from outside
// (it's consumed internally, not exposed on the returned `{ handlers, auth,
// ... }`), and exercising it only through `handlers.POST` would mean
// reimplementing NextAuth's own CSRF/cookie-encoding machinery just to
// drive a test - exactly what the roadmap's own Phase 16 prompt says not to
// build. This is a pure extraction: same body, same behavior, just a named
// export instead of an inline closure, so the "phone-otp" provider below is
// unchanged at runtime.
export async function authorizePhoneOtp(credentials: Partial<Record<"code", unknown>> | undefined, request: Request) {
  const code = typeof credentials?.code === "string" ? credentials.code.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new OtpInvalidFormatError();

  const store = await cookies();
  const challengeId = store.get(OTP_COOKIE)?.value ?? "";
  const challengePhone = getOtpChallengePhone(challengeId);
  if (!challengePhone) throw new OtpExpiredError();

  const verifyLimit = checkRateLimit(`otp-verify:phone:${challengePhone}`, OTP_VERIFY_PHONE_RULE);
  if (!verifyLimit.allowed) throw new OtpRateLimitedError();

  // Code comparison and attempt counting happen entirely server-side -
  // nothing client-supplied besides the submitted code is trusted.
  const result = verifyOtpChallenge(challengeId, code);
  if (result.status === "expired") throw new OtpExpiredError();
  if (result.status === "max_attempts") {
    store.delete(OTP_COOKIE);
    throw new OtpMaxAttemptsError();
  }
  if (result.status === "wrong_code") {
    // Same challenge id; re-set only to refresh maxAge in step with the
    // server-side TTL, which restarts on each wrong attempt.
    store.set(OTP_COOKIE, challengeId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OTP_TTL_SECONDS,
    });
    throw new OtpWrongCodeError(result.remainingAttempts);
  }

  store.delete(OTP_COOKIE);

  let user = await prisma.user.findUnique({ where: { phoneNumber: result.phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber: result.phone } });
  }

  void request; // available for IP/UA logging if ever needed
  return { ...user, id: String(user.id) };
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Credentials providers can't have real database-backed sessions (there's
  // no OAuth/adapter round trip to persist), so this must be JWT - see
  // https://authjs.dev/getting-started/authentication/credentials. We also
  // never created a Session table (see prisma/schema.prisma), so this is
  // required, not just a preference.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 90 },
  secret: process.env.AUTH_SECRET,
  // This app is deployed behind a reverse proxy on a self-managed VPS
  // (not a platform like Vercel that sets trusted forwarded headers by
  // default) - without this, Auth.js rejects requests with "UntrustedHost".
  trustHost: true,
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    Credentials({
      id: "phone-otp",
      name: "شماره موبایل",
      credentials: {
        code: { label: "کد تایید", type: "text" },
      },
      authorize: authorizePhoneOtp,
    }),

    Credentials({
      id: "email-password",
      name: "ایمیل و رمز عبور",
      credentials: {
        email: { label: "ایمیل", type: "email" },
        password: { label: "رمز عبور", type: "password" },
      },
      async authorize(credentials, request) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) throw new InvalidEmailPasswordError();

        const ip = getClientIp(request.headers);
        const ipLimit = checkRateLimit(`email-login:ip:${ip}`, EMAIL_LOGIN_IP_RULE);
        const emailLimit = checkRateLimit(`email-login:email:${email}`, EMAIL_LOGIN_EMAIL_RULE);
        if (!ipLimit.allowed || !emailLimit.allowed) throw new EmailLoginRateLimitedError();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
          await verifyPassword(password, DUMMY_PASSWORD_HASH);
          throw new InvalidEmailPasswordError();
        }

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) throw new InvalidEmailPasswordError();

        return { ...user, id: String(user.id) };
      },
    }),

    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // We do our own explicit, verified-email-gated linking in the signIn
      // callback below instead of trusting this flag blindly.
      allowDangerousEmailAccountLinking: false,
    }),
  ],
  callbacks: {
    // --- Google account-linking logic ---
    //
    // By default, Auth.js refuses to sign a user in via Google if their
    // Google email already belongs to an existing jib account that has no
    // Google account linked yet (it throws OAuthAccountNotLinked) - this is
    // a safety net against OAuth providers that don't verify email
    // ownership. Google *does* verify email ownership (`email_verified` on
    // the ID token), so we explicitly link in that case instead of
    // rejecting the sign-in or blindly trusting `allowDangerousEmailAccountLinking`
    // (which would link on ANY email match, regardless of verification).
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      const email = user.email;
      const googleProfile = profile as GoogleProfile | undefined;
      if (!email || !googleProfile?.email_verified) {
        // Can't safely find-or-create a jib account from an unverified
        // Google email - refuse the sign-in.
        return false;
      }

      const existingUser = await prisma.user.findUnique({
        where: { email },
        include: { oauthAccounts: { where: { provider: "google" } } },
      });

      // No existing jib account with this email: let Auth.js create a new
      // user + link the Google account automatically (default adapter flow).
      if (!existingUser) return true;

      // Already linked (returning user signing in again): nothing to do,
      // let the normal getUserByAccount lookup sign them in.
      if (existingUser.oauthAccounts.length > 0) return true;

      // The Google email matches an existing jib account that was created
      // via phone OTP or email/password and has never linked Google before.
      //
      // Google verifying the email only proves *this* Google user owns it -
      // not that whoever created the existing jib row did. /api/auth/register
      // creates an email+password account with no ownership check at all
      // (emailVerified stays null), so linking unconditionally here was an
      // account pre-hijack: an attacker registers victim@gmail.com with a
      // password of their choosing, the victim later signs in with Google,
      // gets silently linked into that same row, and starts entering real
      // financial data the attacker can still read by logging in with their
      // known password. So only link when the existing row has no attacker-
      // settable credential: either this app has verified its email, or it
      // has no password at all. Otherwise refuse the sign-in (surfaces as
      // AccessDenied on /login) - same outcome as Auth.js's own default
      // refusal for an ambiguous email match.
      if (!existingUser.emailVerified && existingUser.passwordHash) return false;

      // Safe to link the two accounts instead of creating a duplicate.
      await prisma.account.create({
        data: {
          userId: existingUser.id,
          type: account.type,
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_at: account.expires_at,
          token_type: account.token_type,
          scope: account.scope,
          id_token: account.id_token,
          session_state: account.session_state as string | undefined,
        },
      });

      return true;
    },

    async jwt({ token, user, trigger, session }) {
      if (user) {
        // Fresh sign-in via any provider - `user` is always a real User row
        // (see the Credentials authorize() functions above and Auth.js's
        // default Google profile mapping).
        token.sub = user.id;
        token.onboarded = Boolean((user as { name?: string | null }).name);
      }
      if (trigger === "update" && session && typeof session.onboarded === "boolean") {
        token.onboarded = session.onboarded;
      }
      return token;
    },

    async session({ session, token }) {
      if (token.sub) session.userId = token.sub;
      session.onboarded = Boolean(token.onboarded);
      return session;
    },
  },
});

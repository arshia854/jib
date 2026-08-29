import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createOtpToken, verifyOtpToken, OTP_COOKIE, OTP_TTL_SECONDS, MAX_ATTEMPTS } from "@/lib/auth/otp";
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
  const token = store.get(OTP_COOKIE)?.value;
  const payload = token ? await verifyOtpToken(token) : null;
  if (!payload) throw new OtpExpiredError();

  const verifyLimit = checkRateLimit(`otp-verify:phone:${payload.phone}`, OTP_VERIFY_PHONE_RULE);
  if (!verifyLimit.allowed) throw new OtpRateLimitedError();

  if (payload.attempts >= MAX_ATTEMPTS) {
    store.delete(OTP_COOKIE);
    throw new OtpMaxAttemptsError();
  }

  if (payload.code !== code) {
    const retryToken = await createOtpToken(payload.phone, payload.code, payload.attempts + 1);
    store.set(OTP_COOKIE, retryToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OTP_TTL_SECONDS,
    });
    throw new OtpWrongCodeError(MAX_ATTEMPTS - payload.attempts - 1);
  }

  store.delete(OTP_COOKIE);

  let user = await prisma.user.findUnique({ where: { phoneNumber: payload.phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber: payload.phone } });
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
        if (!user || !user.passwordHash) throw new InvalidEmailPasswordError();

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
      // Google has verified this email belongs to whoever is signing in, so
      // it's safe to link the two accounts instead of creating a duplicate.
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

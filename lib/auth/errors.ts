import "server-only";
import { CredentialsSignin } from "next-auth";

// Each `.code` value shows up as the ?code= param on the client-side
// signIn() result (see next-auth/react's signIn), which the login/verify
// forms map to a Persian message. Keep these stable - they're a contract
// with the client code, not just log output.

export class OtpExpiredError extends CredentialsSignin {
  code = "otp_expired";
}

export class OtpMaxAttemptsError extends CredentialsSignin {
  code = "otp_max_attempts";
}

export class OtpRateLimitedError extends CredentialsSignin {
  code = "otp_rate_limited";
}

export class OtpInvalidFormatError extends CredentialsSignin {
  code = "otp_invalid_format";
}

export class OtpWrongCodeError extends CredentialsSignin {
  constructor(remainingAttempts: number) {
    super();
    this.code = `otp_wrong_${remainingAttempts}`;
  }
}

export class InvalidEmailPasswordError extends CredentialsSignin {
  code = "invalid_email_password";
}

export class EmailLoginRateLimitedError extends CredentialsSignin {
  code = "email_rate_limited";
}

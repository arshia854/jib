const MELIPAYAMAK_SEND_URL = "https://rest.payamak-panel.com/api/SendSMS/BaseServiceNumber";

export interface SendOtpResult {
  success: boolean;
  error?: string;
}

export function isMelipayamakConfigured(): boolean {
  return Boolean(
    process.env.MELIPAYAMAK_USERNAME && process.env.MELIPAYAMAK_PASSWORD && process.env.MELIPAYAMAK_BODY_ID
  );
}

interface MelipayamakResponse {
  RetStatus?: number;
  Value?: string;
  StrRetStatus?: string;
}

// Pattern-based SMS ("ارسال پیامک با الگو" / BaseServiceNumber) rather than
// plain-text: it's built for OTP codes, passes carrier filters that block
// plain-text ad-like content, and needs no dedicated sender line - only a
// pre-approved pattern (bodyId) from the Melipayamak panel with a single
// placeholder that `text` fills with the OTP code.
export async function sendOtpViaMelipayamak(phone: string, code: string): Promise<SendOtpResult> {
  const username = process.env.MELIPAYAMAK_USERNAME;
  const password = process.env.MELIPAYAMAK_PASSWORD;
  const bodyId = process.env.MELIPAYAMAK_BODY_ID;

  if (!username || !password || !bodyId) {
    return { success: false, error: "Melipayamak credentials are not configured" };
  }

  try {
    const response = await fetch(MELIPAYAMAK_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, to: phone, bodyId, text: code }),
    });

    if (!response.ok) {
      return { success: false, error: `Melipayamak HTTP ${response.status}` };
    }

    const data: MelipayamakResponse = await response.json();
    if (data.RetStatus !== 1) {
      return {
        success: false,
        error: `Melipayamak RetStatus ${data.RetStatus ?? "unknown"}: ${data.StrRetStatus ?? "no message"}`,
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown Melipayamak error" };
  }
}

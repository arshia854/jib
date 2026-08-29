import { prisma } from "@/lib/prisma";
import { redact } from "@/lib/observability/redact";

const MAX_ROUTE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 8000;

export interface LogErrorInput {
  route: string;
  message: string;
  stack?: string | null;
  userId?: number | null;
}

// Minimal insert helper for the ErrorLog table (see app/app/admin/logs).
// Deliberately swallows its own failures - a logging call must never throw
// and mask (or crash the handler around) the original error it's recording.
//
// `message`/`stack` are run through the shared redact() (lib/observability/
// redact.ts, Phase 6 privacy-audit addition) before being stored. Unlike
// the pino/Sentry pipeline (lib/observability/report-error.ts), this table
// is written to directly - by two server-side catch blocks whose `message`
// can be a raw upstream error string (e.g. a JSON.parse SyntaxError quoting
// a snippet of the AI's response, or NVIDIA NIM's own error-response text),
// and by app/api/log-error/route.ts, which accepts client-submitted
// message/stack from an unauthenticated endpoint - so nothing here can
// assume its input has already been sanitized. `stack` needs the same
// treatment as `message`, not just message: a JS Error's `.stack` string
// conventionally starts with `"${name}: ${message}"` (V8's own format), so
// the same content this redacts out of `message` would otherwise still be
// sitting at the top of `stack` untouched.
export async function logError({ route, message, stack, userId }: LogErrorInput): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        route: route.slice(0, MAX_ROUTE_LENGTH),
        message: redact(message).slice(0, MAX_MESSAGE_LENGTH),
        stack: stack ? redact(stack).slice(0, MAX_STACK_LENGTH) : undefined,
        userId: userId ?? undefined,
      },
    });
  } catch (err) {
    console.error("logError: failed to write ErrorLog row:", err);
  }
}

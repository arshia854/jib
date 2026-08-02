import { prisma } from "@/lib/prisma";

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
export async function logError({ route, message, stack, userId }: LogErrorInput): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        route: route.slice(0, MAX_ROUTE_LENGTH),
        message: message.slice(0, MAX_MESSAGE_LENGTH),
        stack: stack ? stack.slice(0, MAX_STACK_LENGTH) : undefined,
        userId: userId ?? undefined,
      },
    });
  } catch (err) {
    console.error("logError: failed to write ErrorLog row:", err);
  }
}

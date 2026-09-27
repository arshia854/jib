// `web-push` ships no types of its own, and `@types/web-push` was
// deliberately not added (Phase 2 of the notifications feature was
// explicitly scoped to add exactly one new dependency, `web-push` itself)
// - this is a minimal ambient declaration covering only the API surface
// this codebase actually calls (lib/notifications/send-push.ts,
// scripts/*, see each call site), not the whole package.
declare module "web-push" {
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export function generateVAPIDKeys(): VapidKeys;

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  export interface PushSubscriptionKeys {
    p256dh: string;
    auth: string;
  }

  export interface PushSubscription {
    endpoint: string;
    keys: PushSubscriptionKeys;
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export interface WebPushError extends Error {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
    endpoint: string;
  }

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: Record<string, unknown>
  ): Promise<SendResult>;
}

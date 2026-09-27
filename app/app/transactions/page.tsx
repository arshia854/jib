import { redirect } from "next/navigation";

// Phase 3 (docs/roadmap-status.md): the Transactions tab moved to
// app/app/dashboard/page.tsx?tab=transactions - this route is now just a
// thin redirect for anything that still links/bookmarks the old path.

interface PageProps {
  searchParams: Promise<{ type?: string; categoryId?: string; page?: string }>;
}

/**
 * Builds the /app/dashboard?tab=transactions URL for a given set of old
 * /app/transactions query params, carrying `type`/`categoryId`/`page` over
 * unchanged so a bookmarked/linked filtered URL still lands on the same
 * filtered view under its new home. Exported (not just used inline) so this
 * param-preservation logic has its own unit test (page.test.ts) - the one
 * part of an otherwise-trivial redirect worth getting wrong.
 */
export function buildTransactionsRedirectPath(params: { type?: string; categoryId?: string; page?: string }): string {
  const search = new URLSearchParams();
  search.set("tab", "transactions");
  if (params.type) search.set("type", params.type);
  if (params.categoryId) search.set("categoryId", params.categoryId);
  if (params.page) search.set("page", params.page);
  return `/app/dashboard?${search.toString()}`;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  redirect(buildTransactionsRedirectPath(params));
}

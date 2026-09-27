import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listSavingsStrategies } from "@/lib/data/savings-strategies";
import { getMonthlyFinancialProfile } from "@/lib/savings/monthly-profile";
import { suggestAllFormulas } from "@/lib/savings/formulas";
import { listGoalsWithFeasibility } from "@/lib/data/goals";
import { listAccounts, getSavingsTransferredThisMonth } from "@/lib/data/accounts";
import { SavingsManager } from "@/components/savings/savings-manager";

export const dynamic = "force-dynamic";

// Dedicated route, same shape as app/app/transfer/page.tsx (a server
// component fetching what the client manager needs, rendering one client
// component) - not a tab on the dashboard, matching that route's own
// convention. Entry point is a link from components/goals/goals-manager.tsx's
// header, not a bottom-nav slot - see that file's own comment.
export default async function SavingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [strategies, profile, goals, accounts, actualTransferredThisMonth] = await Promise.all([
    listSavingsStrategies(session.userId),
    getMonthlyFinancialProfile(session.userId),
    listGoalsWithFeasibility(session.userId),
    listAccounts(session.userId),
    getSavingsTransferredThisMonth(session.userId),
  ]);
  const suggestions = suggestAllFormulas(profile);

  // Only the fields the read-only goal-allocation view needs - not the full
  // row or its `feasibility` object, which that view doesn't use.
  const goalAllocations = goals.map((g) => ({
    id: g.id,
    name: g.name,
    targetAmount: g.targetAmount,
    alreadySaved: g.alreadySaved,
    availableBalance: g.availableBalance,
    status: g.status,
  }));

  // id/name/type only (AccountOption's shape, lib/accounts.ts) - the
  // "do this transfer now" shortcut just needs to pick a from/to account by
  // type, not the full row.
  const accountOptions = accounts.map((a) => ({ id: a.id, name: a.name, type: a.type }));

  return (
    <SavingsManager
      strategies={strategies}
      suggestions={suggestions}
      goals={goalAllocations}
      accounts={accountOptions}
      actualTransferredThisMonth={actualTransferredThisMonth}
    />
  );
}

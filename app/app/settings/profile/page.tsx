import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserFacts } from "@/lib/facts/user-facts";
import { ProfileFactsForm } from "@/components/settings/profile-facts-form";
import { BackIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const facts = await getUserFacts(session.userId);
  const factValues = Object.fromEntries(facts.map((f) => [f.key, f.value]));

  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-4">
        <Link
          href="/app/settings"
          aria-label="بازگشت به تنظیمات"
          className="rounded-full p-1.5 text-muted hover:bg-surface hover:text-foreground"
        >
          <BackIcon className="h-5 w-5" />
        </Link>
        <span className="text-xs text-muted">تنظیمات</span>
      </div>
      <ProfileFactsForm initialValues={factValues} />
    </div>
  );
}

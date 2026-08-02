import Link from "next/link";
import { listErrorLogsForAdmin, type AdminErrorLogItem } from "@/lib/data/admin-logs";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { EmptyState } from "@/components/empty-state";
import { AlertIcon } from "@/components/icons";
import { formatJalaaliDateTime, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function AdminLogsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const requestedPage = Number(params.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const result = await listErrorLogsForAdmin(page);

  return (
    <div className="space-y-4 px-4 pb-8 pt-5">
      <h2 className="text-sm font-semibold text-foreground">رویدادهای خطا ({formatNumber(result.total)})</h2>

      {result.items.length === 0 ? (
        <EmptyState icon={<AlertIcon className="h-6 w-6" />} title="خطایی ثبت نشده است." />
      ) : (
        <div className="space-y-2">
          {result.items.map((log) => (
            <LogEntry key={log.id} log={log} />
          ))}
        </div>
      )}

      <PaginationControls basePath="/app/admin/logs" page={result.page} totalPages={result.totalPages} />
    </div>
  );
}

function LogEntry({ log }: { log: AdminErrorLogItem }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
          {log.route}
        </span>
        <span className="shrink-0 text-[11px] text-muted">{formatJalaaliDateTime(log.timestamp)}</span>
      </div>
      <p className="mt-2 text-sm text-foreground">{log.message}</p>
      {log.user && (
        <Link href={`/app/admin/users/${log.user.id}`} className="mt-1 inline-block text-xs text-accent">
          {log.user.name ?? log.user.phoneNumber ?? `کاربر #${log.user.id}`}
        </Link>
      )}
      {log.stack && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted">جزئیات فنی</summary>
          <pre dir="ltr" className="mt-2 max-h-48 overflow-auto rounded-xl bg-background p-2 text-left text-[11px] text-muted">
            {log.stack}
          </pre>
        </details>
      )}
    </div>
  );
}

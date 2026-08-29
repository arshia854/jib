import Link from "next/link";
import { formatNumber } from "@/lib/format";

interface PaginationControlsProps {
  basePath: string;
  page: number;
  totalPages: number;
  // Extra query params (e.g. active filters) to carry over onto the
  // prev/next links so paging doesn't silently reset them. `undefined`
  // values are omitted, same convention as TransactionFilterBar's
  // updateParams. Optional and unused by the admin pages this component
  // originally shipped for, so their rendered links are unchanged.
  queryParams?: Record<string, string | undefined>;
}

export function PaginationControls({ basePath, page, totalPages, queryParams }: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  function hrefForPage(targetPage: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    params.set("page", String(targetPage));
    return `${basePath}?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-between px-1 text-xs">
      {page > 1 ? (
        <Link href={hrefForPage(page - 1)} className="font-medium text-accent">
          قبلی
        </Link>
      ) : (
        <span />
      )}
      <span className="text-muted">
        صفحه {formatNumber(page)} از {formatNumber(totalPages)}
      </span>
      {page < totalPages ? (
        <Link href={hrefForPage(page + 1)} className="font-medium text-accent">
          بعدی
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

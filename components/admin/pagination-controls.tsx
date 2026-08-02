import Link from "next/link";
import { formatNumber } from "@/lib/format";

interface PaginationControlsProps {
  basePath: string;
  page: number;
  totalPages: number;
}

export function PaginationControls({ basePath, page, totalPages }: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-1 text-xs">
      {page > 1 ? (
        <Link href={`${basePath}?page=${page - 1}`} className="font-medium text-accent">
          قبلی
        </Link>
      ) : (
        <span />
      )}
      <span className="text-muted">
        صفحه {formatNumber(page)} از {formatNumber(totalPages)}
      </span>
      {page < totalPages ? (
        <Link href={`${basePath}?page=${page + 1}`} className="font-medium text-accent">
          بعدی
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

import Link from "next/link";
import { PlusIcon } from "@/components/icons";

export function Fab() {
  return (
    <Link
      href="/app/add"
      aria-label="افزودن تراکنش"
      className="absolute bottom-20 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-primary-dark text-white shadow-lg shadow-primary/30 transition-transform active:scale-95"
    >
      <PlusIcon className="h-7 w-7" />
    </Link>
  );
}

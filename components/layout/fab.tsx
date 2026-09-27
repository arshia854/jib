import Link from "next/link";
import { PlusIcon } from "@/components/icons";

// `hidden` (driven by AppShell's scroll tracking) slides the button out of
// the way while the user scrolls down through content it would otherwise
// sit on top of, e.g. a transaction row's amount; `inert` keeps it out of
// the tab order and accessibility tree while it's off-screen.
export function Fab({ hidden = false }: { hidden?: boolean }) {
  return (
    <Link
      href="/app/add"
      aria-label="افزودن تراکنش"
      inert={hidden}
      className={`absolute bottom-24 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg shadow-primary/25 ring-4 ring-background transition-[translate,scale,opacity] duration-200 ease-out active:scale-95 motion-reduce:transition-none ${
        hidden ? "pointer-events-none translate-y-6 scale-75 opacity-0" : ""
      }`}
    >
      <PlusIcon className="h-7 w-7" strokeWidth={2.2} />
    </Link>
  );
}

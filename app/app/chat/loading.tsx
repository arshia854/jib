import { SpinnerIcon } from "@/components/icons";

export default function ChatLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <SpinnerIcon className="h-6 w-6 animate-spin text-muted" />
    </div>
  );
}

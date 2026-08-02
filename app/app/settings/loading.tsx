import { SpinnerIcon } from "@/components/icons";

export default function SettingsLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <SpinnerIcon className="h-6 w-6 animate-spin text-muted" />
    </div>
  );
}

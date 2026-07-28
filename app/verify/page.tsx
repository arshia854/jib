import { Suspense } from "react";
import { VerifyForm } from "@/components/auth/verify-form";

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyForm />
    </Suspense>
  );
}

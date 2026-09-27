import type { ReactNode } from "react";
import { Reveal } from "./reveal";

interface SectionHeadingProps {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  // Lets the parent <section> point aria-labelledby at this heading.
  id?: string;
}

// Shared eyebrow + title + description block, so every landing section opens
// with the same type scale and spacing instead of each one drifting on its own.
export function SectionHeading({ eyebrow, title, description, id }: SectionHeadingProps) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-foreground/5 px-3 py-1 text-xs font-semibold text-foreground">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
        {eyebrow}
      </span>
      <h2 id={id} className="mt-4 text-2xl font-extrabold leading-snug text-foreground sm:text-4xl sm:leading-snug">
        {title}
      </h2>
      {description && <p className="mt-4 text-sm leading-relaxed text-muted sm:text-base">{description}</p>}
    </Reveal>
  );
}

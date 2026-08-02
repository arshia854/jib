import type { ImgHTMLAttributes } from "react";

type LogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;

export function Logo({ className = "h-9 w-9", ...props }: LogoProps) {
  return <img src="/icon.svg" alt="" className={className} {...props} />;
}

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-rule bg-paper-2 text-ink-2",
        signal:  "border-signal-tint bg-signal-wash text-signal",
        ok:      "border-ok-tint bg-ok-tint text-ok",
        warn:    "border-warn-tint bg-warn-tint text-warn",
        error:   "border-error-tint bg-error-tint text-error"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

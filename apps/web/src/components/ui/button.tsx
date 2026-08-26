import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border font-sans text-[12.5px] transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:     "border-rule bg-card text-foreground hover:bg-card-2",
        primary:     "border-ink bg-ink text-paper hover:bg-ink-2",
        signal:      "border-signal bg-signal text-paper hover:bg-signal-2",
        secondary:   "border-rule bg-paper-2 text-foreground hover:bg-paper-3",
        ghost:       "border-transparent bg-transparent text-ink-2 hover:bg-paper-3",
        destructive: "border-error bg-error text-destructive-foreground hover:opacity-90",
        outline:     "border-rule bg-transparent text-foreground hover:bg-paper-3",
        link:        "border-transparent bg-transparent text-signal underline-offset-4 hover:underline"
      },
      size: {
        default: "h-8 px-3 py-[7px]",
        sm:      "h-7 px-2 py-1 text-[11.5px]",
        xs:      "h-6 px-2 py-0.5 text-[11px] [&_svg]:size-3",
        lg:      "h-10 px-5",
        icon:    "h-8 w-8 p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  }
);
Button.displayName = "Button";

export { buttonVariants };

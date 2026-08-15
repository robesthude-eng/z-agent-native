import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Скругление полное. Меняется ТОЛЬКО радиус: высоты и отступы
  // остались прежними, поэтому ни одна кнопка не сдвинулась и ни один
  // сосед не поехал. `border-radius` размер коробки не меняет.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:opacity-90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:opacity-90",
        outline: "border border-border bg-transparent hover:bg-muted",
        secondary: "bg-muted text-foreground hover:bg-muted/80",
        ghost: "hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        // 36px. `md:h-9 md:w-9` отсюда убрано: он дублировал базовый размер и
        // потому ничего не рисовал, но переопределить размер кнопки через
        // className становилось невозможно — на широком экране медиа-вариант
        // побеждал, и `h-8 w-8` молча оставалась 36-пиксельной.
        icon: "h-9 w-9", // min 44px на касании — правило .min-touch в index.css
        // 'icon' buttons get min touch target via CSS — see index.css .min-touch
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

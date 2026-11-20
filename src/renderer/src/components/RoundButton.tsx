import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  call: "bg-call hover:bg-call-hover text-white",
  hangup: "bg-hangup hover:bg-hangup-hover text-white",
  neutral: "bg-key hover:bg-key-hover active:bg-key-active text-foreground",
  on: "bg-foreground text-background hover:bg-foreground/85",
} as const;

export function roundButtonClass(tone: keyof typeof TONES, size: "md" | "lg" = "md"): string {
  return cn(
    "focus-visible:ring-ring/60 flex items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] disabled:opacity-40 [&_svg]:size-6",
    size === "lg" ? "size-16 [&_svg]:size-7" : "size-14",
    TONES[tone],
  );
}

/** A circular action button; `label` puts a caption under it and names it for assistive tech. */
export function RoundButton({
  tone,
  size = "md",
  label,
  showLabel = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  tone: keyof typeof TONES;
  size?: "md" | "lg";
  label: string;
  showLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <button
        type="button"
        aria-label={label}
        title={showLabel ? undefined : label}
        className={roundButtonClass(tone, size)}
        {...props}
      >
        {children}
      </button>
      {showLabel && <span className="text-muted-foreground text-xs">{label}</span>}
    </div>
  );
}

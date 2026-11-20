import type { LineSummary } from "@/lib/format";
import { cn } from "@/lib/utils";

const COLOURS: Record<LineSummary["tone"], string> = {
  ok: "bg-call",
  busy: "bg-primary",
  warn: "bg-[#e0a100]",
  off: "bg-muted-foreground/50",
};

export function StatusDot({ tone, className }: { tone: LineSummary["tone"]; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", COLOURS[tone], className)} />;
}

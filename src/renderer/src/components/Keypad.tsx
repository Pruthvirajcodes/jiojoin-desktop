import { useRef } from "react";
import { cn } from "@/lib/utils";

const KEYS: readonly { digit: string; letters: string }[] = [
  { digit: "1", letters: "" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  { digit: "*", letters: "" },
  { digit: "0", letters: "+" },
  { digit: "#", letters: "" },
];

const LABELS: Record<string, string> = { "*": "star", "#": "hash" };

/** The 12-key pad, shared by the dialler and the in-call tone keypad. */
export function Keypad({
  onKey,
  onLongZero,
  className,
}: {
  onKey(digit: string): void;
  /** Holding 0 enters "+" on the dialler. */
  onLongZero?(): void;
  className?: string;
}) {
  // Refs, not locals: a long press re-renders the parent before the click lands.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  return (
    <div className={cn("grid grid-cols-3 gap-x-5 gap-y-3", className)} role="group" aria-label="Keypad">
      {KEYS.map(({ digit, letters }) => (
        <button
          key={digit}
          type="button"
          aria-label={LABELS[digit] ?? digit}
          className="bg-key hover:bg-key-hover active:bg-key-active focus-visible:ring-ring/60 flex size-16 flex-col items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px]"
          onPointerDown={() => {
            if (digit !== "0" || !onLongZero) return;
            held.current = false;
            holdTimer.current = setTimeout(() => {
              held.current = true;
              onLongZero();
            }, 550);
          }}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onClick={() => {
            if (held.current) {
              held.current = false;
              return;
            }
            onKey(digit);
          }}
        >
          <span className={cn("text-[26px] leading-none font-normal", digit === "*" && "translate-y-1 text-[34px]")}>
            {digit}
          </span>
          {letters && (
            <span className="text-muted-foreground mt-1 text-[9px] leading-none font-semibold tracking-[0.14em]">
              {letters}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

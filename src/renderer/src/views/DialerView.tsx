import { Delete, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatAsTyped, formatNumber, sanitizeDialInput, toDialString } from "@shared/phone";
import type { AppState } from "@shared/types";
import { Keypad } from "@/components/Keypad";
import { RoundButton } from "@/components/RoundButton";
import { cn } from "@/lib/utils";

export function DialerView({
  state,
  number,
  onNumberChange,
}: {
  state: AppState;
  number: string;
  onNumberChange(value: string): void;
}) {
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const connected = state.line.status === "registered";
  const target = toDialString(number);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const change = (value: string) => {
    setError("");
    onNumberChange(sanitizeDialInput(value));
  };

  const call = async () => {
    if (number === "") return;
    const result = await window.jiojoin.dial(number);
    if (!result.ok) setError(result.error ?? "The call couldn't be started.");
    else onNumberChange("");
  };

  // Show how the network will see the number once it is complete enough to call.
  const preview = target.ok && number.length >= 10 ? formatNumber(number) : "";
  const display = formatAsTyped(number);

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-6">
      <div className="flex h-24 w-full max-w-sm flex-col items-center justify-end">
        <input
          ref={inputRef}
          value={display}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void call();
            if (event.key === "Escape") change("");
          }}
          onPaste={(event) => {
            // Pasted numbers arrive with spaces, brackets and "tel:" prefixes.
            event.preventDefault();
            change(event.clipboardData.getData("text"));
          }}
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          aria-label="Number to call"
          aria-describedby="dial-hint"
          placeholder="Enter a number"
          className={cn(
            "placeholder:text-muted-foreground/60 w-full bg-transparent text-center font-light tabular-nums outline-none placeholder:text-xl placeholder:font-normal",
            display.length > 14 ? "text-2xl" : "text-[34px]",
            // A caret in the middle of the centred placeholder reads as a glitch.
            number === "" && "caret-transparent",
          )}
        />
        <p
          id="dial-hint"
          role={error ? "alert" : undefined}
          className={cn("mt-1 h-5 text-[13px]", error ? "text-destructive" : "text-muted-foreground")}
        >
          {error || (preview && preview !== display ? preview : "")}
        </p>
      </div>

      <Keypad
        className="mt-5"
        onKey={(digit) => {
          change(number + digit);
          inputRef.current?.focus();
        }}
        onLongZero={() => {
          if (number === "") change("+");
          inputRef.current?.focus();
        }}
      />

      <div className="mt-5 grid grid-cols-3 gap-x-5">
        <span className="size-16" />
        <RoundButton
          tone="call"
          size="lg"
          label={connected ? "Call" : "Call (line not connected)"}
          disabled={number === "" || !connected}
          onClick={() => void call()}
        >
          <Phone fill="currentColor" strokeWidth={0} />
        </RoundButton>
        <div className="flex size-16 items-center justify-center">
          {number !== "" && (
            <button
              type="button"
              aria-label="Delete last digit"
              title="Delete"
              onClick={() => {
                change(number.slice(0, -1));
                inputRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
            >
              <Delete className="size-6" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

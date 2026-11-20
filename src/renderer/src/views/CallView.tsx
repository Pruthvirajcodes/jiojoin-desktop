import { Grip, Mic, MicOff, Pause, Phone, Play, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatNumber } from "@shared/phone";
import type { CallInfo } from "@shared/types";
import { DeviceSelect, useAudioDevices } from "@/components/DevicePickers";
import { Keypad } from "@/components/Keypad";
import { RoundButton, roundButtonClass } from "@/components/RoundButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTimer } from "@/lib/format";
import { useNow } from "@/lib/store";
import { cn } from "@/lib/utils";

function statusText(call: CallInfo, now: number): string {
  switch (call.state) {
    case "dialing":
      return "Calling…";
    case "ringing":
      return "Ringing…";
    case "incoming":
      return "Incoming call";
    case "connecting":
      return "Connecting…";
    case "active":
      if (call.held) return "On hold";
      if (call.remoteHeld) return "The other side put you on hold";
      return formatTimer(now - (call.answeredAt ?? now));
    case "ended":
      return call.endReason || "Call ended";
  }
}

function AudioPopover() {
  const { audio, reload, choose } = useAudioDevices();
  return (
    <Popover onOpenChange={(open) => open && reload()}>
      <div className="flex flex-col items-center gap-1.5">
        <PopoverTrigger asChild>
          <button type="button" aria-label="Audio devices" className={roundButtonClass("neutral")}>
            <Volume2 />
          </button>
        </PopoverTrigger>
        <span className="text-muted-foreground text-xs">Audio</span>
      </div>
      <PopoverContent className="grid w-72 gap-4" side="top">
        <DeviceSelect id="call-input" label="Microphone" kind="input" audio={audio} onChoose={choose} />
        <DeviceSelect id="call-output" label="Speaker" kind="output" audio={audio} onChoose={choose} />
      </PopoverContent>
    </Popover>
  );
}

/** Takes over the window for the length of a call. */
export function CallView({ call }: { call: CallInfo }) {
  const [keypad, setKeypad] = useState(false);
  const [tones, setTones] = useState("");
  const live = call.state === "active";
  const now = useNow(live && !call.held);
  const title = formatNumber(call.number) || call.name || "Unknown caller";
  const ended = call.state === "ended";

  useEffect(() => {
    if (!live) setKeypad(false);
  }, [live]);

  const sendTone = (digit: string) => {
    setTones((current) => (current + digit).slice(-24));
    void window.jiojoin.sendDtmf(digit);
  };

  // Typing digits during a call sends tones, like pressing them on a phone.
  useEffect(() => {
    if (!live) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9*#]$/.test(event.key)) sendTone(event.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-between px-8 pb-8">
        <div className={cn("flex flex-col items-center justify-center text-center", keypad ? "min-h-16" : "min-h-28")}>
          {keypad ? (
            <p className="h-8 text-2xl font-light tracking-wider tabular-nums" aria-live="polite">
              {tones || title}
            </p>
          ) : (
            <h1 className="selectable text-[30px] leading-tight font-light tabular-nums">{title}</h1>
          )}
          {call.name && formatNumber(call.number) && !keypad && (
            <p className="text-muted-foreground mt-0.5 text-sm">{call.name}</p>
          )}
          <p
            role="status"
            className={cn(
              "text-[15px] tabular-nums",
              keypad ? "mt-0.5" : "mt-2",
              ended && call.failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {statusText(call, now)}
            {live && call.codec === "AMR-WB" && !call.held && (
              <span className="border-border ml-2 rounded border px-1 py-px align-[1px] text-[10px] font-semibold tracking-wide">
                HD
              </span>
            )}
          </p>
        </div>

        {keypad && <Keypad onKey={sendTone} />}

        {call.state === "incoming" ? (
          <div className="flex gap-16">
            <RoundButton tone="hangup" size="lg" label="Decline" showLabel onClick={() => void window.jiojoin.hangup()}>
              <Phone fill="currentColor" strokeWidth={0} className="rotate-[135deg]" />
            </RoundButton>
            <RoundButton tone="call" size="lg" label="Answer" showLabel autoFocus onClick={() => void window.jiojoin.answer()}>
              <Phone fill="currentColor" strokeWidth={0} />
            </RoundButton>
          </div>
        ) : ended ? (
          <div className="flex gap-2">
            {call.failed && call.direction === "outgoing" && call.number !== "" && (
              <Button variant="outline" onClick={() => void window.jiojoin.dial(call.number)}>
                Call again
              </Button>
            )}
            <Button variant="outline" autoFocus onClick={() => void window.jiojoin.dismissCall()}>
              Done
            </Button>
          </div>
        ) : keypad ? (
          <div className="grid grid-cols-3 items-center gap-x-5">
            <span className="size-16" />
            <RoundButton tone="hangup" size="lg" label="End call" onClick={() => void window.jiojoin.hangup()}>
              <Phone fill="currentColor" strokeWidth={0} className="rotate-[135deg]" />
            </RoundButton>
            <Button variant="ghost" size="sm" onClick={() => setKeypad(false)}>
              Hide
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-8">
            <div className="flex gap-7">
              <RoundButton
                tone={call.muted ? "on" : "neutral"}
                label={call.muted ? "Unmute" : "Mute"}
                showLabel
                aria-pressed={call.muted}
                onClick={() => void window.jiojoin.setMuted(!call.muted)}
              >
                {call.muted ? <MicOff /> : <Mic />}
              </RoundButton>
              <RoundButton
                tone="neutral"
                label="Keypad"
                showLabel
                disabled={!live}
                onClick={() => setKeypad(true)}
              >
                <Grip />
              </RoundButton>
              <RoundButton
                tone={call.held ? "on" : "neutral"}
                label={call.held ? "Resume" : "Hold"}
                showLabel
                aria-pressed={call.held}
                disabled={!live}
                onClick={() => void window.jiojoin.setHold(!call.held)}
              >
                {call.held ? <Play /> : <Pause />}
              </RoundButton>
              <AudioPopover />
            </div>
            <RoundButton tone="hangup" size="lg" label="End call" onClick={() => void window.jiojoin.hangup()}>
              <Phone fill="currentColor" strokeWidth={0} className="rotate-[135deg]" />
            </RoundButton>
          </div>
        )}
      </div>
    </div>
  );
}

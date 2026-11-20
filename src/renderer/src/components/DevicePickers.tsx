import { useEffect, useState } from "react";
import type { AudioDevices } from "@shared/types";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SYSTEM_DEFAULT = "__default__";

/** Loads the engine's device list; `reload` picks up devices plugged in since. */
export function useAudioDevices() {
  const [audio, setAudio] = useState<AudioDevices | null>(null);
  const reload = () => void window.jiojoin.listAudioDevices().then(setAudio);
  useEffect(reload, []);

  const choose = (kind: "input" | "output", value: string) => {
    const name = value === SYSTEM_DEFAULT ? "" : value;
    setAudio((current) => (current ? { ...current, [kind]: name } : current));
    void window.jiojoin.setAudioDevices({ [kind]: name });
  };
  return { audio, reload, choose };
}

export function DeviceSelect({
  id,
  label,
  kind,
  audio,
  onChoose,
  onOpen,
}: {
  id: string;
  label: string;
  kind: "input" | "output";
  audio: AudioDevices | null;
  onChoose(kind: "input" | "output", value: string): void;
  onOpen?(): void;
}) {
  const options = (audio?.devices ?? []).filter((device) => device[kind]);
  const selected = audio?.[kind] ?? "";
  // A saved device that is unplugged stays listed so the choice is visible.
  const missing = selected !== "" && !options.some((device) => device.name === selected);

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={selected === "" ? SYSTEM_DEFAULT : selected}
        onValueChange={(value) => onChoose(kind, value)}
        onOpenChange={(open) => open && onOpen?.()}
        disabled={audio === null}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Loading…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
          {options.map((device) => (
            <SelectItem key={device.name} value={device.name}>
              {device.name}
            </SelectItem>
          ))}
          {missing && <SelectItem value={selected}>{selected} (not connected)</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}

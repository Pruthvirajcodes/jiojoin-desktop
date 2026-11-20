import { contextBridge, ipcRenderer } from "electron";
import { API_METHODS, type Api, type ApiEvents, type Bridge } from "@shared/types";

// The renderer gets exactly the methods in API_METHODS and nothing else:
// no ipcRenderer, no Node, no channel names of its own choosing.
const api = Object.fromEntries(
  API_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(`api:${method}`, ...args)]),
) as unknown as Api;

const EVENTS: readonly (keyof ApiEvents)[] = ["state", "history", "level", "navigate"];

const bridge: Bridge = {
  ...api,
  on(event, listener) {
    if (!EVENTS.includes(event)) throw new Error(`unknown event: ${String(event)}`);
    const handler = (_: unknown, payload: ApiEvents[typeof event]) => listener(payload);
    ipcRenderer.on(`event:${event}`, handler);
    return () => ipcRenderer.removeListener(`event:${event}`, handler);
  },
};

contextBridge.exposeInMainWorld("jiojoin", bridge);

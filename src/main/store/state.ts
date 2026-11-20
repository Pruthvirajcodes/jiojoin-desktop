import type { AppState } from "@shared/types";

/** The single snapshot every window renders from. */
export class StateStore {
  private readonly listeners = new Set<(state: AppState) => void>();

  constructor(private state: AppState) {}

  get(): AppState {
    return this.state;
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: AppState) => void): void {
    this.listeners.add(listener);
  }
}

import type { Clock } from "./types.js";

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/** Deterministic clock for tests and maintenance fixtures. */
export class FixedClock implements Clock {
  private currentMs: number;

  constructor(iso: string | number | Date = "2026-11-10T00:00:00.000Z") {
    this.currentMs = new Date(iso).getTime();
    if (!Number.isFinite(this.currentMs)) throw new Error("invalid FixedClock time");
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  set(iso: string | number | Date): void {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) throw new Error("invalid FixedClock time");
    this.currentMs = ms;
  }

  advanceDays(days: number): void {
    this.currentMs += Math.round(days * 86_400_000);
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

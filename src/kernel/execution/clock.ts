/**
 * t68 内核：可注入时钟。
 * 生产使用 Date.now；测试用 FakeClock 让租约/退避确定性可验证。
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  private current: number;

  constructor(start = Date.parse("2026-01-01T00:00:00.000Z")) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

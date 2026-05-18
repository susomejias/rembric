/**
 * Test clock fixture. Pass `clock.now` into services that accept a
 * `now: () => Date` constructor argument. Tests can freeze time, advance
 * by milliseconds, or set an absolute instant.
 */
export class TestClock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00Z')) {}

  now = (): Date => new Date(this.current.getTime());

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  get value(): Date {
    return new Date(this.current.getTime());
  }
}

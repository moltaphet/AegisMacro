// A strictly monotone logical clock. Wall-clock time can repeat (same ms) or go
// backwards (NTP step); load ordering must not. Every request takes a ticket,
// and only the newest ticket per key may publish its result.

export class MonotonicClock {
  private last = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  next(): number {
    const t = this.now();
    this.last = t > this.last ? t : this.last + 1;
    return this.last;
  }

  peek(): number {
    return this.last;
  }
}

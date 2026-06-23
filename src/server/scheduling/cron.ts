// Minimal 5-field cron parser. Fields: minute hour day-of-month month
// day-of-week. Supports `*`, comma lists, dash ranges, `*/n` and `a-b/n`
// step values. No L/W/# extensions, no second-field, no timezone hacks —
// scheduler always interprets in local time.
//
// `next(after)` returns the next absolute millisecond-since-epoch the
// expression fires strictly after `after`. Searches up to 4 years ahead;
// returns null if no match (e.g. `0 0 30 2 *` — Feb 30, impossible).

export interface CronExpr {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  raw: string;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: Record<string, FieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // 0 = Sunday, 6 = Saturday. 7 is accepted as alias for 0.
  dow: { min: 0, max: 6 },
};

export function parseCron(raw: string): CronExpr {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${raw}"`);
  }
  return {
    minutes: parseField(fields[0]!, FIELD_RANGES.minute!, 'minute'),
    hours: parseField(fields[1]!, FIELD_RANGES.hour!, 'hour'),
    daysOfMonth: parseField(fields[2]!, FIELD_RANGES.dom!, 'day-of-month'),
    months: parseField(fields[3]!, FIELD_RANGES.month!, 'month'),
    daysOfWeek: normalizeDow(parseField(fields[4]!, { min: 0, max: 7 }, 'day-of-week')),
    raw,
  };
}

function normalizeDow(set: Set<number>): Set<number> {
  if (set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set;
}

function parseField(input: string, range: FieldRange, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of input.split(',')) {
    const piece = part.trim();
    if (piece.length === 0) {
      throw new Error(`empty value in ${label} field`);
    }
    let step = 1;
    let body = piece;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      step = Number(piece.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step in ${label}: "${piece}"`);
      }
      body = piece.slice(0, slash);
      if (body === '*' || body === '') {
        body = `${range.min}-${range.max}`;
      }
    }

    let lo: number;
    let hi: number;
    if (body === '*') {
      lo = range.min;
      hi = range.max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(body);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
      throw new Error(`invalid range in ${label}: "${piece}"`);
    }
    if (lo < range.min || hi > range.max) {
      throw new Error(`${label} out of range [${range.min}-${range.max}]: "${piece}"`);
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Returns the next epoch-ms the cron expression fires, strictly after
// `afterMs`. Uses local time. Returns null if no firing within 4 years —
// guards against impossible expressions like `0 0 30 2 *`.
export function nextCronFire(expr: CronExpr, afterMs: number): number | null {
  // Step minute-by-minute from the next minute boundary. The 4-year cap is
  // ~2.1 million minutes, fast enough at runtime since the scheduler only
  // calls this on enable / each tick per instance.
  const start = new Date(afterMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = afterMs + 4 * 365 * 24 * 60 * 60_000;
  for (let t = start.getTime(); t < limit; t += 60_000) {
    const d = new Date(t);
    if (!expr.minutes.has(d.getMinutes())) continue;
    if (!expr.hours.has(d.getHours())) continue;
    if (!expr.months.has(d.getMonth() + 1)) continue;
    // Cron's day-of-month + day-of-week have a quirk: if BOTH are wildcards
    // every day matches; if only ONE is wildcard the other narrows the day
    // set; if NEITHER is wildcard the day matches if EITHER does (union).
    const domWildcard = expr.daysOfMonth.size === 31;
    const dowWildcard = expr.daysOfWeek.size === 7;
    const domMatch = expr.daysOfMonth.has(d.getDate());
    const dowMatch = expr.daysOfWeek.has(d.getDay());
    let dayOk: boolean;
    if (domWildcard && dowWildcard) dayOk = true;
    else if (domWildcard) dayOk = dowMatch;
    else if (dowWildcard) dayOk = domMatch;
    else dayOk = domMatch || dowMatch;
    if (!dayOk) continue;
    return t;
  }
  return null;
}

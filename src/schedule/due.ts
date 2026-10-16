import { DateTime } from "luxon";

export type Cadence = {
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  time: string; // HH:mm
  timezone: string;
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Most recent occurrence of the cadence at or before `now`. DST-correct: the wall-clock time is resolved in the cadence's zone per date. */
export function latestOccurrence(c: Cadence, now: Date): { at: Date; periodKey: string } | null {
  const m = TIME.exec(c.time);
  if (!m) throw new Error(`invalid cadence time "${c.time}" (expected HH:mm)`);
  if (!Number.isInteger(c.weekday) || c.weekday < 1 || c.weekday > 7) {
    throw new Error(`invalid cadence weekday ${c.weekday}`);
  }
  const local = DateTime.fromJSDate(now).setZone(c.timezone);
  if (!local.isValid) throw new Error(`invalid cadence timezone "${c.timezone}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);

  for (let back = 0; back <= 7; back++) {
    const day = local.minus({ days: back });
    if (day.weekday !== c.weekday) continue;
    const at = DateTime.fromObject(
      { year: day.year, month: day.month, day: day.day, hour, minute },
      { zone: c.timezone },
    );
    if (at.toMillis() <= now.getTime()) {
      return { at: at.toJSDate(), periodKey: at.toFormat("yyyy-MM-dd") };
    }
  }
  return null;
}

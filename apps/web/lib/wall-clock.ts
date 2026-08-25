/**
 * Converting between a wall clock the reader typed and an instant the API means.
 *
 * ## Why this is a file and not two inline expressions
 *
 * The availability window is entered as a local date and a local time — the
 * reader means "2pm where I am". The API takes an instant. Getting that
 * conversion wrong is silent: every value still looks plausible, and the search
 * window is simply shifted by the reader's UTC offset. P7 shipped exactly that
 * bug once already, by rendering an instant into a `datetime-local` input on the
 * server, where the reader's zone is unknown.
 *
 * So both directions are pure functions with no `Date` string parsing in them.
 * `new Date("2026-09-01T14:30")` is local and `new Date("2026-09-01T14:30Z")` is
 * UTC and the difference is one character — that is not a distinction to leave
 * to a reader of the code, or to a browser's parser. The numeric `Date`
 * constructor is unambiguously local, and `getFullYear`/`getHours` are
 * unambiguously local reads, so the intent is in the API being called rather
 * than in the shape of a string.
 *
 * Pure and exported means testable: `wall-clock.test.ts` runs the round trip
 * under several `TZ` values, including a half-hour offset and a zone that
 * observes DST, and asserts on the produced instant rather than on a shape.
 */

export interface WallClock {
  /** `YYYY-MM-DD`, as a `date` input produces. */
  date: string;
  /** `HH:MM`, 24 hour, on the API's 30-minute grid. */
  time: string;
}

const pad = (n: number): string => n.toString().padStart(2, '0');

/**
 * A local wall clock to the instant it names, as an ISO-8601 UTC string.
 *
 * Returns null for an incomplete pair rather than guessing at a default: a
 * half-filled window must not silently become a query.
 */
export function wallClockToInstant(wall: Partial<WallClock>): string | null {
  if (!wall.date || !wall.time) return null;

  const dateParts = wall.date.split('-').map(Number);
  const timeParts = wall.time.split(':').map(Number);
  if (dateParts.length !== 3 || timeParts.length < 2) return null;

  const [year, month, day] = dateParts as [number, number, number];
  const [hour, minute] = timeParts as [number, number];
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  // The numeric constructor is local time by definition. This is the only
  // place in the console that turns a typed clock into an instant.
  const instant = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(instant.getTime())) return null;

  return instant.toISOString();
}

/**
 * The inverse: an instant to the wall clock that names it *here*.
 *
 * Only ever called in the browser. On the server "here" is the deployment's
 * zone, which is not the reader's, and rendering that into a control the reader
 * will read back as local is precisely the round trip that shifts.
 */
export function instantToWallClock(iso: string): WallClock | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  return {
    date: `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`,
    time: `${pad(instant.getHours())}:${pad(instant.getMinutes())}`,
  };
}

/** `00:00` … `23:30`. The API books on a 30-minute grid, so the picker offers one. */
export function halfHourGrid(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
    const value = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    options.push({ value, label: value });
  }
  return options;
}

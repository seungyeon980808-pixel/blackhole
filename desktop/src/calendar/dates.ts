/** Local-calendar helpers. No time zones beyond the device's own. */
export const DOW = "일월화수목금토";

export const pad = (n: number): string => String(n).padStart(2, "0");

export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const hm = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export const nowHM = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "YYYY-MM-DDTHH:MM" for reminders. */
export const stamp = (d: Date): string => `${ymd(d)}T${nowHM(d)}`;

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export const mins = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export const diffDays = (a: string, b: string): number =>
  Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 864e5);

/** Glass: 10/25(일). */
export const fdShort = (s: string): string => {
  const d = parseDay(s);
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
};

/** Official-document date: 10. 25.(일) */
export const fdDoc = (s: string): string => {
  const d = parseDay(s);
  return `${d.getMonth() + 1}. ${d.getDate()}.(${DOW[d.getDay()]})`;
};

export const fdDocLong = (s: string): string => {
  const d = parseDay(s);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${DOW[d.getDay()]})`;
};

/** Sunday-first week containing d. */
export function weekDays(d: Date): string[] {
  const s = addDays(d, -d.getDay());
  return Array.from({ length: 7 }, (_, i) => ymd(addDays(s, i)));
}

/** "YYYY-MM-DDTHH:MM" → Date (local). */
export function fromStamp(s: string): Date {
  const [day, time] = s.split("T");
  const d = parseDay(day);
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** ISO 8601 with offset → local stamp. */
export function isoToStamp(iso: string): string {
  return stamp(new Date(iso));
}

export function isoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${ymd(d)}T${nowHM(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

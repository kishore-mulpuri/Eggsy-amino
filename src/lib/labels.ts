import type { EventState, Meal } from "../types";

export const MEALS: Meal[] = ["breakfast", "lunch", "dinner"];

export const MEAL_LABEL: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

export const MEAL_LETTER: Record<Meal, string> = {
  breakfast: "B",
  lunch: "L",
  dinner: "D",
};

export const STATE_LABEL: Record<EventState, string> = {
  verified: "Verified",
  name_matched: "Name match",
  unverified_attendance: "Unverified attendance",
  override: "Override",
  guest: "Guest",
};

/** Badge styling per state. The brand palette drives every piece of chrome;
 * these are the few functional status colours a busy counter needs to read
 * "fine to serve" vs "needs a second look" at a glance. */
export const STATE_BADGE: Record<EventState, string> = {
  verified: "bg-emerald-100 text-emerald-800",
  name_matched: "bg-sky-100 text-sky-800",
  unverified_attendance: "bg-amber-100 text-amber-800",
  override: "bg-orange-100 text-orange-800",
  guest: "bg-slate-200 text-slate-700",
};

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function formatWhen(ts: number | null): string {
  if (!ts) return "never";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return new Date(ts).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

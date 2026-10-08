export type Locale = "zh-CN" | "en";

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

export function storedLocale(value: unknown): Locale {
  return isLocale(value) ? value : "zh-CN";
}

export function formatNumber(value: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

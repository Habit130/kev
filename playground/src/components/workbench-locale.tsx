"use client";

import { createContext, useContext } from "react";
import { formatNumber, formatTime, type Locale } from "@/lib/workbench/locale";
import { chinese, type Copy } from "@/lib/workbench/translations";

export const WorkbenchLocale = createContext<Locale>("zh-CN");

export function useWorkbenchLocale() {
  const locale = useContext(WorkbenchLocale);
  return {
    locale,
    t: (copy: Copy, values: Record<string, string | number> = {}) => {
      const text = locale === "zh-CN" ? chinese[copy] : copy;
      return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
    },
    number: (value: number, digits = 0) => formatNumber(value, locale, digits),
    time: (value: string) => formatTime(value, locale),
  };
}

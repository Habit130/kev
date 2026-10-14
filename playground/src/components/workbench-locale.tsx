"use client";

import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
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

export function LanguageSwitch({ locale, saving, onChange }: { locale: Locale; saving: boolean; onChange: (locale: Locale) => void }) {
  const { t } = useWorkbenchLocale();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t("Interface language")}</span>
      <div role="group" aria-label={t("Interface language")} className="inline-flex rounded-lg border border-input p-0.5">
        {([["zh-CN", "简体中文"], ["en", "English"]] as const).map(([value, name]) => (
          <Button key={value} type="button" size="sm" variant={locale === value ? "secondary" : "ghost"} aria-pressed={locale === value} disabled={saving} onClick={() => onChange(value)}>{name}</Button>
        ))}
      </div>
      {saving && <span role="status" className="text-xs">{t("Saving language…")}</span>}
    </div>
  );
}

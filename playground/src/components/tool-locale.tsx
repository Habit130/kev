"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { LanguageSwitch, WorkbenchLocale, useWorkbenchLocale } from "@/components/workbench-locale";
import { displayError, WorkbenchErrorMessage, type DisplayError } from "@/components/workbench-error";
import type { Locale } from "@/lib/workbench/locale";
import { isJsonObject, parseJson, stringifyJson, type JsonValue } from "@/lib/workbench/json";

async function saveLocale(locale: Locale): Promise<void> {
  const response = await fetch("/api/workbench", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: stringifyJson({ action: "settings", settings: { locale } } as unknown as JsonValue),
  });
  if (!response.ok) {
    const data: unknown = await response.text().then((text) => parseJson(text)).catch(() => null);
    const message = isJsonObject(data) && isJsonObject(data.error) && typeof data.error.message === "string" ? data.error.message : `Workbench request failed (${response.status}).`;
    const error = new Error(message) as Error & { category?: string };
    error.category = isJsonObject(data) && isJsonObject(data.error) && typeof data.error.category === "string" ? data.error.category : "workbench_error";
    throw error;
  }
}

export function ToolLocale({ initialLocale, title, children }: { initialLocale: Locale; title: Record<Locale, string>; children: ReactNode }) {
  const [locale, setLocale] = useState(initialLocale);
  return (
    <WorkbenchLocale value={locale}>
      <ToolChrome locale={locale} setLocale={setLocale} title={title} />
      {children}
    </WorkbenchLocale>
  );
}

function ToolChrome({ locale, setLocale, title }: { locale: Locale; setLocale: (locale: Locale) => void; title: Record<Locale, string> }) {
  const { t } = useWorkbenchLocale();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    const previousLang = document.documentElement.lang;
    const previousTitle = document.title;
    document.documentElement.lang = locale;
    document.title = title[locale];
    return () => {
      document.documentElement.lang = previousLang;
      document.title = previousTitle;
    };
  }, [locale, title]);

  async function updateLocale(value: Locale) {
    if (saving || value === locale) return;
    setSaving(true);
    setError(null);
    try {
      await saveLocale(value);
      setLocale(value);
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 pt-4 md:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">{t("← Local model workbench")}</Link>
        <LanguageSwitch locale={locale} saving={saving} onChange={(value) => void updateLocale(value)} />
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive bg-error-surface p-3 text-sm text-destructive"><WorkbenchErrorMessage error={error} /></div>}
      <p className="break-words text-sm leading-6 text-muted-foreground" aria-label={t("Separate local backend")}>{t("This page uses a separate compatible local Kev backend (KEV_API, default http://127.0.0.1:8009). Loading a workbench model does not configure it. This is not a cloud-only tool, and Jev compatibility is not claimed or tested here.")}</p>
    </div>
  );
}

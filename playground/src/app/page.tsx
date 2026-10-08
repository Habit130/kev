import { Workbench } from "@/components/workbench";
import { readAppFile } from "@/lib/workbench/storage";
import type { Locale } from "@/lib/workbench/locale";

export const dynamic = "force-dynamic";

export default function Home() {
  let locale: Locale = "zh-CN";
  try {
    locale = readAppFile().settings.locale;
  } catch {
    // The snapshot request presents storage failures with their stable category.
  }
  return <Workbench initialLocale={locale} />;
}

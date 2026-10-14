import type { Metadata } from "next";
import { Playground } from "@/components/playground";
import { ToolLocale } from "@/components/tool-locale";
import { readSavedAppearance } from "@/lib/workbench/storage";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { locale } = readSavedAppearance();
  return {
    title: locale === "zh-CN" ? "Kev · 经典 Playground" : "Kev · Classic Playground",
    description: locale === "zh-CN" ? "直接编辑 System One 请求的经典 Playground。" : "The existing direct System One Playground.",
  };
}

export default function ClassicPage() {
  const { locale } = readSavedAppearance();
  return (
    <ToolLocale initialLocale={locale} title={{ "zh-CN": "Kev · 经典 Playground", en: "Kev · Classic Playground" }}>
      <Playground />
    </ToolLocale>
  );
}

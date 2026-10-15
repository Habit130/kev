import type { Metadata } from "next";
import { ChessGame } from "@/components/chess-game";
import { ToolLocale } from "@/components/tool-locale";
import { readSavedAppearance } from "@/lib/workbench/storage";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { locale } = readSavedAppearance();
  return {
    title: locale === "zh-CN" ? "Kev · 国际象棋" : "kev · chess",
    description: locale === "zh-CN" ? "决策模型下国际象棋：每一步都是一道选择题。" : "A decision model playing chess: every move is a Choice question.",
  };
}

export default function ChessPage() {
  const { locale } = readSavedAppearance();
  return (
    <ToolLocale initialLocale={locale} title={{ "zh-CN": "Kev · 国际象棋", en: "kev · chess" }}>
      <ChessGame />
    </ToolLocale>
  );
}

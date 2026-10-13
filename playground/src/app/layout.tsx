import type { Metadata } from "next";
import { readSavedAppearance } from "@/lib/workbench/storage";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kev · Local Model Workbench",
  description: "A project-local workbench for typed Kev inference, task templates, and run history.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const appearance = readSavedAppearance();
  return (
    <html lang={appearance.locale} className={`h-full antialiased ${appearance.theme}`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

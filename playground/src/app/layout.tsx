import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kev · Local Model Workbench",
  description: "A project-local workbench for typed Kev inference, task templates, and run history.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased light">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Playground } from "@/components/playground";

export const metadata: Metadata = {
  title: "Kev · Classic Playground",
  description: "The existing direct System One Playground.",
};

export default function ClassicPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-4 md:px-10">
        <Link href="/" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">← Local model workbench</Link>
      </div>
      <Playground />
    </>
  );
}

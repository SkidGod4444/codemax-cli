import type { Metadata } from "next";
import { Instrument_Serif, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif" });
const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "codemax — every AI coding plan you pay for, one terminal",
  description:
    "Use Claude, Codex, Grok and more side by side. When one hits its limit, the next carries on with your task — same context, no restart. Free and open source.",
  openGraph: {
    title: "codemax — never lose your flow to a usage limit",
    description: "Every AI coding plan you pay for, in one terminal. Free and open source.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

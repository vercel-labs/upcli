import type { Metadata, Viewport } from "next";
import { geistMono, geistPixel, geistSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://upcli.dev"),
  title: "up: live development servers on Vercel Sandbox",
  description:
    "Run up . in any working directory. Your app boots in a persistent Vercel Sandbox with a public URL, live file sync, and a fast path back after resume.",
  openGraph: {
    title: "up: live development servers on Vercel Sandbox",
    description:
      "Run up . in any working directory. Your app boots in a persistent Vercel Sandbox with a public URL and resumes from a saved snapshot.",
    url: "https://upcli.dev",
    siteName: "up",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "up: live development servers on Vercel Sandbox",
    description:
      "Run up . in any working directory, share the live URL, and resume the saved Vercel Sandbox later.",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${geistPixel.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}

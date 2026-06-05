import localFont from "next/font/local";

export const geistSans = localFont({
  src: [
    { path: "./fonts/Geist-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/Geist-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/Geist-SemiBold.otf", weight: "600", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

export const geistMono = localFont({
  src: [
    { path: "./fonts/GeistMono-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/GeistMono-Medium.otf", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

// Geist Pixel (BETA), used only for large display headings.
export const geistPixel = localFont({
  src: [{ path: "./fonts/GeistPixelBETA-Line.woff2", weight: "400", style: "normal" }],
  variable: "--font-pixel",
  display: "swap",
  adjustFontFallback: false,
});

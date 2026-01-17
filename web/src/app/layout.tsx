import type { Metadata } from "next";
import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-sans",
});

export const metadata: Metadata = {
  title: "Cheddar Logic | Signal-Qualified Analytics",
  description:
    "Outputs based on confidence thresholds and uncertainty controls.",
  metadataBase: new URL("https://cheddarlogic.com"),
  openGraph: {
    title: "Cheddar Logic",
    description:
      "We produce signal-qualified analytical outputs based on confidence thresholds and uncertainty controls.",
    url: "https://cheddarlogic.com",
    siteName: "Cheddar Logic",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${plexSans.variable} bg-night text-cloud antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

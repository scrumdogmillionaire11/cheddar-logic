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
  title: "Cheddar Logic | Abstention-First Analytics",
  description:
    "Probabilistic sports analytics, methodological transparency, and abstention-first decision-support.",
  metadataBase: new URL("https://cheddarlogic.com"),
  openGraph: {
    title: "Cheddar Logic",
    description:
      "Abstention-first sports analytics and decision-support for disciplined research teams.",
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

import type { Metadata } from "next";
import "./globals.css";

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
      <body className="bg-night text-cloud antialiased">
        {children}
      </body>
    </html>
  );
}

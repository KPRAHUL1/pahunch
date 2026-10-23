import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Pahunch — will I make it?",
  description:
    "Calibrated arrival confidence for electric vehicles on Indian roads. Answers with a probability, not a range figure.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}

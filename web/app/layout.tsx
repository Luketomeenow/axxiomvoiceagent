import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Axxiom — Outbound Qualification",
  description: "Live dashboard for the Axxiom elevator-violation outbound campaign.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

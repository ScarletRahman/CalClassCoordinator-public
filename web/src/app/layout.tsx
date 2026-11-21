import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CalClassCoordinator · Berkeley class planner",
  description: "Plan your Berkeley semesters, track every requirement, and know when to enroll.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

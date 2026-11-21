import type { Metadata } from "next";
import SimplePage from "@/components/SimplePage";
import ResetPassword from "./ResetPassword";

export const metadata: Metadata = { title: "Reset password · CalClassCoordinator", robots: { index: false } };

export default function ResetPage() {
  return (
    <SimplePage>
      <ResetPassword />
    </SimplePage>
  );
}

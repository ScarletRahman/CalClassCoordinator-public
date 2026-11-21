import type { Metadata } from "next";
import SimplePage from "@/components/SimplePage";
import VerifyEmail from "./VerifyEmail";

export const metadata: Metadata = { title: "Verify email · CalClassCoordinator", robots: { index: false } };

export default function VerifyPage() {
  return (
    <SimplePage>
      <VerifyEmail />
    </SimplePage>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import SimplePage from "@/components/SimplePage";

export const metadata: Metadata = {
  title: "Privacy · CalClassCoordinator",
  description: "What CalClassCoordinator stores, and what it doesn't.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <SimplePage wide>
      <h1 className="text-lg font-semibold text-slate-900">Privacy</h1>
      <p className="mt-1 text-sm text-slate-500">Your transcript stays on your computer, and we keep as little as we can.</p>

      <p className="mt-4 rounded-xl bg-cal-gold-100 px-3 py-2 text-sm text-slate-800 ring-1 ring-cal-gold/60">
        CalClassCoordinator is an unofficial, student-run tool. It is not affiliated with or endorsed by UC Berkeley.
        Requirement checklists can be wrong or out of date, so confirm your progress with your advisor and your official
        Academic Progress Report before making decisions.
      </p>

      <Section title="Your transcript">
        <p>
          When you import a transcript PDF, it is read inside your browser. The file is never uploaded to our server or
          anyone else&apos;s. The same goes for transcript text you paste in.
        </p>
        <p>
          Scanned PDFs are read with text recognition that also runs in your browser. The first time, your browser
          downloads about 7 MB of recognition files from this site and caches them. Your transcript is still not uploaded.
        </p>
        <p>
          Only the list of classes is kept: course, title, term, grade and units. Your name, student ID and anything else
          on the transcript are not saved.
        </p>
      </Section>

      <Section title="Without an account">
        <p>
          Your plan (majors, classes taken and planned, checked-off requirements) is saved in your browser&apos;s local
          storage on this device only. Nothing is sent to our server. If a saved plan ever can&apos;t be read, we keep a
          backup copy next to it in the same storage instead of deleting it.
        </p>
        <p>To remove it, use &ldquo;Start over&rdquo; in the planner or clear this site&apos;s data in your browser.</p>
      </Section>

      <Section title="If you create an account">
        <p>We store:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>your email address, and when you created the account and confirmed the email;</li>
          <li>your password, only as a salted scrypt hash (we can&apos;t read it);</li>
          <li>your plan: the class list described above, your majors and minors, year, planned semesters and checked-off requirements;</li>
          <li>your seat alerts: which class numbers to watch and whether to include reserved seats;</li>
          <li>a sign-in cookie, and a hashed copy of it on the server, so you stay signed in for up to 30 days;</li>
          <li>while an email link is unused, a hashed copy of it (confirm links work for 24 hours, reset links for 1 hour).</li>
        </ul>
        <p>
          Saved plans are encrypted in our database (AES-256) when the server has an encryption key set up. Your email
          address and seat alerts are not, because the server needs to read them to send you mail.
        </p>
        <p>
          Your browser also keeps a copy of your plan in local storage, so it loads quickly. When you sign
          out, we ask whether to keep that copy. On a shared computer, choose No.
        </p>
      </Section>

      <Section title="Emails and seat alerts">
        <p>
          We only email you about your account (confirming your address, resetting your password) and the seat alerts you
          turn on. No newsletters. Emails go out through our email provider, which sees the address and the message.
        </p>
        <p>
          Seat alerts need a confirmed email and are always sent to your account&apos;s address. To send them, your email
          and the class numbers you chose are passed to this project&apos;s seat-watcher service, which runs on the same
          server and keeps its own list of who to notify.
        </p>
        <p>
          To limit abuse, the server remembers your IP address in memory for up to an hour when you sign in or use the
          account forms. It is not stored in the database.
        </p>
      </Section>

      <Section title="No tracking">
        <p>There are no analytics, advertising or third-party trackers on this site, and we don&apos;t sell your data.</p>
      </Section>

      <Section title="Your control">
        <p>
          From the account menu (top right, once signed in) you can <strong>Download my data</strong> as a JSON file with your
          account details, saved plan and seat alerts, remove seat alerts, or <strong>Delete account &amp; data</strong>.
          Deleting removes your account, plan, alerts, sign-ins and email links from our database right away, and tells the
          seat watcher to stop your alerts. You can also choose to remove the copy in this browser at the same time.
        </p>
      </Section>

      <p className="mt-8">
        <Link href="/" className="text-sm font-medium text-cal-blue hover:underline">
          Back to your plan
        </Link>
      </p>
    </SimplePage>
  );
}

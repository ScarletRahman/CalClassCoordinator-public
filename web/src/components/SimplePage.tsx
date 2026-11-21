import Link from "next/link";

/** Small centred page shell for /verify, /reset and /privacy, matching the planner header. */
export default function SimplePage({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white/90">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link href="/" className="flex items-center gap-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-gold">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-cal-blue text-sm font-bold text-cal-gold">Cal</span>
            <span className="text-sm font-semibold leading-tight text-slate-900">CalClassCoordinator</span>
          </Link>
        </div>
      </header>
      <main className={`mx-auto px-4 py-10 ${wide ? "max-w-2xl" : "max-w-sm"}`}>
        <div className="rounded-2xl bg-white p-6 text-slate-800 shadow-sm ring-1 ring-slate-200">{children}</div>
      </main>
    </div>
  );
}

import Planner from "@/components/Planner";
import { loadCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function Home() {
  const catalog = await loadCatalog();
  return <Planner catalog={catalog} />;
}

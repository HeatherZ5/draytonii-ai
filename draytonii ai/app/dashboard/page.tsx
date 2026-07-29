import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col bg-neutral-50">
      <NavBar />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <DashboardClient userName={session.user.name ?? session.user.email ?? "there"} />
      </main>
    </div>
  );
}

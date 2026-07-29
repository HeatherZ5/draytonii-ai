"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatBox from "@/components/StatBox";
import PeriodToggle, { PeriodKey } from "@/components/PeriodToggle";
import AssistantPieChart from "@/components/AssistantPieChart";
import type { StatsResult } from "@/lib/logs";

const PERIOD_TITLE: Record<PeriodKey, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
};

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export default function DashboardClient({ userName }: { userName: string }) {
  const [period, setPeriod] = useState<PeriodKey>("week");
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: show a loading state immediately when the period changes, before the fetch resolves.
    setLoading(true);
    fetch(`/api/logs?period=${period}`)
      .then((res) => res.json())
      .then((data: StatsResult) => {
        if (!cancelled) setStats(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const totals = stats?.totals ?? {
    prompts: 0,
    tokensIn: 0,
    tokensOut: 0,
    energyWh: 0,
    co2G: 0,
  };

  const co2PieData =
    stats?.byAssistant.map((a) => ({ assistant: a.assistant, value: a.co2G })) ?? [];
  const energyPieData =
    stats?.byAssistant.map((a) => ({ assistant: a.assistant, value: a.energyWh })) ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hi, {userName}</h1>
          <p className="text-sm text-neutral-500">{PERIOD_TITLE[period]}&apos;s AI footprint</p>
        </div>
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>

      {loading && <p className="text-sm text-neutral-400">Loading...</p>}

      {!loading && totals.prompts === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-8 text-center text-sm text-neutral-500">
          No usage logged for this period yet.{" "}
          <Link href="/log" className="font-medium text-neutral-900 underline">
            Log a session
          </Link>{" "}
          or{" "}
          <Link href="/import" className="font-medium text-neutral-900 underline">
            import an export file
          </Link>{" "}
          to get started.
        </div>
      )}

      {/* Row 1: Prompts / Tokens In / Tokens Out */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <StatBox label="Prompts Written" value={formatNumber(totals.prompts)} />
        <StatBox label="Tokens Inputted" value={formatNumber(totals.tokensIn)} />
        <StatBox label="Tokens Outputted" value={formatNumber(totals.tokensOut)} />
      </div>

      {/* Row 2: Total CO2 Emissions */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Total CO2 Emissions
          </h2>
          <span className="text-2xl font-bold tabular-nums">
            {totals.co2G.toFixed(1)} <span className="text-sm font-medium text-neutral-400">g</span>
          </span>
        </div>
        <AssistantPieChart data={co2PieData} unit="g CO2" />
      </section>

      {/* Row 3: Estimated Energy */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Estimated Energy
          </h2>
          <span className="text-2xl font-bold tabular-nums">
            {totals.energyWh.toFixed(2)}{" "}
            <span className="text-sm font-medium text-neutral-400">Wh</span>
          </span>
        </div>
        <AssistantPieChart data={energyPieData} unit="Wh" />
      </section>

      <p className="pb-4 text-center text-xs text-neutral-400">
        Energy and CO2 figures are research-based estimates (not vendor-reported data).{" "}
        See{" "}
        <Link href="/about-the-numbers" className="underline">
          methodology &amp; sources
        </Link>
        .
      </p>
    </div>
  );
}

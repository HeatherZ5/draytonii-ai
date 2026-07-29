import Link from "next/link";
import {
  ASSISTANT_LABELS,
  ENERGY_WH_PER_1000_TOKENS,
  GRID_INTENSITY_G_PER_KWH,
  PUE,
} from "@/lib/co2";

export default function AboutTheNumbersPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <Link href="/dashboard" className="text-sm text-neutral-500 underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="text-3xl font-bold tracking-tight">About these numbers</h1>
      <p className="text-neutral-600">
        ChatGPT, Claude, and Gemini don&apos;t publish official per-query energy or
        carbon figures, so every energy and CO2 number on this dashboard is a
        research-based <strong>estimate</strong>, not a measured value. The goal is a
        reasonable, transparent order of magnitude — not lab-grade accuracy.
      </p>

      <h2 className="mt-4 text-lg font-semibold">How it&apos;s calculated</h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-neutral-600">
        <li>
          Each logged session has a token count (input + output). Energy is estimated as{" "}
          <code className="rounded bg-neutral-100 px-1 py-0.5">
            tokens ÷ 1000 × Wh-per-1000-tokens
          </code>{" "}
          using the per-assistant rate below.
        </li>
        <li>
          CO2 is estimated by converting that energy to kilowatt-hours, multiplying by a
          global average grid carbon intensity of {GRID_INTENSITY_G_PER_KWH} gCO2e/kWh
          (IEA average), then applying a typical datacenter Power Usage Effectiveness (PUE)
          overhead of {PUE}.
        </li>
      </ol>

      <h2 className="mt-4 text-lg font-semibold">Per-assistant energy rates used</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="py-2">Assistant</th>
            <th className="py-2">Wh per 1,000 tokens</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(ENERGY_WH_PER_1000_TOKENS).map(([key, rate]) => (
            <tr key={key} className="border-b border-neutral-100">
              <td className="py-2">{ASSISTANT_LABELS[key as keyof typeof ASSISTANT_LABELS]}</td>
              <td className="py-2 tabular-nums">{rate}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-4 text-lg font-semibold">Sources</h2>
      <ul className="list-disc space-y-2 pl-5 text-sm text-neutral-600">
        <li>
          &quot;How Hungry is AI? Benchmarking Energy, Water, and Carbon Footprint of LLM
          Inference&quot; — arXiv:2505.09598 (2025). Energy-per-token ranges for
          frontier-class LLMs.
        </li>
        <li>
          Hannah Ritchie, &quot;What&apos;s the carbon footprint of using ChatGPT or
          Gemini?&quot; — Substack, August 2025 update. ~0.42 Wh (± 0.13 Wh) for a short
          GPT-4o-class query.
        </li>
        <li>
          Google, &quot;Measuring the environmental impact of AI inference&quot; (2025) —
          median Gemini text query ≈ 0.24 Wh and ≈ 0.03 g CO2.
        </li>
        <li>
          IEA global average power-sector grid intensity, and typical hyperscale
          datacenter PUE (~1.1), used to convert energy to carbon for assistants that
          don&apos;t publish their own carbon figure.
        </li>
      </ul>

      <p className="mt-4 text-xs text-neutral-400">
        Anthropic has not published a comparable per-query figure for Claude, so its rate
        above is extrapolated from the same frontier-model research (assumed similar in
        scale to GPT-4o) rather than sourced directly from Anthropic.
      </p>
    </div>
  );
}

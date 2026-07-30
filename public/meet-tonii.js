(function () {
  const ASSISTANT_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
  const ORDER = ['chatgpt', 'claude', 'gemini'];
  const FALLBACK_TYPICAL_OUTPUT_TOKENS = 500;

  let statsCache = null;
  let calendarCache = null;
  let contextLoadFailed = false;

  const el = (id) => document.getElementById(id);

  function fmt(n, unit) {
    if (n === null || n === undefined) return 'not available';
    if (n === 0) return `0 ${unit}`.trim();
    if (n < 0.001) return `${n.toExponential(2)} ${unit}`.trim();
    if (n < 1) return `${n.toFixed(4)} ${unit}`.trim();
    if (n < 100) return `${n.toFixed(3)} ${unit}`.trim();
    return `${n.toFixed(1)} ${unit}`.trim();
  }

  async function loadContext() {
    try {
      const [statsRes, calendarRes] = await Promise.all([
        fetch('/api/stats?period=month'),
        fetch('/api/calendar'),
      ]);
      statsCache = await statsRes.json();
      calendarCache = await calendarRes.json();
    } catch (err) {
      contextLoadFailed = true;
    }
  }

  const EMPTY_ASSISTANT_BUCKET = {
    prompts: 0, tokensIn: 0, tokensOut: 0,
    co2Kg: 0, co2Min: 0, co2Max: 0,
    energyKwh: 0, energyMin: 0, energyMax: 0,
    waterL: 0, waterMin: 0, waterMax: 0, waterCount: 0,
    mineralsKg: 0, mineralsMin: 0, mineralsMax: 0, mineralsCount: 0,
    ecologitsCount: 0, fallbackCount: 0,
  };

  /**
   * Everything here is derived only from aggregate counts already in the
   * store (prompts, tokens, per-assistant impact totals) - never from
   * actual prompt text, which is discarded client-side before anything
   * is sent to the server. "Habits" and "recommendations" are therefore
   * necessarily inferred from usage patterns, not message content.
   */
  function computeInsights() {
    if (!statsCache) {
      const emptyByAssistant = {};
      ORDER.forEach((k) => { emptyByAssistant[k] = { ...EMPTY_ASSISTANT_BUCKET }; });
      return {
        totals: { ...EMPTY_ASSISTANT_BUCKET },
        byAssistant: emptyByAssistant,
        hasData: false,
        loadFailed: contextLoadFailed,
        largestContributor: null,
        largestCo2: 0,
        mostEfficient: null,
        mostEfficientRate: 0,
        avgOutputTokens: 0,
        avgInputTokens: 0,
        fallbackRatio: null,
      };
    }

    const totals = statsCache.totals;
    const byAssistant = statsCache.byAssistant;

    let largestContributor = null;
    let largestCo2 = -1;
    let mostEfficient = null;
    let mostEfficientRate = Infinity;

    ORDER.forEach((key) => {
      const bucket = byAssistant[key];
      if (!bucket || bucket.prompts <= 0) return;
      if (bucket.co2Kg > largestCo2) {
        largestCo2 = bucket.co2Kg;
        largestContributor = key;
      }
      const rate = bucket.co2Kg / bucket.prompts;
      if (rate < mostEfficientRate) {
        mostEfficientRate = rate;
        mostEfficient = key;
      }
    });

    const avgOutputTokens = totals.prompts > 0 ? totals.tokensOut / totals.prompts : 0;
    const avgInputTokens = totals.prompts > 0 ? totals.tokensIn / totals.prompts : 0;
    const estimateBasis = totals.ecologitsCount + totals.fallbackCount;
    const fallbackRatio = estimateBasis > 0 ? totals.fallbackCount / estimateBasis : null;

    return {
      totals,
      byAssistant,
      hasData: statsCache.hasAnyData && totals.prompts > 0,
      largestContributor,
      largestCo2,
      mostEfficient,
      mostEfficientRate,
      avgOutputTokens,
      avgInputTokens,
      fallbackRatio,
    };
  }

  function buildRecommendations(insights) {
    const recs = [];
    if (!insights.hasData) {
      return ['Upload an export from the Dashboard first - recommendations are based on your own usage patterns.'];
    }

    if (insights.avgOutputTokens > FALLBACK_TYPICAL_OUTPUT_TOKENS * 1.3) {
      recs.push(
        `Your average reply is about ${Math.round(insights.avgOutputTokens)} tokens, well above the ~${FALLBACK_TYPICAL_OUTPUT_TOKENS}-token baseline these estimates are calibrated against. Asking more targeted questions, or requesting shorter answers when you don't need the full detail, cuts both the footprint and your wait time.`
      );
    }

    if (insights.largestContributor) {
      const label = ASSISTANT_LABELS[insights.largestContributor];
      const share = insights.totals.co2Kg > 0 ? (insights.largestCo2 / insights.totals.co2Kg) * 100 : 0;
      recs.push(
        `${label} accounts for about ${share.toFixed(0)}% of your estimated CO2 footprint this period. Reserving it for tasks that actually need its strengths, and using a lighter assistant for quick lookups, is the single biggest lever you have.`
      );
    }

    if (insights.fallbackRatio !== null && insights.fallbackRatio > 0.3) {
      recs.push(
        `About ${(insights.fallbackRatio * 100).toFixed(0)}% of your estimates came from a local fallback formula rather than live EcoLogits data, so treat the totals as directional rather than precise - see the Sources page for what that means.`
      );
    }

    recs.push('Continue an existing conversation instead of starting a fresh one when the context still applies - re-explaining background makes the model reprocess it from scratch.');
    recs.push('Batch related questions into a single prompt rather than sending several small back-to-back ones - each request carries fixed overhead regardless of size.');

    return recs.slice(0, 5);
  }

  function computeWeeklyTrend() {
    const days = (calendarCache && calendarCache.days) || {};
    const keys = Object.keys(days).sort();
    const lastKey = keys.length ? keys[keys.length - 1] : new Date().toISOString().slice(0, 10);
    const trend = [];
    const anchor = new Date(`${lastKey}T00:00:00.000Z`);
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const dayData = days[key];
      trend.push({
        day: key,
        label: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        total: dayData ? dayData.total : 0,
      });
    }
    return trend;
  }

  // --- Chat -----------------------------------------------------------------

  function appendMessage(text, sender) {
    const container = el('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = `chat-msg ${sender}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  const TOPICS = [
    {
      test: /^(hi|hello|hey|yo)\b/i,
      handle: () => "Hi, I'm Tonii! Ask me what any of the metrics mean, why AI uses energy and water, how confident these numbers are, or ask about your own habits and how to improve them.",
    },
    {
      test: /\bco2\b|carbon|emission/i,
      handle: (i) => {
        const base = 'CO2 (carbon dioxide equivalent) estimates the greenhouse gas impact of generating a model\'s electricity - both the emissions from powering the data center and the grid mix behind it.';
        if (!i.hasData) return base;
        return `${base}\n\nYour last 30 days: about ${fmt(i.totals.co2Kg, 'kg CO2eq')} (EcoLogits range: ${fmt(i.totals.co2Min, 'kg')} – ${fmt(i.totals.co2Max, 'kg')}).`;
      },
    },
    {
      test: /\benergy\b|electric|kwh|power/i,
      handle: (i) => {
        const base = 'Electricity consumption covers the GPU/TPU compute used to run the model, plus the servers and data-center overhead (cooling, networking) around it for that single reply.';
        if (!i.hasData) return base;
        return `${base}\n\nYour last 30 days: about ${fmt(i.totals.energyKwh, 'kWh')} (range: ${fmt(i.totals.energyMin, 'kWh')} – ${fmt(i.totals.energyMax, 'kWh')}).`;
      },
    },
    {
      test: /\bwater\b/i,
      handle: (i) => {
        const base = 'Water consumption mostly comes from evaporative cooling towers that keep data-center servers from overheating, plus the water used upstream in generating electricity.';
        if (!i.hasData || i.totals.waterCount === 0) return `${base}\n\nNo EcoLogits water figure is available for your uploads yet - it's only reported for responses matched to a registered model.`;
        return `${base}\n\nYour last 30 days: about ${fmt(i.totals.waterL, 'L')} (range: ${fmt(i.totals.waterMin, 'L')} – ${fmt(i.totals.waterMax, 'L')}).`;
      },
    },
    {
      test: /mineral|metal|antimony|sb-eq/i,
      handle: (i) => {
        const base = 'The minerals figure (abiotic depletion potential, in kg antimony-equivalent) reflects the finite metals and elements consumed making the chips that ran your prompt - things like gallium, palladium, and silicon.';
        if (!i.hasData || i.totals.mineralsCount === 0) return `${base}\n\nNo EcoLogits minerals figure is available for your uploads yet - it's only reported for responses matched to a registered model, and no assistant currently publishes a public per-chip bill of materials.`;
        return `${base}\n\nYour last 30 days: about ${fmt(i.totals.mineralsKg, 'kg Sb-eq')} (range: ${fmt(i.totals.mineralsMin, 'kg')} – ${fmt(i.totals.mineralsMax, 'kg')}).`;
      },
    },
    {
      test: /why.*(energy|power|consum)|consum.*(energy|power)/i,
      handle: () => "AI models run on GPUs (or TPUs) - specialized chips doing billions of matrix calculations per reply. Every one of those calculations draws electricity, and the data center around the chips needs its own power for cooling and networking on top of that. Training a model first (a one-time cost spread across every future reply) is even more intensive - GPT-3's training run alone is estimated at ~1,287 MWh. So each reply you get carries a small slice of both the ongoing inference cost and that upfront training cost.",
    },
    {
      test: /uncertain|estimate|accura|confiden|precise|reliab/i,
      handle: (i) => {
        let msg = "These numbers are estimates, not measurements - here's why they carry real uncertainty:\n\n" +
          "• When possible, we call the EcoLogits API, which models impact from published research on each model's size and hardware. It returns a min-max range, not a single number - we show you the midpoint.\n" +
          "• When EcoLogits can't match a model (or is unreachable), we fall back to a simpler formula calibrated from independent research (Epoch AI, Google's own published figures) - flagged separately in your data.\n" +
          "• Claude's export doesn't include which model answered each message, so we assume a default model for every Claude reply.\n" +
          "• Gemini's export (Google Takeout) doesn't include reply text at all, so both the model and reply length are estimated.";
        if (i.hasData && i.fallbackRatio !== null) {
          msg += `\n\nFor your data specifically: ${(i.fallbackRatio * 100).toFixed(0)}% of replies this period used the fallback formula rather than live EcoLogits data.`;
        }
        return msg;
      },
    },
    {
      test: /habit|inefficient|pattern|my usage|how am i doing/i,
      handle: (i) => {
        if (!i.hasData) return "I don't see any usage data yet for the last 30 days - upload an export from the Dashboard first and I'll be able to break down your habits.";
        const parts = [`Over the last 30 days you sent ${Math.round(i.totals.prompts)} prompts, averaging ${Math.round(i.avgInputTokens)} tokens in and ${Math.round(i.avgOutputTokens)} tokens out per reply.`];
        if (i.largestContributor) parts.push(`${ASSISTANT_LABELS[i.largestContributor]} is your largest contributor to estimated CO2.`);
        if (i.mostEfficient) parts.push(`${ASSISTANT_LABELS[i.mostEfficient]} is your most efficient assistant per prompt, by estimated CO2.`);
        parts.push('Ask me to "recommend improvements" for specific suggestions.');
        return parts.join(' ');
      },
    },
    {
      test: /recommend|improve|tip|reduce|lower|better|advice/i,
      handle: (i) => buildRecommendations(i).map((r, idx) => `${idx + 1}. ${r}`).join('\n\n'),
    },
    {
      test: /receipt|pdf|report|download/i,
      handle: () => "Click \"Generate Receipt (PDF)\" below and I'll put together a one-page summary of your footprint, habits, and recommendations.",
    },
  ];

  const FALLBACK_RESPONSE = "I can help with: what CO2/energy/water/minerals mean, why AI consumes energy, how reliable these estimates are, your own prompting habits, and recommendations to reduce your footprint. What would you like to know?";

  function respond(userText) {
    const insights = computeInsights();
    const topic = TOPICS.find((t) => t.test.test(userText));
    const reply = topic ? topic.handle(insights) : FALLBACK_RESPONSE;
    if (insights.loadFailed && /habit|my usage|how am i doing|receipt/i.test(userText)) {
      return `${reply}\n\n(I couldn't reach your saved data just now - try again in a moment.)`;
    }
    return reply;
  }

  function wireChat() {
    const suggestions = [
      'What does CO2 mean?',
      'Why does AI use energy?',
      'How accurate are these numbers?',
      'How are my habits?',
      'Recommend improvements',
    ];
    const suggestionsEl = el('chatSuggestions');
    suggestions.forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', () => sendMessage(text));
      suggestionsEl.appendChild(btn);
    });

    appendMessage("Hi, I'm Tonii! Ask me what any of the metrics mean, why AI uses energy and water, how confident these numbers are, or ask about your own habits and how to improve them.", 'bot');

    const form = el('chatForm');
    const input = el('chatInput');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendMessage(text);
    });
  }

  function sendMessage(text) {
    appendMessage(text, 'user');
    const reply = respond(text);
    setTimeout(() => appendMessage(reply, 'bot'), 200);
  }

  // --- PDF receipt ------------------------------------------------------------

  function loadImageAsDataUrl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  async function generateReceipt() {
    const btn = el('generateReceiptBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Generating…';

    try {
      await loadContext();
      const insights = computeInsights();
      const recommendations = buildRecommendations(insights);
      const trend = computeWeeklyTrend();
      const logoDataUrl = await loadImageAsDataUrl('images/frog-logo.png').catch(() => null);

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 48;
      let y = 0;

      const primary = [27, 122, 77];
      const primaryDark = [20, 92, 58];
      const muted = [99, 117, 106];
      const bg = [243, 249, 245];
      const border = [224, 236, 228];
      const ink = [20, 37, 28];

      // Header band
      doc.setFillColor(bg[0], bg[1], bg[2]);
      doc.rect(0, 0, pageWidth, 92, 'F');
      if (logoDataUrl) {
        doc.addImage(logoDataUrl, 'PNG', margin, 22, 48, 48);
      }
      doc.setTextColor(primaryDark[0], primaryDark[1], primaryDark[2]);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text('Project Draytonii', margin + (logoDataUrl ? 60 : 0), 46);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      doc.text('Sustainability Receipt', margin + (logoDataUrl ? 60 : 0), 64);
      doc.setTextColor(muted[0], muted[1], muted[2]);
      doc.setFontSize(9);
      doc.text(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} - last 30 days`, margin + (logoDataUrl ? 60 : 0), 78);

      y = 122;

      function sectionHeading(title) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12.5);
        doc.setTextColor(primaryDark[0], primaryDark[1], primaryDark[2]);
        doc.text(title, margin, y);
        y += 6;
        doc.setDrawColor(border[0], border[1], border[2]);
        doc.line(margin, y, pageWidth - margin, y);
        y += 16;
      }

      function bodyText(text, size) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(size || 10);
        doc.setTextColor(ink[0], ink[1], ink[2]);
        const lines = doc.splitTextToSize(text, pageWidth - margin * 2);
        doc.text(lines, margin, y);
        y += lines.length * (size ? size * 1.35 : 13.5) + 8;
      }

      // Summary
      sectionHeading('Summary');
      if (insights.hasData) {
        bodyText(
          `Over the last 30 days you sent ${Math.round(insights.totals.prompts)} prompt(s) across ${ORDER.filter((k) => insights.byAssistant[k].prompts > 0).map((k) => ASSISTANT_LABELS[k]).join(', ') || 'your assistants'}, with an estimated footprint of ${fmt(insights.totals.co2Kg, 'kg CO2eq')}, ${fmt(insights.totals.energyKwh, 'kWh')} of electricity, ${insights.totals.waterCount > 0 ? fmt(insights.totals.waterL, 'L of water') : 'no reported water figure'}, and ${insights.totals.mineralsCount > 0 ? fmt(insights.totals.mineralsKg, 'kg Sb-eq of minerals') : 'no reported minerals figure'}.`
        );
      } else {
        bodyText('No usage has been imported for the last 30 days. Upload an export from the Dashboard to generate a full receipt.');
      }

      // Estimated footprint
      sectionHeading('Estimated Footprint');
      bodyText(
        `CO2: ${fmt(insights.totals.co2Kg, 'kg CO2eq')}  (range ${fmt(insights.totals.co2Min, 'kg')} - ${fmt(insights.totals.co2Max, 'kg')})\n` +
        `Electricity: ${fmt(insights.totals.energyKwh, 'kWh')}  (range ${fmt(insights.totals.energyMin, 'kWh')} - ${fmt(insights.totals.energyMax, 'kWh')})\n` +
        `Water: ${insights.totals.waterCount > 0 ? `${fmt(insights.totals.waterL, 'L')}  (range ${fmt(insights.totals.waterMin, 'L')} - ${fmt(insights.totals.waterMax, 'L')})` : 'not available for this period'}\n` +
        `Minerals: ${insights.totals.mineralsCount > 0 ? `${fmt(insights.totals.mineralsKg, 'kg Sb-eq')}  (range ${fmt(insights.totals.mineralsMin, 'kg')} - ${fmt(insights.totals.mineralsMax, 'kg')})` : 'not available for this period'}`
      );

      // Largest contributor / most efficient
      sectionHeading('Largest Contributor');
      bodyText(
        insights.largestContributor
          ? `${ASSISTANT_LABELS[insights.largestContributor]} - ${fmt(insights.largestCo2, 'kg CO2eq')} (${insights.totals.co2Kg > 0 ? ((insights.largestCo2 / insights.totals.co2Kg) * 100).toFixed(0) : 0}% of your total).`
          : 'Not enough data yet.'
      );

      sectionHeading('Most Efficient Provider');
      bodyText(
        insights.mostEfficient
          ? `${ASSISTANT_LABELS[insights.mostEfficient]} - lowest estimated CO2 per prompt (${fmt(insights.mostEfficientRate, 'kg CO2eq/prompt')}).`
          : 'Not enough data yet.'
      );

      // Prompt habits
      sectionHeading('Prompt Habits');
      bodyText(
        insights.hasData
          ? `${Math.round(insights.totals.prompts)} prompts, averaging ${Math.round(insights.avgInputTokens)} tokens in / ${Math.round(insights.avgOutputTokens)} tokens out per exchange. ${insights.fallbackRatio !== null ? `${(insights.fallbackRatio * 100).toFixed(0)}% of estimates used a local fallback formula rather than live EcoLogits data.` : ''}`
          : 'No prompts recorded yet.'
      );

      // Recommendations
      sectionHeading('Recommendations');
      recommendations.forEach((r) => bodyText(`•  ${r}`));

      // Weekly trend
      if (y > 620) { doc.addPage(); y = 60; }
      sectionHeading('Weekly Trend (last 7 days, prompts)');
      const chartTop = y;
      const chartHeight = 90;
      const chartWidth = pageWidth - margin * 2;
      const barGap = 10;
      const barWidth = (chartWidth - barGap * (trend.length - 1)) / trend.length;
      const maxTotal = Math.max(1, ...trend.map((t) => t.total));
      doc.setDrawColor(border[0], border[1], border[2]);
      doc.rect(margin, chartTop, chartWidth, chartHeight);
      trend.forEach((t, idx) => {
        const barH = (t.total / maxTotal) * (chartHeight - 24);
        const x = margin + idx * (barWidth + barGap);
        const barY = chartTop + chartHeight - 18 - barH;
        doc.setFillColor(primary[0], primary[1], primary[2]);
        doc.rect(x, barY, barWidth, Math.max(barH, t.total > 0 ? 2 : 0), 'F');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(muted[0], muted[1], muted[2]);
        doc.text(t.label, x + barWidth / 2, chartTop + chartHeight - 6, { align: 'center' });
        doc.setTextColor(ink[0], ink[1], ink[2]);
        doc.text(String(t.total), x + barWidth / 2, barY - 4, { align: 'center' });
      });
      y = chartTop + chartHeight + 24;

      // Footer
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(muted[0], muted[1], muted[2]);
      doc.text('Figures are estimates for personal awareness, not precise measurements. See the Sources page for methodology and citations.', margin, 800);

      doc.save('draytonii-sustainability-receipt.pdf');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function wireReceipt() {
    el('generateReceiptBtn').addEventListener('click', () => {
      generateReceipt().catch((err) => {
        window.alert(`Couldn't generate the receipt: ${err.message}`);
      });
    });
  }

  loadContext().catch(() => {});
  wireChat();
  wireReceipt();
})();

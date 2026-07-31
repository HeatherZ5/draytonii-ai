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
      handle: (i) => {
        if (!i.hasData) return "Hi, I'm Tonii! I'm here to analyze your own AI usage and help you cut its footprint. Upload an export from the Dashboard first, then ask me things like \"how are my habits?\" or \"how can I reduce my footprint?\"";
        return `Hi, I'm Tonii! I've looked at your last 30 days: ${Math.round(i.totals.prompts)} prompts, about ${fmt(i.totals.co2Kg, 'kg CO2eq')}${i.largestContributor ? `, mostly from ${ASSISTANT_LABELS[i.largestContributor]}` : ''}. Ask me "how can I reduce my footprint?" or "how are my habits?" and I'll dig into your specific numbers.`;
      },
    },
    {
      test: /\bco2\b|carbon|emission/i,
      handle: (i) => {
        if (!i.hasData) return 'CO2 (carbon dioxide equivalent) estimates the greenhouse gas impact of generating a model\'s electricity. Upload your data and I\'ll show what that means for you specifically, plus how to bring it down.';
        const parts = [`Your last 30 days produced about ${fmt(i.totals.co2Kg, 'kg CO2eq')} (range: ${fmt(i.totals.co2Min, 'kg')} – ${fmt(i.totals.co2Max, 'kg')}).`];
        if (i.largestContributor) {
          const share = i.totals.co2Kg > 0 ? (i.largestCo2 / i.totals.co2Kg) * 100 : 0;
          parts.push(`${ASSISTANT_LABELS[i.largestContributor]} drives about ${share.toFixed(0)}% of it - that's your single biggest lever for cutting this number.`);
        }
        parts.push('Ask me "how can I reduce this?" for specific next steps.');
        return parts.join(' ');
      },
    },
    {
      test: /\benergy\b|electric|kwh|power/i,
      handle: (i) => {
        if (!i.hasData) return 'Electricity consumption covers the compute, cooling, and data-center overhead behind each reply. Upload your data and I\'ll break down your own usage and where to trim it.';
        const parts = [`Your last 30 days used about ${fmt(i.totals.energyKwh, 'kWh')} (range: ${fmt(i.totals.energyMin, 'kWh')} – ${fmt(i.totals.energyMax, 'kWh')}), averaging ${Math.round(i.avgOutputTokens)} output tokens per reply.`];
        if (i.avgOutputTokens > FALLBACK_TYPICAL_OUTPUT_TOKENS * 1.3) {
          parts.push('That reply length is well above typical - shorter, more targeted asks would meaningfully cut this.');
        }
        return parts.join(' ');
      },
    },
    {
      test: /\bwater\b/i,
      handle: (i) => {
        const base = 'Water consumption mostly comes from data-center cooling and the electricity generation behind your prompts.';
        if (!i.hasData || i.totals.waterCount === 0) return `${base} No EcoLogits water figure is available for your uploads yet - it's only reported for responses matched to a registered model, so I can't tell you your personal number right now.`;
        return `${base} Your last 30 days: about ${fmt(i.totals.waterL, 'L')} (range: ${fmt(i.totals.waterMin, 'L')} – ${fmt(i.totals.waterMax, 'L')}). Check the Comparison tab on the Dashboard's Water panel to see that in rain-drop terms.`;
      },
    },
    {
      test: /mineral|metal|antimony|sb-eq/i,
      handle: (i) => {
        const base = 'The minerals figure reflects the finite metals consumed making the chips that ran your prompts.';
        if (!i.hasData || i.totals.mineralsCount === 0) return `${base} No EcoLogits minerals figure is available for your uploads yet - it's only reported for responses matched to a registered model.`;
        return `${base} Your last 30 days: about ${fmt(i.totals.mineralsKg, 'kg Sb-eq')} (range: ${fmt(i.totals.mineralsMin, 'kg')} – ${fmt(i.totals.mineralsMax, 'kg')}). This one mostly tracks how many prompts you send, not how long your replies are - fewer, more deliberate prompts is the main lever here.`;
      },
    },
    {
      test: /why.*(energy|power|consum)|consum.*(energy|power)/i,
      handle: (i) => {
        const base = "AI models run on GPUs (or TPUs) - specialized chips doing billions of matrix calculations per reply. Every calculation draws electricity, and the data center around the chips needs its own power for cooling and networking on top of that.";
        if (!i.hasData) return base;
        return `${base} For you specifically: your ${Math.round(i.totals.prompts)} prompts this period averaged ${Math.round(i.avgOutputTokens)} output tokens each - longer replies mean more compute per prompt, so trimming reply length is the fastest way to lower your own draw.`;
      },
    },
    {
      test: /uncertain|estimate|accura|confiden|precise|reliab/i,
      handle: (i) => {
        let msg = "These numbers are estimates, not measurements. When possible we call the live EcoLogits API for a real model-based estimate; when that's unavailable we fall back to a simpler calibrated formula that can't report water (except Gemini) or minerals at all.";
        if (i.hasData && i.fallbackRatio !== null) {
          msg += ` For your data specifically: ${(i.fallbackRatio * 100).toFixed(0)}% of replies this period used the fallback formula rather than live EcoLogits data`;
          msg += i.fallbackRatio > 0.3 ? ' - treat your totals as directional, not precise.' : '.';
        }
        return msg;
      },
    },
    {
      test: /habit|inefficient|pattern|my usage|how am i doing/i,
      handle: (i) => {
        if (!i.hasData) return "I don't see any usage data yet for the last 30 days - upload an export from the Dashboard first and I'll break down your habits and how to improve them.";
        const parts = [`Over the last 30 days you sent ${Math.round(i.totals.prompts)} prompts, averaging ${Math.round(i.avgInputTokens)} tokens in and ${Math.round(i.avgOutputTokens)} tokens out per reply.`];
        if (i.largestContributor) parts.push(`${ASSISTANT_LABELS[i.largestContributor]} is your largest contributor to estimated CO2.`);
        if (i.mostEfficient) parts.push(`${ASSISTANT_LABELS[i.mostEfficient]} is your most efficient assistant per prompt, by estimated CO2.`);
        parts.push('Ask me "how can I reduce my footprint?" and I\'ll turn this into concrete steps for you.');
        return parts.join(' ');
      },
    },
    {
      test: /recommend|improve|tip|reduce|lower|better|advice|boost|sustainab/i,
      handle: (i) => {
        if (!i.hasData) return buildRecommendations(i)[0];
        const intro = `Based on your last 30 days (${Math.round(i.totals.prompts)} prompts, ${fmt(i.totals.co2Kg, 'kg CO2eq')}), here's how to boost your sustainability:`;
        return `${intro}\n\n${buildRecommendations(i).map((r, idx) => `${idx + 1}. ${r}`).join('\n\n')}`;
      },
    },
    {
      test: /receipt|pdf|report|download/i,
      handle: () => "Click \"Generate Receipt (PDF)\" below and I'll analyze your footprint, habits, and the specific steps you can take to improve your sustainability.",
    },
  ];

  const FALLBACK_RESPONSE = "I'm focused on analyzing your own AI usage - ask me things like \"how are my habits?\", \"what's my biggest impact area?\", or \"how can I boost my sustainability?\" and I'll dig into your actual numbers. I can also explain what CO2/energy/water/minerals mean or how reliable these estimates are, if that helps interpret your data.";

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
      'How are my habits?',
      'How can I boost my sustainability?',
      "What's my biggest impact area?",
      'How accurate are these numbers?',
      'What does CO2 mean?',
    ];
    const suggestionsEl = el('chatSuggestions');
    suggestions.forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', () => sendMessage(text));
      suggestionsEl.appendChild(btn);
    });

    const greetingInsights = computeInsights();
    const greetingText = greetingInsights.hasData
      ? `Hi, I'm Tonii! I've looked at your last 30 days: ${Math.round(greetingInsights.totals.prompts)} prompts, about ${fmt(greetingInsights.totals.co2Kg, 'kg CO2eq')}${greetingInsights.largestContributor ? `, mostly from ${ASSISTANT_LABELS[greetingInsights.largestContributor]}` : ''}. Ask me "how can I boost my sustainability?" and I'll dig into your specific numbers.`
      : "Hi, I'm Tonii! I'm here to analyze your own AI usage and help you boost its sustainability. Upload an export from the Dashboard first, then ask me things like \"how are my habits?\" or \"how can I reduce my footprint?\"";
    appendMessage(greetingText, 'bot');

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

  loadContext().catch(() => {}).then(wireChat);
  wireReceipt();
})();

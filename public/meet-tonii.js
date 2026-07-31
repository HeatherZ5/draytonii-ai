(function () {
  const ASSISTANT_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
  const ORDER = ['chatgpt', 'claude', 'gemini'];
  const FALLBACK_TYPICAL_OUTPUT_TOKENS = 500;

  let statsCache = null;
  let calendarCache = null;
  let contextLoadFailed = false;
  let promptBuilderStage = null; // null | 'awaiting_goal'

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
      return ['Please upload an export from the Dashboard first; recommendations are based on your own usage patterns.'];
    }

    if (insights.avgOutputTokens > FALLBACK_TYPICAL_OUTPUT_TOKENS * 1.3) {
      recs.push(
        `Your average reply is approximately ${Math.round(insights.avgOutputTokens)} tokens, well above the ~${FALLBACK_TYPICAL_OUTPUT_TOKENS}-token baseline these estimates are calibrated against. Asking more targeted questions, or requesting shorter answers when the full detail is unnecessary, reduces both the footprint and your wait time.`
      );
    }

    if (insights.largestContributor) {
      const label = ASSISTANT_LABELS[insights.largestContributor];
      const share = insights.totals.co2Kg > 0 ? (insights.largestCo2 / insights.totals.co2Kg) * 100 : 0;
      recs.push(
        `${label} accounts for approximately ${share.toFixed(0)}% of your estimated CO2 footprint this period. Reserving it for tasks that genuinely require its strengths, and using a lighter assistant for quick lookups, is your single largest lever.`
      );
    }

    if (insights.fallbackRatio !== null && insights.fallbackRatio > 0.3) {
      recs.push(
        `Approximately ${(insights.fallbackRatio * 100).toFixed(0)}% of your estimates came from a local fallback formula rather than live EcoLogits data, so please treat the totals as directional rather than precise; see the Sources page for further detail.`
      );
    }

    recs.push('Continue an existing conversation instead of starting a new one when the context still applies; re-explaining background requires the model to reprocess it from scratch.');
    recs.push('Batch related questions into a single prompt rather than sending several small requests in succession; each request carries fixed overhead regardless of size.');

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

  // --- Prompt Builder ---------------------------------------------------------
  //
  // A guided questionnaire, presented as a single message with embedded text
  // boxes rather than one question per chat turn, so the user is not left to
  // format ten separate answers independently. Runs entirely client-side and
  // never leaves the browser, consistent with the rest of this app's privacy
  // design.

  const PROMPT_BUILDER_QUESTIONS = [
    {
      label: 'What is the specific outcome or deliverable you want?',
      placeholder: 'e.g., a 300-word email, a working code snippet',
      clause: (v) => `The desired outcome is: ${v}.`,
    },
    {
      label: 'Who is the intended audience for this?',
      placeholder: 'e.g., executives, beginners, myself',
      clause: (v) => `The intended audience is ${v}.`,
    },
    {
      label: 'What tone or style should the response use?',
      placeholder: 'e.g., formal, casual, technical',
      clause: (v) => `Please use a ${v} tone.`,
    },
    {
      label: 'How long or detailed should the response be?',
      placeholder: 'e.g., a brief summary, an in-depth report',
      clause: (v) => `The desired length or level of detail is: ${v}.`,
    },
    {
      label: 'Are there examples, formats, or references it should follow?',
      placeholder: 'e.g., bullet points, a specific template',
      clause: (v) => `Please follow this format or example: ${v}.`,
    },
    {
      label: 'What key facts or context does the AI need to know?',
      placeholder: 'e.g., relevant background information',
      clause: (v) => `Important context: ${v}.`,
    },
    {
      label: 'Are there any constraints or restrictions to observe?',
      placeholder: 'e.g., no jargon, under 200 words',
      clause: (v) => `Please observe the following constraints: ${v}.`,
    },
    {
      label: 'What have you already tried, if anything?',
      placeholder: 'e.g., a previous draft, a prior approach',
      clause: (v) => `Previously attempted: ${v}.`,
    },
    {
      label: 'Is there a deadline or urgency level for this?',
      placeholder: 'e.g., needed today, no rush',
      clause: (v) => `Urgency: ${v}.`,
    },
    {
      label: 'What would make the response unsatisfactory to you?',
      placeholder: 'e.g., too generic, missing detail',
      clause: (v) => `Please avoid the following, as it would be unsatisfactory: ${v}.`,
    },
  ];

  function isBlankAnswer(value) {
    if (!value) return true;
    return /^(n\/a|na|unknown|none|skip|idk)$/i.test(value.trim());
  }

  function compilePrompt(goal, answers) {
    const parts = [`Please help with the following task: ${goal}.`];
    answers.forEach((value, idx) => {
      if (isBlankAnswer(value)) return;
      parts.push(PROMPT_BUILDER_QUESTIONS[idx].clause(value.trim()));
    });
    return parts.join(' ');
  }

  function appendPromptBuilderForm(goal) {
    const container = el('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg bot pb-msg';

    const heading = document.createElement('p');
    heading.className = 'pb-heading';
    heading.textContent = 'Prompt Builder Questionnaire';
    bubble.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'pb-intro';
    intro.textContent = `Thank you. Based on "${goal}", please answer the following questions to help assemble a well-rounded prompt. An answer of "N/A" or "Unknown" is entirely acceptable, and short phrases are welcome.`;
    bubble.appendChild(intro);

    const form = document.createElement('form');
    form.className = 'pb-form';
    const inputs = [];

    PROMPT_BUILDER_QUESTIONS.forEach((q, idx) => {
      const row = document.createElement('div');
      row.className = 'pb-row';

      const label = document.createElement('label');
      label.className = 'pb-label';
      label.setAttribute('for', `pbInput${idx}`);
      label.textContent = `${idx + 1}. ${q.label}`;

      const input = document.createElement('input');
      input.type = 'text';
      input.id = `pbInput${idx}`;
      input.className = 'pb-input';
      input.placeholder = q.placeholder;
      input.autocomplete = 'off';

      row.appendChild(label);
      row.appendChild(input);
      form.appendChild(row);
      inputs.push(input);
    });

    inputs.forEach((input, idx) => {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (idx < inputs.length - 1) {
          inputs[idx + 1].focus();
        } else if (form.requestSubmit) {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      });
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary pb-submit';
    submitBtn.textContent = 'Build My Prompt';
    form.appendChild(submitBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const answers = inputs.map((input) => input.value);
      inputs.forEach((input) => { input.disabled = true; });
      submitBtn.disabled = true;
      submitBtn.textContent = 'Prompt Built';
      const compiled = compilePrompt(goal, answers);
      setTimeout(() => appendCompiledPrompt(compiled), 200);
    });

    bubble.appendChild(form);
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  function appendCompiledPrompt(promptText) {
    const container = el('chatMessages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg bot';

    const intro = document.createElement('p');
    intro.className = 'pb-result-intro';
    intro.textContent = 'Thank you. Here is a well-rounded prompt compiled from your answers:';
    bubble.appendChild(intro);

    const result = document.createElement('div');
    result.className = 'pb-result';
    result.textContent = promptText;
    bubble.appendChild(result);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-outline pb-copy';
    copyBtn.textContent = 'Copy Prompt';
    copyBtn.addEventListener('click', () => {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(promptText).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy Prompt'; }, 1500);
      }).catch(() => {});
    });
    bubble.appendChild(copyBtn);

    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  const TOPICS = [
    {
      test: /prompt builder|build.*prompt|craft.*prompt|write.*prompt/i,
      handle: () => {
        promptBuilderStage = 'awaiting_goal';
        return 'Certainly. Prompt Builder helps assemble a well-rounded AI prompt through a short questionnaire. First, please give me a brief description of what you are trying to do (for example, "write a marketing email" or "debug a Python script").';
      },
    },
    {
      test: /^(hi|hello|hey|yo)\b/i,
      handle: (i) => {
        if (!i.hasData) return 'Good day. I am Tonii, your personal sustainability analyst. Please upload an export from the Dashboard, then ask me a question such as "How Are My Habits?" or "How Can I Reduce My Footprint?"';
        return `Good day. I am Tonii. I have reviewed your last 30 days: ${Math.round(i.totals.prompts)} prompts, approximately ${fmt(i.totals.co2Kg, 'kg CO2eq')}${i.largestContributor ? `, primarily from ${ASSISTANT_LABELS[i.largestContributor]}` : ''}. Ask me "How Can I Reduce My Footprint?" or "How Are My Habits?" and I will examine your specific figures.`;
      },
    },
    {
      test: /\bco2\b|carbon|emission/i,
      handle: (i) => {
        if (!i.hasData) return 'CO2 (carbon dioxide equivalent) estimates the greenhouse gas impact of generating a model\'s electricity. Please upload your data, and I will show what that means for you specifically, along with how to reduce it.';
        const parts = [`Your last 30 days produced approximately ${fmt(i.totals.co2Kg, 'kg CO2eq')} (range: ${fmt(i.totals.co2Min, 'kg')} – ${fmt(i.totals.co2Max, 'kg')}).`];
        if (i.largestContributor) {
          const share = i.totals.co2Kg > 0 ? (i.largestCo2 / i.totals.co2Kg) * 100 : 0;
          parts.push(`${ASSISTANT_LABELS[i.largestContributor]} accounts for approximately ${share.toFixed(0)}% of this - your single largest lever for reducing this figure.`);
        }
        parts.push('Ask me "How Can I Reduce This?" for specific next steps.');
        return parts.join(' ');
      },
    },
    {
      test: /\benergy\b|electric|kwh|power/i,
      handle: (i) => {
        if (!i.hasData) return 'Electricity consumption covers the compute, cooling, and data-center overhead behind each reply. Please upload your data, and I will provide a breakdown of your usage and where to reduce it.';
        const parts = [`Your last 30 days used approximately ${fmt(i.totals.energyKwh, 'kWh')} (range: ${fmt(i.totals.energyMin, 'kWh')} – ${fmt(i.totals.energyMax, 'kWh')}), averaging ${Math.round(i.avgOutputTokens)} output tokens per reply.`];
        if (i.avgOutputTokens > FALLBACK_TYPICAL_OUTPUT_TOKENS * 1.3) {
          parts.push('This reply length is well above typical; shorter, more targeted requests would meaningfully reduce this figure.');
        }
        return parts.join(' ');
      },
    },
    {
      test: /\bwater\b/i,
      handle: (i) => {
        const base = 'Water consumption primarily comes from data-center cooling and the electricity generation behind your prompts.';
        if (!i.hasData || i.totals.waterCount === 0) return `${base} No EcoLogits water figure is available for your uploads at this time; it is only reported for responses matched to a registered model, so I am unable to provide your personal figure right now.`;
        return `${base} Your last 30 days: approximately ${fmt(i.totals.waterL, 'L')} (range: ${fmt(i.totals.waterMin, 'L')} – ${fmt(i.totals.waterMax, 'L')}). Please see the Comparison tab on the Dashboard's Water panel for this figure expressed in rain-drop terms.`;
      },
    },
    {
      test: /mineral|metal|antimony|sb-eq/i,
      handle: (i) => {
        const base = 'The minerals figure reflects the finite metals consumed in manufacturing the chips that processed your prompts.';
        if (!i.hasData || i.totals.mineralsCount === 0) return `${base} No EcoLogits minerals figure is available for your uploads at this time; it is only reported for responses matched to a registered model.`;
        return `${base} Your last 30 days: approximately ${fmt(i.totals.mineralsKg, 'kg Sb-eq')} (range: ${fmt(i.totals.mineralsMin, 'kg')} – ${fmt(i.totals.mineralsMax, 'kg')}). This figure primarily tracks how many prompts you send, not how long your replies are; fewer, more deliberate prompts is the primary lever here.`;
      },
    },
    {
      test: /why.*(energy|power|consum)|consum.*(energy|power)/i,
      handle: (i) => {
        const base = 'AI models run on GPUs (or TPUs), specialized chips performing billions of matrix calculations per reply. Each calculation draws electricity, and the data center surrounding the chips requires its own power for cooling and networking as well.';
        if (!i.hasData) return base;
        return `${base} For you specifically: your ${Math.round(i.totals.prompts)} prompts this period averaged ${Math.round(i.avgOutputTokens)} output tokens each. Longer replies require more compute per prompt, so reducing reply length is the fastest way to lower your own consumption.`;
      },
    },
    {
      test: /uncertain|estimate|accura|confiden|precise|reliab/i,
      handle: (i) => {
        let msg = 'These figures are estimates, not measurements. When possible, we call the live EcoLogits API for a model-based estimate; when that is unavailable, we rely on a simpler calibrated formula that cannot report water (except for Gemini) or minerals at all.';
        if (i.hasData && i.fallbackRatio !== null) {
          msg += ` For your data specifically: ${(i.fallbackRatio * 100).toFixed(0)}% of replies this period used the fallback formula rather than live EcoLogits data`;
          msg += i.fallbackRatio > 0.3 ? '; please treat your totals as directional rather than precise.' : '.';
        }
        return msg;
      },
    },
    {
      test: /habit|inefficient|pattern|my usage|how am i doing/i,
      handle: (i) => {
        if (!i.hasData) return 'No usage data is available for the last 30 days at this time. Please upload an export from the Dashboard, and I will provide a breakdown of your habits and how to improve them.';
        const parts = [`Over the last 30 days you sent ${Math.round(i.totals.prompts)} prompts, averaging ${Math.round(i.avgInputTokens)} tokens in and ${Math.round(i.avgOutputTokens)} tokens out per reply.`];
        if (i.largestContributor) parts.push(`${ASSISTANT_LABELS[i.largestContributor]} is your largest contributor to estimated CO2.`);
        if (i.mostEfficient) parts.push(`${ASSISTANT_LABELS[i.mostEfficient]} is your most efficient assistant per prompt, by estimated CO2.`);
        parts.push('Ask me "How Can I Reduce My Footprint?" and I will provide concrete steps for you.');
        return parts.join(' ');
      },
    },
    {
      test: /recommend|improve|tip|reduce|lower|better|advice|boost|sustainab/i,
      handle: (i) => {
        if (!i.hasData) return buildRecommendations(i)[0];
        const intro = `Based on your last 30 days (${Math.round(i.totals.prompts)} prompts, ${fmt(i.totals.co2Kg, 'kg CO2eq')}), here is how to boost your sustainability:`;
        return `${intro}\n\n${buildRecommendations(i).map((r, idx) => `${idx + 1}. ${r}`).join('\n\n')}`;
      },
    },
    {
      test: /receipt|pdf|report|download/i,
      handle: () => 'Please select "Generate Receipt (PDF)" below, and I will analyze your footprint, habits, and the specific steps you may take to improve your sustainability.',
    },
  ];

  const FALLBACK_RESPONSE = 'I am focused on analyzing your own AI usage. Ask me a question such as "How Are My Habits?", "What Is My Biggest Impact Area?", or "How Can I Boost My Sustainability?" and I will examine your actual figures. I can also explain what CO2, energy, water, and minerals mean, how reliable these estimates are, or help you assemble a well-rounded prompt via "Prompt Builder".';

  function respond(userText) {
    const insights = computeInsights();
    const topic = TOPICS.find((t) => t.test.test(userText));
    const reply = topic ? topic.handle(insights) : FALLBACK_RESPONSE;
    if (insights.loadFailed && /habit|my usage|how am i doing|receipt/i.test(userText)) {
      return `${reply}\n\n(I was unable to reach your saved data just now; please try again in a moment.)`;
    }
    return reply;
  }

  function wireChat() {
    const suggestions = [
      'How Are My Habits?',
      'How Can I Boost My Sustainability?',
      'What Is My Biggest Impact Area?',
      'How Accurate Are These Numbers?',
      'Prompt Builder',
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
      ? `Good day. I am Tonii. I have reviewed your last 30 days: ${Math.round(greetingInsights.totals.prompts)} prompts, approximately ${fmt(greetingInsights.totals.co2Kg, 'kg CO2eq')}${greetingInsights.largestContributor ? `, primarily from ${ASSISTANT_LABELS[greetingInsights.largestContributor]}` : ''}. Ask me "How Can I Boost My Sustainability?" and I will examine your specific figures.`
      : 'Good day. I am Tonii, your personal sustainability analyst. Please upload an export from the Dashboard, then ask me a question such as "How Are My Habits?" or "How Can I Reduce My Footprint?"';
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

    if (promptBuilderStage === 'awaiting_goal') {
      const goal = text.trim();
      promptBuilderStage = null;
      setTimeout(() => appendPromptBuilderForm(goal), 200);
      return;
    }

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

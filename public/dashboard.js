(function () {
  const ASSISTANT_COLORS = {
    chatgpt: '#10a37f',
    claude: '#d97757',
    gemini: '#4285f4',
  };
  const ASSISTANT_LABELS = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
  };
  const ORDER = ['chatgpt', 'claude', 'gemini'];

  let currentPeriod = 'day';

  const el = (id) => document.getElementById(id);

  function formatInt(n) {
    return Math.round(n).toLocaleString();
  }

  function formatAdaptive(n, unit) {
    if (n === 0) return `0 ${unit}`;
    if (n < 0.001) return `${n.toExponential(2)} ${unit}`;
    if (n < 1) return `${n.toFixed(4)} ${unit}`;
    if (n < 100) return `${n.toFixed(3)} ${unit}`;
    return `${n.toFixed(1)} ${unit}`;
  }

  function buildConicGradient(entries) {
    // entries: [{key, value}] already filtered to value > 0
    const total = entries.reduce((sum, e) => sum + e.value, 0);
    if (total <= 0) {
      return `conic-gradient(var(--color-border) 0 100%)`;
    }
    let cumulative = 0;
    const stops = entries.map((e) => {
      const start = (cumulative / total) * 100;
      cumulative += e.value;
      const end = (cumulative / total) * 100;
      const color = ASSISTANT_COLORS[e.key] || '#9aa79e';
      return `${color} ${start}% ${end}%`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }

  function renderLegend(listEl, entries, formatter) {
    const total = entries.reduce((sum, e) => sum + e.value, 0);
    listEl.innerHTML = '';
    if (total <= 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No data yet for this period.';
      listEl.appendChild(li);
      return;
    }
    entries.forEach((e) => {
      if (e.value <= 0) return;
      const li = document.createElement('li');
      const pct = ((e.value / total) * 100).toFixed(1);
      li.innerHTML = `
        <span class="swatch" style="background:${ASSISTANT_COLORS[e.key] || '#9aa79e'}"></span>
        <span class="legend-label">${ASSISTANT_LABELS[e.key] || e.key}</span>
        <span class="legend-value">${formatter(e.value)} &middot; ${pct}%</span>
      `;
      listEl.appendChild(li);
    });
  }

  function render(stats) {
    el('statPrompts').textContent = formatInt(stats.totals.prompts);
    el('statTokensIn').textContent = formatInt(stats.totals.tokensIn);
    el('statTokensOut').textContent = formatInt(stats.totals.tokensOut);

    el('rangeLabel').textContent = stats.hasAnyData
      ? `Showing ${stats.rangeStart} to ${stats.rangeEnd}`
      : 'No data imported yet — upload an export below to get started.';

    const co2Entries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).co2Kg || 0 }));
    el('co2Pie').style.background = buildConicGradient(co2Entries);
    const co2Total = co2Entries.reduce((s, e) => s + e.value, 0);
    el('co2Center').innerHTML = `${formatAdaptive(co2Total, '')}<span>kg CO&#8322;</span>`;
    renderLegend(el('co2Legend'), co2Entries, (v) => formatAdaptive(v, 'kg'));

    const energyEntries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).energyKwh || 0 }));
    const energyTotal = energyEntries.reduce((s, e) => s + e.value, 0);
    el('energyTotal').textContent = formatAdaptive(energyTotal, '').trim();
    el('energyPie').style.background = buildConicGradient(energyEntries);
    el('energyCenter').innerHTML = `${formatAdaptive(energyTotal, '')}<span>kWh</span>`;
    renderLegend(el('energyLegend'), energyEntries, (v) => formatAdaptive(v, 'kWh'));

    const breakdownList = el('energyBreakdownList');
    breakdownList.innerHTML = '';
    ORDER.forEach((key) => {
      const bucket = stats.byAssistant[key] || {};
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="swatch" style="background:${ASSISTANT_COLORS[key]}"></span>
        <span class="name">${ASSISTANT_LABELS[key]}</span>
        <span class="value">${formatAdaptive(bucket.energyKwh || 0, 'kWh')}</span>
      `;
      breakdownList.appendChild(li);
    });

    let ecologitsCount = 0;
    let fallbackCount = 0;
    ORDER.forEach((key) => {
      const bucket = stats.byAssistant[key] || {};
      ecologitsCount += bucket.ecologitsCount || 0;
      fallbackCount += bucket.fallbackCount || 0;
    });
    const noteParts = [];
    if (ecologitsCount || fallbackCount) {
      noteParts.push(
        `${ecologitsCount} response${ecologitsCount === 1 ? '' : 's'} estimated via the live EcoLogits API` +
        (fallbackCount ? `, ${fallbackCount} via a local fallback formula (EcoLogits unreachable or model unrecognized).` : '.')
      );
    }
    noteParts.push('Token counts are approximations (exports don\'t include real token counts). Prompts, tokens, CO2, and energy are all estimates for personal awareness, not precise measurements.');
    el('dataNote').textContent = noteParts.join(' ');
  }

  async function loadStats(period) {
    const res = await fetch(`/api/stats?period=${period}`);
    const stats = await res.json();
    render(stats);
  }

  function wirePeriodToggle() {
    const buttons = document.querySelectorAll('#periodToggle button');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        currentPeriod = btn.dataset.period;
        loadStats(currentPeriod);
      });
    });
  }

  function wireEnergyTabs() {
    const buttons = document.querySelectorAll('#energyTabs button');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const showChart = btn.dataset.tab === 'chart';
        el('energyNumbers').classList.toggle('hidden', showChart);
        el('energyChart').classList.toggle('hidden', !showChart);
      });
    });
  }

  function wireUpload() {
    const fileInput = el('fileInput');
    const uploadBtn = el('uploadBtn');
    const status = el('uploadStatus');
    const labelText = el('fileLabelText');

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      labelText.textContent = file ? file.name : 'Choose .zip file';
      uploadBtn.disabled = !file;
      status.textContent = '';
      status.className = 'upload-status';
    });

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file) return;

      uploadBtn.disabled = true;
      status.className = 'upload-status';
      status.textContent = 'Uploading and analyzing your export…';

      const formData = new FormData();
      formData.append('exportZip', file);

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed.');

        status.className = 'upload-status ok';
        status.textContent =
          `Imported ${data.turnsIngested} exchange(s) from ${data.conversationsFound} ` +
          `${data.platform} conversation(s).` +
          (data.modelAssumed ? ' (Model name was assumed — the export doesn\'t include it.)' : '') +
          (data.responseTextUnavailable ? ' (Gemini response lengths were estimated — Takeout doesn\'t export reply text.)' : '');

        await loadStats(currentPeriod);
      } catch (err) {
        status.className = 'upload-status err';
        status.textContent = err.message;
      } finally {
        uploadBtn.disabled = false;
      }
    });
  }

  wirePeriodToggle();
  wireEnergyTabs();
  wireUpload();
  loadStats(currentPeriod);
})();

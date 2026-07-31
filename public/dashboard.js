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
  let selectedPlatform = null;

  let calendarData = null;
  let calendarMonths = [];
  let calendarCenterIndex = 0;

  const el = (id) => document.getElementById(id);

  function formatInt(n) {
    return Math.round(n).toLocaleString();
  }

  function formatAdaptive(n, unit) {
    if (n === 0) return `0 ${unit}`.trim();
    if (n < 0.001) return `${n.toExponential(2)} ${unit}`.trim();
    if (n < 1) return `${n.toFixed(4)} ${unit}`.trim();
    if (n < 100) return `${n.toFixed(3)} ${unit}`.trim();
    return `${n.toFixed(1)} ${unit}`.trim();
  }

  function buildConicGradient(entries) {
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

  function renderMetricPanel(prefix, { total, min, max, unit, entries, unavailableNote }) {
    el(`${prefix}Total`).textContent = formatAdaptive(total, '');
    const rangeEl = el(`${prefix}Range`);
    if (unavailableNote) {
      rangeEl.textContent = unavailableNote;
    } else if (total > 0 || max > 0) {
      rangeEl.textContent = `EcoLogits range: ${formatAdaptive(min, unit)} – ${formatAdaptive(max, unit)}`;
    } else {
      rangeEl.textContent = 'No data yet for this period.';
    }

    const list = el(`${prefix}BreakdownList`);
    list.innerHTML = '';
    entries.forEach(({ key, value }) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="swatch" style="background:${ASSISTANT_COLORS[key]}"></span>
        <span class="name">${ASSISTANT_LABELS[key]}</span>
        <span class="value">${formatAdaptive(value, unit)}</span>
      `;
      list.appendChild(li);
    });

    el(`${prefix}Pie`).style.background = buildConicGradient(entries);
    el(`${prefix}Center`).innerHTML = `${formatAdaptive(total, '')}<span>${unit}</span>`;
    renderLegend(el(`${prefix}Legend`), entries, (v) => formatAdaptive(v, unit));
  }

  function render(stats) {
    el('statPrompts').textContent = formatInt(stats.totals.prompts);
    el('statTokensIn').textContent = formatInt(stats.totals.tokensIn);
    el('statTokensOut').textContent = formatInt(stats.totals.tokensOut);

    el('rangeLabel').textContent = stats.hasAnyData
      ? `Showing ${stats.rangeStart} to ${stats.rangeEnd}`
      : 'No data imported yet — upload an export below to get started.';

    const co2Entries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).co2Kg || 0 }));
    renderMetricPanel('co2', {
      total: stats.totals.co2Kg,
      min: stats.totals.co2Min,
      max: stats.totals.co2Max,
      unit: 'kg',
      entries: co2Entries,
    });

    const energyEntries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).energyKwh || 0 }));
    renderMetricPanel('energy', {
      total: stats.totals.energyKwh,
      min: stats.totals.energyMin,
      max: stats.totals.energyMax,
      unit: 'kWh',
      entries: energyEntries,
    });

    const waterEntries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).waterL || 0 }));
    renderMetricPanel('water', {
      total: stats.totals.waterL,
      min: stats.totals.waterMin,
      max: stats.totals.waterMax,
      unit: 'L',
      entries: waterEntries,
      unavailableNote: stats.totals.waterCount === 0
        ? 'No EcoLogits water data available for this period (only responses matched to a registered EcoLogits model report a figure).'
        : null,
    });

    const mineralsEntries = ORDER.map((key) => ({ key, value: (stats.byAssistant[key] || {}).mineralsKg || 0 }));
    renderMetricPanel('minerals', {
      total: stats.totals.mineralsKg,
      min: stats.totals.mineralsMin,
      max: stats.totals.mineralsMax,
      unit: 'kg Sb-eq',
      entries: mineralsEntries,
      unavailableNote: stats.totals.mineralsCount === 0
        ? 'No EcoLogits minerals data available for this period (only responses matched to a registered EcoLogits model report a figure).'
        : null,
    });

    renderEquivalents(stats);

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
    noteParts.push('Token counts are approximations (exports don\'t include real token counts). All figures on this page are estimates for personal awareness, not precise measurements.');
    el('dataNote').textContent = noteParts.join(' ');
  }

  async function loadStats(period) {
    const res = await fetch(`/api/stats?period=${period}`);
    const stats = await res.json();
    render(stats);
  }

  // --- Calendar carousel --------------------------------------------------

  function monthKeyFromDate(date) {
    return date.toISOString().slice(0, 7);
  }

  function addMonths(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return monthKeyFromDate(d);
  }

  function buildCalendarMonths() {
    const dayKeys = Object.keys(calendarData.days);
    let minMonth;
    let maxMonth;
    if (dayKeys.length === 0) {
      const nowKey = monthKeyFromDate(new Date());
      minMonth = nowKey;
      maxMonth = nowKey;
    } else {
      const sorted = dayKeys.slice().sort();
      minMonth = sorted[0].slice(0, 7);
      maxMonth = sorted[sorted.length - 1].slice(0, 7);
    }
    const start = addMonths(minMonth, -1);
    const end = addMonths(maxMonth, 1);

    calendarMonths = [];
    let cur = start;
    let guard = 0;
    while (cur <= end && guard < 600) {
      calendarMonths.push(cur);
      cur = addMonths(cur, 1);
      guard += 1;
    }
    calendarCenterIndex = calendarMonths.indexOf(maxMonth);
    if (calendarCenterIndex < 0) calendarCenterIndex = calendarMonths.length - 1;
  }

  function computeGlobalMax(scope) {
    let max = 0;
    for (const day of Object.values(calendarData.days)) {
      const v = scope === 'total' ? day.total : (day[scope] || 0);
      if (v > max) max = v;
    }
    return max;
  }

  function tierFor(value, max) {
    if (!value || value <= 0) return 0;
    if (max <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
  }

  function renderMonthPanel(container, ym, { isCenter, scope, globalMax }) {
    container.innerHTML = '';
    if (!ym) return;
    const [y, m] = ym.split('-').map(Number);

    const title = document.createElement('div');
    title.className = 'month-title';
    title.textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    container.appendChild(title);

    if (isCenter) {
      const weekdays = document.createElement('div');
      weekdays.className = 'month-weekdays';
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => {
        const span = document.createElement('span');
        span.textContent = d;
        weekdays.appendChild(span);
      });
      container.appendChild(weekdays);
    }

    const grid = document.createElement('div');
    grid.className = 'month-grid';

    const firstDay = new Date(Date.UTC(y, m - 1, 1));
    const startWeekday = firstDay.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    for (let i = 0; i < startWeekday; i += 1) {
      const blank = document.createElement('div');
      blank.className = 'day-cell empty';
      grid.appendChild(blank);
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dayKey = `${ym}-${String(d).padStart(2, '0')}`;
      const dayData = calendarData.days[dayKey];
      const value = dayData ? (scope === 'total' ? dayData.total : (dayData[scope] || 0)) : 0;
      const tier = tierFor(value, globalMax);
      const cell = document.createElement('div');
      cell.className = `day-cell tier-${tier}`;
      if (isCenter) cell.title = `${dayKey}: ${value} prompt${value === 1 ? '' : 's'}`;
      grid.appendChild(cell);
    }
    container.appendChild(grid);
  }

  function renderCalendarLegend(globalMax) {
    const legend = el('calendarLegend');
    legend.innerHTML = '';
    const tiers = [{ cls: 'tier-0', label: 'No data' }];
    if (globalMax > 0) {
      const q1 = Math.max(1, Math.round(globalMax * 0.25));
      const q2 = Math.max(q1 + 1, Math.round(globalMax * 0.5));
      const q3 = Math.max(q2 + 1, Math.round(globalMax * 0.75));
      tiers.push(
        { cls: 'tier-1', label: `1–${q1}` },
        { cls: 'tier-2', label: `${q1 + 1}–${q2}` },
        { cls: 'tier-3', label: `${q2 + 1}–${q3}` },
        { cls: 'tier-4', label: `${q3 + 1}+` }
      );
    }
    tiers.forEach((t) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="swatch day-cell ${t.cls}"></span><span>${t.label} prompt${t.cls === 'tier-0' ? '' : 's'}</span>`;
      legend.appendChild(li);
    });
  }

  function renderCalendar() {
    if (!calendarData) return;
    const scope = el('calendarScopeSelect').value;
    const globalMax = computeGlobalMax(scope);
    const leftYm = calendarMonths[calendarCenterIndex - 1] || null;
    const centerYm = calendarMonths[calendarCenterIndex] || null;
    const rightYm = calendarMonths[calendarCenterIndex + 1] || null;

    renderMonthPanel(el('calSideLeft'), leftYm, { isCenter: false, scope, globalMax });
    renderMonthPanel(el('calCenter'), centerYm, { isCenter: true, scope, globalMax });
    renderMonthPanel(el('calSideRight'), rightYm, { isCenter: false, scope, globalMax });
    renderCalendarLegend(globalMax);

    const centerEl = el('calCenter');
    centerEl.classList.remove('pulse');
    // eslint-disable-next-line no-unused-expressions
    void centerEl.offsetWidth;
    centerEl.classList.add('pulse');

    el('calPrevBtn').disabled = calendarCenterIndex <= 0;
    el('calNextBtn').disabled = calendarCenterIndex >= calendarMonths.length - 1;
  }

  async function loadCalendarData() {
    const res = await fetch('/api/calendar');
    calendarData = await res.json();
    buildCalendarMonths();
    renderCalendar();
  }

  function wireCalendar() {
    el('calPrevBtn').addEventListener('click', () => {
      if (calendarCenterIndex > 0) {
        calendarCenterIndex -= 1;
        renderCalendar();
      }
    });
    el('calNextBtn').addEventListener('click', () => {
      if (calendarCenterIndex < calendarMonths.length - 1) {
        calendarCenterIndex += 1;
        renderCalendar();
      }
    });
    el('calendarScopeSelect').addEventListener('change', () => renderCalendar());
  }

  // --- Period / tab toggles ------------------------------------------------

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

  const TAB_ID_SUFFIX = { numbers: 'Numbers', chart: 'Chart', comparison: 'Comparison' };

  function wireMetricTabToggles() {
    document.querySelectorAll('.tab-toggle[data-tabs]').forEach((toggle) => {
      const prefix = toggle.dataset.tabs;
      const buttons = toggle.querySelectorAll('button');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          buttons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const activeTab = btn.dataset.tab;
          Object.keys(TAB_ID_SUFFIX).forEach((tab) => {
            const panel = el(`${prefix}${TAB_ID_SUFFIX[tab]}`);
            if (panel) panel.classList.toggle('hidden', tab !== activeTab);
          });
        });
      });
    });
  }

  // --- Comparison equivalents -----------------------------------------------
  //
  // Conversion factors taken directly from EcoLogits' own official calculator
  // (github.com/mlco2/ecologits-calculator, src/config/constants.py) so the
  // comparisons trace back to the same published sources EcoLogits itself
  // uses, not numbers we made up.
  const EV_KWH_PER_KM = 0.17; // electric vehicle energy use
  const THERMIC_VEHICLE_G_PER_KM = 142; // gas vehicle GHG emissions
  const WATER_DROP_ML = 0.05; // volume of one rain drop
  const IPHONE_G_SBEQ = 2; // abiotic depletion (minerals) to build one iPhone

  function renderEquivalentCard(prefix, { emoji, value, unit, name, text }) {
    const container = el(`${prefix}Comparison`);
    if (!container) return;
    container.innerHTML = `
      <div class="equiv-card">
        <div class="equiv-emoji">${emoji}</div>
        <div class="equiv-value">${value}<span class="equiv-unit">${unit}</span></div>
        <div class="equiv-name">${name}</div>
        <div class="equiv-text muted">${text}</div>
      </div>
    `;
  }

  function renderEquivalentEmpty(prefix, message) {
    const container = el(`${prefix}Comparison`);
    if (!container) return;
    container.innerHTML = `<p class="muted equiv-empty">${message}</p>`;
  }

  function renderEquivalents(stats) {
    const co2Km = (stats.totals.co2Kg * 1000) / THERMIC_VEHICLE_G_PER_KM;
    renderEquivalentCard('co2', {
      emoji: '🏎️',
      value: formatAdaptive(co2Km, ''),
      unit: 'km',
      name: 'Driving a gas car',
      text: `Distance an average gas-powered vehicle would need to drive to emit the same CO2 (${THERMIC_VEHICLE_G_PER_KM} gCO2eq/km, per EcoLogits' calculator).`,
    });

    const evKm = stats.totals.energyKwh / EV_KWH_PER_KM;
    renderEquivalentCard('energy', {
      emoji: '🔋',
      value: formatAdaptive(evKm, ''),
      unit: 'km',
      name: 'Driving an electric vehicle',
      text: `Distance an electric vehicle could travel on the same electricity (${EV_KWH_PER_KM} kWh/km, per EcoLogits' calculator).`,
    });

    if (stats.totals.waterCount > 0) {
      const drops = (stats.totals.waterL * 1000) / WATER_DROP_ML;
      renderEquivalentCard('water', {
        emoji: '💦',
        value: formatAdaptive(drops, ''),
        unit: 'rain drops',
        name: 'Rain drops',
        text: `Number of average rain drops (${WATER_DROP_ML} mL each, per EcoLogits' calculator) holding the same volume of water.`,
      });
    } else {
      renderEquivalentEmpty('water', 'No EcoLogits water data available for this period, so no comparison can be computed.');
    }

    if (stats.totals.mineralsCount > 0) {
      const iphoneEq = (stats.totals.mineralsKg * 1000) / IPHONE_G_SBEQ;
      renderEquivalentCard('minerals', {
        emoji: '📱',
        value: formatAdaptive(iphoneEq, ''),
        unit: 'iPhones',
        name: 'iPhone equivalents',
        text: `Share of the metals and minerals needed to build one iPhone (${IPHONE_G_SBEQ} gSb-eq each, per EcoLogits' calculator).`,
      });
    } else {
      renderEquivalentEmpty('minerals', 'No EcoLogits minerals data available for this period, so no comparison can be computed.');
    }
  }

  // --- Upload ---------------------------------------------------------------

  function wirePlatformSelect() {
    const select = el('platformSelect');
    const fileInput = el('fileInput');
    const uploadBtn = el('uploadBtn');
    select.addEventListener('change', () => {
      selectedPlatform = select.value || null;
      uploadBtn.disabled = !(selectedPlatform && fileInput.files[0]);
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
      uploadBtn.disabled = !(file && selectedPlatform);
      status.textContent = '';
      status.className = 'upload-status';
    });

    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file || !selectedPlatform) return;

      uploadBtn.disabled = true;
      status.className = 'upload-status';
      status.textContent = 'Reading and analyzing your export in your browser…';

      try {
        const arrayBuffer = await file.arrayBuffer();
        const { detection, parsed } = await window.DraytoniiParsers.parseExportZip(arrayBuffer, selectedPlatform);

        if (detection.platform === 'unknown') {
          const expectedFile = selectedPlatform === 'gemini' ? 'MyActivity.json' : 'conversations.json';
          const filesNote = Array.isArray(detection.names) && detection.names.length
            ? ` Files found in your zip: ${detection.names.slice(0, 30).join(', ')}${detection.names.length > 30 ? ', …' : ''}`
            : '';
          throw new Error(
            `You selected ${selectedPlatform}, but this zip doesn't contain the expected ` +
            `${expectedFile} file for that platform. Double-check the toggle matches the ` +
            `export you are uploading.${filesNote}`
          );
        }

        if (!parsed || !parsed.turns || parsed.turns.length === 0) {
          throw new Error(`Recognized this as a ${detection.platform} export, but found no readable conversation turns inside it.`);
        }

        // Sent in bounded-size batches, not one giant request - Vercel's
        // serverless functions hard-cap the request body around 4.5MB at
        // the platform edge (well below express's own 15mb json limit),
        // and a large multi-year export's turns array can exceed that,
        // which shows up in the browser as a bare "Failed to fetch" with
        // no server-side error at all. The first batch carries the full
        // set of (day, assistant) pairs touched by this whole upload so
        // the server resets them once; later batches accumulate onto
        // those already-reset buckets instead of re-clobbering them.
        const CHUNK_SIZE = 300;
        const dayKeyFor = (timestamp) => {
          const d = new Date(timestamp);
          return Number.isNaN(d.getTime())
            ? new Date().toISOString().slice(0, 10)
            : d.toISOString().slice(0, 10);
        };
        const resetKeys = Array.from(
          new Set(parsed.turns.map((t) => `${dayKeyFor(t.timestamp)}::${t.assistant}`))
        );

        let turnsIngestedTotal = 0;
        const totalBatches = Math.ceil(parsed.turns.length / CHUNK_SIZE);

        for (let i = 0; i < parsed.turns.length; i += CHUNK_SIZE) {
          const batch = parsed.turns.slice(i, i + CHUNK_SIZE);
          const batchNumber = i / CHUNK_SIZE + 1;
          status.textContent = totalBatches > 1
            ? `Uploading batch ${batchNumber} of ${totalBatches}…`
            : 'Uploading the analyzed results…';

          const res = await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              platform: detection.platform,
              turns: batch,
              conversationCount: parsed.conversationCount,
              modelAssumed: parsed.modelAssumed,
              responseTextUnavailable: parsed.responseTextUnavailable,
              resetKeys: batchNumber === 1 ? resetKeys : [],
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed.');

          turnsIngestedTotal += data.turnsIngested;
        }

        status.className = 'upload-status ok';
        status.textContent =
          `Imported ${turnsIngestedTotal} exchange(s) from ${parsed.conversationCount} ` +
          `${detection.platform} conversation(s).` +
          (parsed.modelAssumed ? ' (Model name was assumed — the export doesn\'t include it.)' : '') +
          (parsed.responseTextUnavailable ? ' (Gemini response lengths were estimated — Takeout doesn\'t export reply text.)' : '');

        await loadStats(currentPeriod);
        await loadCalendarData();
      } catch (err) {
        status.className = 'upload-status err';
        status.textContent = err.message;
      } finally {
        uploadBtn.disabled = false;
      }
    });
  }

  function wireClearData() {
    el('clearDataBtn').addEventListener('click', async () => {
      const confirmed = window.confirm('This permanently deletes all imported usage data (ChatGPT, Claude, and Gemini). Continue?');
      if (!confirmed) return;
      try {
        await fetch('/api/reset', { method: 'POST' });
        await loadStats(currentPeriod);
        await loadCalendarData();
      } catch (err) {
        window.alert(`Failed to clear data: ${err.message}`);
      }
    });
  }

  wirePeriodToggle();
  wireMetricTabToggles();
  wirePlatformSelect();
  wireUpload();
  wireCalendar();
  wireClearData();
  loadStats(currentPeriod);
  loadCalendarData();
})();

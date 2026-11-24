/*
 * assets/state.js — вкладка «Состояние системы».
 * Считает CFD, WIP/бэклог, поток «поступило − закрыто», Lead Time (P50/P85),
 * возраст незавершённых задач и рисует четыре графика через ECharts.
 *
 * Все настройки берутся из JSON-схемы:
 *   mapping.charts.cfd.stages              — этапы (ключи колонок-дат, последний — «закрыта»)
 *   mapping.workflow.doneStage | doneStage — финальный этап (иначе последний из cfd.stages)
 *   mapping.charts.leadTime.startDate      — старт Lead Time (иначе cfd.stages[0])
 *   mapping.charts.forecast.backlogStages  — этапы бэклога (иначе cfd.stages[0])
 *   mapping.id / mapping.title             — колонки таблицы старых задач
 *
 * Данные берутся из window.DemoApp (assets/app.js): фильтры поиска/сегментов применены,
 * фильтр текущего статуса — нет (он только про таблицу).
 * Без ECharts (нет интернета) KPI, выводы и таблица работают; вместо графиков — сообщение.
 *
 * Экспорт: window.StateView
 */
(function () {
    'use strict';

    const DAY_MS = 86400000;
    const MAX_CHART_DAYS = 260;   // защита от «весь период» на многолетних данных
    const RECENT_DAYS = 28;       // окно баланса потока и узкого места
    const LT_WINDOW_DAYS = 182;   // Lead Time по задачам, закрытым за 26 недель
    const WORKDAYS_IN_28 = 20;    // 4 полных недели (пн–пт)

    const byId = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtInt = (n) => Number(n).toLocaleString('ru-RU');
    const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(Math.abs(n));
    const pad2 = (n) => (n < 10 ? '0' : '') + n;

    /* ===================== даты ===================== */
    const dayToDate = (d) => new Date(d * DAY_MS);

    function fmtDay(d) {
        if (d === null || d === undefined) return '—';
        const t = dayToDate(d);
        return pad2(t.getUTCDate()) + '.' + pad2(t.getUTCMonth() + 1) + '.' + t.getUTCFullYear();
    }
    function fmtShort(d) {
        const t = dayToDate(d);
        return pad2(t.getUTCDate()) + '.' + pad2(t.getUTCMonth() + 1);
    }
    const weekday = (d) => dayToDate(d).getUTCDay(); // 0 = вс, 6 = сб
    const isWeekend = (d) => { const w = weekday(d); return w === 0 || w === 6; };

    function workdaysBetween(from, to) {
        if (from === null || from === undefined || to === null || to === undefined || to <= from) return 0;
        let n = 0;
        for (let d = from + 1; d <= to; d += 1) if (!isWeekend(d)) n += 1;
        return n;
    }
    function eachWorkday(from, to) {
        const out = [];
        for (let d = from; d <= to; d += 1) if (!isWeekend(d)) out.push(d);
        return out;
    }
    const weekStart = (d) => d - ((weekday(d) + 6) % 7);

    function thin(arr, max) {
        if (arr.length <= max) return arr.slice();
        const step = Math.ceil(arr.length / max);
        const out = [];
        for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
        if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
        return out;
    }

    function upperBound(arr, x) {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Nearest-rank перцентиль (как в методологии)
    function percentile(sorted, p) {
        if (!sorted.length) return null;
        const rank = Math.ceil(p * sorted.length);
        const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
        return sorted[idx];
    }

    /* ===================== конфигурация из схемы ===================== */
    function resolveConfig(schema) {
        const m = (schema && schema.mapping) || {};
        const charts = m.charts || {};
        const cfd = charts.cfd || null;
        const labelOf = (k) => (schema.byKey && schema.byKey[k] && schema.byKey[k].label) || k;

        const keys = [];
        if (cfd && Array.isArray(cfd.stages)) {
            cfd.stages.forEach((s) => {
                const k = typeof s === 'string' ? s : (s && s.key);
                if (k && schema.byKey && schema.byKey[k] && keys.indexOf(k) < 0) keys.push(k);
            });
        }
        if (keys.length < 2) return { ok: false };

        const lastKey = keys[keys.length - 1];
        const workflow = m.workflow || {};
        const rawDone = workflow.doneStage || m.doneStage || null;
        const doneKey = (rawDone && keys.indexOf(rawDone) >= 0) ? rawDone : lastKey;
        const doneIdx = keys.indexOf(doneKey);

        const lt = charts.leadTime || {};
        const leadKey = (lt.startDate && schema.byKey[lt.startDate]) ? lt.startDate : keys[0];

        const fc = charts.forecast || {};
        const notes = [];
        let backlog = Array.isArray(fc.backlogStages)
            ? fc.backlogStages.filter((k) => keys.indexOf(k) >= 0 && keys.indexOf(k) < doneIdx)
            : [];
        if (!backlog.length) {
            backlog = [keys[0]];
            notes.push(Array.isArray(fc.backlogStages)
                ? 'Все этапы forecast.backlogStages отсутствуют в cfd.stages — бэклог принят за «' + labelOf(keys[0]) + '».'
                : 'В схеме нет forecast.backlogStages — бэклог принят за «' + labelOf(keys[0]) + '».');
        }
        const backlogEnd = Math.max.apply(null, backlog.map((k) => keys.indexOf(k)));

        return {
            ok: true,
            keys: keys,
            labels: keys.map(labelOf),
            doneIdx: doneIdx,
            doneKey: doneKey,
            leadKey: leadKey,
            leadLabel: labelOf(leadKey),
            backlogEnd: backlogEnd,
            notes: notes
        };
    }

    /* ===================== расчёт модели ===================== */
    function computeModel(schema, records, asOf, weeks, cfg) {
        const keys = cfg.keys;
        const n = keys.length;
        const doneIdx = cfg.doneIdx;

        // Для каждого этапа — отсортированный массив дат входа (<= среза)
        const dates = [];
        for (let s = 0; s < n; s += 1) {
            const key = keys[s];
            const arr = [];
            for (let i = 0; i < records.length; i += 1) {
                const v = records[i][key];
                if (typeof v === 'number' && isFinite(v) && v <= asOf) arr.push(v);
            }
            arr.sort((a, b) => a - b);
            dates.push(arr);
        }
        const upto = (s, d) => upperBound(dates[s], d);
        const band = (s, d) => upto(s, d) - (s + 1 < n ? upto(s + 1, d) : 0);

        // ---- период графиков ----
        let startDay;
        if (weeks === 'all') {
            let min = Infinity;
            for (let s = 0; s < n; s += 1) if (dates[s].length && dates[s][0] < min) min = dates[s][0];
            startDay = isFinite(min) ? min : asOf - 182;
        } else {
            startDay = asOf - weeks * 7 + 1;
        }
        if (startDay > asOf) startDay = asOf;
        let days = eachWorkday(startDay, asOf);
        if (!days.length) days = [asOf];
        days = thin(days, MAX_CHART_DAYS);

        // ---- CFD ----
        const cfd = [];
        for (let s = 0; s < n; s += 1) cfd.push(new Array(days.length));
        for (let i = 0; i < days.length; i += 1) {
            const d = days[i];
            for (let s = 0; s < n; s += 1) cfd[s][i] = band(s, d);
        }

        // ---- поток по неделям ----
        const weekDays = [];
        for (let w = weekStart(startDay); w <= asOf; w += 7) weekDays.push(w);
        const arrivalsW = weekDays.map((w) => upto(0, w + 6) - upto(0, w - 1));
        const closuresW = weekDays.map((w) => upto(doneIdx, w + 6) - upto(doneIdx, w - 1));

        // ---- KPI ----
        const then = asOf - RECENT_DAYS;
        const totalNow = upto(0, asOf);
        const doneNow = upto(doneIdx, asOf);
        const inSystem = totalNow - doneNow;
        const backlogNow = totalNow - upto(cfg.backlogEnd + 1, asOf);
        const wipNow = upto(cfg.backlogEnd + 1, asOf) - doneNow;

        const inSystemThen = upto(0, then) - upto(doneIdx, then);
        const wipThen = upto(cfg.backlogEnd + 1, then) - upto(doneIdx, then);
        const backlogThen = upto(0, then) - upto(cfg.backlogEnd + 1, then);

        // ---- узкое место: максимальный рост очереди за 28 дней среди этапов «в работе» ----
        let bottleneck = null;
        for (let s = cfg.backlogEnd + 1; s < doneIdx; s += 1) {
            const nowV = band(s, asOf);
            const thenV = band(s, then);
            const growth = nowV - thenV;
            if (!bottleneck || growth > bottleneck.growth || (growth === bottleneck.growth && nowV > bottleneck.now)) {
                bottleneck = { idx: s, key: keys[s], label: cfg.labels[s], now: nowV, then: thenV, growth: growth };
            }
        }
        if (bottleneck && bottleneck.growth <= 0) {
            let best = null;
            for (let s = cfg.backlogEnd + 1; s < doneIdx; s += 1) {
                const v = band(s, asOf);
                if (!best || v > best.now) {
                    best = { idx: s, key: keys[s], label: cfg.labels[s], now: v, then: band(s, then), growth: v - band(s, then) };
                }
            }
            bottleneck = best;
        }

        // ---- баланс потока за 28 дней ----
        const winStart = asOf - RECENT_DAYS;
        const arrivals28 = upto(0, asOf) - upto(0, winStart);
        const closed28 = upto(doneIdx, asOf) - upto(doneIdx, winStart);
        const balance = arrivals28 - closed28;

        // ---- Lead Time ----
        const ltStart = asOf - LT_WINDOW_DAYS;
        const ltAll = [];
        records.forEach((r) => {
            const a = r[cfg.leadKey];
            const b = r[cfg.doneKey];
            if (typeof a === 'number' && typeof b === 'number' && b > ltStart) {
                ltAll.push(workdaysBetween(a, b));
            }
        });
        ltAll.sort((a, b) => a - b);
        const ltOk = ltAll.length >= 5;
        const p50 = ltOk ? percentile(ltAll, 0.5) : null;
        const p85 = ltOk ? percentile(ltAll, 0.85) : null;

        // ---- незавершённые задачи и их возраст ----
        const idKey = schema.mapping.id;
        const titleKey = schema.mapping.title;
        const open = [];
        records.forEach((r) => {
            if (typeof r[cfg.doneKey] === 'number') return;
            const a = r[cfg.leadKey];
            if (typeof a !== 'number') return;
            let stageIdx = -1;
            for (let s = n - 1; s >= 0; s -= 1) {
                const v = r[keys[s]];
                if (typeof v === 'number' && v <= asOf) { stageIdx = s; break; }
            }
            const stageDate = stageIdx >= 0 ? r[keys[stageIdx]] : null;
            open.push({
                id: r[idKey],
                title: r[titleKey],
                stageLabel: stageIdx >= 0 ? cfg.labels[stageIdx] : '—',
                age: workdaysBetween(a, asOf),
                onStage: typeof stageDate === 'number' ? workdaysBetween(stageDate, asOf) : null
            });
        });

        const aging = open.map((t) => t.age);
        const maxAge = aging.length ? Math.max.apply(null, aging) : 0;
        const STEPS = [1, 2, 5, 10, 15, 20, 30, 50, 100];
        let bin = STEPS[0];
        for (let i = 0; i < STEPS.length; i += 1) {
            bin = STEPS[i];
            if (maxAge / bin <= 12) break;
        }
        const binCount = Math.max(1, Math.ceil((maxAge + 1) / bin));
        const bins = new Array(binCount).fill(0);
        aging.forEach((a) => { bins[Math.min(binCount - 1, Math.floor(a / bin))] += 1; });
        const binLabels = bins.map((_, i) => (i === binCount - 1)
            ? (i * bin) + '+'
            : (i * bin) + '–' + (i * bin + bin - 1));

        const agingCount = p85 === null ? 0 : open.filter((t) => t.age > p85).length;

        // ---- закон Литтла ----
        const throughput = closed28 / WORKDAYS_IN_28;
        const little = throughput > 0 ? Math.round((wipNow / throughput) * 10) / 10 : null;

        // ---- WIP по этапам: сейчас и 4 недели назад ----
        const wipRows = [];
        for (let s = 0; s < doneIdx; s += 1) {
            wipRows.push({ label: cfg.labels[s], now: band(s, asOf), then: band(s, then) });
        }
        wipRows.sort((a, b) => b.now - a.now);

        const oldest = open.slice().sort((a, b) => b.age - a.age).slice(0, 8);

        return {
            cfg: cfg,
            asOf: asOf,
            days: days,
            cfd: cfd,
            cfdLabels: days.map(fmtShort),
            weekLabels: weekDays.map(fmtShort),
            arrivalsW: arrivalsW,
            closuresW: closuresW,
            inSystem: inSystem, inSystemThen: inSystemThen,
            backlog: backlogNow, backlogThen: backlogThen,
            wip: wipNow, wipThen: wipThen,
            bottleneck: bottleneck,
            arrivals28: arrivals28, closed28: closed28, balance: balance,
            p50: p50, p85: p85, ltOk: ltOk, ltCount: ltAll.length,
            agingCount: agingCount,
            little: little,
            binLabels: binLabels, bins: bins, bin: bin,
            wipRows: wipRows,
            oldest: oldest,
            openCount: open.length
        };
    }

    /* ===================== ECharts ===================== */
    const instances = Object.create(null);
    const MUTED = '#5B6878';
    const TEXT = '#1A2430';
    const GRID_LINE = '#EDF0F3';
    const RAMP = ['#CBD8E1', '#A9C3D5', '#86ADC6', '#6297B7', '#3E7F9F', '#2E6B86', '#1F4E5F'];

    function stageColor(i, n) {
        if (i >= n - 1) return '#2F7D4F';
        const t = n > 2 ? i / (n - 2) : 0;
        return RAMP[Math.min(RAMP.length - 1, Math.round(t * (RAMP.length - 1)))];
    }

    const axisLine = { lineStyle: { color: '#AEB8C3' } };
    const axisLabel = { color: MUTED, fontSize: 11 };
    const splitLine = { lineStyle: { color: GRID_LINE } };

    function mountChart(id, option) {
        const el = byId(id);
        if (!el) return;
        const EC = window.echarts;
        if (!EC) {
            instances[id] = null;
            el.innerHTML = '<p class="chart-fallback">График недоступен: библиотека ECharts не загрузилась с cdn.jsdelivr.net. ' +
                'Включите интернет и обновите страницу — KPI, выводы и таблица работают и без неё.</p>';
            return;
        }
        if (el.querySelector('.chart-fallback')) el.innerHTML = '';
        let inst = EC.getInstanceByDom(el);
        if (!inst) inst = EC.init(el, null, { renderer: 'canvas' });
        inst.setOption(option, true);
        inst.resize();
        instances[id] = inst;
    }

    function drawCfd(m) {
        const n = m.cfg.keys.length;
        const series = [];
        for (let s = n - 1; s >= 0; s -= 1) {
            series.push({
                name: m.cfg.labels[s],
                type: 'line',
                stack: 'cfd',
                smooth: false,
                symbol: 'none',
                lineStyle: { width: 0.8, color: stageColor(s, n) },
                areaStyle: { color: stageColor(s, n), opacity: 0.95 },
                emphasis: { focus: 'series' },
                data: m.cfd[s]
            });
        }
        mountChart('chart-cfd', {
            color: m.cfg.labels.map((_, i) => stageColor(i, n)),
            animationDuration: 250,
            grid: { left: 8, right: 20, top: 56, bottom: 8, containLabel: true },
            legend: { top: 0, left: 0, type: 'scroll', textStyle: { color: TEXT, fontSize: 12 } },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'line', lineStyle: { color: '#AEB8C3' } },
                confine: true,
                formatter: function (params) {
                    if (!params || !params.length) return '';
                    const i = params[0].dataIndex;
                    const rows = params.slice().reverse().map((p) =>
                        '<div style="display:flex;justify-content:space-between;gap:18px">' +
                        '<span>' + p.marker + esc(p.seriesName) + '</span>' +
                        '<b style="font-variant-numeric:tabular-nums">' + fmtInt(p.value || 0) + '</b></div>').join('');
                    const total = params.reduce((acc, p) => acc + (p.value || 0), 0);
                    return '<div style="font-weight:600;margin-bottom:6px">' + esc(m.cfdLabels[i]) + '</div>' + rows +
                        '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #DDE2E8;display:flex;justify-content:space-between;gap:18px">' +
                        '<span>Всего задач</span><b>' + fmtInt(total) + '</b></div>';
                }
            },
            xAxis: { type: 'category', boundaryGap: false, data: m.cfdLabels, axisLabel: axisLabel, axisLine: axisLine },
            yAxis: Object.assign({
                type: 'value',
                name: 'Задач',
                nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
                minInterval: 1
            }, { axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } }),
            series: series
        });
    }

    function drawWip(m) {
        mountChart('chart-wip', {
            animationDuration: 250,
            grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
            legend: { top: 0, left: 0, textStyle: { color: TEXT, fontSize: 12 } },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                confine: true,
                valueFormatter: (v) => fmtInt(v) + ' задач'
            },
            xAxis: {
                type: 'category',
                data: m.wipRows.map((r) => r.label),
                axisLabel: { color: MUTED, fontSize: 11, interval: 0, width: 90, overflow: 'truncate' },
                axisLine: axisLine
            },
            yAxis: Object.assign({
                type: 'value',
                name: 'Задач',
                nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
                minInterval: 1
            }, { axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } }),
            series: [
                { name: 'Сейчас', type: 'bar', barMaxWidth: 28, itemStyle: { color: '#2E86AB' }, data: m.wipRows.map((r) => r.now) },
                { name: '4 недели назад', type: 'bar', barMaxWidth: 28, itemStyle: { color: '#C3D2DD' }, data: m.wipRows.map((r) => r.then) }
            ]
        });
    }

    function drawFlow(m) {
        mountChart('chart-flow', {
            animationDuration: 250,
            grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
            legend: { top: 0, left: 0, textStyle: { color: TEXT, fontSize: 12 } },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                confine: true,
                valueFormatter: (v) => fmtInt(v) + ' задач'
            },
            xAxis: {
                type: 'category',
                data: m.weekLabels,
                axisLabel: { color: MUTED, fontSize: 11, interval: 'auto', hideOverlap: true },
                axisLine: axisLine
            },
            yAxis: Object.assign({
                type: 'value',
                name: 'Задач за неделю',
                nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
                minInterval: 1
            }, { axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } }),
            series: [
                { name: 'Поступило', type: 'bar', barMaxWidth: 22, itemStyle: { color: '#2E86AB' }, data: m.arrivalsW },
                { name: 'Закрыто', type: 'bar', barMaxWidth: 22, itemStyle: { color: '#2F7D4F' }, data: m.closuresW }
            ]
        });
    }

    function drawAging(m) {
        const series = {
            name: 'Незавершённые задачи',
            type: 'bar',
            barMaxWidth: 40,
            itemStyle: { color: '#D9822B' },
            data: m.bins
        };
        if (m.p85 !== null) {
            const idx = Math.min(m.binLabels.length - 1, Math.floor(m.p85 / m.bin));
            series.markLine = {
                symbol: 'none',
                silent: true,
                lineStyle: { color: '#B42318', type: 'dashed', width: 1.5 },
                label: {
                    formatter: 'P85 = ' + m.p85 + ' раб. дн.',
                    position: 'insideEndTop',
                    color: '#B42318',
                    fontSize: 11
                },
                data: [{ xAxis: m.binLabels[idx] }]
            };
        }
        mountChart('chart-aging', {
            animationDuration: 250,
            grid: { left: 8, right: 16, top: 32, bottom: 12, containLabel: true },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                confine: true,
                formatter: (params) => {
                    const p = params[0];
                    return 'Возраст ' + esc(p.name) + ' раб. дн.<br><b>' + fmtInt(p.value) + '</b> незавершённых задач';
                }
            },
            xAxis: {
                type: 'category',
                data: m.binLabels,
                name: 'Возраст, раб. дн.',
                nameLocation: 'middle',
                nameGap: 26,
                nameTextStyle: { color: MUTED, fontSize: 11 },
                axisLabel: { color: MUTED, fontSize: 11, interval: 0, rotate: m.binLabels.length > 10 ? 30 : 0 },
                axisLine: axisLine
            },
            yAxis: Object.assign({
                type: 'value',
                name: 'Задач',
                nameTextStyle: { color: MUTED, fontSize: 11, align: 'left' },
                minInterval: 1
            }, { axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } }),
            series: [series]
        });
    }

    /* ===================== отрисовка DOM ===================== */
    const view = { weeks: 26 };
    let lastModel = null;

    function deltaClass(d, upIsBad) {
        if (d === 0) return 'delta-neutral';
        return ((d > 0) === upIsBad) ? 'delta-bad' : 'delta-good';
    }

    function kpiTile(o) {
        return '<div class="kpi' + (o.hot ? ' kpi-hot' : '') + '" role="listitem">' +
            '<p class="kpi-label">' + esc(o.label) + '</p>' +
            '<p class="kpi-value' + (o.text ? ' is-text' : '') + '">' + esc(o.value) + '</p>' +
            (o.delta ? '<p class="kpi-delta ' + o.deltaClass + '">' + esc(o.delta) + '</p>' : '') +
            (o.note ? '<p class="kpi-note">' + esc(o.note) + '</p>' : '') +
            '</div>';
    }

    function renderKpis(m) {
        const tiles = [];
        tiles.push({
            label: 'В системе',
            value: fmtInt(m.inSystem),
            delta: fmtSigned(m.inSystem - m.inSystemThen) + ' за 28 дн.',
            deltaClass: deltaClass(m.inSystem - m.inSystemThen, true),
            note: 'Незакрытые задачи на ' + fmtDay(m.asOf)
        });
        tiles.push({
            label: 'В работе (WIP)',
            value: fmtInt(m.wip),
            delta: fmtSigned(m.wip - m.wipThen) + ' за 28 дн.',
            deltaClass: deltaClass(m.wip - m.wipThen, true),
            note: m.cfg.backlogEnd + 1 < m.cfg.doneIdx
                ? 'Этапы: ' + m.cfg.labels.slice(m.cfg.backlogEnd + 1, m.cfg.doneIdx).join(', ')
                : 'Нет этапов «в работе» между бэклогом и закрытием'
        });
        tiles.push({
            label: 'Бэклог',
            value: fmtInt(m.backlog),
            delta: fmtSigned(m.backlog - m.backlogThen) + ' за 28 дн.',
            deltaClass: deltaClass(m.backlog - m.backlogThen, true),
            note: 'Этапы: ' + m.cfg.labels.slice(0, m.cfg.backlogEnd + 1).join(', ')
        });
        if (m.bottleneck) {
            tiles.push({
                label: 'Узкое место',
                value: m.bottleneck.label,
                text: true,
                hot: true,
                delta: m.bottleneck.growth > 0 ? 'Очередь +' + fmtInt(m.bottleneck.growth) + ' за 28 дн.' : 'Очередь не растёт',
                deltaClass: m.bottleneck.growth > 0 ? 'delta-hot' : 'delta-neutral',
                note: 'Сейчас ' + fmtInt(m.bottleneck.now) + ' задач, 28 дн. назад — ' + fmtInt(m.bottleneck.then)
            });
        } else {
            tiles.push({ label: 'Узкое место', value: '—', text: true, note: 'Нет этапов «в работе» между бэклогом и закрытием' });
        }
        tiles.push({
            label: 'Баланс потока, 28 дн.',
            value: fmtSigned(m.balance),
            delta: m.balance > 0 ? 'Приём выше завершения' : m.balance < 0 ? 'Завершение выше приёма' : 'Поток сбалансирован',
            deltaClass: m.balance > 0 ? 'delta-bad' : m.balance < 0 ? 'delta-good' : 'delta-neutral',
            note: 'Поступило ' + fmtInt(m.arrivals28) + ' · закрыто ' + fmtInt(m.closed28)
        });
        if (m.ltOk) {
            tiles.push({
                label: 'P85 Lead Time',
                value: fmtInt(m.p85) + ' раб. дн.',
                delta: 'Старше порога: ' + fmtInt(m.agingCount) + ' задач',
                deltaClass: m.agingCount > 0 ? 'delta-hot' : 'delta-neutral',
                note: 'P50 = ' + fmtInt(m.p50) + ' · по ' + fmtInt(m.ltCount) + ' закрытым задачам'
            });
        } else {
            tiles.push({
                label: 'P85 Lead Time',
                value: '—',
                delta: 'Недостаточно данных',
                deltaClass: 'delta-neutral',
                note: 'Нужно ≥ 5 задач, закрытых за 26 недель'
            });
        }
        byId('state-kpis').innerHTML = tiles.map(kpiTile).join('');
    }

    function renderInsights(m) {
        const growth = m.bottleneck ? m.bottleneck.growth : 0;

        const what = 'На ' + fmtDay(m.asOf) + ' в системе ' + fmtInt(m.inSystem) + ' незакрытых задач: ' +
            fmtInt(m.backlog) + ' в бэклоге, ' + fmtInt(m.wip) + ' в работе. За последние 28 дней поступило ' +
            fmtInt(m.arrivals28) + ' и закрыто ' + fmtInt(m.closed28) + ' — ' +
            (m.balance > 0 ? 'приём опережает завершение на ' + fmtInt(m.balance) + ' задач'
                : m.balance < 0 ? 'закрыто на ' + fmtInt(-m.balance) + ' задач больше, чем поступило'
                    : 'поток сбалансирован') + '. ' +
            (m.bottleneck && growth > 0
                ? 'Быстрее всего растёт очередь на этапе «' + m.bottleneck.label + '»: ' +
                fmtInt(m.bottleneck.then) + ' → ' + fmtInt(m.bottleneck.now) + ' задач за 28 дней.'
                : m.bottleneck
                    ? 'Очереди на этапах «в работе» не растут; крупнейшая — «' + m.bottleneck.label +
                    '» (' + fmtInt(m.bottleneck.now) + ' задач).'
                    : '');

        const soWhat = (m.bottleneck && growth > 0
                ? 'Узкое место ограничивает пропускную способность: пока очередь на «' + m.bottleneck.label + '» растёт, время прохождения задач увеличивается. '
                : 'Поток по этапам стабилен, но общий объём работы в системе определяет время ожидания. ') +
            (m.ltOk
                ? 'P85 Lead Time = ' + fmtInt(m.p85) + ' раб. дн.; ' + fmtInt(m.agingCount) +
                ' незавершённых задач уже старше этого порога. '
                : 'Lead Time пока не рассчитан: закрытых задач за 26 недель меньше пяти. ') +
            (m.little !== null
                ? 'По закону Литтла среднее время прохождения ≈ WIP ÷ пропускная способность ≈ ' +
                String(m.little).replace('.', ',') + ' раб. дн. Это оценка для стабильной системы, а не прогноз.'
                : 'Пропускная способность за 28 дней нулевая — закон Литтла неприменим.');

        const parts = [];
        if (m.bottleneck && growth > 0) {
            parts.push('Ограничьте приём работы и добавьте мощность на этап «' + m.bottleneck.label + '»: без этого очередь и Lead Time продолжат расти.');
        } else if (m.balance > 0) {
            parts.push('Приём выше завершения — введите WIP-лимиты по этапам и проверьте, где задачи ждут дольше всего.');
        }
        if (m.agingCount > 0) {
            parts.push('Разберите ' + fmtInt(m.agingCount) + ' задач старше P85 (' + fmtInt(m.p85) +
                ' раб. дн.): часть из них, вероятно, пора закрыть или переоценить.');
        }
        if (!parts.length) {
            parts.push('Поток сбалансирован — зафиксируйте текущие WIP-лимиты и следите за этапом «' +
                (m.bottleneck ? m.bottleneck.label : '—') + '».');
        }

        byId('ins-what').textContent = what;
        byId('ins-so').textContent = soWhat;
        byId('ins-now').textContent = parts.join(' ');
    }

    function renderContext(m) {
        const parts = [
            'Срез ' + fmtDay(m.asOf),
            'в системе ' + fmtInt(m.inSystem) + ' задач',
            'период графиков — ' + (view.weeks === 'all' ? 'весь' : view.weeks + ' нед.')
        ];
        const filt = window.DemoApp && window.DemoApp.getFilterSummary ? window.DemoApp.getFilterSummary() : '';
        if (filt) parts.push(filt);
        if (m.cfg.notes.length) parts.push(m.cfg.notes.join(' '));
        byId('state-context').textContent = parts.join(' · ');
    }

    function renderSubs(m) {
        const periodText = view.weeks === 'all' ? 'весь период' : view.weeks + ' нед.';
        const filt = window.DemoApp && window.DemoApp.getFilterSummary ? window.DemoApp.getFilterSummary() : '';
        byId('cfd-sub').textContent = 'Период: ' + periodText + ' · этапов: ' + m.cfg.keys.length +
            ' · срез ' + fmtDay(m.asOf) + (filt ? ' · ' + filt : '');
        byId('wip-sub').textContent = 'Сравнение с 28 днями назад; этапы отсортированы по текущему числу задач.';
        byId('flow-sub').textContent = 'Недельные суммы; баланс за 28 дн.: ' +
            (m.balance > 0 ? '+' : '') + fmtInt(m.balance) + ' задач.';
        byId('aging-sub').textContent = 'Возраст от старта (' + m.cfg.leadLabel + ') до среза, в рабочих днях.' +
            (m.p85 !== null ? ' Порог P85 = ' + fmtInt(m.p85) + ' раб. дн.' : '');
    }

    function renderOldest(m) {
        const tbody = byId('aging-tbody');
        const note = byId('aging-note');
        if (!tbody) return;
        if (!m.oldest.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">Нет незавершённых задач по фильтрам.</td></tr>';
            if (note) note.textContent = '';
            return;
        }
        tbody.innerHTML = m.oldest.map((t) => {
            const late = m.p85 !== null && t.age > m.p85;
            const title = t.title === null || t.title === undefined || t.title === '' ? '—' : String(t.title);
            return '<tr' + (late ? ' class="is-late"' : '') + '>' +
                '<th scope="row"><code>' + esc(t.id) + '</code></th>' +
                '<td>' + esc(title) + '</td>' +
                '<td>' + esc(t.stageLabel) + '</td>' +
                '<td class="num">' + fmtInt(t.age) + '</td>' +
                '<td class="num">' + (t.onStage === null ? '—' : fmtInt(t.onStage)) + '</td>' +
                '</tr>';
        }).join('');
        if (note) {
            note.textContent = 'Показаны до 8 самых старых задач; всего незавершённых по фильтрам — ' +
                fmtInt(m.openCount) + '.' +
                (m.p85 !== null ? ' Красным — задачи старше P85 = ' + fmtInt(m.p85) + ' раб. дн.' : '');
        }
    }

    function drawAll(m) {
        drawCfd(m);
        drawWip(m);
        drawFlow(m);
        drawAging(m);
    }

    function setEmpty(html) {
        const e = byId('state-empty');
        const b = byId('state-body');
        const t = byId('state-empty-text');
        const btn = byId('state-empty-btn');
        if (e) e.hidden = false;
        if (b) b.hidden = true;
        if (t) t.innerHTML = html;
        if (btn) btn.hidden = false;
    }

    function setBody() {
        const e = byId('state-empty');
        const b = byId('state-body');
        if (e) e.hidden = true;
        if (b) b.hidden = false;
    }

    function doRender() {
        const D = window.DemoApp;
        if (!D || typeof D.getSchema !== 'function') {
            setEmpty('<b>Не удалось запустить вкладку.</b> Модуль assets/app.js не загружен или упал при запуске.');
            return;
        }
        const schema = D.getSchema();
        if (!schema) {
            setEmpty('<b>Данные не загружены.</b> Выберите JSON-схему и загрузите CSV на вкладке «1. Данные задач».');
            return;
        }
        const cfg = resolveConfig(schema);
        if (!cfg.ok) {
            setEmpty('<b>В схеме нет описания этапов для CFD.</b> Добавьте в <code>mapping.charts.cfd</code> массив <code>stages</code> с ключами колонок-дат — вкладка пересчитается автоматически.');
            return;
        }
        const records = D.getRecords();
        const asOf = D.getAsOfDay();
        if (!records.length || asOf === null || asOf === undefined) {
            setEmpty('<b>Схема «' + esc(schema.name) + '» принята — загрузите CSV.</b> Таблица и графики появятся после загрузки данных.');
            return;
        }

        const model = computeModel(schema, records, asOf, view.weeks, cfg);
        lastModel = model;

        // Порядок важен: сначала показываем контейнер, чтобы контейнеры графиков имели размер,
        // затем — считаем и рисуем.
        setBody();
        renderContext(model);
        renderKpis(model);
        renderInsights(model);
        renderSubs(model);
        renderOldest(model);
        drawAll(model);
    }

    function render() {
        try {
            doRender();
        } catch (e) {
            if (window.console && console.error) console.error(e);
            if (window.__diag && window.__diag.errors) window.__diag.errors.push('state.js — ' + (e && e.message ? e.message : e));
            setEmpty('<b>Не удалось построить вкладку «Состояние системы».</b> ' + esc(e && e.message ? e.message : String(e)));
        }
    }

    /* ===================== экспорт CFD ===================== */
    function exportCfd() {
        const m = lastModel;
        if (!m) return;
        const D = window.DemoApp;
        if (!D || typeof D.download !== 'function') return;

        // Используем точку с запятой — удобно для RU-локали Excel.
        // Если в схеме задан другой разделитель, его можно передать сюда же.
        const delim = ';';
        const header = ['Дата'].concat(m.cfg.labels).map(csvCell).join(delim);
        const lines = m.days.map((d, i) => {
            const cells = m.cfg.keys.map((_, s) => String(m.cfd[s][i]));
            return [csvCell(fmtDay(d))].concat(cells).join(delim);
        });
        const csv = header + '\n' + lines.join('\n') + '\n';
        D.download('cfd_slice.csv', csv, 'text/csv;charset=utf-8', true);
    }

    function csvCell(s) {
        const str = String(s === null || s === undefined ? '' : s);
        if (/[";\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
        return str;
    }

    /* ===================== init ===================== */
    function bindPeriods() {
        const el = byId('state-periods');
        if (!el) return;
        el.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-period]');
            if (!b) return;
            const v = b.dataset.period;
            view.weeks = v === 'all' ? 'all' : Number(v);
            el.querySelectorAll('button').forEach((btn) => {
                btn.setAttribute('aria-pressed', btn === b ? 'true' : 'false');
            });
            if (window.DemoApp && window.DemoApp.getView() === 'state') render();
        });
    }

    function bindExport() {
        const btn = byId('cfd-csv');
        if (btn) btn.addEventListener('click', exportCfd);
    }

    function bindApp() {
        if (!window.DemoApp || typeof window.DemoApp.onChange !== 'function') return;
        window.DemoApp.onChange(() => {
            if (window.DemoApp.getView() === 'state') render();
        });
    }

    function bindResize() {
        let timer = null;
        window.addEventListener('resize', () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                Object.keys(instances).forEach((id) => {
                    const inst = instances[id];
                    if (inst && typeof inst.resize === 'function') inst.resize();
                });
            }, 150);
        });
    }

    function init() {
        bindPeriods();
        bindExport();
        bindApp();
        bindResize();
        // app.js на старте вызывает applyView до того, как StateView подписался на события —
        // поэтому, если страница открыта сразу на #state, дорисовываем один раз вручную.
        if (window.DemoApp && window.DemoApp.getView() === 'state') render();
    }

    window.StateView = Object.freeze({
        render: render,
        getWeeks: () => view.weeks
    });

    init();
})();
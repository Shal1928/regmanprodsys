/*
 * assets/app.js — демо: загрузка CSV по JSON-схеме, таблица (вкладка 1) и общий API для графиков.
 * Порядок: JSON-схема → CSV → таблица. Колонки, фильтры, этапы и подсветка статуса берутся из схемы.
 * Вкладки: #data — «Данные задач», #state — «Состояние системы» (assets/state.js).
 * Зависимости: assets/loader.js (window.DataLoader), assets/data.js (window.TaskData — демо-набор по seed).
 * Экспорт: window.DemoApp — схема, отфильтрованные строки, дата среза, подписка на изменения.
 */
(function () {
    'use strict';

    const L = window.DataLoader;
    const G = window.TaskData || null;
    const byId = (id) => document.getElementById(id);

    if (!L) {
        const t = byId('no-data-text');
        if (t) t.textContent = 'Не удалось загрузить assets/loader.js — проверьте структуру файлов.';
        return;
    }

    const els = {
        dataWarning: byId('data-warning'),
        schemaInput: byId('schema-input'), csvInput: byId('csv-input'),
        schemaBtn: byId('schema-btn'), csvBtn: byId('csv-btn'), csvHint: byId('csv-hint'),
        schemaStatus: byId('schema-status'), schemaMsgs: byId('schema-msgs'),
        csvStatus: byId('csv-status'), csvMsgs: byId('csv-msgs'), clearBtn: byId('clear-btn'),
        genForm: byId('gen-form'), genSeed: byId('gen-seed'), genSchema: byId('gen-schema'), genMsg: byId('gen-msg'),
        searchField: byId('search-field'), qLabel: byId('f-q-label'), q: byId('f-q'),
        segFilters: byId('seg-filters'), status: byId('f-status'), reset: byId('f-reset'),
        statusSection: byId('status-section'), chips: byId('status-chips'),
        meta: byId('table-meta'), exportBtn: byId('export-csv'),
        noData: byId('no-data'), noDataText: byId('no-data-text'), noDataBtn: byId('no-data-btn'),
        loading: byId('loading-state'),
        wrap: byId('table-wrap'), table: byId('tasks-table'), thead: byId('tasks-thead'), tbody: byId('tasks-tbody'),
        empty: byId('empty-state'), emptyReset: byId('empty-reset'),
        pager: byId('pager'), pageSize: byId('page-size'), prev: byId('page-prev'), next: byId('page-next'), pageInfo: byId('page-info')
    };

    const HINT_NO_SCHEMA = 'Шаг 1 — выберите JSON-схему с форматом CSV. Кнопка загрузки CSV разблокируется после её проверки.';
    const NO_ASOF = { day: null, text: '—' };
    const emptyFilters = () => ({ q: '', seg: {}, status: '' });
    const state = {
        schema: null, schemaFile: '',
        records: [], csvFile: '', asOf: NO_ASOF,
        loading: false, csvToken: 0,
        filters: emptyFilters(),
        sort: { key: '__line', dir: 'asc' },
        page: 1, pageSize: 50
    };

    /* ---------- подписчики (графики других вкладок) ---------- */
    const listeners = [];
    let dataVersion = 0;
    let lastSig = null;
    function notify(reason) {
        listeners.forEach((fn) => {
            try { fn(reason); } catch (e) { console.error(e); if (window.__diag) window.__diag.errors.push('state.js — ' + e.message); }
        });
    }
    // Уведомляем только при смене данных или фильтров, которые влияют на графики (статус и страницы — нет)
    function maybeNotify() {
        const sig = dataVersion + '|' + state.filters.q + '|' + JSON.stringify(state.filters.seg);
        if (sig !== lastSig) { lastSig = sig; notify('data'); }
    }

    /* ---------- helpers ---------- */
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtInt = (n) => n.toLocaleString('ru-RU');
    const setText = (selector, value) => document.querySelectorAll(selector).forEach((n) => { n.textContent = value; });

    function setStatus(el, label, text, kind) {
        el.innerHTML = '<b>' + esc(label) + ':</b> ' + esc(text);
        if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
    }

    function msgBlock(kind, title, items, open) {
        const cls = 'msg msg-' + kind;
        if (!items || !items.length) return '<div class="' + cls + '"><p>' + esc(title) + '</p></div>';
        return '<div class="' + cls + '"><details' + (open ? ' open' : '') + '><summary>' + esc(title) + '</summary><ul>' +
            items.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></details></div>';
    }

    function download(name, text, mime, bom) {
        const blob = new Blob([(bom ? '\uFEFF' : '') + text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ---------- schema helpers ---------- */
    const visibleCols = () => (state.schema ? state.schema.columns.filter((c) => c.visible) : []);
    const stageKeys = () => (state.schema ? state.schema.mapping.stages : []);
    const isNumeric = (col) => col.type === 'integer' || col.type === 'number';

    function defaultSort() {
        const st = stageKeys();
        return st.length ? { key: st[0], dir: 'desc' } : { key: '__line', dir: 'asc' };
    }

    function displayValue(col, v) {
        if (v === null || v === undefined) return '';
        if (col.type === 'date') return col.displayFormat.format(v);
        if (isNumeric(col)) return v.toLocaleString('ru-RU');
        return String(v);
    }

    // ID закрепляется слева, если это первая видимая колонка (как на этапе 1)
    function stickyKey() {
        const cols = visibleCols();
        return cols.length && cols[0].key === state.schema.mapping.id ? cols[0].key : null;
    }

    function colClass(col, sk) {
        const cls = [];
        if (col.key === sk) cls.push('col-id');
        if (col.key === state.schema.mapping.title) cls.push('col-title');
        if (col.type === 'date') cls.push('col-date');
        if (isNumeric(col)) cls.push('col-num');
        return cls.join(' ');
    }

    function describeFormat(sc) {
        const charts = Object.keys(sc.mapping.charts).filter((k) => L.CHART_SPECS[k]).map((k) => L.CHART_SPECS[k].label);
        return '«' + sc.name + '»: разделитель ' + L.describeDelimiter(sc.csv.delimiter) +
            ', кодировка ' + sc.csv.encoding +
            ', колонок ' + sc.columns.length +
            '. Графики: ' + (charts.length ? charts.join(', ') : 'не настроены') + '.';
    }

    // Дата среза = самая поздняя дата в колонках этапов (workflow + CFD)
    function computeAsOf(records) {
        const sc = state.schema;
        if (!sc || !records.length) return NO_ASOF;
        const keys = stageKeys().slice();
        const cfd = sc.mapping.charts && sc.mapping.charts.cfd;
        if (cfd && Array.isArray(cfd.stages)) cfd.stages.forEach((k) => { if (keys.indexOf(k) < 0 && sc.byKey[k]) keys.push(k); });
        if (!keys.length) return NO_ASOF;
        let max = -Infinity;
        records.forEach((r) => keys.forEach((k) => { const v = r[k]; if (v !== null && v !== undefined && v > max) max = v; }));
        return isFinite(max) ? { day: max, text: sc.byKey[keys[0]].displayFormat.format(max) } : NO_ASOF;
    }

    function filterSummary() {
        const sc = state.schema;
        if (!sc) return '';
        const parts = [];
        Object.keys(state.filters.seg).forEach((k) => { const v = state.filters.seg[k]; if (v && sc.byKey[k]) parts.push(sc.byKey[k].label + ': ' + v); });
        if (state.filters.q) parts.push('поиск «' + state.filters.q + '»');
        return parts.length ? 'фильтры — ' + parts.join(', ') : '';
    }

    /* ---------- filtering & sorting ---------- */
    function matchesBase(r) {
        const f = state.filters, sc = state.schema;
        for (const key in f.seg) {
            if (f.seg[key] !== '' && (r[key] === null || String(r[key]) !== f.seg[key])) return false;
        }
        if (f.q) {
            const q = f.q.toLowerCase();
            const hit = sc.mapping.search.some((k) => r[k] !== null && displayValue(sc.byKey[k], r[k]).toLowerCase().includes(q));
            if (!hit) return false;
        }
        return true;
    }

    function applyStatus(rows) {
        return state.filters.status === '' ? rows : rows.filter((r) => r.__stage === Number(state.filters.status));
    }

    function sortRows(rows) {
        const key = state.sort.key, dir = state.sort.dir === 'asc' ? 1 : -1;
        const col = state.schema.byKey[key];
        return rows.slice().sort((a, b) => {
            if (!col) return (a.__line - b.__line) * dir;
            const va = a[key], vb = b[key];
            const an = va === null || va === undefined, bn = vb === null || vb === undefined;
            if (an && bn) return a.__line - b.__line;
            if (an) return 1;   // пустые значения всегда внизу
            if (bn) return -1;
            let c;
            if (col.type === 'date' || isNumeric(col)) c = va - vb;
            else if (col.type === 'enum' && col.order) c = col.order.get(va) - col.order.get(vb);
            else c = String(va).localeCompare(String(vb), 'ru');
            if (c === 0) c = a.__line - b.__line;
            return c * dir;
        });
    }

    function currentRows() {
        if (!state.schema || !state.records.length) return [];
        return sortRows(applyStatus(state.records.filter(matchesBase)));
    }

    /* ---------- build: head & filters ---------- */
    function buildHead() {
        els.thead.innerHTML = '';
        if (!state.schema) { els.table.style.minWidth = ''; return; }
        const cols = visibleCols(), sk = stickyKey();
        const tr = document.createElement('tr');
        cols.forEach((col) => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.dataset.key = col.key;
            th.className = colClass(col, sk);
            if (col.description) th.title = col.description;
            th.innerHTML = '<button type="button" class="sort-btn" title="Сортировать по «' + esc(col.label) + '»">' +
                '<span>' + esc(col.label) + '</span><span class="sort-ind" aria-hidden="true">↕</span></button>';
            tr.appendChild(th);
        });
        els.thead.appendChild(tr);
        els.table.style.minWidth = Math.max(720, cols.length * 120) + 'px';
    }

    function uniqueValues(key) {
        const set = new Set();
        state.records.forEach((r) => { if (r[key] !== null) set.add(String(r[key])); });
        return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 200);
    }

    function buildFilters() {
        const sc = state.schema;
        els.segFilters.innerHTML = '';
        els.q.value = '';
        const statusField = els.status.closest('.field');

        if (!sc) {
            els.searchField.hidden = false;
            els.qLabel.textContent = 'Поиск по ID или теме';
            els.status.innerHTML = '<option value="">Все статусы</option>';
            statusField.hidden = false;
            return;
        }

        const sk = sc.mapping.search;
        els.searchField.hidden = !sk.length;
        els.qLabel.textContent = 'Поиск по ' + sk.map((k) => sc.byKey[k].label).join(' или ').toLowerCase().replace(/^id/, 'ID');

        sc.mapping.segments.forEach((key) => {
            const col = sc.byKey[key];
            const values = col.type === 'enum' ? col.values.slice() : uniqueValues(key);
            const id = 'f-seg-' + key;
            const wrap = document.createElement('div');
            wrap.className = 'field';
            wrap.innerHTML = '<label for="' + id + '">' + esc(col.label) + '</label>' +
                '<select id="' + id + '" data-seg="' + esc(key) + '"><option value="">Все</option>' +
                values.map((v) => '<option value="' + esc(v) + '">' + esc(col.valueLabels[v] ? v + ' — ' + col.valueLabels[v] : v) + '</option>').join('') +
                '</select>';
            els.segFilters.appendChild(wrap);
        });

        const st = stageKeys();
        statusField.hidden = !st.length;
        els.status.innerHTML = '<option value="">Все статусы</option>' +
            st.map((k, i) => '<option value="' + i + '">' + esc(sc.byKey[k].label) + '</option>').join('') +
            (st.length ? '<option value="-1">Без дат статусов</option>' : '');
    }

    function setControlsEnabled(on) {
        els.q.disabled = !on;
        els.status.disabled = !on;
        els.reset.disabled = !on;
        els.segFilters.querySelectorAll('select').forEach((s) => { s.disabled = !on; });
    }

    /* ---------- rendering ---------- */
    function updateSortIndicators() {
        els.thead.querySelectorAll('th').forEach((th) => {
            const active = th.dataset.key === state.sort.key;
            const asc = state.sort.dir === 'asc';
            th.setAttribute('aria-sort', active ? (asc ? 'ascending' : 'descending') : 'none');
            th.querySelector('.sort-ind').textContent = active ? (asc ? '▲' : '▼') : '↕';
        });
    }

    function renderCell(col, r, stageIdx, sk) {
        const sc = state.schema;
        const v = r[col.key];
        const cls = colClass(col, sk);
        if (col.key === sc.mapping.id) {
            return '<th scope="row" class="' + cls + '"><code>' + esc(v === null ? '' : v) + '</code></th>';
        }
        if (v === null || v === undefined) {
            return '<td class="' + cls + ' is-empty"><span aria-hidden="true">—</span><span class="sr-only">нет значения</span></td>';
        }
        const text = esc(displayValue(col, v));
        const si = stageIdx.has(col.key) ? stageIdx.get(col.key) : -1;
        if (si >= 0 && si === r.__stage) {
            const done = sc.mapping.doneIndex >= 0 && si >= sc.mapping.doneIndex;
            return '<td class="' + cls + ' is-current' + (done ? ' is-done' : '') + '" title="Текущий статус: ' + esc(col.label) + '">' +
                '<span class="dot" aria-hidden="true"></span>' + text + '<span class="sr-only"> (текущий статус)</span></td>';
        }
        if (col.display === 'tag') {
            const tone = col.tones[v] || 'neutral';
            const lbl = col.valueLabels[v];
            return '<td class="' + cls + '"><span class="cls tone-' + tone + '"' + (lbl ? ' title="' + esc(lbl) + '"' : '') + '>' + text + '</span>' +
                (lbl ? '<span class="sr-only"> — ' + esc(lbl) + '</span>' : '') + '</td>';
        }
        return '<td class="' + cls + '">' + text + '</td>';
    }

    function renderBody(rows) {
        const cols = visibleCols(), sk = stickyKey();
        const stageIdx = new Map(stageKeys().map((k, i) => [k, i]));
        els.tbody.innerHTML = rows.map((r) => '<tr>' + cols.map((c) => renderCell(c, r, stageIdx, sk)).join('') + '</tr>').join('');
    }

    function renderChips(base) {
        const st = stageKeys();
        if (!st.length) { els.chips.innerHTML = ''; return; }
        const counts = st.map(() => 0);
        let none = 0;
        base.forEach((r) => { if (r.__stage >= 0) counts[r.__stage] += 1; else none += 1; });
        const cur = state.filters.status;
        const chip = (value, label, n) =>
            '<button type="button" class="chip" data-status="' + value + '" aria-pressed="' + (cur === value) + '">' +
            '<span>' + esc(label) + '</span><b>' + fmtInt(n) + '</b></button>';
        els.chips.innerHTML = chip('', 'Все', base.length) +
            st.map((k, i) => chip(String(i), state.schema.byKey[k].label, counts[i])).join('') +
            (none ? chip('-1', 'Без дат', none) : '');
    }

    function updateChrome() {
        const sc = state.schema, n = state.records.length;
        els.schemaBtn.disabled = state.loading;
        els.csvBtn.disabled = !sc || state.loading;
        els.schemaBtn.classList.toggle('btn-primary', !sc);  // подсвечиваем следующий шаг
        els.csvBtn.classList.toggle('btn-primary', !!sc);
        els.clearBtn.hidden = !sc && !n;
        els.clearBtn.disabled = state.loading;
        els.csvHint.textContent = sc ? describeFormat(sc) : HINT_NO_SCHEMA;
        els.dataWarning.hidden = !sc || sc.synthetic !== false;
        els.noDataBtn.textContent = sc ? 'Загрузить данные из CSV' : 'Выбрать JSON-файл';
        els.noDataBtn.disabled = state.loading;
        setText('[data-source]', state.csvFile || 'не загружен');
        setText('[data-schema]', sc ? sc.name : '—');
        setText('[data-asof]', state.asOf.text);
        setText('[data-count]', fmtInt(n));
    }

    function render() {
        const sc = state.schema;
        const hasData = !!sc && state.records.length > 0;
        els.loading.hidden = !state.loading;

        if (!hasData) {
            els.tbody.innerHTML = '';
            els.wrap.hidden = true;
            els.empty.hidden = true;
            els.pager.hidden = true;
            els.statusSection.hidden = true;
            els.exportBtn.disabled = true;
            els.noData.hidden = state.loading;
            els.noDataText.textContent = !sc
                ? 'Выберите JSON-схему с форматом CSV, затем загрузите CSV-файл.'
                : 'Схема «' + sc.name + '» принята — загрузите CSV-файл.';
            els.meta.textContent = 'Нет данных';
            setControlsEnabled(false);
            maybeNotify();
            return;
        }

        els.noData.hidden = true;
        setControlsEnabled(!state.loading);

        const base = state.records.filter(matchesBase);
        const sorted = sortRows(applyStatus(base));
        els.statusSection.hidden = !stageKeys().length;
        renderChips(base);

        const size = state.pageSize === 'all' ? Math.max(sorted.length, 1) : state.pageSize;
        const pages = Math.max(1, Math.ceil(sorted.length / size));
        state.page = Math.min(Math.max(1, state.page), pages);
        const from = (state.page - 1) * size;
        const pageRows = sorted.slice(from, from + size);
        renderBody(pageRows);

        const isEmpty = sorted.length === 0;
        els.wrap.hidden = isEmpty || state.loading;
        els.empty.hidden = !isEmpty || state.loading;
        els.pager.hidden = isEmpty;
        els.exportBtn.disabled = isEmpty || state.loading;
        els.meta.textContent = isEmpty
            ? 'Нет задач по фильтрам · всего задач: ' + fmtInt(state.records.length)
            : 'Показаны ' + fmtInt(from + 1) + '–' + fmtInt(from + pageRows.length) + ' из ' + fmtInt(sorted.length) +
            ' · всего задач: ' + fmtInt(state.records.length);
        els.pageInfo.textContent = 'Страница ' + state.page + ' из ' + pages;
        els.prev.disabled = state.page <= 1;
        els.next.disabled = state.page >= pages;
        updateSortIndicators();
        maybeNotify();
    }

    /* ---------- шаг 1: JSON-схема ---------- */
    function applySchema(sc, fileName) {
        state.csvToken += 1;          // отменяем незавершённую загрузку CSV
        state.loading = false;
        state.schema = sc;
        state.schemaFile = fileName;
        state.records = [];
        state.csvFile = '';
        state.asOf = NO_ASOF;
        state.filters = emptyFilters();
        state.sort = defaultSort();
        state.page = 1;
        dataVersion += 1;
        els.csvMsgs.innerHTML = '';
        setStatus(els.csvStatus, 'Данные', 'не загружены');
        buildHead();
        buildFilters();
        updateChrome();
        render();
    }

    function onSchemaFile(file) {
        els.schemaMsgs.innerHTML = '';
        const keep = state.schema ? ' Действует прежняя схема.' : '';
        if (file.size > L.MAX_SCHEMA_BYTES) {
            setStatus(els.schemaStatus, 'Схема', '✗ «' + file.name + '» больше 1 МБ — это не похоже на схему.' + keep, 'error');
            return;
        }
        setStatus(els.schemaStatus, 'Схема', 'проверка «' + file.name + '»…');

        L.readFileText(file, 'utf-8').then(({ text }) => {
            let raw;
            try { raw = JSON.parse(text); }
            catch (e) {
                setStatus(els.schemaStatus, 'Схема', '✗ «' + file.name + '» — некорректный JSON: ' + e.message + '.' + keep, 'error');
                return;
            }
            const res = L.validateSchema(raw);
            if (!res.ok) {
                setStatus(els.schemaStatus, 'Схема', '✗ «' + file.name + '» отклонена, ошибок: ' + res.errors.length + '.' + keep, 'error');
                els.schemaMsgs.innerHTML = msgBlock('error', 'Исправьте ошибки в JSON (' + res.errors.length + ')', res.errors, true) +
                    (res.warnings.length ? msgBlock('warn', 'Предупреждения: ' + res.warnings.length, res.warnings, false) : '');
                return;
            }
            const hadData = state.records.length > 0;
            applySchema(res.schema, file.name);
            setStatus(els.schemaStatus, 'Схема', '✓ ' + file.name, 'ok');
            els.schemaMsgs.innerHTML =
                (hadData ? msgBlock('info', 'Прежние данные очищены — загрузите CSV под новую схему.') : '') +
                (res.warnings.length ? msgBlock('warn', 'Предупреждения: ' + res.warnings.length, res.warnings, false) : '');
            els.csvBtn.focus();
        }).catch((e) => {
            setStatus(els.schemaStatus, 'Схема', '✗ не удалось прочитать «' + file.name + '»: ' + (e && e.message ? e.message : e) + '.' + keep, 'error');
        });
    }

    /* ---------- шаг 2: CSV ---------- */
    function onCsvFile(file) {
        const sc = state.schema;
        if (!sc) return;
        els.csvMsgs.innerHTML = '';
        const keep = state.records.length ? ' Показаны прежние данные.' : '';
        if (file.size === 0) { setStatus(els.csvStatus, 'Данные', '✗ файл «' + file.name + '» пустой.' + keep, 'error'); return; }
        if (file.size > L.MAX_CSV_BYTES) { setStatus(els.csvStatus, 'Данные', '✗ «' + file.name + '» больше 20 МБ — для демо уменьшите выгрузку.' + keep, 'error'); return; }

        const token = ++state.csvToken;
        state.loading = true;
        setStatus(els.csvStatus, 'Данные', 'чтение «' + file.name + '» (' + sc.csv.encoding + ')…');
        updateChrome();
        render();

        L.readFileText(file, sc.csv.encoding)
            .then((read) => new Promise((resolve) => {
                // даём браузеру отрисовать состояние загрузки перед разбором
                window.setTimeout(() => resolve({ res: L.parseWithSchema(read.text, sc), suspicious: read.suspiciousEncoding }), 20);
            }))
            .then(({ res, suspicious }) => {
                if (token !== state.csvToken || sc !== state.schema) return; // устаревший запрос
                state.loading = false;

                const warnings = [];
                if (suspicious) warnings.push('В тексте есть нераспознанные символы — возможно, файл не в ' + sc.csv.encoding + '. Для выгрузки из Excel попробуйте "encoding": "windows-1251".');
                res.warnings.forEach((w) => warnings.push(w));
                const rowErrors = res.errors.map((e) => 'Строка ' + e.line + (e.id ? ' (' + e.id + ')' : '') + ': ' + e.messages.join('; '));
                if (res.errorCount > res.errors.length) rowErrors.push('… и ещё ' + fmtInt(res.errorCount - res.errors.length) + ' строк с ошибками');

                if (res.fatal) {
                    setStatus(els.csvStatus, 'Данные', '✗ «' + file.name + '»: ' + res.fatal + '.' + keep, 'error');
                    els.csvMsgs.innerHTML =
                        (rowErrors.length ? msgBlock('error', 'Ошибки в строках: ' + fmtInt(res.errorCount), rowErrors, true) : '') +
                        (warnings.length ? msgBlock('warn', 'Предупреждения: ' + warnings.length, warnings, false) : '');
                } else {
                    state.records = res.records;
                    state.csvFile = file.name;
                    state.asOf = computeAsOf(res.records);
                    state.filters = emptyFilters();
                    state.sort = defaultSort();
                    state.page = 1;
                    dataVersion += 1;
                    buildFilters(); // значения строковых сегментов берутся из данных
                    els.status.value = '';
                    const partial = res.errorCount > 0;
                    setStatus(els.csvStatus, 'Данные',
                        (partial ? '⚠ ' : '✓ ') + file.name + ' — ' + fmtInt(res.records.length) + ' из ' + fmtInt(res.totalRows) + ' строк' +
                        (partial ? ', пропущено с ошибками: ' + fmtInt(res.errorCount) : ''),
                        partial ? 'warn' : 'ok');
                    els.csvMsgs.innerHTML =
                        (rowErrors.length ? msgBlock('warn', 'Пропущенные строки: ' + fmtInt(res.errorCount), rowErrors, false) : '') +
                        (warnings.length ? msgBlock('warn', 'Предупреждения: ' + warnings.length, warnings, false) : '');
                }
                updateChrome();
                render();
            })
            .catch((e) => {
                if (token !== state.csvToken) return;
                state.loading = false;
                setStatus(els.csvStatus, 'Данные', '✗ не удалось прочитать «' + file.name + '»: ' + (e && e.message ? e.message : e) + '.' + keep, 'error');
                updateChrome();
                render();
            });
    }

    /* ---------- очистка ---------- */
    function clearAll() {
        state.csvToken += 1;
        state.loading = false;
        state.schema = null;
        state.schemaFile = '';
        state.records = [];
        state.csvFile = '';
        state.asOf = NO_ASOF;
        state.filters = emptyFilters();
        state.sort = { key: '__line', dir: 'asc' };
        state.page = 1;
        dataVersion += 1;
        els.schemaMsgs.innerHTML = '';
        els.csvMsgs.innerHTML = '';
        setStatus(els.schemaStatus, 'Схема', 'не выбрана');
        setStatus(els.csvStatus, 'Данные', 'не загружены');
        buildHead();
        buildFilters();
        updateChrome();
        render();
        els.schemaBtn.focus();
    }

    /* ---------- выгрузка текущего среза ---------- */
    function exportSlice() {
        const rows = currentRows();
        if (!rows.length) return;
        const base = (state.csvFile || 'tasks').replace(/\.[^.]+$/, '');
        download(base + '_slice.csv', L.toCsv(rows, state.schema), 'text/csv;charset=utf-8', true);
    }

    /* ---------- демо-набор по seed ---------- */
    function genMessage(text, kind) {
        els.genMsg.hidden = !text;
        els.genMsg.textContent = text;
        if (kind) els.genMsg.dataset.kind = kind; else delete els.genMsg.dataset.kind;
    }

    function setupGenerator() {
        if (!G || !G.DEMO_SCHEMA) {
            els.genSeed.disabled = true;
            els.genForm.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            genMessage('assets/data.js не загружен — демо-набор недоступен.', 'error');
            return;
        }
        els.genSeed.value = String(G.DEFAULT_SEED);
        setText('[data-gen-asof]', G.formatDay(G.AS_OF));
        setText('[data-window-start]', G.formatDay(G.WINDOW_START));

        els.genSchema.addEventListener('click', () => {
            download('tasks-schema.json', JSON.stringify(G.DEMO_SCHEMA, null, 2) + '\n', 'application/json;charset=utf-8', false);
            genMessage('✓ Скачан tasks-schema.json', 'ok');
        });

        els.genForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const raw = els.genSeed.value.trim();
            const seed = Number(raw);
            if (raw === '' || !G.isValidSeed(seed)) {
                els.genSeed.setAttribute('aria-invalid', 'true');
                genMessage('Seed должен быть целым числом от 0 до 4 294 967 295.', 'error');
                els.genSeed.focus();
                return;
            }
            els.genSeed.removeAttribute('aria-invalid');
            const v = L.validateSchema(G.DEMO_SCHEMA);
            if (!v.ok) { genMessage('Встроенная демо-схема некорректна: ' + v.errors[0], 'error'); return; }
            const tasks = G.generate(seed);
            download('tasks_seed-' + seed + '.csv', L.toCsv(G.toSchemaRecords(tasks), v.schema), 'text/csv;charset=utf-8', true);
            genMessage('✓ Задач: ' + fmtInt(tasks.length) + ' · срез ' + G.formatDay(G.AS_OF) + ' · отпечаток ' + G.fingerprint(tasks), 'ok');
        });
    }

    /* ---------- вкладки (#data / #state) ---------- */
    const VIEWS = ['data', 'state'];
    const VIEW_TITLES = { data: 'Данные задач', state: 'Состояние системы' };
    function readView() {
        const h = window.location.hash.slice(1);
        return VIEWS.indexOf(h) >= 0 ? h : null;
    }
    function applyView(v, focus) {
        document.body.dataset.view = v;
        document.querySelectorAll('[data-view-link]').forEach((a) => {
            if (a.dataset.viewLink === v) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        });
        document.title = VIEW_TITLES[v] + ' — демо-дашборд регламента Prod IT (синтетические данные)';
        notify('view');
        if (focus) {
            const h = byId(v === 'state' ? 'state-h' : 'table-h');
            if (h) h.focus({ preventScroll: true });
        }
    }

    /* ---------- события ---------- */
    function resetFilters() {
        state.filters = emptyFilters();
        state.sort = defaultSort();
        state.page = 1;
        els.q.value = '';
        els.status.value = '';
        els.segFilters.querySelectorAll('select').forEach((s) => { s.value = ''; });
        render();
    }

    function pickFile(input, handler) {
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            input.value = ''; // разрешаем повторно выбрать тот же файл
            if (file) handler(file);
        });
    }

    function bind() {
        els.schemaBtn.addEventListener('click', () => els.schemaInput.click());
        els.csvBtn.addEventListener('click', () => { if (state.schema) els.csvInput.click(); });
        els.noDataBtn.addEventListener('click', () => (state.schema ? els.csvInput : els.schemaInput).click());
        pickFile(els.schemaInput, onSchemaFile);
        pickFile(els.csvInput, onCsvFile);
        els.clearBtn.addEventListener('click', clearAll);

        let qTimer = null;
        els.q.addEventListener('input', () => {
            window.clearTimeout(qTimer);
            qTimer = window.setTimeout(() => { state.filters.q = els.q.value.trim(); state.page = 1; render(); }, 150);
        });
        els.segFilters.addEventListener('change', (e) => {
            const sel = e.target.closest('select[data-seg]');
            if (!sel) return;
            state.filters.seg[sel.dataset.seg] = sel.value;
            state.page = 1;
            render();
        });
        els.status.addEventListener('change', () => { state.filters.status = els.status.value; state.page = 1; render(); });
        els.reset.addEventListener('click', resetFilters);
        els.emptyReset.addEventListener('click', resetFilters);

        els.chips.addEventListener('click', (e) => {
            const b = e.target.closest('.chip');
            if (!b) return;
            const value = b.dataset.status;
            state.filters.status = value;
            els.status.value = value;
            state.page = 1;
            render();
            const again = els.chips.querySelector('.chip[data-status="' + value + '"]');
            if (again) again.focus();
        });

        els.thead.addEventListener('click', (e) => {
            const btn = e.target.closest('.sort-btn');
            if (!btn || !state.schema) return;
            const key = btn.closest('th').dataset.key;
            const col = state.schema.byKey[key];
            if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
            else state.sort = { key, dir: col && (col.type === 'date' || isNumeric(col)) ? 'desc' : 'asc' };
            state.page = 1;
            render();
        });

        els.pageSize.addEventListener('change', () => {
            state.pageSize = els.pageSize.value === 'all' ? 'all' : Number(els.pageSize.value);
            state.page = 1;
            render();
        });
        els.prev.addEventListener('click', () => { state.page -= 1; render(); els.wrap.scrollTop = 0; });
        els.next.addEventListener('click', () => { state.page += 1; render(); els.wrap.scrollTop = 0; });
        els.exportBtn.addEventListener('click', exportSlice);

        window.addEventListener('hashchange', () => { const v = readView(); if (v) applyView(v, true); });
    }

    /* ---------- API для вкладок с графиками ---------- */
    window.DemoApp = Object.freeze({
        getSchema: () => state.schema,
        getRecords: () => (state.schema ? state.records.filter(matchesBase) : []), // фильтры поиска и сегментов, без статуса
        getAllCount: () => state.records.length,
        getAsOfDay: () => state.asOf.day,
        getView: () => document.body.dataset.view,
        getFilterSummary: filterSummary,
        onChange: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
        download, esc
    });

    /* ---------- init: по умолчанию страница без данных ---------- */
    function init() {
        els.pageSize.value = String(state.pageSize);
        buildFilters();
        setupGenerator();
        bind();
        applyView(readView() || 'data', false);
        updateChrome();
        render();
    }

    init();
})();
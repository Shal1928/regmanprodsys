/*
 * assets/loader.js
 * Загрузка данных по JSON-схеме: проверка схемы, разбор CSV, приведение типов, проверка строк, выгрузка CSV.
 * Всё выполняется в браузере — файлы никуда не отправляются.
 * API: window.DataLoader
 */
(function (global) {
    'use strict';

    const DAY_MS = 86400000;
    const MAX_CSV_BYTES = 20 * 1024 * 1024;   // 20 МБ
    const MAX_SCHEMA_BYTES = 1024 * 1024;     // 1 МБ
    const MAX_STORED_ERRORS = 200;            // в отчёте храним первые N строк с ошибками
    const TYPES = ['string', 'enum', 'date', 'integer', 'number'];
    const TYPE_LABELS = { string: 'строка', enum: 'справочник', date: 'дата', integer: 'целое число', number: 'число' };
    const TONES = ['neutral', 'info', 'success', 'warning', 'danger'];
    const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
    const CHART_SPECS = {
        cfd: { label: 'Состояние системы (CFD)', required: ['stages'] },
        throughput: { label: 'Пропускная способность', required: ['doneDate'] },
        leadTime: { label: 'Lead Time', required: ['startDate', 'endDate'] },
        cycleTime: { label: 'Cycle Time', required: ['startDate', 'endDate'] },
        forecast: { label: 'Прогноз (Monte Carlo)', required: ['doneDate'] }
    };

    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const pad2 = (n) => String(n).padStart(2, '0');
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quoted = (s) => '«' + s + '»';
    const describeDelimiter = (d) => (d === '\t' ? 'табуляция' : d === ' ' ? 'пробел' : quoted(d));

    /* ===================== Даты по формату (dd, d, MM, M, yyyy, yy) ===================== */
    function compileDateFormat(fmt) {
        if (typeof fmt !== 'string' || !fmt) throw new Error('формат даты не задан');
        const tokenRe = /yyyy|yy|MM|M|dd|d/g;
        const tokens = [];
        let pattern = '^', last = 0, m;
        while ((m = tokenRe.exec(fmt)) !== null) {
            pattern += escapeRe(fmt.slice(last, m.index));
            tokens.push(m[0]);
            pattern += m[0] === 'yyyy' ? '(\\d{4})' : (m[0].length === 2 ? '(\\d{2})' : '(\\d{1,2})');
            last = m.index + m[0].length;
        }
        pattern += escapeRe(fmt.slice(last)) + '$';
        const has = (c) => tokens.some((t) => t[0] === c);
        if (!has('y') || !has('M') || !has('d')) throw new Error(quoted(fmt) + ' должен содержать день (dd), месяц (MM) и год (yyyy)');
        const re = new RegExp(pattern);

        return {
            source: fmt,
            parse(s) {
                const mm = re.exec(s);
                if (!mm) return NaN;
                let y = 0, mo = 0, d = 0;
                tokens.forEach((t, k) => {
                    const v = Number(mm[k + 1]);
                    if (t === 'yyyy') y = v;
                    else if (t === 'yy') y = 2000 + v;
                    else if (t[0] === 'M') mo = v;
                    else d = v;
                });
                if (mo < 1 || mo > 12 || d < 1) return NaN;
                const dt = new Date(Date.UTC(y, mo - 1, d));
                if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN; // 31.02 и т.п.
                return Math.round(dt.getTime() / DAY_MS);
            },
            format(day) {
                const dt = new Date(day * DAY_MS);
                const y = String(dt.getUTCFullYear());
                const parts = {
                    yyyy: y, yy: y.slice(-2),
                    MM: pad2(dt.getUTCMonth() + 1), M: String(dt.getUTCMonth() + 1),
                    dd: pad2(dt.getUTCDate()), d: String(dt.getUTCDate())
                };
                return fmt.replace(/yyyy|yy|MM|M|dd|d/g, (t) => parts[t]);
            }
        };
    }

    function parseNumber(s, decimalSeparator, integer) {
        let t = s.replace(/[\s\u00A0\u202F]/g, '');
        if (decimalSeparator === ',') t = t.replace(',', '.');
        if (integer) return /^[-+]?\d+$/.test(t) ? Number(t) : NaN;
        return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN;
    }

    /* ===================== CSV (RFC 4180 + настраиваемый разделитель) ===================== */
    // Возвращает { rows: [{ cells, line }], unterminatedAt } — line = номер физической строки начала записи.
    function parseCsv(text, delimiter, quote) {
        const rows = [];
        const n = text.length;
        const d0 = delimiter[0], dl = delimiter.length;
        const q = quote || null;
        let row = [], field = '', i = 0, inQuotes = false, quotedField = false, line = 1, rowStart = 1;
        if (text.charCodeAt(0) === 0xFEFF) i = 1; // BOM

        while (i < n) {
            const c = text[i];
            if (inQuotes) {
                if (c === q) {
                    if (text[i + 1] === q) { field += q; i += 2; continue; } // экранированная кавычка
                    inQuotes = false; i += 1; continue;
                }
                if (c === '\n') line += 1;
                field += c; i += 1; continue;
            }
            if (q !== null && c === q && field === '' && !quotedField) { inQuotes = true; quotedField = true; i += 1; continue; }
            if (c === d0 && (dl === 1 || text.startsWith(delimiter, i))) {
                row.push(field); field = ''; quotedField = false; i += dl; continue;
            }
            if (c === '\r' || c === '\n') {
                row.push(field);
                rows.push({ cells: row, line: rowStart });
                row = []; field = ''; quotedField = false;
                i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
                line += 1; rowStart = line;
                continue;
            }
            field += c; i += 1;
        }
        if (inQuotes) return { rows, unterminatedAt: rowStart };
        if (field !== '' || row.length > 0 || quotedField) { row.push(field); rows.push({ cells: row, line: rowStart }); }
        return { rows, unterminatedAt: 0 };
    }

    /* ===================== Проверка и компиляция JSON-схемы ===================== */
    function validateSchema(raw) {
        const errors = [], warnings = [];
        const err = (path, msg) => { errors.push(path + ': ' + msg); };
        const warn = (path, msg) => { warnings.push(path + ': ' + msg); };
        if (!isObj(raw)) return { ok: false, errors: ['Корень JSON должен быть объектом { … }'], warnings, schema: null };

        const sc = {
            version: raw.$schemaVersion === undefined ? '1.0' : String(raw.$schemaVersion),
            name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Без названия',
            description: typeof raw.description === 'string' ? raw.description : '',
            synthetic: typeof raw.synthetic === 'boolean' ? raw.synthetic : null,
            csv: { delimiter: ';', quote: '"', encoding: 'utf-8', header: true, skipEmptyLines: true, trim: true, decimalSeparator: '.' },
            validation: { onRowError: 'skip', checkStageOrder: true },
            columns: [],
            byKey: Object.create(null),
            mapping: { id: null, title: null, search: [], segments: [], stages: [], doneIndex: -1, charts: {} }
        };

        if (sc.version.split('.')[0] !== '1') warn('$schemaVersion', 'версия ' + quoted(sc.version) + ' не поддерживается полностью, ожидается 1.x');
        if (raw.synthetic !== undefined && typeof raw.synthetic !== 'boolean') err('synthetic', 'true или false');
        else if (sc.synthetic === null) warn('synthetic', 'не указано — для демо укажите true');

        /* --- csv --- */
        const c = raw.csv;
        if (c !== undefined && !isObj(c)) err('csv', 'должен быть объектом');
        else if (c) {
            if (c.delimiter !== undefined) {
                if (typeof c.delimiter !== 'string' || c.delimiter === '') err('csv.delimiter', 'непустая строка: ";", ",", "tab"…');
                else {
                    const d = /^(tab|\\t)$/i.test(c.delimiter) ? '\t' : c.delimiter;
                    if (/[\r\n]/.test(d)) err('csv.delimiter', 'не может содержать перевод строки');
                    else sc.csv.delimiter = d;
                }
            }
            if (c.quote !== undefined) {
                if (typeof c.quote !== 'string' || c.quote.length > 1) err('csv.quote', 'один символ или пустая строка (без кавычек)');
                else sc.csv.quote = c.quote;
            }
            if (c.encoding !== undefined) {
                if (typeof c.encoding !== 'string' || !c.encoding.trim()) err('csv.encoding', 'строка, например "utf-8" или "windows-1251"');
                else {
                    try { new TextDecoder(c.encoding.trim()); sc.csv.encoding = c.encoding.trim().toLowerCase(); }
                    catch (e) { err('csv.encoding', 'неизвестная кодировка ' + quoted(c.encoding)); }
                }
            }
            ['header', 'skipEmptyLines', 'trim'].forEach((f) => {
                if (c[f] === undefined) return;
                if (typeof c[f] !== 'boolean') err('csv.' + f, 'true или false');
                else sc.csv[f] = c[f];
            });
            if (c.decimalSeparator !== undefined) {
                if (c.decimalSeparator !== '.' && c.decimalSeparator !== ',') err('csv.decimalSeparator', '"." или ","');
                else sc.csv.decimalSeparator = c.decimalSeparator;
            }
            if (sc.csv.quote && sc.csv.delimiter.includes(sc.csv.quote)) err('csv.quote', 'совпадает с разделителем');
            if (sc.csv.decimalSeparator === sc.csv.delimiter) warn('csv.decimalSeparator', 'совпадает с разделителем — дробные числа должны быть в кавычках');
        }

        /* --- validation --- */
        const v = raw.validation;
        if (v !== undefined && !isObj(v)) err('validation', 'должен быть объектом');
        else if (v) {
            if (v.onRowError !== undefined) {
                if (v.onRowError !== 'skip' && v.onRowError !== 'fail') err('validation.onRowError', '"skip" или "fail"');
                else sc.validation.onRowError = v.onRowError;
            }
            if (v.checkStageOrder !== undefined) {
                if (typeof v.checkStageOrder !== 'boolean') err('validation.checkStageOrder', 'true или false');
                else sc.validation.checkStageOrder = v.checkStageOrder;
            }
        }

        /* --- columns --- */
        if (!Array.isArray(raw.columns) || raw.columns.length === 0) err('columns', 'нужен непустой массив колонок');
        else raw.columns.forEach((rc, i) => {
            const p = 'columns[' + i + ']';
            if (!isObj(rc)) { err(p, 'должен быть объектом'); return; }
            const key = rc.key;
            if (typeof key !== 'string' || !KEY_RE.test(key)) { err(p + '.key', 'обязателен: латиница, цифры, «_», начинается с буквы'); return; }
            const kp = p + ' (' + key + ')';
            if (sc.byKey[key]) { err(kp + '.key', 'дублируется'); return; }

            const col = {
                key, source: null, index: null, label: '', type: 'string',
                required: false, unique: false, visible: true, description: '',
                pattern: null, values: null, valueSet: null, order: null, valueLabels: {}, tones: {}, display: 'text',
                format: null, displayFormat: null, min: null, max: null
            };

            if (rc.source !== undefined) {
                if (typeof rc.source !== 'string' || !rc.source.trim()) err(kp + '.source', 'непустая строка — имя колонки в заголовке CSV');
                else col.source = rc.source.trim();
            }
            if (rc.index !== undefined) {
                if (!Number.isInteger(rc.index) || rc.index < 0) err(kp + '.index', 'целое число ≥ 0 (нумерация с 0)');
                else col.index = rc.index;
            }
            if (sc.csv.header && col.source === null && col.index === null) err(kp, 'укажите source (имя в заголовке CSV) или index');
            if (!sc.csv.header && col.index === null) err(kp + '.index', 'обязателен, когда csv.header = false');

            col.label = typeof rc.label === 'string' && rc.label.trim() ? rc.label.trim() : (col.source || key);
            if (rc.type !== undefined) {
                if (!TYPES.includes(rc.type)) err(kp + '.type', 'допустимо: ' + TYPES.join(', '));
                else col.type = rc.type;
            }
            ['required', 'unique', 'visible'].forEach((f) => {
                if (rc[f] === undefined) return;
                if (typeof rc[f] !== 'boolean') err(kp + '.' + f, 'true или false');
                else col[f] = rc[f];
            });
            if (rc.description !== undefined) col.description = String(rc.description);

            if (rc.pattern !== undefined) {
                if (col.type !== 'string') warn(kp + '.pattern', 'применяется только к типу string — игнорируется');
                else {
                    try { col.pattern = new RegExp(rc.pattern); }
                    catch (e) { err(kp + '.pattern', 'некорректное регулярное выражение'); }
                }
            }

            if (col.type === 'date') {
                if (rc.format === undefined) warn(kp + '.format', 'не задан, используется dd.MM.yyyy');
                try { col.format = compileDateFormat(rc.format === undefined ? 'dd.MM.yyyy' : rc.format); }
                catch (e) { err(kp + '.format', e.message); }
                if (rc.displayFormat !== undefined) {
                    try { col.displayFormat = compileDateFormat(rc.displayFormat); }
                    catch (e) { err(kp + '.displayFormat', e.message); }
                } else col.displayFormat = col.format;
            } else if (rc.format !== undefined) warn(kp + '.format', 'учитывается только для типа date');

            if (col.type === 'enum') {
                if (!Array.isArray(rc.values) || !rc.values.length || rc.values.some((x) => typeof x !== 'string' || x === '')) {
                    err(kp + '.values', 'для enum нужен непустой массив строк');
                } else {
                    col.values = rc.values.slice();
                    col.valueSet = new Set(col.values);
                    col.order = new Map(col.values.map((x, k) => [x, k]));
                    if (col.valueSet.size !== col.values.length) warn(kp + '.values', 'есть повторяющиеся значения');
                }
            }
            if (rc.valueLabels !== undefined) {
                if (!isObj(rc.valueLabels)) err(kp + '.valueLabels', 'объект { "значение": "расшифровка" }');
                else Object.keys(rc.valueLabels).forEach((x) => { col.valueLabels[x] = String(rc.valueLabels[x]); });
            }
            if (rc.display !== undefined) {
                if (rc.display !== 'tag' && rc.display !== 'text') err(kp + '.display', '"tag" или "text"');
                else col.display = rc.display;
            }
            if (rc.tones !== undefined) {
                if (!isObj(rc.tones)) err(kp + '.tones', 'объект { "значение": "тон" }');
                else Object.keys(rc.tones).forEach((x) => {
                    if (!TONES.includes(rc.tones[x])) err(kp + '.tones.' + x, 'допустимо: ' + TONES.join(', '));
                    else col.tones[x] = rc.tones[x];
                });
            }
            if (col.type === 'integer' || col.type === 'number') {
                ['min', 'max'].forEach((f) => {
                    if (rc[f] === undefined) return;
                    if (typeof rc[f] !== 'number' || !isFinite(rc[f])) err(kp + '.' + f, 'число');
                    else col[f] = rc[f];
                });
                if (col.min !== null && col.max !== null && col.min > col.max) err(kp, 'min больше max');
            } else if (rc.min !== undefined || rc.max !== undefined) warn(kp, 'min/max учитываются только для integer и number');

            sc.columns.push(col);
            sc.byKey[key] = col;
        });

        // Дубли source / index
        const seenSrc = new Map(), seenIdx = new Map();
        sc.columns.forEach((col) => {
            if (col.source) {
                const k = col.source.toLowerCase();
                if (seenSrc.has(k)) err('columns (' + col.key + ').source', quoted(col.source) + ' уже используется колонкой ' + quoted(seenSrc.get(k)));
                else seenSrc.set(k, col.key);
            }
            if (!sc.csv.header && col.index !== null) {
                if (seenIdx.has(col.index)) err('columns (' + col.key + ').index', col.index + ' уже используется колонкой ' + quoted(seenIdx.get(col.index)));
                else seenIdx.set(col.index, col.key);
            }
        });

        /* --- mapping --- */
        const m = raw.mapping;
        const mp = sc.mapping;
        const colRef = (path, key, types) => {
            if (typeof key !== 'string' || !sc.byKey[key]) { err(path, 'ссылается на неизвестную колонку ' + quoted(String(key))); return null; }
            if (types && !types.includes(sc.byKey[key].type)) { err(path, 'колонка ' + quoted(key) + ' должна быть типа ' + types.join(' / ')); return null; }
            return key;
        };
        const colRefs = (path, arr, types, minLen) => {
            if (!Array.isArray(arr)) { err(path, 'нужен массив ключей колонок'); return []; }
            const out = [];
            arr.forEach((k, i) => {
                const r = colRef(path + '[' + i + ']', k, types);
                if (r && !out.includes(r)) out.push(r);
            });
            if (minLen && out.length < minLen) err(path, 'нужно минимум ' + minLen + ' колонки');
            return out;
        };

        if (m === undefined) warn('mapping', 'не задан — таблица будет без этапов и графиков');
        else if (!isObj(m)) err('mapping', 'должен быть объектом');
        else {
            if (m.id !== undefined) {
                mp.id = colRef('mapping.id', m.id);
                if (mp.id && !sc.byKey[mp.id].unique) warn('mapping.id', 'колонка не помечена "unique": true — дубли ключей не будут найдены');
            } else warn('mapping.id', 'не задан — строки будут без ключа');
            if (m.title !== undefined) mp.title = colRef('mapping.title', m.title, ['string', 'enum']);
            if (m.search !== undefined) mp.search = colRefs('mapping.search', m.search, null, 0);
            if (m.segments !== undefined) mp.segments = colRefs('mapping.segments', m.segments, ['enum', 'string'], 0);

            if (m.workflow !== undefined) {
                const wf = m.workflow;
                if (!isObj(wf)) err('mapping.workflow', 'должен быть объектом');
                else {
                    mp.stages = colRefs('mapping.workflow.stages', wf.stages, ['date'], 2);
                    if (wf.doneStage !== undefined) {
                        const di = mp.stages.indexOf(wf.doneStage);
                        if (di < 0) err('mapping.workflow.doneStage', 'должен входить в stages');
                        else mp.doneIndex = di;
                    } else mp.doneIndex = mp.stages.length - 1;
                }
            } else warn('mapping.workflow', 'не задан — текущий статус и CFD недоступны');

            if (m.charts !== undefined) {
                if (!isObj(m.charts)) err('mapping.charts', 'должен быть объектом');
                else Object.keys(m.charts).forEach((name) => {
                    const cfg = m.charts[name];
                    const base = 'mapping.charts.' + name;
                    if (!CHART_SPECS[name]) warn(base, 'неизвестный график — будет проигнорирован');
                    if (!isObj(cfg)) { err(base, 'должен быть объектом'); return; }
                    Object.keys(cfg).forEach((prop) => {
                        const val = cfg[prop], p = base + '.' + prop;
                        if (/Date$/.test(prop)) colRef(p, val, ['date']);
                        else if (prop === 'stages' || /Stages$/.test(prop)) colRefs(p, val, ['date'], prop === 'stages' ? 2 : 1);
                        else if (prop === 'groupBy') {
                            if (typeof val === 'string') colRef(p, val);
                            else colRefs(p, val, null, 1);
                        }
                    });
                    if (CHART_SPECS[name]) {
                        CHART_SPECS[name].required.forEach((r) => { if (cfg[r] === undefined) err(base, 'нет обязательного поля ' + quoted(r)); });
                        mp.charts[name] = JSON.parse(JSON.stringify(cfg));
                    }
                });
            }
            Object.keys(CHART_SPECS).forEach((name) => {
                if (!isObj(m.charts) || m.charts[name] === undefined) warn('mapping.charts.' + name, 'не настроен — график «' + CHART_SPECS[name].label + '» будет недоступен');
            });
        }

        const ok = errors.length === 0;
        return { ok, errors, warnings, schema: ok ? sc : null };
    }

    /* ===================== Приведение значения к типу колонки ===================== */
    // Возвращает значение или undefined (ошибка добавлена в msgs).
    function convert(col, raw, opt, msgs) {
        const name = quoted(col.label);
        switch (col.type) {
            case 'date': {
                const d = col.format.parse(raw);
                if (Number.isNaN(d)) { msgs.push(name + ': ' + quoted(raw) + ' — не дата в формате ' + col.format.source); return undefined; }
                return d;
            }
            case 'integer':
            case 'number': {
                const n = parseNumber(raw, opt.decimalSeparator, col.type === 'integer');
                if (Number.isNaN(n)) { msgs.push(name + ': ' + quoted(raw) + ' — не ' + (col.type === 'integer' ? 'целое число' : 'число')); return undefined; }
                if (col.min !== null && n < col.min) { msgs.push(name + ': ' + n + ' меньше минимума ' + col.min); return undefined; }
                if (col.max !== null && n > col.max) { msgs.push(name + ': ' + n + ' больше максимума ' + col.max); return undefined; }
                return n;
            }
            case 'enum':
                if (!col.valueSet.has(raw)) { msgs.push(name + ': значения ' + quoted(raw) + ' нет в справочнике (' + col.values.join(', ') + ')'); return undefined; }
                return raw;
            default:
                if (col.pattern && !col.pattern.test(raw)) { msgs.push(name + ': ' + quoted(raw) + ' не соответствует шаблону ' + col.pattern.source); return undefined; }
                return raw;
        }
    }

    /* ===================== Разбор CSV по схеме ===================== */
    function parseWithSchema(text, sc) {
        const res = { records: [], totalRows: 0, errorCount: 0, errors: [], warnings: [], fatal: null };
        const opt = sc.csv;
        const parsed = parseCsv(text, opt.delimiter, opt.quote);
        if (parsed.unterminatedAt) {
            res.fatal = 'незакрытая кавычка ' + quoted(opt.quote) + ' в строке ' + parsed.unterminatedAt + ' — проверьте csv.quote и экранирование';
            return res;
        }
        let rows = parsed.rows;
        if (opt.skipEmptyLines) rows = rows.filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ''));
        if (!rows.length) { res.fatal = 'файл не содержит строк'; return res; }

        const idx = new Array(sc.columns.length).fill(-1);
        let expected = 0;

        if (opt.header) {
            const head = rows.shift();
            const names = head.cells.map((h) => h.trim());
            expected = names.length;
            if (names.length === 1 && sc.columns.length > 1) {
                const found = [';', ',', '\t', '|'].filter((d) => d !== opt.delimiter && names[0].includes(d));
                res.fatal = 'в заголовке найдена одна колонка — разделитель в файле не ' + describeDelimiter(opt.delimiter) +
                    (found.length ? ', похоже, это ' + describeDelimiter(found[0]) : '') + '. Исправьте csv.delimiter в схеме';
                return res;
            }
            const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
            const normNames = names.map(norm);
            const missingReq = [], missingOpt = [];
            sc.columns.forEach((col, k) => {
                if (col.source !== null) {
                    let i = names.indexOf(col.source);
                    if (i < 0) i = normNames.indexOf(norm(col.source));
                    if (i >= 0) { idx[k] = i; return; }
                }
                if (col.index !== null && col.index < names.length) { idx[k] = col.index; return; }
                (col.required ? missingReq : missingOpt).push(quoted(col.source || ('#' + col.index)));
            });
            if (missingReq.length) {
                res.fatal = 'в заголовке нет обязательных колонок: ' + missingReq.join(', ') + '. Найдено: ' + names.map(quoted).join(', ');
                return res;
            }
            if (missingOpt.length) res.warnings.push('Нет необязательных колонок — они будут пустыми: ' + missingOpt.join(', '));
            const used = new Set(idx);
            const extra = names.filter((nm, i) => !used.has(i) && nm !== '');
            if (extra.length) res.warnings.push('Колонки CSV не описаны в схеме и не показываются: ' + extra.map(quoted).join(', '));
        } else {
            sc.columns.forEach((col, k) => { idx[k] = col.index; });
            expected = Math.max.apply(null, idx) + 1;
        }

        if (!rows.length) { res.fatal = 'в файле только заголовок, строк с данными нет'; return res; }
        res.totalRows = rows.length;

        const uniqueSeen = Object.create(null);
        sc.columns.forEach((col) => { if (col.unique) uniqueSeen[col.key] = new Map(); });
        const stageCols = sc.mapping.stages.map((k) => sc.byKey[k]);
        const idKey = sc.mapping.id;

        rows.forEach((row) => {
            const cells = row.cells;
            // Допускаем лишний пустой хвост «…;» в конце строки
            if (opt.header && cells.length === expected + 1 && cells[cells.length - 1].trim() === '') cells.pop();
            const msgs = [];
            if (opt.header ? cells.length !== expected : cells.length < expected) {
                msgs.push('ожидалось полей: ' + expected + ', получено: ' + cells.length + ' (проверьте разделитель и кавычки)');
            }
            const rec = { __line: row.line, __stage: -1 };
            sc.columns.forEach((col, k) => {
                let raw = idx[k] >= 0 && idx[k] < cells.length ? cells[idx[k]] : '';
                if (opt.trim) raw = raw.trim();
                rec[col.key] = null;
                if (raw === '') {
                    if (col.required) msgs.push(quoted(col.label) + ': пустое значение');
                    return;
                }
                const val = convert(col, raw, opt, msgs);
                if (val !== undefined) rec[col.key] = val;
            });

            if (sc.validation.checkStageOrder) {
                let prev = null;
                stageCols.forEach((col) => {
                    const d = rec[col.key];
                    if (d === null) return;
                    if (prev && d < prev.d) {
                        msgs.push(quoted(col.label) + ' (' + col.format.format(d) + ') раньше, чем ' + quoted(prev.col.label) + ' (' + prev.col.format.format(prev.d) + ')');
                    }
                    prev = { col, d };
                });
            }

            // Уникальность проверяем только для строк без других ошибок
            if (!msgs.length) {
                Object.keys(uniqueSeen).forEach((key) => {
                    const val = rec[key];
                    if (val === null) return;
                    const seen = uniqueSeen[key], s = String(val);
                    if (seen.has(s)) msgs.push(quoted(sc.byKey[key].label) + ': дубликат ' + quoted(s) + ' (уже в строке ' + seen.get(s) + ')');
                });
                if (!msgs.length) Object.keys(uniqueSeen).forEach((key) => { if (rec[key] !== null) uniqueSeen[key].set(String(rec[key]), row.line); });
            }

            for (let s = stageCols.length - 1; s >= 0; s--) {
                if (rec[stageCols[s].key] !== null) { rec.__stage = s; break; }
            }

            if (msgs.length) {
                res.errorCount += 1;
                if (res.errors.length < MAX_STORED_ERRORS) {
                    res.errors.push({ line: row.line, id: idKey && rec[idKey] !== null ? String(rec[idKey]) : '', messages: msgs });
                }
            } else res.records.push(rec);
        });

        if (sc.validation.onRowError === 'fail' && res.errorCount) {
            res.fatal = 'загрузка отменена (validation.onRowError = "fail"): строк с ошибками — ' + res.errorCount;
            res.records = [];
        } else if (!res.records.length) {
            res.fatal = 'ни одна строка не прошла проверку';
        }
        return res;
    }

    /* ===================== Чтение файла в нужной кодировке ===================== */
    function readFileText(file, encoding) {
        const read = typeof file.arrayBuffer === 'function'
            ? file.arrayBuffer()
            : new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => reject(fr.error);
                fr.readAsArrayBuffer(file);
            });
        return read.then((buf) => {
            const enc = encoding || 'utf-8';
            const text = new TextDecoder(enc).decode(buf);
            const suspiciousEncoding = /utf-?8/i.test(enc) && text.indexOf('\uFFFD') >= 0;
            return { text, suspiciousEncoding };
        });
    }

    /* ===================== Выгрузка записей в CSV по схеме ===================== */
    function toCsv(records, sc) {
        const o = sc.csv;
        const q = o.quote;
        const needsQuote = (s) => s.includes(o.delimiter) || /[\r\n]/.test(s) || (q && s.includes(q)) || s !== s.trim();
        const enc = (s) => {
            if (!q) return s.split(o.delimiter).join(' ').replace(/[\r\n]+/g, ' ');
            return needsQuote(s) ? q + s.split(q).join(q + q) + q : s;
        };
        const fmt = (col, v) => {
            if (v === null || v === undefined) return '';
            if (col.type === 'date') return col.format.format(v);
            if (col.type === 'number') { const s = String(v); return o.decimalSeparator === ',' ? s.replace('.', ',') : s; }
            return String(v);
        };
        const lines = [];
        if (o.header) {
            lines.push(sc.columns.map((c) => enc(c.source || c.label)).join(o.delimiter));
            records.forEach((r) => lines.push(sc.columns.map((c) => enc(fmt(c, r[c.key]))).join(o.delimiter)));
        } else {
            const width = Math.max.apply(null, sc.columns.map((c) => c.index)) + 1;
            records.forEach((r) => {
                const arr = new Array(width).fill('');
                sc.columns.forEach((c) => { arr[c.index] = enc(fmt(c, r[c.key])); });
                lines.push(arr.join(o.delimiter));
            });
        }
        return lines.join('\r\n') + '\r\n';
    }

    global.DataLoader = Object.freeze({
        MAX_CSV_BYTES, MAX_SCHEMA_BYTES, CHART_SPECS, TYPE_LABELS,
        compileDateFormat, parseCsv, validateSchema, parseWithSchema, readFileText, toCsv, describeDelimiter
    });
})(window);
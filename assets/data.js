/*
 * assets/data.js
 * Синтетический генератор задач трекера для демо-витрины.
 * Детерминирован: одинаковый seed -> одинаковые данные (PRNG mulberry32, фиксированная дата среза).
 * Данные сгенерированы для демонстрации. Не использовать для реальных решений.
 * Содержит: генератор (этап 1), демо-схему CSV (этап 2) и преобразование задач в записи схемы.
 * API: window.TaskData
 */
(function (global) {
    'use strict';

    /* ===================== Параметры ===================== */
    const DAY_MS = 86400000;
    const AS_OF = Math.floor(Date.UTC(2026, 9, 29) / DAY_MS); // дата среза 29.10.2026 (UTC, номер дня от 01.01.1970)
    const HISTORY_DAYS = 182;        // окно таблицы ~26 недель
    const WARMUP_DAYS = 90;          // разогрев: незакрытые к началу окна задачи попадают в таблицу
    const DEMAND_GROWTH = 0.35;      // рост входящего потока за период (+35%)
    const DEMAND_SEASONALITY = 0.12; // амплитуда 28-дневного цикла
    const BOTTLENECK_DAYS = 60;      // аномалия: последние N дней тестирование замедляется
    const BOTTLENECK_MAX = 1.2;      // до +120% к медиане тестирования (×2,2)
    const DEFAULT_SEED = 2026;
    const WINDOW_START = AS_OF - HISTORY_DAYS;

    const STAGES = [
        { key: 'open', label: 'Открыта' },
        { key: 'analysis', label: 'Анализ' },
        { key: 'dev', label: 'Разработка' },
        { key: 'test', label: 'Тестирование' },
        { key: 'release', label: 'Релиз' },
        { key: 'closed', label: 'Закрыта' }
    ];
    const TEAMS = ['Платформа', 'Ядро', 'Интеграции'];
    const WORK_TYPES = ['Новый функционал', 'Ошибка', 'Техническое развитие'];
    const SERVICE_CLASSES = ['EXP', 'FD', 'STD', 'INT'];
    const SERVICE_CLASS_LABELS = {
        EXP: 'Срочный (Expedite)',
        FD: 'Фиксированная дата (Fixed Date)',
        STD: 'Стандартный (Standard)',
        INT: 'Нематериальный (Intangible)'
    };

    // Переход i: из STAGES[i] в STAGES[i+1]. Медиана — рабочие дни, sigma — разброс лог-нормального распределения.
    const TRANSITIONS = [
        { name: 'Открыта → Анализ (ожидание в бэклоге)', median: 3.0, sigma: 0.80 },
        { name: 'Анализ → Разработка', median: 2.0, sigma: 0.60 },
        { name: 'Разработка → Тестирование', median: 5.0, sigma: 0.55 },
        { name: 'Тестирование → Релиз', median: 2.5, sigma: 0.60 },
        { name: 'Релиз → Закрыта (проверка на продуктиве)', median: 1.5, sigma: 0.50 }
    ];
    const TEST_TRANSITION = 3;

    const TEAM_CFG = {
        'Платформа': { rate: 0.75, mult: [1.0, 1.0, 1.00, 1.0, 0.8] },
        'Ядро': { rate: 1.10, mult: [1.0, 1.0, 1.15, 1.0, 1.0] },
        'Интеграции': { rate: 0.70, mult: [1.0, 1.1, 1.00, 1.3, 1.0] }
    };
    const TYPE_CFG = {
        'Новый функционал': { weight: 0.50, mult: [1.0, 1.0, 1.0, 1.0, 1.0], classWeights: { EXP: 0.02, FD: 0.18, STD: 0.65, INT: 0.15 } },
        'Ошибка': { weight: 0.30, mult: [0.5, 0.6, 0.6, 0.9, 0.8], classWeights: { EXP: 0.15, FD: 0.10, STD: 0.65, INT: 0.10 } },
        'Техническое развитие': { weight: 0.20, mult: [1.2, 1.3, 1.2, 0.8, 1.0], classWeights: { EXP: 0.02, FD: 0.10, STD: 0.48, INT: 0.40 } }
    };
    const CLASS_CFG = {
        EXP: { mult: [0.1, 0.3, 0.4, 0.5, 0.3], blockProb: 0.03 },
        FD: { mult: [0.6, 0.8, 0.8, 0.8, 0.7], blockProb: 0.08 },
        STD: { mult: [1.0, 1.0, 1.0, 1.0, 1.0], blockProb: 0.12 },
        INT: { mult: [3.0, 1.3, 1.2, 1.1, 1.5], blockProb: 0.18 }
    };
    const BLOCK_MIN_DAYS = 3;
    const BLOCK_MAX_DAYS = 10;

    // Словари для тем задач (вымышленные модули, без брендов)
    const MODULES = ['Биллинг', 'Личный кабинет', 'Каталог', 'Отчётность', 'Платёжный шлюз', 'Уведомления', 'Склад', 'Авторизация', 'Интеграционная шина', 'Мониторинг'];
    const FEATURE_VERBS = ['Добавить', 'Реализовать'];
    const FEATURE_OBJECTS = ['фильтр по статусу заказа', 'экспорт в CSV', 'массовое редактирование карточек', 'историю изменений', 'роль «Аудитор»', 'уведомление о просрочке', 'поиск по артикулу', 'виджет остатков', 'черновики документов', 'двухэтапное подтверждение'];
    const BUG_PREFIXES = ['Ошибка', 'Сбой', 'Дефект'];
    const BUG_SYMPTOMS = ['таймаут при выгрузке отчёта', 'дублирование записей', 'неверный расчёт итоговой суммы', 'пустой ответ API', 'ошибка 500 при сохранении', 'некорректная сортировка списка', 'утечка памяти в фоновом задании', 'расхождение остатков', 'повторная отправка уведомления', 'сбой входа после смены пароля'];
    const TECH_TASKS = ['Обновить версию СУБД на контуре TEST', 'Перевести сборку на общий CI-шаблон', 'Оптимизировать тяжёлые запросы', 'Автоматизировать развёртывание стенда STAGE', 'Настроить ротацию логов', 'Настроить резервное копирование БД', 'Добавить мониторинг очередей сообщений', 'Обновить конфигурацию балансировщика', 'Вынести секреты в хранилище', 'Покрыть API автотестами'];
    const ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // без I и O

    /* ===================== PRNG и распределения ===================== */
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function normal(rnd) {
        const u1 = rnd() || 1e-12;
        const u2 = rnd();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    function lognormal(rnd, median, sigma) { return median * Math.exp(sigma * normal(rnd)); }
    function poisson(rnd, lambda) {
        const L = Math.exp(-lambda);
        let k = 0, p = 1;
        do { k += 1; p *= rnd(); } while (p > L);
        return k - 1;
    }
    function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
    function pickWeighted(rnd, items, weights) {
        const total = weights.reduce((s, w) => s + w, 0);
        let r = rnd() * total;
        for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
        return items[items.length - 1];
    }

    /* ===================== Даты (номер дня UTC) ===================== */
    function isWeekend(day) { const dow = (((day + 4) % 7) + 7) % 7; return dow === 0 || dow === 6; } // 01.01.1970 — четверг
    function addWorkdays(day, n) {
        let d = day, left = n;
        while (left > 0) { d += 1; if (!isWeekend(d)) left -= 1; }
        return d;
    }
    const pad = (n) => String(n).padStart(2, '0');
    function formatDay(day) {
        if (day === null || day === undefined) return '';
        const dt = new Date(day * DAY_MS);
        return pad(dt.getUTCDate()) + '.' + pad(dt.getUTCMonth() + 1) + '.' + dt.getUTCFullYear();
    }
    function toIsoDay(day) {
        const dt = new Date(day * DAY_MS);
        return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
    }

    /* ===================== Генерация ===================== */
    function isValidSeed(n) { return Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF; }

    function makeId(rnd, used) {
        let id;
        do {
            id = pick(rnd, ID_LETTERS) + pick(rnd, ID_LETTERS) + pick(rnd, ID_LETTERS) + String(Math.floor(rnd() * 1000)).padStart(3, '0');
        } while (used.has(id));
        used.add(id);
        return id;
    }

    function makeTitle(rnd, type) {
        const module = pick(rnd, MODULES);
        if (type === 'Новый функционал') return pick(rnd, FEATURE_VERBS) + ' ' + pick(rnd, FEATURE_OBJECTS) + ' (' + module + ')';
        if (type === 'Ошибка') return pick(rnd, BUG_PREFIXES) + ': ' + pick(rnd, BUG_SYMPTOMS) + ' (' + module + ')';
        return pick(rnd, TECH_TASKS) + ' (' + module + ')';
    }

    function bottleneckFactor(day) {
        const from = AS_OF - BOTTLENECK_DAYS;
        if (day < from) return 1;
        return 1 + BOTTLENECK_MAX * Math.min(1, (day - from) / BOTTLENECK_DAYS);
    }

    function makeTask(rnd, openDay, team, usedIds) {
        const type = pickWeighted(rnd, WORK_TYPES, WORK_TYPES.map((t) => TYPE_CFG[t].weight));
        const cw = TYPE_CFG[type].classWeights;
        const cls = pickWeighted(rnd, SERVICE_CLASSES, SERVICE_CLASSES.map((c) => cw[c]));
        const id = makeId(rnd, usedIds);
        const title = makeTitle(rnd, type);

        const blocked = rnd() < CLASS_CFG[cls].blockProb;
        const blockedTransition = blocked ? Math.floor(rnd() * TRANSITIONS.length) : -1;
        const blockDays = blocked ? BLOCK_MIN_DAYS + Math.floor(rnd() * (BLOCK_MAX_DAYS - BLOCK_MIN_DAYS + 1)) : 0;

        const dates = [openDay];
        let cur = openDay;
        for (let s = 0; s < TRANSITIONS.length; s++) {
            let median = TRANSITIONS[s].median * CLASS_CFG[cls].mult[s] * TYPE_CFG[type].mult[s] * TEAM_CFG[team].mult[s];
            if (s === TEST_TRANSITION) median *= bottleneckFactor(cur);
            let dur = Math.max(0, Math.round(lognormal(rnd, median, TRANSITIONS[s].sigma)));
            if (s === blockedTransition) dur += blockDays;
            cur = addWorkdays(cur, dur);
            dates.push(cur);
        }

        // Срез на дату AS_OF: будущие статусы очищаются
        let status = 0;
        for (let s = 1; s < dates.length; s++) {
            if (dates[s] <= AS_OF) { status = s; }
            else { for (let k = s; k < dates.length; k++) dates[k] = null; break; }
        }

        return { id, title, team, type, cls, dates, status, blockedTransition, blockDays };
    }

    function generate(seed) {
        if (!isValidSeed(seed)) throw new RangeError('Seed must be an integer 0..4294967295');
        const rnd = mulberry32(seed);
        const genFrom = WINDOW_START - WARMUP_DAYS;
        const span = AS_OF - genFrom;
        const usedIds = new Set();
        const tasks = [];

        for (let d = genFrom; d <= AS_OF; d++) {
            if (isWeekend(d)) continue;
            const t = (d - genFrom) / span;
            const demand = (1 - DEMAND_GROWTH / 2 + DEMAND_GROWTH * t) *
                (1 + DEMAND_SEASONALITY * Math.sin((2 * Math.PI * (d - genFrom)) / 28));
            for (let k = 0; k < TEAMS.length; k++) {
                const team = TEAMS[k];
                const n = poisson(rnd, TEAM_CFG[team].rate * demand);
                for (let i = 0; i < n; i++) tasks.push(makeTask(rnd, d, team, usedIds));
            }
        }
        return tasks.filter((task) => task.dates[5] === null || task.dates[5] >= WINDOW_START);
    }

    // Отпечаток данных (FNV-1a) — проверка воспроизводимости по seed
    function fingerprint(tasks) {
        let h = 0x811c9dc5;
        const feed = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
        tasks.forEach((t) => { feed(t.id); t.dates.forEach((d) => feed(d === null ? '-' : String(d))); });
        return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }

    /* ===================== Демо-схема CSV (копия samples/tasks-schema.json) ===================== */
    // Встроена в JS, чтобы кнопка «Скачать JSON-схему» работала по file:// без fetch.
    const DEMO_SCHEMA = {
        "$schemaVersion": "1.0",
        "name": "Задачи трекера — демо Prod IT",
        "description": "Формат выгрузки задач для демо-дашборда регламента управления производственной IT-системой. Данные синтетические.",
        "synthetic": true,
        "csv": { "delimiter": ";", "quote": "\"", "encoding": "utf-8", "header": true, "skipEmptyLines": true, "trim": true, "decimalSeparator": "," },
        "validation": { "onRowError": "skip", "checkStageOrder": true },
        "columns": [
            { "key": "id", "source": "ID", "label": "ID", "type": "string", "required": true, "unique": true, "pattern": "^[A-Z]{3}[0-9]{3}$", "description": "Уникальный ключ: 3 латинские буквы и 3 цифры" },
            { "key": "title", "source": "Тема", "label": "Тема", "type": "string", "required": true, "description": "Краткое описание работы" },
            { "key": "team", "source": "Команда", "label": "Команда", "type": "enum", "required": true, "values": ["Платформа", "Ядро", "Интеграции"] },
            { "key": "workType", "source": "Тип работы", "label": "Тип работы", "type": "enum", "required": true, "values": ["Новый функционал", "Ошибка", "Техническое развитие"] },
            { "key": "serviceClass", "source": "Класс обслуживания", "label": "Класс обслуживания", "type": "enum", "required": true,
                "values": ["EXP", "FD", "STD", "INT"],
                "valueLabels": { "EXP": "Срочный (Expedite)", "FD": "Фиксированная дата (Fixed Date)", "STD": "Стандартный (Standard)", "INT": "Нематериальный (Intangible)" },
                "display": "tag",
                "tones": { "EXP": "danger", "FD": "warning", "STD": "neutral", "INT": "info" } },
            { "key": "opened", "source": "Открыта", "label": "Открыта", "type": "date", "format": "dd.MM.yyyy", "required": true, "description": "Дата входа в статус «Открыта»" },
            { "key": "analysis", "source": "Анализ", "label": "Анализ", "type": "date", "format": "dd.MM.yyyy", "required": false, "description": "Дата входа в статус «Анализ»" },
            { "key": "development", "source": "Разработка", "label": "Разработка", "type": "date", "format": "dd.MM.yyyy", "required": false, "description": "Дата входа в статус «Разработка»" },
            { "key": "testing", "source": "Тестирование", "label": "Тестирование", "type": "date", "format": "dd.MM.yyyy", "required": false, "description": "Дата входа в статус «Тестирование»" },
            { "key": "release", "source": "Релиз", "label": "Релиз", "type": "date", "format": "dd.MM.yyyy", "required": false, "description": "Дата входа в статус «Релиз»" },
            { "key": "closed", "source": "Закрыта", "label": "Закрыта", "type": "date", "format": "dd.MM.yyyy", "required": false, "description": "Дата входа в статус «Закрыта»" }
        ],
        "mapping": {
            "id": "id",
            "title": "title",
            "search": ["id", "title"],
            "segments": ["team", "workType", "serviceClass"],
            "workflow": { "stages": ["opened", "analysis", "development", "testing", "release", "closed"], "doneStage": "closed" },
            "charts": {
                "cfd": { "title": "Состояние системы: накопительная диаграмма потока", "stages": ["opened", "analysis", "development", "testing", "release", "closed"], "groupBy": ["team", "workType", "serviceClass"], "interval": "day" },
                "throughput": { "title": "Возможности: пропускная способность", "doneDate": "closed", "interval": "week", "groupBy": "workType" },
                "leadTime": { "title": "Возможности: Lead Time", "startDate": "opened", "endDate": "closed", "units": "workdays", "percentiles": [50, 85, 95], "groupBy": "serviceClass" },
                "cycleTime": { "title": "Cycle Time от начала разработки", "startDate": "development", "endDate": "closed", "units": "workdays", "percentiles": [50, 85] },
                "forecast": { "title": "Прогноз: Monte Carlo", "doneDate": "closed", "historyWeeks": 12, "simulations": 10000, "confidence": [50, 85, 95], "backlogStages": ["opened", "analysis"] }
            }
        }
    };

    // Ключи колонок-этапов схемы в порядке STAGES
    const SCHEMA_STAGE_KEYS = ['opened', 'analysis', 'development', 'testing', 'release', 'closed'];

    // Задачи генератора → записи в ключах DEMO_SCHEMA (даты — номера дней UTC, пусто — null).
    // Сортировка: по дате открытия, затем по ID — стабильный порядок строк в CSV.
    function toSchemaRecords(tasks) {
        return tasks.slice()
            .sort((a, b) => (a.dates[0] - b.dates[0]) || a.id.localeCompare(b.id))
            .map((t) => {
                const r = { id: t.id, title: t.title, team: t.team, workType: t.type, serviceClass: t.cls };
                SCHEMA_STAGE_KEYS.forEach((k, i) => { r[k] = t.dates[i]; });
                return r;
            });
    }

    global.TaskData = Object.freeze({
        AS_OF, WINDOW_START, DEFAULT_SEED, STAGES, TEAMS, WORK_TYPES, SERVICE_CLASSES, SERVICE_CLASS_LABELS, TRANSITIONS,
        DEMO_SCHEMA, SCHEMA_STAGE_KEYS,
        generate, fingerprint, toSchemaRecords, isValidSeed, formatDay, toIsoDay, isWeekend, addWorkdays
    });
})(window);
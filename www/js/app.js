/* ============================================
 * 古诗词大全 v4 - 离线优先加载
 *
 * 加载策略 (按优先级回退, 全部失败才报错):
 *   1. window.POEM_*  同步变量 (由 index.html 预注入的 index.js/authors.js 提供)
 *   2. 动态注入 <script> 加载 .js (lite 分片、full 数据)
 *   3. fetch() 兜底 (HTTP/HTTPS 服务下使用, 也用于 .json)
 *
 * 特性:
 *   - 并发去重: 同一资源同时多次请求只发一次
 *   - 超时与重试: script 注入与 fetch 均有超时, 失败最多重试 2 次
 *   - 错误隔离: 单个分片失败不影响其它分片
 *   - 返回手势兼容: 集中 pushState, popstate 防循环, WebView.goBack() 切页
 * ============================================ */
(function () {
    'use strict';

    // ============== 常量 ==============
    const STORAGE = {
        history: 'p_history',
        favs: 'p_favs',
        theme: 'p_theme',
        fontSize: 'p_fontSize',
        fontFamily: 'p_fontFamily',
        read: 'p_read',
        anno: 'p_anno',         // 全局默认: { tr, ex1, int } -> bool
    };

    const SCRIPT_TIMEOUT_MS = 12000;     // script 注入超时
    const FETCH_TIMEOUT_MS = 15000;      // fetch 超时
    const MAX_RETRY = 2;                 // 失败重试次数
    const SCRIPT_BASE = 'data/lite/';    // lite js 相对路径前缀
    const FULL_BASE = 'data/full/';      // full js 相对路径前缀
    const NOTES_BASE = 'data/notes/';    // notes js 相对路径前缀
    // 页面级稳定 cache buster (避免每次重试重读)
    const PAGE_V = Date.now();

    // 调试开关: window.POETRY_DEBUG = true 打开 history/导航日志
    const DBG = () => !!(window.POETRY_DEBUG);
    const logNav = (...a) => { if (DBG()) try { console.log('[nav]', ...a); } catch (e) { /* ignore */ } };

    // 防 popstate 处理中再 pushState 导致历史栈污染
    let inPopstate = false;
    /**
     * 统一 pushState: 集中处理 try-catch, 防止隐私模式抛错.
     * 在 popstate 处理中调用会被静默忽略, 避免栈污染.
     */
    function pushHistoryState(pageName) {
        if (inPopstate) {
            logNav('pushState skipped (in popstate)', pageName);
            return;
        }
        try {
            history.pushState({ page: pageName }, '');
            logNav('push', pageName, 'len=', history.length);
        } catch (e) {
            logNav('pushState fail', e && e.message);
        }
    }

    // ============== 全局状态 ==============
    const State = {
        index: null,
        authors: null,
        liteBySrc: new Map(),      // source -> [lite items per part]
        liteById: new Map(),       // id -> lite item
        fullCache: new Map(),      // source -> {byId: Map, raw: Array}
        notesBySrc: new Map(),     // source -> Map<id, notes> (已加载的)
        notesLoadedParts: new Map(),// source -> Set<partName> 已加载的分片
        favSet: new Set(),
        readSet: new Set(),
        history: [],
        loaded: false,
        currentPage: 'home',
        // 列表分页
        listSource: null,
        listTitle: '诗词',
        listIds: [],
        listPartLoaded: 0,
        listOffset: 0,
        listPageSize: 20,
        listMode: 'category',
        listQuery: '',
        activePoem: null,
        // 注释全局默认 (持久化), 详情页临时切换另存 tmpAnnoOverride
        annoDefault: { tr: true, ex1: true, int: false },
        tmpAnnoOverride: null,  // { tr?, ex1?, int? } 仅本次, null 表示不覆盖
    };

    // ============== DOM 工具 ==============
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    function setLoading(percent, msg) {
        const mask = $('#loadingMask');
        if (!mask) return;
        if (percent >= 100) { mask.classList.add('hide'); return; }
        const bar = mask.querySelector('.load-bar');
        const txt = mask.querySelector('.load-text');
        if (bar) bar.style.width = percent + '%';
        if (txt) txt.textContent = msg || (percent + '%');
    }

    // ============== 数据加载器 (核心) ==============
    const Loader = (function () {
        // 并发去重: key -> Promise
        const inflight = new Map();

        /** 把源名转成与 build_data.py 一致的变量名后缀 */
        function varSuffix(source) {
            return String(source || '').replace(/[^\w\u4e00-\u9fff\-]/g, '_').replace(/-/g, '_');
        }

        /** 注入 <script> 加载 js, 返回 Promise */
        function loadScript(url, timeoutMs) {
            return new Promise((resolve, reject) => {
                const s = document.createElement('script');
                let done = false;
                const cleanup = () => {
                    if (s.parentNode) s.parentNode.removeChild(s);
                    clearTimeout(timer);
                };
                const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
                const fail = (e) => { if (done) return; done = true; cleanup(); reject(e); };
                s.src = url + (url.indexOf('?') < 0 ? '?v=' : '&v=') + PAGE_V;
                s.async = false;
                s.onload = ok;
                s.onerror = () => fail(new Error('script load fail: ' + url));
                const timer = setTimeout(() => fail(new Error('script timeout: ' + url)), timeoutMs || SCRIPT_TIMEOUT_MS);
                document.head.appendChild(s);
            });
        }

        /** 带超时的 fetch */
        function fetchJSON(url, timeoutMs) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
            return fetch(url, { signal: ctrl.signal })
                .then(r => {
                    clearTimeout(timer);
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .catch(e => { clearTimeout(timer); throw e; });
        }

        /** 通用重试 */
        function withRetry(fn, max) {
            return new Promise((resolve, reject) => {
                let attempt = 0;
                const run = () => {
                    fn().then(resolve, err => {
                        if (++attempt >= max) return reject(err);
                        setTimeout(run, 300 * attempt);
                    });
                };
                run();
            });
        }

        /** 通用去重 */
        function dedup(key, factory) {
            if (inflight.has(key)) return inflight.get(key);
            const p = factory().finally(() => inflight.delete(key));
            inflight.set(key, p);
            return p;
        }

        /** 加载 lite 分片: 优先 window 变量, 再 script 注入, 再 fetch */
        function loadLite(source, partIdx) {
            const part = (State.index && State.index.source_parts && State.index.source_parts[source] || [])[partIdx];
            if (!part) return Promise.reject(new Error('no such part: ' + source + '#' + partIdx));
            const varName = 'POEM_LITE_' + varSuffix(source) + '_p' + partIdx;
            const jsFile = part.jsfile || (part.file && part.file.replace(/\.json$/, '.js'));
            const key = 'lite|' + source + '|' + partIdx;

            return dedup(key, () => {
                // 1. 已注入?
                if (window[varName]) return Promise.resolve(window[varName]);
                // 2. script 注入
                if (jsFile) {
                    return withRetry(() => loadScript(SCRIPT_BASE + jsFile).then(() => {
                        if (window[varName]) return window[varName];
                        throw new Error('window var missing after load: ' + varName);
                    }), MAX_RETRY);
                }
                // 3. fetch 兜底
                return withRetry(() => fetchJSON(SCRIPT_BASE + part.file), MAX_RETRY);
            });
        }

        /** 加载 full 数据: 优先 window 变量, 再 script 注入, 再 fetch */
        function loadFull(source) {
            const varName = 'POEM_FULL_' + varSuffix(source);
            const safe = source.replace(/[^\w\u4e00-\u9fff\-]/g, '_');
            const jsFile = safe + '.js';
            const jsonFile = safe + '.json';
            const key = 'full|' + source;

            return dedup(key, () => {
                if (window[varName]) return Promise.resolve(window[varName]);
                return withRetry(() => loadScript(FULL_BASE + jsFile).then(() => {
                    if (window[varName]) return window[varName];
                    throw new Error('window var missing after load: ' + varName);
                }), MAX_RETRY)
                    .catch(() => withRetry(() => fetchJSON(FULL_BASE + jsonFile), MAX_RETRY));
            });
        }

        /** 加载单条 notes (按需). 从 POEM_NOTES_PART_INDEX 定位 poemId 所在分片, 注入对应 js, 返回 notes.
         *  返回 { notes, failed } -- notes 可能为 null (该诗无注释), failed 表示加载异常.
         *  优化: 不再强制加载所有分片, 只加载目标分片 (parts 数 1-18). */
        function loadNotes(source, poemId) {
            const partIdx = window.POEM_NOTES_PART_INDEX;
            if (!partIdx) return Promise.resolve({ notes: null, failed: true, reason: 'no_part_index' });
            const safe = source.replace(/[^\w\u4e00-\u9fff\-]/g, '_');
            const srcParts = partIdx[safe];
            if (!srcParts) return Promise.resolve({ notes: null, failed: false, reason: 'no_source' });
            // 缓存命中
            if (State.notesBySrc.has(source)) {
                const hit = State.notesBySrc.get(source).get(poemId);
                if (hit) return Promise.resolve({ notes: hit, failed: false });
            }
            // 找到 poemId 所在分片
            let targetParts = [];
            for (const partName of Object.keys(srcParts)) {
                if (srcParts[partName].indexOf(poemId) >= 0) {
                    targetParts.push(partName);
                    break;
                }
            }
            if (targetParts.length === 0) {
                // 未找到: 该诗在此 source 无注释 (可能是 src 中本就没注这首诗)
                return Promise.resolve({ notes: null, failed: false, reason: 'no_id_in_source' });
            }
            const loadPromises = targetParts.map(partName => {
                const partKey = 'notes|' + source + '|' + partName;
                return dedup(partKey, () => {
                    const varName = 'POEM_NOTES_' + partName.replace(/-/g, '_');
                    if (window[varName]) return Promise.resolve(window[varName]);
                    return withRetry(() => loadScript(NOTES_BASE + partName + '.js').then(() => {
                        if (window[varName]) return window[varName];
                        throw new Error('window var missing: ' + varName);
                    }), MAX_RETRY)
                        .catch(() => withRetry(() => fetchJSON(NOTES_BASE + partName + '.json'), MAX_RETRY))
                        .then(data => {
                            if (!State.notesBySrc.has(source)) State.notesBySrc.set(source, new Map());
                            const m = State.notesBySrc.get(source);
                            data.forEach(item => m.set(item.id, item.n));
                            return data;
                        });
                });
            });
            return Promise.all(loadPromises).then(() => {
                const notes = (State.notesBySrc.get(source) || new Map()).get(poemId) || null;
                return { notes, failed: false };
            }).catch(err => {
                return { notes: null, failed: true, reason: err && err.message || 'load_fail' };
            });
        }

        return { loadLite, loadFull, loadNotes, varSuffix };
    })();

    // ============== 启动: 加载 index + authors ==============
    async function loadData() {
        setLoading(10, '正在加载索引...');
        // 1. 优先 window.POEM_INDEX (index.html 已同步注入)
        if (window.POEM_INDEX) {
            State.index = window.POEM_INDEX;
        } else {
            // 兜底: 动态加载
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'data/index.js?v=' + PAGE_V;
                s.onload = resolve;
                s.onerror = () => reject(new Error('load index.js fail'));
                document.head.appendChild(s);
            }).catch(async () => {
                const data = await fetch('data/index.json').then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                });
                State.index = data;
            });
            if (!State.index && window.POEM_INDEX) State.index = window.POEM_INDEX;
        }
        if (!State.index) throw new Error('index 数据为空');

        setLoading(50, '正在加载作者...');
        // 2. authors
        if (window.POEM_AUTHORS) {
            State.authors = window.POEM_AUTHORS;
        } else {
            try {
                const r = await fetch('data/authors.json');
                if (r.ok) State.authors = await r.json();
            } catch (e) { /* authors 非关键, 静默 */ }
        }
        if (!State.authors) State.authors = {};

        setLoading(100, '加载完成');
        State.loaded = true;
        renderHome();
    }

    // ============== 分类 lite 分片懒加载 ==============
    async function ensureLitePart(source, partIdx) {
        const key = source + '|' + partIdx;
        if (!State.liteBySrc.has(source)) State.liteBySrc.set(source, []);
        const arr = State.liteBySrc.get(source);
        if (arr[partIdx]) return arr[partIdx];
        const data = await Loader.loadLite(source, partIdx);
        if (!data) return null;
        arr[partIdx] = data;
        data.forEach(p => State.liteById.set(p.id, p));
        return data;
    }

    // ============== 详情 full 懒加载 ==============
    async function ensureFullLoaded(source) {
        if (State.fullCache.has(source)) return State.fullCache.get(source);
        const data = await Loader.loadFull(source);
        const byId = new Map();
        data.forEach(p => byId.set(p.id, p));
        const obj = { byId, raw: data };
        State.fullCache.set(source, obj);
        return obj;
    }

    // ============== 存储 ==============
    function loadHistory() { try { return JSON.parse(localStorage.getItem(STORAGE.history) || '[]'); } catch (e) { return []; } }
    function saveHistory(l) { try { localStorage.setItem(STORAGE.history, JSON.stringify(l)); } catch (e) { /* 隐私模式可能失败 */ } }
    function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(STORAGE.favs) || '[]')); } catch (e) { return new Set(); } }
    function saveFavs() { try { localStorage.setItem(STORAGE.favs, JSON.stringify([...State.favSet])); } catch (e) { /* ignore */ } }
    function loadRead() { try { return new Set(JSON.parse(localStorage.getItem(STORAGE.read) || '[]')); } catch (e) { return new Set(); } }
    function saveRead() { try { localStorage.setItem(STORAGE.read, JSON.stringify([...State.readSet])); } catch (e) { /* ignore */ } }
    function loadAnno() {
        try {
            const v = JSON.parse(localStorage.getItem(STORAGE.anno) || 'null');
            if (v && typeof v === 'object') {
                return {
                    tr: v.tr !== undefined ? !!v.tr : State.annoDefault.tr,
                    ex1: v.ex1 !== undefined ? !!v.ex1 : State.annoDefault.ex1,
                    int: v.int !== undefined ? !!v.int : State.annoDefault.int,
                };
            }
        } catch (e) { /* ignore */ }
        return { ...State.annoDefault };
    }
    function saveAnno() { try { localStorage.setItem(STORAGE.anno, JSON.stringify(State.annoDefault)); } catch (e) { /* ignore */ } }

    /** 计算当前有效显示设置: 临时覆盖优先, 否则用全局默认 */
    function effectiveAnno() {
        if (State.tmpAnnoOverride) {
            return {
                tr: State.tmpAnnoOverride.tr !== undefined ? State.tmpAnnoOverride.tr : State.annoDefault.tr,
                ex1: State.tmpAnnoOverride.ex1 !== undefined ? State.tmpAnnoOverride.ex1 : State.annoDefault.ex1,
                int: State.tmpAnnoOverride.int !== undefined ? State.tmpAnnoOverride.int : State.annoDefault.int,
            };
        }
        return { ...State.annoDefault };
    }

    // ============== 主题/字体 ==============
    function applyTheme() { document.documentElement.setAttribute('data-theme', localStorage.getItem(STORAGE.theme) || 'light'); }
    function toggleTheme() {
        const t = document.documentElement.getAttribute('data-theme');
        localStorage.setItem(STORAGE.theme, t === 'dark' ? 'light' : 'dark');
        applyTheme();
        toast('已切换为' + (t === 'dark' ? '亮色' : '暗色') + '主题');
    }
    function applyFontSize() { document.documentElement.style.setProperty('--font-base', (localStorage.getItem(STORAGE.fontSize) || '16') + 'px'); }
    function setFontSize(sz) { localStorage.setItem(STORAGE.fontSize, String(sz)); applyFontSize(); }
    function applyFontFamily() {
        const f = localStorage.getItem(STORAGE.fontFamily) || 'serif';
        const v = f === 'kai' ? 'var(--font-kai)' : (f === 'fang' ? 'var(--font-fang)' : 'var(--font-family)');
        document.documentElement.style.setProperty('--font-family', v);
    }
    function setFontFamily(f) { localStorage.setItem(STORAGE.fontFamily, f); applyFontFamily(); }

    // ============== 导航 ==============
    function switchPage(name) {
        State.currentPage = name;
        $$('.page').forEach(p => p.classList.remove('active'));
        const el = $('#page-' + name);
        if (el) el.classList.add('active');
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.page === name));
        window.scrollTo(0, 0);
        if (name === 'home') renderHome();
        else if (name === 'author') renderAuthorPage();
        else if (name === 'list') {
            // 列表页: 重新渲染 (popstate 回到 list 时, 数据应还在 State)
            renderListHeader();
            renderList();
        } else if (name === 'detail') {
            // 详情页: popstate 回到 detail 时, 重新渲染 (activePoem 应还在)
            if (State.activePoem) renderDetail();
        }
    }

    // ============== 首页 ==============
    async function renderHome() {
        if (!State.loaded) return;
        // 加载第一个分类的 lite_p0 用于"今日一诗"
        let podHtml = '<div class="pod-label">今日一诗</div><div class="pod-body">点击下方分类浏览诗词</div>';
        try {
            await ensureLitePart('唐诗三百首', 0);
            const arr = State.liteBySrc.get('唐诗三百首')[0];
            if (arr && arr.length) {
                const today = new Date();
                const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
                const idx = seed % arr.length;
                const p = arr[idx];
                podHtml = `
                    <div class="pod-label">${greetingByHour()} · 今日一诗</div>
                    <div class="pod-title">${escapeHtml(p.t)}</div>
                    <div class="pod-author">${escapeHtml(p.a)}${p.rh ? ' · ' + escapeHtml(p.rh) : ''}</div>
                    <div class="pod-body">${escapeHtml(p.p0)}</div>
                    <div class="pod-footer" onclick="App.openPoem('${p.id}')">阅读全诗 →</div>
                `;
            }
        } catch (e) { /* 静默, 不影响首页展示 */ }
        const pod = $('#pod');
        if (pod) pod.innerHTML = podHtml;

        const catGrid = $('#catGrid');
        if (catGrid) {
            const cats = [
                { name: '唐诗三百首', source: '唐诗三百首' },
                { name: '全唐诗', source: '全唐诗' },
                { name: '宋词三百首', source: '宋词三百首' },
                { name: '宋词', source: '宋词' },
                { name: '诗经', source: '诗经' },
                { name: '楚辞', source: '楚辞' },
                { name: '元曲', source: '元曲' },
                { name: '曹操集', source: '曹操诗集' },
                { name: '纳兰性德', source: '纳兰性德' },
            ];
            catGrid.innerHTML = cats.map(c => {
                const ids = (State.index.by_source && State.index.by_source[c.source]) || [];
                return `<div class="cat-card" onclick="App.openCategory('${escapeAttr(c.source)}', '${escapeAttr(c.name)}')">
                    <div class="cat-name">${escapeHtml(c.name)}</div>
                    <div class="cat-count">${ids.length.toLocaleString()} 首</div>
                </div>`;
            }).join('');
        }
    }
    function greetingByHour() {
        const h = new Date().getHours();
        if (h < 6) return '夜深'; if (h < 11) return '晨起';
        if (h < 14) return '午时'; if (h < 18) return '午后';
        if (h < 22) return '夜读'; return '夜深';
    }

    // ============== 列表 ==============
    async function openCategory(source, label) {
        pushHistoryState('list');
        State.listMode = 'category';
        State.listSource = source;
        State.listTitle = label;
        State.listIds = (State.index.by_source && State.index.by_source[source]) || [];
        State.listPartLoaded = 0;
        State.listOffset = 0;
        State.listPageSize = 20;
        switchPage('list');
        renderListHeader();
        const container = $('#listContainer');
        const more = $('#listMore');
        container.innerHTML = '<div class="loading">加载中...</div>';
        more.classList.add('hide');
        try {
            await ensureLitePart(source, 0);
            State.listPartLoaded = 1;
            container.innerHTML = '';
            renderList();
        } catch (e) {
            container.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}<br><br><a onclick="App.openCategory('${escapeAttr(source)}','${escapeAttr(label)}')">点击重试</a></div>`;
        }
    }

    async function openAuthor(name) {
        const ids = (State.index.by_author && State.index.by_author[name]) || [];
        if (ids.length === 0) { toast('该作者无作品'); return; }
        pushHistoryState('list');
        State.listMode = 'author';
        State.listSource = null;
        State.listTitle = name;
        State.listIds = ids;
        State.listOffset = 0;
        switchPage('list');
        renderListHeader();
        $('#listContainer').innerHTML = '<div class="loading">加载中...</div>';
        try {
            const source = findAuthorSource(name);
            if (source) {
                const parts = (State.index.source_parts && State.index.source_parts[source]) || [];
                // 串行加载所有分片, 保证 liteById 完整
                for (let i = 0; i < parts.length; i++) {
                    await ensureLitePart(source, i);
                }
            } else {
                // 未找到源: 兜底扫描所有 source 的 part 0, 至少保证诗人页可用
                const allSources = Object.keys(State.index.by_source || {});
                await Promise.all(allSources.map(s => ensureLitePart(s, 0).catch(() => null)));
                const found = findAuthorSource(name);
                if (!found) {
                    $('#listContainer').innerHTML = `<div class="empty">未找到作者 "${escapeHtml(name)}" 的作品<br><br>请先在诗库中浏览相关分类</div>`;
                    $('#listMore').classList.add('hide');
                    return;
                }
                // 找到后再补全该源剩余分片
                const parts = (State.index.source_parts && State.index.source_parts[found]) || [];
                for (let i = 1; i < parts.length; i++) {
                    await ensureLitePart(found, i);
                }
            }
            $('#listContainer').innerHTML = '';
            renderList();
        } catch (e) {
            $('#listContainer').innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
        }
    }

    function findAuthorSource(name) {
        const bySource = State.index.by_source || {};
        for (const src of Object.keys(bySource)) {
            const arr = State.liteBySrc.get(src) || [];
            for (const part of arr) {
                if (part && part.some(p => p.a === name)) return src;
            }
        }
        // 退化: 直接用 by_author 第一个 id 反查
        return null;
    }

    // 搜索: 仅在已加载的 liteById 中查找
    function searchPoems(q) {
        q = (q || '').trim();
        if (!q) {
            State.listIds = [];
            State.listMode = 'search';
            return;
        }
        State.listMode = 'search';
        State.listQuery = q;
        const ids = [];
        State.liteById.forEach(p => {
            if (!p) return;
            if (p.t && p.t.includes(q)) ids.push(p.id);
            else if (p.a && p.a.includes(q)) ids.push(p.id);
            else if (p.p0 && p.p0.includes(q)) ids.push(p.id);
            else if (p.tags && p.tags.some(t => t && t.includes(q))) ids.push(p.id);
        });
        State.listIds = ids;
        State.listOffset = 0;
    }

    function renderListHeader() {
        const title = $('#listTitle');
        const count = $('#listCount');
        if (title) title.textContent = State.listTitle;
        if (count) count.textContent = `共 ${State.listIds.length.toLocaleString()} 首`;
    }

    async function renderList() {
        const list = $('#listContainer');
        if (!list) return;
        // 分类模式: 按分片懒加载
        if (State.listMode === 'category' && State.listSource) {
            const source = State.listSource;
            const parts = (State.index.source_parts && State.index.source_parts[source]) || [];
            // 找到第一个已加载的分片
            let curArr = null;
            let curPart = -1;
            for (let i = 0; i < parts.length; i++) {
                const arr = State.liteBySrc.get(source) ? State.liteBySrc.get(source)[i] : null;
                if (arr) { curArr = arr; curPart = i; break; }
            }
            if (!curArr) {
                list.innerHTML = '<div class="loading">加载中...</div>';
                try {
                    await ensureLitePart(source, 0);
                } catch (e) {
                    list.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
                    return;
                }
                State.listPartLoaded = 1;
                list.innerHTML = '';
                return renderList();
            }
            const partIds = State.index.by_source[source].slice(parts[curPart].start, parts[curPart].end);
            const visibleIds = partIds.filter(id => State.listIds.indexOf(id) >= 0);
            const start = State.listOffset;
            const slice = visibleIds.slice(start, start + State.listPageSize);
            const html = slice.map(id => {
                const p = State.liteById.get(id);
                if (!p) return '';
                return renderItem(p);
            }).join('');
            list.innerHTML = (start > 0 ? list.innerHTML : '') + html;
            State.listOffset += slice.length;
            const partDone = State.listOffset >= visibleIds.length;
            const more = $('#listMore');
            if (partDone && curPart + 1 < parts.length) {
                more.textContent = '加载下一分片...';
                more.classList.remove('hide');
                try {
                    await ensureLitePart(source, curPart + 1);
                    State.listPartLoaded = Math.max(State.listPartLoaded, curPart + 2);
                    State.listOffset = 0;
                    renderList();
                } catch (e) {
                    more.textContent = '加载失败, 点击重试';
                    more.onclick = () => { more.onclick = null; renderList(); };
                }
            } else if (curPart + 1 >= parts.length && State.listOffset >= visibleIds.length) {
                more.classList.add('hide');
            } else {
                more.textContent = '点击加载更多 ↓';
                more.classList.remove('hide');
            }
            return;
        }
        // 其它模式: 直接按 State.listIds 渲染
        const start = State.listOffset;
        const slice = State.listIds.slice(start, start + State.listPageSize);
        if (slice.length === 0) {
            list.innerHTML = '<div class="empty">无匹配诗词<br><br>提示: 搜索基于已浏览的诗词</div>';
            $('#listMore').classList.add('hide');
            return;
        }
        const html = slice.map(id => {
            const p = State.liteById.get(id);
            if (!p) {
                return `<div class="poem-item" style="opacity:0.5;"><div class="pi-title">未加载</div><div class="pi-author">id: ${id}</div></div>`;
            }
            return renderItem(p);
        }).join('');
        list.innerHTML = (start > 0 ? list.innerHTML : '') + html;
        State.listOffset += slice.length;
        const hasMore = State.listOffset < State.listIds.length;
        const more = $('#listMore');
        more.classList.toggle('hide', !hasMore);
        more.textContent = '点击加载更多 ↓';
    }

    function renderItem(p) {
        const isRead = State.readSet.has(p.id);
        const isFav = State.favSet.has(p.id);
        return `<div class="poem-item ${isRead ? 'read' : ''} ${isFav ? 'fav' : ''}" onclick="App.openPoem('${p.id}')">
            <div class="pi-title">${escapeHtml(p.t)}</div>
            <div class="pi-author">${escapeHtml(p.a)}${p.rh ? ' · ' + escapeHtml(p.rh) : ''}</div>
            <div class="pi-preview">${escapeHtml(p.p0)}</div>
        </div>`;
    }

    function loadMoreList() { renderList(); }

    // ============== 详情 ==============
    // 当前正在加载的注释请求版本, 防止旧请求覆盖新诗
    let annoLoadVer = 0;

    async function openPoem(id, opts) {
        opts = opts || {};
        const pushHistory = opts.pushHistory !== false;  // 翻页场景传 false
        const lite = State.liteById.get(id);
        if (!lite) { toast('诗词未加载, 请先浏览该分类'); return; }
        // 进入详情 -> 推入 WebView 历史 (Android 返回键会触发 popstate 切回)
        if (pushHistory) pushHistoryState('detail');
        $('#detailBody').textContent = '加载中...';
        $('#detailAnnotations').innerHTML = '';
        switchPage('detail');
        // 切换诗时清空临时覆盖, 使用全局默认
        State.tmpAnnoOverride = null;
        try {
            const source = lite.src || findSourceOfId(id);
            if (!source) throw new Error('未找到该诗词所在分类');
            const full = await ensureFullLoaded(source);
            const p = full.byId.get(id) || lite;
            State.activePoem = p;
            State.readSet.add(id);
            saveRead();
            const list = loadHistory();
            const filtered = list.filter(r => r.id !== id);
            filtered.unshift({ id, t: p.t, a: p.a, time: Date.now() });
            if (filtered.length > 100) filtered.length = 100;
            saveHistory(filtered);
            State.history = filtered;
            renderDetail();
            // 异步加载注释 (不阻塞主显示)
            loadAndRenderAnno(source, id);
        } catch (e) {
            $('#detailBody').textContent = '加载失败: ' + e.message;
        }
    }

    /** 异步加载并渲染注释 (保护: 切换诗时旧请求自动失效) */
    async function loadAndRenderAnno(source, id) {
        const myVer = ++annoLoadVer;
        const container = $('#detailAnnotations');
        if (!container) return;
        const eff = effectiveAnno();
        // 全部关闭则清空, 不发起网络
        if (!eff.tr && !eff.ex1 && !eff.int) {
            container.innerHTML = '';
            updateAnnoBtns();
            return;
        }
        container.innerHTML = '<div class="annotation-loading">正在加载注释...</div>';
        const result = await Loader.loadNotes(source, id);
        if (myVer !== annoLoadVer) return;  // 已被新诗覆盖
        if (result.failed) {
            container.innerHTML = `<div class="annotation-empty">注释加载失败: ${escapeHtml(result.reason || '未知错误')}</div>`;
            updateAnnoBtns();
            return;
        }
        renderAnnotations(result.notes);
        updateAnnoBtns();
    }

    function renderAnnotations(notes) {
        const container = $('#detailAnnotations');
        if (!container) return;
        const eff = effectiveAnno();
        // 全部关闭 -> 清空
        if (!eff.tr && !eff.ex1 && !eff.int) {
            container.innerHTML = '';
            return;
        }
        // 完全没有注释
        if (!notes || (!notes.tr && !notes.int && (!notes.ex1 || notes.ex1.length === 0))) {
            container.innerHTML = '<div class="annotation-empty">本诗暂无注释</div>';
            return;
        }
        const parts = [];
        if (eff.tr && notes.tr) {
            parts.push(`<div class="annotation-section">
                <div class="annotation-title">译文</div>
                <div class="annotation-content">${escapeHtml(notes.tr)}</div>
            </div>`);
        }
        if (eff.int && notes.int) {
            parts.push(`<div class="annotation-section">
                <div class="annotation-title">讲解</div>
                <div class="annotation-content">${escapeHtml(notes.int)}</div>
            </div>`);
        }
        if (eff.ex1 && notes.ex1 && notes.ex1.length) {
            const items = notes.ex1.map(it =>
                `<div class="ex1-item"><span class="ex1-word">${escapeHtml(it.w || '')}</span>${escapeHtml(it.m || '')}</div>`
            ).join('');
            parts.push(`<div class="annotation-section">
                <div class="annotation-title">字词注释</div>
                <div class="annotation-content ex1">${items}</div>
            </div>`);
        }
        // 当前设置都开启但某项无内容, 给一个空提示
        if (parts.length === 0) {
            container.innerHTML = '<div class="annotation-empty">本诗暂无对应注释</div>';
            return;
        }
        container.innerHTML = parts.join('');
    }

    /** 临时切换 (本次详情页有效, 不持久化) */
    function toggleAnno(type) {
        if (!State.activePoem) return;
        if (!State.tmpAnnoOverride) {
            State.tmpAnnoOverride = {
                tr: State.annoDefault.tr,
                ex1: State.annoDefault.ex1,
                int: State.annoDefault.int,
            };
        }
        State.tmpAnnoOverride[type] = !State.tmpAnnoOverride[type];
        // 已有 notes -> 立即重渲染; 否则按需加载
        const source = State.activePoem.src;
        const id = State.activePoem.id;
        if (State.notesBySrc.has(source) && State.notesBySrc.get(source).has(id)) {
            renderAnnotations(State.notesBySrc.get(source).get(id));
        } else {
            loadAndRenderAnno(source, id);
        }
        updateAnnoBtns();
    }

    function updateAnnoBtns() {
        const eff = effectiveAnno();
        const btns = [['#btn-tr', eff.tr], ['#btn-ex1', eff.ex1], ['#btn-int', eff.int]];
        btns.forEach(([sel, on]) => {
            const b = $(sel);
            if (b) b.classList.toggle('active', on);
        });
    }

    /** 设置全局默认 (从侧边菜单调用, 持久化) */
    function setAnnoDefault(type) {
        State.annoDefault[type] = !State.annoDefault[type];
        saveAnno();
        // 当前在详情页则同步刷新
        if (State.currentPage === 'detail' && State.activePoem) {
            // 详情页显示跟随全局 -> 清除临时覆盖
            State.tmpAnnoOverride = null;
            const source = State.activePoem.src;
            const id = State.activePoem.id;
            if (State.notesBySrc.has(source) && State.notesBySrc.get(source).has(id)) {
                renderAnnotations(State.notesBySrc.get(source).get(id));
            } else {
                loadAndRenderAnno(source, id);
            }
            updateAnnoBtns();
        }
        renderSideMenu();
    }

    function findSourceOfId(id) {
        const bySource = State.index.by_source || {};
        for (const src of Object.keys(bySource)) {
            if (bySource[src].indexOf(id) >= 0) return src;
        }
        return null;
    }

    function renderDetail() {
        const p = State.activePoem;
        if (!p) return;
        const isFav = State.favSet.has(p.id);
        const aInfo = (State.authors && State.authors[p.a]) || {};
        $('#detailTitle').textContent = p.t;
        $('#detailSubtitle').textContent = p.rh ? `〔${p.rh}〕` : '';
        $('#detailAuthor').innerHTML = aInfo.short
            ? `${escapeHtml(p.a)} · ${escapeHtml(aInfo.short)}`
            : escapeHtml(p.a);
        $('#detailAuthor').onclick = () => openAuthor(p.a);
        $('#detailBody').textContent = (p.p || []).join('\n');
        const tags = p.tags || [];
        $('#detailTags').innerHTML = tags.length
            ? tags.slice(0, 8).map(t => `<span class="d-tag">${escapeHtml(t)}</span>`).join('')
            : `<span class="d-tag">${escapeHtml(p.src || '')}</span>`;
        $('#btnFav').textContent = isFav ? '★ 已收藏' : '☆ 收藏';
        $('#btnFav').classList.toggle('active', isFav);
        // 注释按钮初始态
        updateAnnoBtns();
        // 翻页导航条: 根据当前列表位置更新按钮禁用态
        updateDetailNav();
    }

    /**
     * 查找当前 activePoem 在 State.listIds 中的下标.
     * @returns {number} -1 表示未找到 (例如从首页"今日一诗"直接进入)
     */
    function currentPoemIndex() {
        const p = State.activePoem;
        if (!p || !Array.isArray(State.listIds) || State.listIds.length === 0) return -1;
        return State.listIds.indexOf(p.id);
    }

    /**
     * 更新翻页按钮状态 (上一首/下一首禁用 + 位置 N/M).
     * 单条列表 / 不在 listIds 中 / listIds 为空 -> 整个 nav 隐藏.
     */
    function updateDetailNav() {
        const nav = $('#detailNav');
        const pos = $('#detailNavPos');
        const prev = $('#btnPrevPoem');
        const next = $('#btnNextPoem');
        if (!nav || !pos || !prev || !next) return;
        const ids = State.listIds || [];
        const idx = currentPoemIndex();
        if (idx < 0 || ids.length < 2) {
            // 不在可翻页上下文 (例如首页今日一诗), 或只有 1 首
            nav.classList.add('hide');
            return;
        }
        nav.classList.remove('hide');
        pos.textContent = (idx + 1) + ' / ' + ids.length;
        prev.disabled = idx <= 0;
        next.disabled = idx >= ids.length - 1;
        prev.classList.toggle('disabled', prev.disabled);
        next.classList.toggle('disabled', next.disabled);
    }

    /**
     * 跳转到上一首/下一首 (offset = -1 / +1).
     * 不修改 listOffset 和 listIds, 仅在当前列表内游走.
     * 翻页时复用 openPoem (异步加载 full + 注释 + 写历史).
     * 边界: 已是第一/最后 -> toast 提示, 不弹错.
     */
    async function stepPoem(offset) {
        const ids = State.listIds || [];
        if (ids.length === 0) { toast('当前列表为空'); return; }
        const idx = currentPoemIndex();
        if (idx < 0) { toast('当前页不在列表中, 无法翻页'); return; }
        const nextIdx = idx + offset;
        if (nextIdx < 0) { toast('已是第一首'); return; }
        if (nextIdx >= ids.length) { toast('已是最后一首'); return; }
        const nextId = ids[nextIdx];
        // 异步确保 lite 已加载 (跨分片场景: 下一首可能在未加载的分片)
        try {
            if (!State.liteById.has(nextId)) {
                const source = findSourceOfId(nextId);
                if (source) {
                    // 找到 nextId 所在分片
                    const parts = (State.index.source_parts && State.index.source_parts[source]) || [];
                    for (let i = 0; i < parts.length; i++) {
                        const partIds = (State.index.by_source[source] || []).slice(parts[i].start, parts[i].end);
                        if (partIds.indexOf(nextId) >= 0) {
                            await ensureLitePart(source, i);
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            logNav('stepPoem preload fail', e && e.message);
            toast('加载下一首失败, 请稍后重试');
            return;
        }
        if (!State.liteById.has(nextId)) {
            toast('该诗暂未加载, 请先浏览相关分类');
            return;
        }
        // 翻页: replaceState 替换当前 detail state (不增加栈深度),
        // 调用 openPoem 时传 {pushHistory:false} 避免重复 push,
        // 这样从列表进入详情后连续翻页, 物理返回键一次即回到列表.
        try {
            history.replaceState({ page: 'detail' }, '');
            logNav('stepPoem replaceState detail, len=', history.length);
        } catch (e) {
            logNav('stepPoem replaceState fail', e && e.message);
        }
        await openPoem(nextId, { pushHistory: false });
        window.scrollTo(0, 0);
    }

    function gotoNextPoem() { return stepPoem(1); }
    function gotoPrevPoem() { return stepPoem(-1); }

    function toggleFav() {
        const p = State.activePoem;
        if (!p) return;
        if (State.favSet.has(p.id)) { State.favSet.delete(p.id); toast('已取消收藏'); }
        else { State.favSet.add(p.id); toast('已收藏'); }
        saveFavs();
        renderDetail();
    }
    function toggleMask() {
        const body = $('#detailBody');
        body.classList.toggle('fade');
        $('#btnMask').textContent = body.classList.contains('fade') ? '显示全文' : '遮罩背诵';
    }

    // ============== 收藏 / 历史 ==============
    function renderFav() {
        pushHistoryState('list');
        const ids = [...State.favSet];
        State.listMode = 'fav';
        State.listSource = null;
        State.listTitle = '我的收藏';
        State.listIds = ids;
        State.listOffset = 0;
        renderListHeader();
        $('#listContainer').innerHTML = '';
        if (ids.length === 0) {
            $('#listContainer').innerHTML = '<div class="empty">还没有收藏任何诗词<br><br>在诗词详情页点击 ☆ 收藏 即可</div>';
            $('#listMore').classList.add('hide');
        } else {
            renderList();
        }
        $$('.page').forEach(p => p.classList.remove('active'));
        $('#page-list').classList.add('active');
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.page === 'fav'));
    }
    function renderHistoryPage() {
        const list = loadHistory();
        State.listMode = 'history';
        State.listSource = null;
        State.listTitle = '阅读历史';
        State.listIds = list.map(r => r.id);
        State.listOffset = 0;
        renderListHeader();
        $('#listContainer').innerHTML = '';
        if (State.listIds.length === 0) {
            $('#listContainer').innerHTML = '<div class="empty">还没有阅读历史<br><br>开始浏览诗词吧</div>';
            $('#listMore').classList.add('hide');
        } else {
            renderList();
        }
        $$('.page').forEach(p => p.classList.remove('active'));
        $('#page-list').classList.add('active');
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.page === 'history'));
    }

    // ============== 作者页 ==============
    function renderAuthorPage() {
        const authors = (State.index.authors || []).filter(n => ((State.index.by_author && State.index.by_author[n]) || []).length >= 3);
        const wrap = $('#authorGrid');
        if (wrap) {
            wrap.innerHTML = authors.map(name => {
                const cnt = (State.index.by_author[name] || []).length;
                return `<div class="cat-card" onclick="App.openAuthor('${escapeAttr(name)}')">
                    <div class="cat-name">${escapeHtml(name)}</div>
                    <div class="cat-count">${cnt} 首</div>
                </div>`;
            }).join('');
        }
    }

    // ============== 侧边菜单 ==============
    function openSideMenu() {
        $('#sideMenu').classList.add('open');
        $('#sideMask').classList.add('open');
        renderSideMenu();
    }
    function closeSideMenu() {
        $('#sideMenu').classList.remove('open');
        $('#sideMask').classList.remove('open');
    }
    function renderSideMenu() {
        const list = loadHistory();
        const total = (State.index && State.index.total) || 0;
        const ad = State.annoDefault;
        $('#sideMenuContent').innerHTML = `
            <div class="sm-header">
                <div class="sm-title">古诗词大全</div>
                <div class="sm-sub">共 ${total.toLocaleString()} 首 · 离线版</div>
            </div>
            <div class="sm-section">
                <div class="sm-section-title">设置</div>
                <a class="sm-item" onclick="App.toggleTheme()">主题：${document.documentElement.getAttribute('data-theme') === 'dark' ? '暗色' : '亮色'} (点击切换)</a>
                <a class="sm-item" onclick="App.cycleFont()">字体：${fontLabel()} (点击切换)</a>
                <a class="sm-item" onclick="App.cycleFontSize()">字号：${localStorage.getItem(STORAGE.fontSize) || '16'}px (点击切换)</a>
            </div>
            <div class="sm-section">
                <div class="sm-section-title">注释默认显示 (详情页可临时切换)</div>
                <div class="sm-anno-row">
                    <div class="sm-anno-btn ${ad.tr ? 'on' : ''}" onclick="App.setAnnoDefault('tr')">译</div>
                    <div class="sm-anno-btn ${ad.ex1 ? 'on' : ''}" onclick="App.setAnnoDefault('ex1')">注</div>
                    <div class="sm-anno-btn ${ad.int ? 'on' : ''}" onclick="App.setAnnoDefault('int')">讲</div>
                </div>
            </div>
            <div class="sm-section">
                <div class="sm-section-title">最近阅读</div>
                ${list.slice(0, 8).map(r => `<a class="sm-item" onclick="App.openPoem('${r.id}');App.closeSideMenu()">${escapeHtml(r.t)}<br><span style="color:var(--text-secondary);font-size:12px;">${escapeHtml(r.a)}</span></a>`).join('') || '<div style="padding:8px 16px;color:var(--text-secondary);font-size:13px;">暂无</div>'}
            </div>
            <div class="sm-section">
                <div class="sm-section-title">关于</div>
                <a class="sm-item">数据源: chinese-poetry/chinese-poetry (CC-BY-SA)</a>
                <a class="sm-item">注释源: byj233/ChinesePoetryLibrary</a>
                <a class="sm-item">完全离线 · 无需联网</a>
            </div>
        `;
    }
    function fontLabel() {
        const f = localStorage.getItem(STORAGE.fontFamily) || 'serif';
        return f === 'kai' ? '楷体' : (f === 'fang' ? '仿宋' : '宋体');
    }
    function cycleFont() {
        const cur = localStorage.getItem(STORAGE.fontFamily) || 'serif';
        const next = cur === 'serif' ? 'kai' : (cur === 'kai' ? 'fang' : 'serif');
        setFontFamily(next);
        renderSideMenu();
        toast('字体：' + fontLabel());
    }
    function cycleFontSize() {
        const cur = parseInt(localStorage.getItem(STORAGE.fontSize) || '16');
        const next = cur >= 22 ? 14 : (cur >= 18 ? 22 : cur + 2);
        setFontSize(next);
        renderSideMenu();
        toast('字号：' + next + 'px');
    }

    // ============== 工具 ==============
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
    }
    function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
    function toast(msg) {
        const t = $('#toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), 1800);
    }

    function bindEvents() {
        const mask = $('#sideMask');
        if (mask) mask.addEventListener('click', closeSideMenu);
        // popstate: WebView.goBack() 触发, 根据 history.state.page 切回对应页
        window.addEventListener('popstate', (ev) => {
            const page = (ev.state && ev.state.page) || 'home';
            logNav('pop', page, 'state=', ev.state, 'len=', history.length);
            inPopstate = true;
            try {
                switchPage(page);
            } finally {
                inPopstate = false;
            }
        });
        $$('.tab-btn').forEach(b => b.addEventListener('click', () => {
            const p = b.dataset.page;
            if (p === 'fav') renderFav();
            else if (p === 'history') renderHistoryPage();
            else switchPage(p);
        }));
        const search = $('#searchInput');
        if (search) {
            let tm;
            // 记录上一次搜索的 query, 避免重复进入搜索页时 push 多条历史
            let lastSearchQ = '';
            search.addEventListener('input', () => {
                clearTimeout(tm);
                tm = setTimeout(() => {
                    const q = search.value;
                    // 只在 query 变化或首次进入搜索时 pushState
                    if (q !== lastSearchQ) {
                        searchPoems(q);
                        State.listTitle = q ? '搜索：' + q : '全部诗词';
                        lastSearchQ = q;
                        if (q && State.currentPage !== 'list') {
                            pushHistoryState('list');
                        } else if (q && State.currentPage === 'list') {
                            // 列表内更新: 不入栈, 避免连续输入污染历史
                        } else if (!q && State.currentPage === 'list') {
                            // 清空: 也不入栈
                        }
                    }
                    $$('.page').forEach(p => p.classList.remove('active'));
                    $('#page-list').classList.add('active');
                    $$('.tab-btn').forEach(b => b.classList.remove('active'));
                    renderListHeader();
                    $('#listContainer').innerHTML = '';
                    renderList();
                }, 300);
            });
        }
        const toTop = $('#toTop');
        if (toTop) {
            window.addEventListener('scroll', () => {
                toTop.classList.toggle('show', window.scrollY > 300);
            });
        }
    }

    async function init() {
        applyTheme();
        applyFontSize();
        applyFontFamily();
        State.favSet = loadFavs();
        State.readSet = loadRead();
        State.history = loadHistory();
        State.annoDefault = loadAnno();   // 恢复全局默认
        bindEvents();
        try {
            await loadData();
            // 初始化 history.state, 让 goBack 第一次触发时也能拿到 state
            try {
                history.replaceState({ page: 'home' }, '');
                logNav('init replaceState home, len=', history.length);
            } catch (e) {
                logNav('init replaceState fail', e && e.message);
            }
        } catch (e) {
            const mask = $('#loadingMask');
            if (mask) {
                mask.innerHTML = `<div style="color:#a55;text-align:center;padding:40px;">
                    加载失败: ${escapeHtml(e.message)}<br><br>
                    <a style="color:var(--accent);text-decoration:underline;" onclick="location.reload()">点击重试</a>
                </div>`;
            }
        }
    }

    window.App = {
        openPoem, openCategory, openAuthor,
        toggleFav, toggleMask,
        toggleTheme, cycleFont, cycleFontSize,
        openSideMenu, closeSideMenu,
        loadMoreList,
        toggleAnno, setAnnoDefault,
        gotoNextPoem, gotoPrevPoem,
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

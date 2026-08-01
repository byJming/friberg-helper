// ==UserScript==
// @name         弗一把助手
// @namespace    shnlfriberg.helper
// @version      0.2.9
// @description  弗一把(CSGO 选手猜测)开源辅助：求解最优猜测并填入输入框，单人与多人联机自动接管，提交与否由你决定
// @match        https://shnlfriberg.online/*
// @homepageURL  https://github.com/byJming/friberg-helper
// @supportURL   https://github.com/byJming/friberg-helper/issues
// @downloadURL  https://github.com/byJming/friberg-helper/raw/main/friberg-helper.user.js
// @run-at       document-start
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const PAGE = unsafeWindow;
  const KEY_PLAYERS = 'friberg.players.v1';
  const KEY_STATS = 'friberg.stats.v1';
  const KEY_SETTINGS = 'friberg.settings.v1';

  const AGE_CLOSE = 3;
  const MAJOR_CLOSE = 1;
  const MODE_NAMES = { beginner: '入门版', easy: '简单版', normal: '完整版' };

  // ---------- 存储 ----------
  function loadPlayersCache() {
    try { return GM_getValue(KEY_PLAYERS, null); } catch (e) { return null; }
  }
  function savePlayersCache(cache) {
    try { GM_setValue(KEY_PLAYERS, cache); } catch (e) { /* quota */ }
  }
  function loadStats() {
    try { return GM_getValue(KEY_STATS, { modes: {}, games: [] }); } catch (e) { return { modes: {}, games: [] }; }
  }
  function saveStats(stats) {
    try { GM_setValue(KEY_STATS, stats); } catch (e) { /* quota */ }
  }
  function loadSettings() {
    try {
      const s = GM_getValue(KEY_SETTINGS, null) || {};
      if (s.autoFill === undefined) s.autoFill = true;
      if (s.autoSubmit === undefined) s.autoSubmit = false;
      if (!s.handicap) s.handicap = { enabled: false, minGuesses: 3, delaySec: 8, loseRate: 0.2 };
      return s;
    } catch (e) { return { autoFill: true, autoSubmit: false, handicap: { enabled: false, minGuesses: 3, delaySec: 8, loseRate: 0.2 } }; }
  }
  function saveSettings(s) {
    try { GM_setValue(KEY_SETTINGS, s); } catch (e) { /* quota */ }
  }

  // ---------- 求解器（移植自 scripts/solver.js） ----------
  function encodePlayers(players) {
    const code = (map, v) => {
      if (!map.has(v)) map.set(v, map.size);
      return map.get(v);
    };
    const natMap = new Map(), regMap = new Map(), teamMap = new Map(), roleMap = new Map();
    const enc = {
      n: players.length,
      nicks: new Array(players.length),
      nats: new Array(players.length),
      regs: new Array(players.length),
      teams: new Array(players.length),
      ages: new Array(players.length),
      roles: new Array(players.length),
      mcs: new Array(players.length),
      mas: new Array(players.length),
      acts: new Array(players.length),
    };
    players.forEach((p, i) => {
      enc.nicks[i] = p.nickname;
      enc.nats[i] = code(natMap, p.nationality);
      enc.regs[i] = code(regMap, p.region);
      enc.teams[i] = code(teamMap, p.team);
      enc.ages[i] = p.age;
      enc.roles[i] = code(roleMap, p.role);
      enc.mcs[i] = p.majorChampionships;
      enc.mas[i] = p.majorAppearances;
      enc.acts[i] = p.isActive ? 1 : 0;
    });
    return enc;
  }

  function feedbackKey(enc, g, a) {
    let k = 0;
    let nat;
    if (enc.nats[g] === enc.nats[a]) nat = 0;
    else if (enc.regs[g] === enc.regs[a]) nat = 1;
    else nat = 2;
    k = k * 3 + nat;
    k = k * 3 + (enc.regs[g] === enc.regs[a] ? 0 : 2);
    k = k * 3 + (enc.teams[g] === enc.teams[a] ? 0 : 2);
    let ageS;
    if (enc.ages[g] === enc.ages[a]) ageS = 0;
    else if (Math.abs(enc.ages[g] - enc.ages[a]) <= AGE_CLOSE) ageS = 1;
    else ageS = enc.ages[a] > enc.ages[g] ? 2 : 3;
    k = k * 4 + ageS;
    k = k * 3 + (enc.roles[g] === enc.roles[a] ? 0 : 2);
    let mcS;
    if (enc.mcs[g] === enc.mcs[a]) mcS = 0;
    else if (Math.abs(enc.mcs[g] - enc.mcs[a]) <= MAJOR_CLOSE) mcS = 1;
    else mcS = enc.mcs[a] > enc.mcs[g] ? 2 : 3;
    k = k * 4 + mcS;
    let maS;
    if (enc.mas[g] === enc.mas[a]) maS = 0;
    else if (Math.abs(enc.mas[g] - enc.mas[a]) <= MAJOR_CLOSE) maS = 1;
    else maS = enc.mas[a] > enc.mas[g] ? 2 : 3;
    k = k * 4 + maS;
    k = k * 3 + (enc.acts[g] === enc.acts[a] ? 0 : 2);
    return k;
  }

  const LEVEL_CODE = { correct: 0, close: 1, wrong: 2 };
  function feedbackKeyFromServer(attrs) {
    const lv = f => LEVEL_CODE[f.level];
    const num = f => (f.level === 'correct' ? 0 : f.level === 'close' ? 1 : f.hint === 'higher' ? 2 : 3);
    let k = 0;
    k = k * 3 + lv(attrs.nationality);
    k = k * 3 + lv(attrs.region);
    k = k * 3 + lv(attrs.team);
    k = k * 4 + num(attrs.age);
    k = k * 3 + lv(attrs.role);
    k = k * 4 + num(attrs.majorChampionships);
    k = k * 4 + num(attrs.majorAppearances);
    k = k * 3 + lv(attrs.isActive);
    return k;
  }

  function filterCandidates(enc, candidates, gIdx, keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return candidates.filter(c => list.includes(feedbackKey(enc, gIdx, c)));
  }

  // 历史答案频率（当前对局的难度），用于信息量相同时优先猜常见答案
  function guessExperience(nick) {
    const stats = loadStats();
    const mode = multi.active ? multi.mode : state.mode;
    if (!mode) return 0;
    const m = stats.modes[mode];
    return m ? (m.answers[nick] || 0) : 0;
  }

  function bestGuess(enc, candidates, pool) {
    const n = candidates.length;
    const counts = new Map();
    let bestIdx = -1;
    let bestEntropy = -Infinity;
    for (const g of pool) {
      counts.clear();
      for (const a of candidates) {
        const k = feedbackKey(enc, g, a);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let e = 0;
      for (const c of counts.values()) {
        const p = c / n;
        e -= p * Math.log2(p);
      }
      if (e > bestEntropy || (e === bestEntropy && (bestIdx < 0 || guessExperience(enc.nicks[g]) > guessExperience(enc.nicks[bestIdx])))) {
        bestEntropy = e;
        bestIdx = g;
      }
    }
    return bestIdx;
  }

  function minimaxGuess(enc, candidates, pool) {
    let best = candidates[0];
    let bestMax = Infinity;
    for (const g of pool) {
      const counts = new Map();
      for (const a of candidates) {
        const k = feedbackKey(enc, g, a);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let m = 0;
      for (const c of counts.values()) if (c > m) m = c;
      if (m < bestMax || (m === bestMax && guessExperience(enc.nicks[g]) > guessExperience(enc.nicks[best]))) {
        bestMax = m;
        best = g;
      }
    }
    return best;
  }

  function pickGuess(enc, candidates, pool, guessed, remaining) {
    const cands = guessed ? candidates.filter(c => !guessed.has(c)) : candidates;
    if (cands.length === 0) return candidates[0];
    if (cands.length === 1) return cands[0];
    if (cands.length <= remaining) {
      // 步数足够时信息量已不关键，优先猜历史高频答案以最快收尾
      return cands.slice().sort((x, y) => guessExperience(enc.nicks[y]) - guessExperience(enc.nicks[x]))[0];
    }
    const p = guessed ? pool.filter(c => !guessed.has(c)) : pool;
    if (cands.length <= 12) return minimaxGuess(enc, cands, p);
    return bestGuess(enc, cands, p);
  }

  // ---------- 全局状态 ----------
  let cache = null;          // {version, players}
  let enc = null;            // 编码后的选手
  let all = [];              // 索引 0..n-1
  let state = {
    inGame: false,
    mode: null,
    maxGuesses: 8,
    turn: 0,
    candidates: [],
    guessed: new Set(),
    lastIdx: -1,
  };
  const multi = {
    active: false,
    mode: null,
    turn: 0,
    candidates: [],
    guessed: new Set(),
    lastIdx: -1,
    lastRowCount: 0,
    lastAnswer: '',
    fillPending: null,
    lastRound: null,
    ended: false,
    handicapLose: false,
    handicapSkipDone: false,
    awaitingRow: false,
    awaitingRowAt: 0,
    autoSubmit: { pending: false, lastClick: 0, nextAttemptAt: 0, delayUntil: 0 },
  };

  // ---------- 控场模式（多人） ----------
  // 目标：避免快速碾压导致对手没有体验。本局掷骰放水时直接跳过（判负），
  // 否则限制每局最少猜测次数、并延迟提交，拉长对局节奏。
  function handicapEnabled() {
    return loadSettings().handicap.enabled;
  }

  function handicapConfig() {
    return loadSettings().handicap;
  }

  // 每局开始时掷骰，决定本局是否放水
  function rollHandicapLose() {
    const h = handicapConfig();
    multi.handicapLose = h.enabled && Math.random() < h.loseRate;
    multi.handicapSkipDone = false;
    return multi.handicapLose;
  }

  // 提交前延迟（毫秒），控场开启时在 0.5s~delaySec 之间随机
  function handicapDelayMs() {
    const h = handicapConfig();
    if (!h.enabled || !h.delaySec) return 0;
    return Math.floor((0.5 + Math.random() * h.delaySec) * 1000);
  }

  // 放水：点击"跳过本局"按钮（lucide-skip-forward 图标定位，语言无关）
  function clickSkipButton() {
    const svg = document.querySelector('svg.lucide-skip-forward');
    if (!svg) return false;
    const btn = svg.closest('button');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }

  // 提交链路参数：按钮需等 React 异步刷新自动补全列表后才可点；
  // 服务端有 1.5s 猜间隔冷却，重试必须留出余量。
  const SUBMIT_RETRY_MS = 60;
  const SUBMIT_WAIT_BUTTON_MAX = 30;
  const SUBMIT_CONFIRM_TIMEOUT = 2500;
  const GUESS_COOLDOWN_MS = 1600;

  // ---------- 数据同步 ----------
  const GITHUB_DB_URL = 'https://raw.githubusercontent.com/shnlfriberg/csgo-major-db/main/players.json';
  const GITHUB_API_COMMITS = 'https://api.github.com/repos/shnlfriberg/csgo-major-db/commits?per_page=1';
  const GITHUB_TIMEOUT_MS = 10_000;

  // 从 GitHub 数据仓库拉取选手属性（snake_case、无 id）。
  // 页面 CSP 的 connect-src 不含 raw.githubusercontent.com，必须用 GM_xmlhttpRequest
  //（扩展沙箱执行，不受页面 CSP 与 CORS 限制），超时/网络错误抛出统一错误码。
  function fetchGitHubDb() {
    return new Promise((resolve, reject) => {
      const fail = () => { clearTimeout(timer); reject(new Error('GITHUB_DB_UNAVAILABLE')); };
      const timer = setTimeout(fail, GITHUB_TIMEOUT_MS);
      GM_xmlhttpRequest({
        method: 'GET',
        url: GITHUB_DB_URL,
        timeout: GITHUB_TIMEOUT_MS,
        onload: res => {
          clearTimeout(timer);
          try {
            const obj = JSON.parse(res.responseText);
            if (Array.isArray(obj) && obj.length > 0) resolve(obj);
            else fail();
          } catch { fail(); }
        },
        onerror: fail,
        ontimeout: fail,
      });
    });
  }

  // 查询数据仓库最新提交 sha（用于更新检测），任何失败返回 null
  function fetchDbCommitSha() {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: GITHUB_API_COMMITS,
        timeout: GITHUB_TIMEOUT_MS,
        onload: res => {
          try {
            const arr = JSON.parse(res.responseText);
            const sha = arr && arr[0] && typeof arr[0].sha === 'string' ? arr[0].sha : null;
            resolve(sha);
          } catch { resolve(null); }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  /**
   * 选手库同步：完全从 csgo-major-db（csgofriberg 官方数据仓库）获取，不依赖游戏服务器，
   * 避免服务器限流影响。数据仓库字段为 snake_case 且不含 id，这里统一转为脚本内部格式。
   */
  async function fetchAllPlayers() {
    const [dbPlayers, commitSha] = await Promise.all([fetchGitHubDb(), fetchDbCommitSha()]);
    const players = dbPlayers
      .map(p => ({
        id: typeof p.id === 'number' ? p.id : null,
        nickname: p.nickname,
        nationality: p.nationality,
        region: p.region,
        team: p.team,
        age: p.age,
        role: p.role,
        majorChampionships: p.major_championships,
        majorAppearances: p.major_appearances,
        isActive: p.is_active !== undefined ? p.is_active : true,
        difficulties: Array.isArray(p.difficulties) ? p.difficulties : [],
      }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh-CN'));
    return { version: 'csgo-major-db', commitSha, players };
  }

  // 启动后检查数据仓库是否有新版本（10 分钟冷却），有新提交则提示手动同步
  let lastDbUpdateCheck = 0;
  function checkDbUpdate() {
    if (!cache || !cache.commitSha) return;
    if (Date.now() - lastDbUpdateCheck < 10 * 60_000) return;
    lastDbUpdateCheck = Date.now();
    fetchDbCommitSha().then(sha => {
      if (sha && cache && cache.commitSha && sha !== cache.commitSha) {
        setStatus('选手库数据仓库有新版本，点面板「同步选手库」更新');
      }
    });
  }

  const SYNC_ERROR_TEXT = {
    GITHUB_DB_UNAVAILABLE: 'GitHub 数据仓库不可用（网络问题），请用「导入 JSON」选择本地选手文件（如 data/players_full.json）',
  };
  function syncErrorMessage(err) {
    if (err instanceof Error && SYNC_ERROR_TEXT[err.message]) return SYNC_ERROR_TEXT[err.message];
    return '同步失败：' + (err instanceof Error ? err.message : String(err));
  }

  function ensureEncoded() {
    if (cache && cache.players && cache.players.length > 0) {
      enc = encodePlayers(cache.players);
      all = Array.from({ length: enc.n }, (_, i) => i);
      return true;
    }
    return false;
  }

  // 首次同步失败后仅自动重试一次（5 秒），再失败就交给手动导入/同步
  let retriedDataSync = false;

  async function ensureData() {
    if (ensureEncoded()) {
      if (state.inGame && state.lastIdx < 0) computeAndFill();
      return true;
    }
    if (retriedDataSync) {
      setStatus('选手库获取失败，请点面板「导入 JSON」选择本地选手文件，或稍后点「同步选手库」重试');
      return false;
    }
    // 首次使用无本地选手库：默认从 GitHub 数据仓库获取，失败 5 秒后自动重试一次
    setStatus('选手库为空：正在从 GitHub 数据仓库获取...');
    try {
      const fresh = await fetchAllPlayers();
      cache = fresh;
      savePlayersCache(fresh);
      ensureEncoded();
      setStatus(`选手库获取成功（v${fresh.version}，${fresh.players.length} 人）`);
      return true;
    } catch (e) {
      retriedDataSync = true;
      setStatus(syncErrorMessage(e) + '，5 秒后自动重试一次');
      setTimeout(() => { void ensureData(); }, 5000);
      return false;
    }
  }

  // ---------- 导入本地 JSON ----------
  // 兼容两种格式：脚本内部格式（camelCase + 可选 id）与 csgo-major-db 数据仓库格式（snake_case、无 id）
  function normalizePlayerFields(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof p.id === 'number' ? p.id : null,
      nickname: p.nickname,
      nationality: p.nationality,
      region: p.region,
      team: p.team,
      age: p.age,
      role: p.role,
      majorChampionships: p.majorChampionships !== undefined ? p.majorChampionships : p.major_championships,
      majorAppearances: p.majorAppearances !== undefined ? p.majorAppearances : p.major_appearances,
      isActive: p.isActive !== undefined ? p.isActive : (p.is_active !== undefined ? p.is_active : true),
      difficulties: Array.isArray(p.difficulties) ? p.difficulties : [],
    };
  }

  function importPlayersFromJson(obj) {
    const raw = Array.isArray(obj) ? obj : obj && obj.players;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, message: '格式无效：未找到 players 数组' };
    }
    const version = (obj && (obj.listVersion || obj.version)) || null;
    const players = raw.map(normalizePlayerFields);
    const need = ['nickname', 'nationality', 'region', 'team', 'age', 'role', 'majorChampionships', 'majorAppearances'];
    const sample = players.find(p => p && typeof p === 'object');
    if (!sample) return { ok: false, message: '格式无效：选手数据为空' };
    const missing = need.filter(k => !(k in sample));
    if (missing.length > 0) {
      return { ok: false, message: '选手数据缺少字段：' + missing.join(', ') };
    }
    const nicks = new Set(players.map(p => p.nickname));
    if (nicks.size !== players.length) {
      return { ok: false, message: '存在重复选手昵称' };
    }
    players.sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh-CN'));
    cache = { version, players };
    savePlayersCache(cache);
    ensureEncoded();
    if (state.inGame) {
      state.candidates = all.slice();
      state.guessed = new Set();
      state.turn = 0;
      state.lastIdx = -1;
      computeAndFill();
    }
    return { ok: true, version, count: players.length };
  }

  function pickJsonFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.remove();
        if (!f) return reject(new Error('未选择文件'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsText(f, 'utf-8');
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  async function importFromFile() {
    try {
      const text = await pickJsonFile();
      const obj = JSON.parse(text);
      const res = importPlayersFromJson(obj);
      if (res.ok) {
        setStatus(`导入成功：${res.count} 名选手` + (res.version ? `（v${res.version}）` : '（未含版本号）'));
      } else {
        setStatus('导入失败：' + res.message);
      }
    } catch (e) {
      setStatus('导入失败：' + e.message);
    }
  }

  // ---------- 经验积累 ----------
  function recordGame(mode, won, guesses, answerNick) {
    const stats = loadStats();
    const m = stats.modes[mode] || (stats.modes[mode] = { games: 0, wins: 0, guesses: 0, answers: {} });
    m.games++;
    if (won) m.wins++;
    m.guesses += guesses;
    if (answerNick) m.answers[answerNick] = (m.answers[answerNick] || 0) + 1;
    stats.games.push({ mode, won, guesses, answer: answerNick, at: Date.now() });
    if (stats.games.length > 200) stats.games.splice(0, stats.games.length - 200);
    saveStats(stats);
    return m;
  }

  // ---------- 对局逻辑 ----------
  function startGame(data) {
    ensureEncoded();
    state.inGame = true;
    state.mode = data.mode;
    state.maxGuesses = data.maxGuesses || 8;
    state.turn = 0;
    state.guessed = new Set();
    state.lastIdx = -1;
    state.candidates = all.slice();
    if (enc) computeAndFill();
  }

  function onGuess(data) {
    if (!state.inGame) return;
    const fb = data.feedback;
    const stats = loadStats();
    // 同步反馈中的权威属性到缓存库（下次对局生效）
    if (fb.attributes && fb.nickname) {
      const list = cache ? cache.players : null;
      if (list) {
        const p = list.find(x => x.nickname === fb.nickname);
        if (p) {
          const a = fb.attributes;
          p.nationality = a.nationality.value;
          p.region = a.region.value;
          p.team = a.team.value;
          p.age = a.age.value;
          p.role = a.role.value;
          p.majorChampionships = a.majorChampionships.value;
          p.majorAppearances = a.majorAppearances.value;
          p.isActive = a.isActive.value;
          savePlayersCache(cache);
        }
      }
    }
    if (fb.correct) {
      endGame(true, data.guessCount, data.answer && data.answer.nickname);
      return;
    }
    const key = feedbackKeyFromServer(fb.attributes);
    // 选手库来自数据仓库（无服务器 id），用昵称映射反馈
    const gIdx = fb.nickname ? enc.nicks.indexOf(fb.nickname) : -1;
    if (gIdx >= 0) {
      state.candidates = filterCandidates(enc, state.candidates, gIdx, key);
      state.guessed.add(gIdx);
    } else {
      setStatus('警告：服务器选手与本地库不一致，请同步数据');
    }
    state.turn = data.guessCount || state.turn + 1;
    computeAndFill();
  }

  function onGiveup(data) {
    if (!state.inGame) return;
    if (data.answer) {
      recordGame(state.mode, false, state.turn, data.answer.nickname);
      setStatus(`本局答案：${data.answer.nickname}（已记录）`);
    }
    state.inGame = false;
  }

  function endGame(won, guesses, answerNick) {
    const m = recordGame(state.mode, won, guesses, answerNick);
    setStatus(
      `本局${won ? '获胜' : '结束'}（${guesses} 步）· 该难度战绩 ${m.wins}/${m.games} 胜率 ${m.games ? Math.round(100 * m.wins / m.games) : 0}% 平均 ${m.games ? (m.guesses / m.games).toFixed(1) : '-'} 步`
    );
    state.inGame = false;
  }

  function computeAndFill() {
    if (!state.inGame || !enc) return;
    let cands = state.candidates;
    if (cands.length === 0) {
      setStatus('候选集已空（数据异常），请重新开始或同步数据');
      return;
    }
    const remaining = state.maxGuesses - state.turn;
    const g = pickGuess(enc, cands, all, state.guessed, remaining);
    state.lastIdx = g;
    const stats = loadStats();
    const modeStats = stats.modes[state.mode];
    const expCount = modeStats ? (modeStats.answers[enc.nicks[g]] || 0) : 0;
    renderPanel({
      mode: state.mode,
      cands: cands.length,
      total: enc.n,
      turn: state.turn,
      max: state.maxGuesses,
      nick: enc.nicks[g],
      exp: expCount,
      statusLine: state.statusLine || ''
    });
    if (loadSettings().autoFill) fillInput(enc.nicks[g]);
  }

  function fillInput(nickname, attempts, retryMs) {
    if (attempts === undefined) attempts = 8;
    if (retryMs === undefined) retryMs = 800;
    const input = document.querySelector('input[role="combobox"]');
    if (!input) {
      if (attempts > 0) {
        setTimeout(() => fillInput(nickname, attempts - 1, retryMs), retryMs);
        setStatus('等待输入框出现...');
      } else {
        setStatus('未找到输入框，请在单人对局页使用');
      }
      return false;
    }
    if (input.disabled) {
      if (attempts > 0) {
        setTimeout(() => fillInput(nickname, attempts - 1, retryMs), retryMs);
        setStatus('输入框不可用，等待页面加载完成...');
      } else {
        setStatus('输入框持续不可用，请手动填入');
      }
      return false;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, nickname);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setStatus(`已填入「${nickname}」，请按提交猜测`);
    return true;
  }

  // ---------- 多人模式（DOM 轮询解析，不依赖 WebSocket） ----------
  // 从对局状态栏识别难度（覆盖中/英/日文案）。
  // 不能读页面全文：大厅的难度选项按钮会同时出现全部难度文本导致误判；
  // 状态栏只含当前局的难度标签，且仅在对局/房间页存在。
  const MODE_WORDS = [
    { key: 'beginner', words: ['入门版', 'Beginner', '入門'] },
    { key: 'easy', words: ['简单版', 'Easy', 'イージー'] },
    { key: 'normal', words: ['完整版', 'Full', 'フル'] },
  ];
  function updateMultiModeFromText() {
    if (multi.mode) return;
    const statusEl = document.querySelector('.status-bar');
    if (!statusEl) return;
    const t = statusEl.innerText;
    for (const mode of MODE_WORDS) {
      if (mode.words.some(w => t.includes(w))) {
        multi.mode = mode.key;
        return;
      }
    }
  }

  // 按列索引解析（列头走 i18n 翻译，不能依赖 data-label 文案）；
  // 列顺序与页面一致：0 昵称, 1 队伍, 2 国家或地区, 3 年龄, 4 位置, 5 Major 冠军, 6 Major 次数, 7 状态
  function keyFromRow(row) {
    const cells = row.cells;
    const lv = td => {
      const cls = td ? String(td.className) : '';
      if (cls.includes('correct')) return 0;
      if (cls.includes('close')) return 1;
      return 2;
    };
    const num = td => {
      if (!td) return 0;
      const cls = String(td.className);
      if (cls.includes('correct')) return 0;
      if (cls.includes('close')) return 1;
      return td.querySelector('.dir svg.lucide-arrow-up') ? 2 : 3;
    };
    const natLv = lv(cells[2]);
    // 多人反馈不含地区维度：同国(correct)或不同国同地区(close)时地区必相同；
    // 国籍不同(wrong)时地区未知，两种编码都保留，避免错误排除同地区选手
    const regionOptions = natLv === 2 ? [0, 2] : [0];
    return regionOptions.map(region => {
      let k = 0;
      k = k * 3 + natLv;
      k = k * 3 + region;
      k = k * 3 + lv(cells[1]);
      k = k * 4 + num(cells[3]);
      k = k * 3 + lv(cells[4]);
      k = k * 4 + num(cells[5]);
      k = k * 4 + num(cells[6]);
      k = k * 3 + lv(cells[7]);
      return k;
    });
  }

  function computeMultiFill() {
    if (!enc) return;
    let cands = multi.candidates;
    if (cands.length === 0) {
      setStatus('多人：候选集已空（数据异常）');
      return;
    }
    // 放水局：不填不猜，等 pollMulti 点「跳过本局」
    if (multi.handicapLose) return;
    let g = pickGuess(enc, cands, all, multi.guessed, 8 - multi.turn);
    // 控场：每局最少猜测次数——候选集足够大时故意不猜最优，随机探路
    const h = handicapConfig();
    if (h.enabled && multi.turn < h.minGuesses && cands.length > 2) {
      const others = cands.filter(c => c !== g);
      if (others.length) g = others[Math.floor(Math.random() * others.length)];
    }
    multi.lastIdx = g;
    renderPanel({ mode: multi.mode, cands: cands.length, total: enc.n, turn: multi.turn, max: 8, nick: enc.nicks[g], exp: 0, statusLine });
    if (loadSettings().autoFill) {
      if (!fillMulti(enc.nicks[g])) multi.fillPending = enc.nicks[g];
    }
  }

  function fillMulti(nickname) {
    if (!fillInput(nickname, 12, 300)) return false;
    multi.fillPending = null;
    multi.awaitingRow = false;
    multi.awaitingRowAt = 0;
    if (loadSettings().autoSubmit) {
      multi.autoSubmit = { pending: true, lastClick: 0, nextAttemptAt: 0, delayUntil: Date.now() + handicapDelayMs() };
      void waitSubmitButton(nickname);
    }
    return true;
  }

  function waitSubmitButton(expected) {
    const my = multi.autoSubmit;
    let waited = 0;
    const tick = () => {
      if (multi.autoSubmit !== my || !my.pending) return;
      if (Date.now() < my.delayUntil) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
      if (Date.now() < my.nextAttemptAt) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
      const btn = document.querySelector('.input-bar button.btn');
      const input = document.querySelector('input[role="combobox"]');
      if (!btn || !input) return;
      const text = input.value.trim();
      if (!text) {
        my.pending = false;
        return;
      }
      if (expected && text.toLowerCase() !== expected.toLowerCase()) {
        my.pending = false;
        return;
      }
      if (btn.disabled) {
        if (waited < SUBMIT_WAIT_BUTTON_MAX) {
          waited++;
          setTimeout(tick, SUBMIT_RETRY_MS);
        }
        return;
      }
      my.lastClick = Date.now();
      my.nextAttemptAt = my.lastClick + GUESS_COOLDOWN_MS;
      btn.click();
      waitSubmitConfirm(expected);
    };
    setTimeout(tick, SUBMIT_RETRY_MS);
  }

  function waitSubmitConfirm(expected) {
    const my = multi.autoSubmit;
    let waited = 0;
    const tick = () => {
      if (multi.autoSubmit !== my) return;
      if (!multi.active || multi.ended) {
        my.pending = false;
        return;
      }
      const input = document.querySelector('input[role="combobox"]');
      if (input && input.value.trim() === '') {
        my.pending = false;
        // 提交成功前端会清空输入框，但行要等 React 渲染才出现。
        // 在行确认前禁止再填同一选手，否则重复提交（服务端 duplicate 又清空）死循环。
        multi.awaitingRow = true;
        multi.awaitingRowAt = Date.now();
        return;
      }
      waited++;
      if (waited * SUBMIT_RETRY_MS >= SUBMIT_CONFIRM_TIMEOUT) {
        waitSubmitButton(expected);
        return;
      }
      setTimeout(tick, SUBMIT_RETRY_MS);
    };
    setTimeout(tick, SUBMIT_RETRY_MS);
  }

  function multiLastRowWon(selfBoard) {
    const table = selfBoard.querySelector('.game-table');
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    const last = rows.length ? rows[rows.length - 1] : null;
    return Boolean(last && last.classList.contains('row-correct'));
  }

  function pollMulti() {
    if (!location.pathname.startsWith('/multi')) return;
    updateMultiModeFromText();
    const selfBoard = document.querySelector('.player-board-self');
    if (!selfBoard) {
      if (multi.active) {
        multi.active = false;
        multi.ended = false;
        multi.mode = null;
        multi.autoSubmit.pending = false;
        setStatus('多人：离开对局，等待下一场');
      }
      return;
    }
    const statusEl = document.querySelector('.status-bar');
    const roundM = statusEl ? statusEl.innerText.match(/第 (\d+) 局/) : null;
    const round = roundM ? Number(roundM[1]) : null;
    const table = selfBoard.querySelector('.game-table');
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    const n = rows.length;
    const answerEl = document.querySelector('.overlay-card .answer-name');
    const answerText = answerEl ? answerEl.textContent.trim() : '';
    const roundEnded = Boolean(answerText);
    if (!multi.active) {
      multi.active = true;
      multi.turn = 0;
      multi.guessed = new Set();
      multi.candidates = all.slice();
      multi.lastRowCount = 0;
      multi.lastAnswer = '';
      multi.fillPending = null;
      multi.lastRound = round;
      multi.ended = roundEnded;
      multi.autoSubmit.pending = false;
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
      rollHandicapLose();
      setStatus(`多人对局（${MODE_NAMES[multi.mode] || '?'}）已接管`);
      if (roundEnded) {
        multi.lastAnswer = answerText;
        const won = multiLastRowWon(selfBoard);
        recordGame(multi.mode || 'normal', won, multi.turn, multi.lastAnswer);
        setStatus(`多人${won ? '获胜' : '失利'}：答案 ${multi.lastAnswer}（已记录）`);
      } else {
        computeMultiFill();
      }
      return;
    }
    if (round !== null && round !== multi.lastRound) {
      multi.turn = 0;
      multi.guessed = new Set();
      multi.candidates = all.slice();
      multi.lastRowCount = 0;
      multi.lastIdx = -1;
      multi.fillPending = null;
      multi.ended = false;
      multi.autoSubmit = { pending: false, lastClick: 0, nextAttemptAt: 0, delayUntil: 0 };
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
      rollHandicapLose();
      computeMultiFill();
      multi.lastRound = round;
      return;
    }
    if (round !== null) multi.lastRound = round;
    if (roundEnded) {
      multi.ended = true;
      multi.fillPending = null;
      multi.autoSubmit.pending = false;
      if (multi.lastAnswer !== answerText) {
        multi.lastAnswer = answerText;
        const won = multiLastRowWon(selfBoard);
        recordGame(multi.mode || 'normal', won, multi.turn, multi.lastAnswer);
        setStatus(`多人${won ? '获胜' : '失利'}：答案 ${multi.lastAnswer}（已记录）`);
      }
    }
    if (multi.ended) {
      if (n < multi.lastRowCount) {
        multi.turn = 0;
        multi.guessed = new Set();
        multi.candidates = all.slice();
        multi.lastRowCount = n;
        multi.lastIdx = -1;
        multi.fillPending = null;
        multi.ended = false;
        multi.autoSubmit = { pending: false, lastClick: 0, nextAttemptAt: 0, delayUntil: 0 };
        multi.awaitingRow = false;
        multi.awaitingRowAt = 0;
        rollHandicapLose();
        computeMultiFill();
      } else {
        multi.lastRowCount = n;
      }
      return;
    }
    // 放水局：不填不猜，点「跳过本局」判负
    if (multi.handicapLose && !multi.handicapSkipDone) {
      if (clickSkipButton()) multi.handicapSkipDone = true;
      return;
    }
    if (multi.lastIdx < 0 && enc && multi.candidates.length > 0) {
      computeMultiFill();
    }
    // 提交后等待行确认：3 秒仍未出现则视为未成功（如服务端 duplicate 只清空输入不添行），解除等待继续
    if (multi.awaitingRow && Date.now() - multi.awaitingRowAt > 3000) {
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
    }
    if (multi.fillPending) {
      if (fillMulti(multi.fillPending)) multi.fillPending = null;
    }
    if (multi.lastIdx >= 0 && multi.turn === 0 && !multi.awaitingRow) {
      const input = document.querySelector('input[role="combobox"]');
      if (input && !input.disabled && input.value === '' && !multi.autoSubmit.pending) {
        fillMulti(enc.nicks[multi.lastIdx]);
      }
    }
    if (n < multi.lastRowCount) {
      multi.turn = 0;
      multi.guessed = new Set();
      multi.candidates = all.slice();
      multi.lastRowCount = 0;
      multi.fillPending = null;
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
      rollHandicapLose();
      computeMultiFill();
    }
    if (n > multi.lastRowCount) {
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
      const row = rows[n - 1];
      const nickEl = row.querySelector('td.name');
      const nick = nickEl ? nickEl.textContent.trim() : '';
      const key = keyFromRow(row);
      const gIdx = nick ? enc.nicks.indexOf(nick) : -1;
      if (gIdx >= 0) {
        const filtered = filterCandidates(enc, multi.candidates, gIdx, key);
        if (filtered.length === 0) {
          // 反馈无法匹配任何候选（行渲染过渡态等）：保留原候选集继续对局，不卡死
          setStatus('多人：反馈未能匹配候选集，已跳过本轮过滤');
        } else {
          multi.candidates = filtered;
        }
        multi.guessed.add(gIdx);
        multi.turn = n;
        computeMultiFill();
      } else {
        setStatus(`多人：无法识别猜测「${nick}」，请同步数据`);
      }
      multi.lastRowCount = n;
    } else {
      multi.lastRowCount = n;
    }
    if (multi.autoSubmit.pending && multi.lastIdx >= 0) {
      const input = document.querySelector('input[role="combobox"]');
      if (input && input.value.trim() === '') {
        multi.autoSubmit.pending = false;
        multi.awaitingRow = true;
        multi.awaitingRowAt = Date.now();
        return;
      }
      if (Date.now() >= multi.autoSubmit.nextAttemptAt) {
        waitSubmitButton(enc.nicks[multi.lastIdx]);
      }
    }
  }

  // ---------- 网络捕获 ----------
  const START_RE = /\/api\/game\/start$/;
  const GUESS_RE = /\/api\/game\/[^/]+\/guess$/;
  const GIVEUP_RE = /\/api\/game\/[^/]+\/giveup$/;

  let lastHandle = { key: '', at: 0 };
  function handleApi(method, url, data) {
    if (!data) return;
    const key = method + url + JSON.stringify(data).slice(0, 80);
    const now = Date.now();
    if (lastHandle.key === key && now - lastHandle.at < 500) return;
    lastHandle = { key, at: now };
    if (method === 'POST' && START_RE.test(url)) {
      startGame(data);
    } else if (method === 'POST' && GUESS_RE.test(url)) {
      onGuess(data);
    } else if (method === 'POST' && GIVEUP_RE.test(url)) {
      onGiveup(data);
    }
  }

  function hookXHR() {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (m, u, ...rest) {
      this.__fbUrl = String(u);
      this.__fbMethod = String(m).toUpperCase();
      return origOpen.call(this, m, u, ...rest);
    };
    proto.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (this.status === 200 && this.__fbUrl) {
            const url = this.__fbUrl;
            const m = this.__fbMethod;
            if ((START_RE.test(url) && m === 'POST') || (GUESS_RE.test(url) && m === 'POST') || (GIVEUP_RE.test(url) && m === 'POST')) {
              const text = this.responseText;
              if (text && (text.startsWith('{') || text.startsWith('['))) {
                handleApi(m, url, JSON.parse(text));
              }
            }
          }
        } catch (e) { /* ignore */ }
      });
      return origSend.apply(this, args);
    };
  }

  function hookFetch() {
    const origFetch = PAGE.fetch;
    if (!origFetch) return;
    PAGE.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return origFetch.apply(this, arguments).then(res => {
        try {
          if (res.ok && ((START_RE.test(url) && method === 'POST') || (GUESS_RE.test(url) && method === 'POST') || (GIVEUP_RE.test(url) && method === 'POST'))) {
            res.clone().json().then(d => handleApi(method, url, d)).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return res;
      });
    };
  }

  // ---------- 面板 ----------
  let panel = null;
  let panelRoot = null;
  let statusLine = '';

  function setStatus(text) {
    statusLine = text;
    const el = panelRoot && panelRoot.querySelector('.fb-status');
    if (el) el.textContent = text;
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = 'friberg-helper';
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:999999;font-family:system-ui,sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .fb-panel{width:230px;background:#111318;color:#e8e8e8;border:1px solid #3a3f4b;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-size:13px;line-height:1.5}
        .fb-title{font-weight:700;display:flex;justify-content:space-between;align-items:center}
        .fb-mode{font-size:11px;color:#9aa3b2}
        .fb-cand{margin:6px 0;color:#b9c0cc}
        .fb-guess{font-size:15px;font-weight:700;color:#7dd87d;margin:4px 0 8px}
        .fb-btn{width:100%;padding:6px 0;border-radius:6px;border:0;background:#2f6f3f;color:#fff;cursor:pointer;font-size:13px;margin-bottom:8px}
        .fb-btn:hover{background:#3a8a50}
        .fb-status{font-size:11px;color:#8a93a2;word-break:break-all}
        .fb-exp{margin-top:8px;border-top:1px solid #33383f;padding-top:6px;font-size:11px;color:#8a93a2}
        .fb-exp ul{margin:4px 0 0;padding-left:14px}
        .fb-hc{display:none;margin-top:8px;padding:8px;border:1px solid #3a3f4b;border-radius:8px;background:#161a22;font-size:12px}
        .fb-hc.open{display:block}
        .fb-hc label{display:flex;justify-content:space-between;align-items:center;margin:4px 0}
        .fb-hc input[type=number]{width:56px;background:#111318;color:#e8e8e8;border:1px solid #3a3f4b;border-radius:4px;padding:2px 4px}
        .fb-hc select{background:#111318;color:#e8e8e8;border:1px solid #3a3f4b;border-radius:4px;padding:2px 4px}
        .fb-hc-btns{display:flex;gap:6px;margin-top:8px}
        .fb-hc-btns button{flex:1;padding:4px 0;border-radius:5px;border:0;cursor:pointer;font-size:12px;color:#fff}
      </style>
      <div class="fb-panel">
        <div class="fb-title"><span>弗一把助手</span><span class="fb-mode" id="fb-mode">-</span></div>
        <div class="fb-cand" id="fb-cand">-</div>
        <div class="fb-guess" id="fb-guess">等待对局...</div>
        <button class="fb-btn" id="fb-autosubmit" style="background:#2b3444">多人自动提交：关</button>
        <button class="fb-btn" id="fb-handicap" style="background:#2b3444">控场：关</button>
        <div class="fb-hc" id="fb-hc">
          <label><span>控场模式</span><input type="checkbox" id="hc-enabled"></label>
          <label><span>每局最少猜测</span><input type="number" id="hc-min" min="0" max="8" step="1"></label>
          <label><span>提交延迟（秒）</span><input type="number" id="hc-delay" min="0" max="20" step="1"></label>
          <label><span>放水概率</span>
            <select id="hc-lose">
              <option value="0">0%</option>
              <option value="0.1">10%</option>
              <option value="0.2">20%</option>
              <option value="0.3">30%</option>
              <option value="0.4">40%</option>
              <option value="0.5">50%</option>
            </select>
          </label>
          <div class="fb-hc-btns">
            <button id="hc-save" style="background:#2f6f3f">保存</button>
            <button id="hc-close" style="background:#2b3444">关闭</button>
          </div>
        </div>
        <button class="fb-btn" id="fb-import" style="background:#2b3444">导入 JSON</button>
        <button class="fb-btn" id="fb-sync" style="background:#2b3444">同步选手库</button>
        <div class="fb-status" id="fb-status">就绪</div>
        <div class="fb-exp" id="fb-exp"></div>
      </div>`;
    document.documentElement.appendChild(host);
    panel = host;
    panelRoot = shadow;
    function updateAutoSubmitButton() {
      const el = shadow.getElementById('fb-autosubmit');
      if (!el) return;
      const on = loadSettings().autoSubmit;
      el.textContent = `多人自动提交：${on ? '开' : '关'}`;
      el.style.background = on ? '#2f6f3f' : '#2b3444';
    }
    shadow.getElementById('fb-autosubmit').addEventListener('click', () => {
      const s = loadSettings();
      s.autoSubmit = !s.autoSubmit;
      saveSettings(s);
      setStatus(`多人自动提交已${s.autoSubmit ? '开启' : '关闭'}`);
      updateAutoSubmitButton();
    });
    updateAutoSubmitButton();
    function updateHandicapButton() {
      const el = shadow.getElementById('fb-handicap');
      if (!el) return;
      const h = loadSettings().handicap;
      el.textContent = `控场：${h.enabled ? '开' : '关'}`;
      el.style.background = h.enabled ? '#2f6f3f' : '#2b3444';
    }
    function fillHandicapForm() {
      const h = loadSettings().handicap;
      shadow.getElementById('hc-enabled').checked = h.enabled;
      shadow.getElementById('hc-min').value = h.minGuesses;
      shadow.getElementById('hc-delay').value = h.delaySec;
      shadow.getElementById('hc-lose').value = String(h.loseRate);
    }
    shadow.getElementById('fb-handicap').addEventListener('click', () => {
      const box = shadow.getElementById('fb-hc');
      box.classList.toggle('open');
      if (box.classList.contains('open')) fillHandicapForm();
    });
    shadow.getElementById('hc-close').addEventListener('click', () => {
      shadow.getElementById('fb-hc').classList.remove('open');
    });
    shadow.getElementById('hc-save').addEventListener('click', () => {
      const s = loadSettings();
      const min = Math.min(8, Math.max(0, Math.floor(Number(shadow.getElementById('hc-min').value) || 0)));
      const delay = Math.min(20, Math.max(0, Math.floor(Number(shadow.getElementById('hc-delay').value) || 0)));
      const lose = Number(shadow.getElementById('hc-lose').value);
      s.handicap = { enabled: shadow.getElementById('hc-enabled').checked, minGuesses: min, delaySec: delay, loseRate: Number.isFinite(lose) ? lose : 0 };
      saveSettings(s);
      updateHandicapButton();
      shadow.getElementById('fb-hc').classList.remove('open');
      setStatus(`控场已${s.handicap.enabled ? '开启' : '关闭'}（最少 ${min} 猜 · 延迟 ${delay}s · 放水 ${Math.round(s.handicap.loseRate * 100)}%）`);
    });
    updateHandicapButton();
    shadow.getElementById('fb-import').addEventListener('click', importFromFile);
    shadow.getElementById('fb-sync').addEventListener('click', async () => {
      shadow.getElementById('fb-sync').disabled = true;
      try {
        setStatus('正在从 GitHub 数据仓库同步选手库...');
        const fresh = await fetchAllPlayers();
        cache = fresh;
        savePlayersCache(fresh);
        ensureEncoded();
        if (state.inGame) { state.candidates = all.slice(); state.guessed = new Set(); computeAndFill(); }
        setStatus(`选手库同步完成（v${fresh.version}，${fresh.players.length} 人）`);
      } catch (e) {
        setStatus(syncErrorMessage(e));
      } finally {
        shadow.getElementById('fb-sync').disabled = false;
      }
    });
    setStatus(statusLine);
    return shadow;
  }

  function renderPanel(info) {
    if (!panelRoot) return;
    panelRoot.getElementById('fb-mode').textContent = MODE_NAMES[info.mode] || info.mode || '多人';
    panelRoot.getElementById('fb-cand').textContent = `候选 ${info.cands}/${info.total} · 已猜 ${info.turn}/${info.max}`;
    const g = panelRoot.getElementById('fb-guess');
    g.textContent = info.nick || '-';
    if (info.exp > 0) g.textContent += `（该难度见过 ${info.exp} 次）`;
    panelRoot.getElementById('fb-status').textContent = statusLine;
    const stats = loadStats();
    const m = stats.modes[info.mode];
    if (m && m.games > 0) {
      const top = Object.entries(m.answers).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([n, c]) => `<li>${n} ×${c}</li>`).join('');
      panelRoot.getElementById('fb-exp').innerHTML =
        `经验：${m.games} 局 / 胜 ${m.wins}（${Math.round(100 * m.wins / m.games)}%）/ 平均 ${(m.guesses / m.games).toFixed(1)} 步` +
        (top ? `<ul>${top}</ul>` : '');
    } else {
      panelRoot.getElementById('fb-exp').textContent = '经验：暂无（打完一局自动积累）';
    }
  }

  // ---------- 菜单 ----------
  GM_registerMenuCommand('切换自动填入', () => {
    const s = loadSettings();
    s.autoFill = !s.autoFill;
    saveSettings(s);
    setStatus(`自动填入已${s.autoFill ? '开启' : '关闭'}`);
  });
  GM_registerMenuCommand('切换自动提交', () => {
    const s = loadSettings();
    s.autoSubmit = !s.autoSubmit;
    saveSettings(s);
    setStatus(`自动提交已${s.autoSubmit ? '开启' : '关闭'}`);
  });
  GM_registerMenuCommand('导入本地 JSON 数据', importFromFile);
  GM_registerMenuCommand('清空积累经验', () => {
    try { GM_setValue(KEY_STATS, { modes: {}, games: [] }); } catch (e) { /* ignore */ }
    setStatus('经验已清空');
  });

  // ---------- 启动 ----------
  let syncQueued = false;
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    setTimeout(() => {
      syncQueued = false;
      pollMulti();
    }, 30);
  }

  function boot() {
    cache = loadPlayersCache();
    ensureEncoded();
    hookXHR();
    hookFetch();
    if (!document.querySelector('#friberg-helper')) createPanel();
    setStatus('就绪；若已有进行中的对局，请点「重新开始」让助手接管');
    ensureData().then(ok => {
      if (ok) checkDbUpdate();
    }).catch(e => setStatus('选手库加载失败：' + e.message));
    // 事件驱动为主（新行/回合结束立即响应），快速轮询兜底
    if (typeof MutationObserver === 'function') {
      new MutationObserver(scheduleSync).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    setInterval(() => {
      if (!document.querySelector('#friberg-helper')) createPanel();
      pollMulti();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

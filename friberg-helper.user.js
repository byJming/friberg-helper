// ==UserScript==
// @name         弗一把助手
// @namespace    shnlfriberg.helper
// @version      0.2.2
// @description  弗一把(CSGO 选手猜测)开源辅助：求解最优猜测并填入输入框，单人与多人联机自动接管，提交与否由你决定
// @match        https://shnlfriberg.online/*
// @homepageURL  https://github.com/byJming/friberg-helper
// @supportURL   https://github.com/byJming/friberg-helper/issues
// @downloadURL  https://github.com/byJming/friberg-helper/raw/main/friberg-helper.user.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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
      return s;
    } catch (e) { return { autoFill: true, autoSubmit: false }; }
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
      ids: new Array(players.length),
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
      enc.ids[i] = p.id;
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

  function filterCandidates(enc, candidates, gIdx, key) {
    return candidates.filter(c => feedbackKey(enc, gIdx, c) === key);
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
      if (e > bestEntropy) {
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
      if (m < bestMax) {
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
    if (cands.length <= remaining) return cands[0];
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
    autoSubmit: { pending: false, lastClick: 0 },
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 数据同步 ----------
  async function pageFetch(url, opts) {
    return PAGE.fetch(url, opts);
  }

  async function fetchAllPlayers(onProgress) {
    const listR = await pageFetch('/api/players/list', { cache: 'no-store' });
    const list = await listR.json();
    const map = new Map();
    for (const p of list.players) {
      try {
        const r = await pageFetch(`/api/players?search=${encodeURIComponent(p.nickname)}`, { cache: 'no-store' });
        if (r.ok) {
          const arr = await r.json();
          for (const pl of arr) map.set(pl.id, pl);
        }
      } catch (e) { /* skip */ }
      if (onProgress) onProgress(map.size, list.players.length);
      await sleep(250);
    }
    return { version: list.version, players: [...map.values()].sort((a, b) => a.id - b.id) };
  }

  function ensureEncoded() {
    if (cache && cache.players && cache.players.length > 0) {
      enc = encodePlayers(cache.players);
      all = Array.from({ length: enc.n }, (_, i) => i);
      return true;
    }
    return false;
  }

  async function ensureData() {
    if (ensureEncoded()) {
      if (state.inGame && state.lastIdx < 0) computeAndFill();
      return true;
    }
    setStatus('无选手库：点面板「导入 JSON」选择本地 players_full.json，或点「同步选手库」在线抓取');
    return false;
  }

  // ---------- 导入本地 JSON ----------
  function importPlayersFromJson(obj) {
    let players = Array.isArray(obj) ? obj : obj && obj.players;
    if (!Array.isArray(players) || players.length === 0) {
      return { ok: false, message: '格式无效：未找到 players 数组' };
    }
    const version = (obj && (obj.listVersion || obj.version)) || null;
    const need = ['id', 'nickname', 'nationality', 'region', 'team', 'age', 'role', 'majorChampionships', 'majorAppearances', 'isActive'];
    const sample = players.find(p => p && typeof p === 'object');
    if (!sample) return { ok: false, message: '格式无效：选手数据为空' };
    const missing = need.filter(k => !(k in sample));
    if (missing.length > 0) {
      return { ok: false, message: '选手数据缺少字段：' + missing.join(', ') };
    }
    const ids = new Set(players.map(p => p.id));
    if (ids.size !== players.length) {
      return { ok: false, message: '存在重复选手 id' };
    }
    players = players.slice().sort((a, b) => a.id - b.id);
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

  function experienceSorted(cands) {
    const stats = loadStats();
    const m = state.mode ? stats.modes[state.mode] : null;
    if (!m) return cands;
    return cands.slice().sort((x, y) => {
      const cx = m.answers[enc.nicks[x]] || 0;
      const cy = m.answers[enc.nicks[y]] || 0;
      return cy - cx;
    });
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
    if (fb.attributes) {
      const list = cache ? cache.players : null;
      if (list) {
        const p = list.find(x => x.id === fb.playerId);
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
    const gIdx = enc.ids.indexOf(fb.playerId);
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

  function fillInput(nickname, attempts) {
    if (attempts === undefined) attempts = 8;
    const input = document.querySelector('input[role="combobox"]');
    if (!input) {
      if (attempts > 0) {
        setTimeout(() => fillInput(nickname, attempts - 1), 800);
        setStatus('等待输入框出现...');
      } else {
        setStatus('未找到输入框，请在单人对局页使用');
      }
      return false;
    }
    if (input.disabled) {
      if (attempts > 0) {
        setTimeout(() => fillInput(nickname, attempts - 1), 800);
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
  function updateMultiModeFromText() {
    const t = document.body.innerText;
    if (!t.includes('数据库') && !t.includes('第 1 局')) return;
    if (t.includes('入门版')) multi.mode = 'beginner';
    else if (t.includes('简单版')) multi.mode = 'easy';
    else if (t.includes('完整版')) multi.mode = 'normal';
  }

  function keyFromRow(row) {
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
    const c = label => row.querySelector('td[data-label="' + label + '"]');
    let k = 0;
    const natLv = lv(c('国家或地区'));
    k = k * 3 + natLv;
    k = k * 3 + (natLv === 2 ? 2 : 0);
    k = k * 3 + lv(c('队伍'));
    k = k * 4 + num(c('年龄'));
    k = k * 3 + lv(c('位置'));
    k = k * 4 + num(c('Major 冠军'));
    k = k * 4 + num(c('Major 次数'));
    k = k * 3 + lv(c('状态'));
    return k;
  }

  function computeMultiFill() {
    if (!enc) return;
    let cands = multi.candidates;
    if (cands.length === 0) {
      setStatus('多人：候选集已空（数据异常）');
      return;
    }
    const g = pickGuess(enc, cands, all, multi.guessed, 8 - multi.turn);
    multi.lastIdx = g;
    renderPanel({ mode: multi.mode, cands: cands.length, total: enc.n, turn: multi.turn, max: 8, nick: enc.nicks[g], exp: 0, statusLine });
    if (loadSettings().autoFill) {
      if (!fillMulti(enc.nicks[g])) multi.fillPending = enc.nicks[g];
    }
  }

  function fillMulti(nickname) {
    if (!fillInput(nickname)) return false;
    multi.fillPending = null;
    if (loadSettings().autoSubmit) {
      multi.autoSubmit = { pending: true, lastClick: 0 };
    }
    return true;
  }

  function pollMulti() {
    if (!location.pathname.startsWith('/multi')) return;
    updateMultiModeFromText();
    const selfBoard = document.querySelector('.player-board-self');
    if (!selfBoard) {
      if (multi.active) {
        multi.active = false;
        multi.ended = false;
        multi.autoSubmit.pending = false;
        setStatus('多人：离开对局，等待下一场');
      }
      return;
    }
    const roundM = document.body.innerText.match(/第 (\d+) 局/);
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
      setStatus(`多人对局（${MODE_NAMES[multi.mode] || '?'}）已接管`);
      if (roundEnded) {
        multi.lastAnswer = answerText;
        const cardText = document.querySelector('.overlay-card').innerText;
        const won = cardText.includes('你赢');
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
      multi.autoSubmit = { pending: false, lastClick: 0 };
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
        const cardText = document.querySelector('.overlay-card').innerText;
        const won = cardText.includes('你赢');
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
        multi.autoSubmit = { pending: false, lastClick: 0 };
        computeMultiFill();
      } else {
        multi.lastRowCount = n;
      }
      return;
    }
    if (multi.lastIdx < 0 && enc && multi.candidates.length > 0) {
      computeMultiFill();
    }
    if (multi.fillPending) {
      if (fillMulti(multi.fillPending)) multi.fillPending = null;
    }
    if (multi.lastIdx >= 0 && multi.turn === 0) {
      const input = document.querySelector('input[role="combobox"]');
      if (input && !input.disabled && input.value === '') {
        fillMulti(enc.nicks[multi.lastIdx]);
      }
    }
    if (n < multi.lastRowCount) {
      multi.turn = 0;
      multi.guessed = new Set();
      multi.candidates = all.slice();
      multi.lastRowCount = 0;
      multi.fillPending = null;
      computeMultiFill();
    }
    if (n > multi.lastRowCount) {
      const row = rows[n - 1];
      const nickEl = row.querySelector('td.name');
      const nick = nickEl ? nickEl.textContent.trim() : '';
      const key = keyFromRow(row);
      const gIdx = nick ? enc.nicks.indexOf(nick) : -1;
      if (gIdx >= 0) {
        multi.candidates = filterCandidates(enc, multi.candidates, gIdx, key);
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
    if (multi.autoSubmit.pending) {
      const input = document.querySelector('input[role="combobox"]');
      const btn = document.querySelector('.input-bar button.btn');
      if (!input || !btn) return;
      const text = input.value.trim();
      if (!text) {
        multi.autoSubmit.pending = false;
      } else if (Date.now() - multi.autoSubmit.lastClick > 3000) {
        const expected = multi.lastIdx >= 0 ? enc.nicks[multi.lastIdx] : '';
        if (expected && text.toLowerCase() !== expected.toLowerCase()) {
          multi.autoSubmit.pending = false;
        } else if (btn.disabled) {
          if (input !== document.activeElement) input.focus();
        } else {
          multi.autoSubmit.lastClick = Date.now();
          btn.click();
        }
      }
    }
  }

  // ---------- 网络捕获 ----------
  const START_RE = /\/api\/game\/start$/;
  const GUESS_RE = /\/api\/game\/[^/]+\/guess$/;
  const GIVEUP_RE = /\/api\/game\/[^/]+\/giveup$/;
  const LIST_RE = /\/api\/players\/list/;

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
    } else if (method === 'GET' && LIST_RE.test(url) && data.version) {
      if (cache && cache.version !== data.version) {
        setStatus(`选手库有新版本 v${data.version}（当前 v${cache.version}），点面板「同步」更新`);
      }
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
            if ((START_RE.test(url) && m === 'POST') || (GUESS_RE.test(url) && m === 'POST') || (GIVEUP_RE.test(url) && m === 'POST') || (LIST_RE.test(url) && m === 'GET')) {
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
          if (res.ok && ((START_RE.test(url) && method === 'POST') || (GUESS_RE.test(url) && method === 'POST') || (GIVEUP_RE.test(url) && method === 'POST') || (LIST_RE.test(url) && method === 'GET'))) {
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
      </style>
      <div class="fb-panel">
        <div class="fb-title"><span>弗一把助手</span><span class="fb-mode" id="fb-mode">-</span></div>
        <div class="fb-cand" id="fb-cand">-</div>
        <div class="fb-guess" id="fb-guess">等待对局...</div>
        <button class="fb-btn" id="fb-fill">填入输入框</button>
        <button class="fb-btn" id="fb-import" style="background:#2b3444">导入 JSON</button>
        <button class="fb-btn" id="fb-sync" style="background:#2b3444">同步选手库</button>
        <div class="fb-status" id="fb-status">就绪</div>
        <div class="fb-exp" id="fb-exp"></div>
      </div>`;
    document.documentElement.appendChild(host);
    panel = host;
    panelRoot = shadow;
    shadow.getElementById('fb-fill').addEventListener('click', () => {
      const g = state.lastIdx;
      if (enc && g >= 0) fillInput(enc.nicks[g]);
    });
    shadow.getElementById('fb-import').addEventListener('click', importFromFile);
    shadow.getElementById('fb-sync').addEventListener('click', async () => {
      shadow.getElementById('fb-sync').disabled = true;
      try {
        const fresh = await fetchAllPlayers((done, total) => setStatus(`正在同步选手库 ${done}/${total} ...`));
        cache = fresh;
        savePlayersCache(fresh);
        ensureEncoded();
        if (state.inGame) { state.candidates = all.slice(); state.guessed = new Set(); computeAndFill(); }
        setStatus(`选手库同步完成（v${fresh.version}，${fresh.players.length} 人）`);
      } catch (e) {
        setStatus('同步失败：' + e.message);
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
  function boot() {
    cache = loadPlayersCache();
    ensureEncoded();
    hookXHR();
    hookFetch();
    if (!document.querySelector('#friberg-helper')) createPanel();
    setStatus('就绪；若已有进行中的对局，请点「重新开始」让助手接管');
    ensureData().catch(e => setStatus('选手库加载失败：' + e.message));
    setInterval(() => {
      if (!document.querySelector('#friberg-helper')) createPanel();
      pollMulti();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

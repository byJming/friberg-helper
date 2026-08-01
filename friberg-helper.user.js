// ==UserScript==
// @name         弗一把助手
// @namespace    shnlfriberg.helper
// @version      0.3.1
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

  // ---------- 存储（带内存缓存，避免热路径反复读 GM 存储） ----------
  let _statsCache = null;
  let _settingsCache = null;
  function loadPlayersCache() {
    try { return GM_getValue(KEY_PLAYERS, null); } catch (e) { return null; }
  }
  function savePlayersCache(cache) {
    try { GM_setValue(KEY_PLAYERS, cache); } catch (e) { /* quota */ }
  }
  function loadStats() {
    if (_statsCache) return _statsCache;
    try { _statsCache = GM_getValue(KEY_STATS, { modes: {}, games: [] }); } catch (e) { _statsCache = { modes: {}, games: [] }; }
    return _statsCache;
  }
  function saveStats(stats) {
    _statsCache = stats;
    try { GM_setValue(KEY_STATS, stats); } catch (e) { /* quota */ }
  }
  const HANDICAP_DEFAULT = { enabled: false, minGuessesMin: 2, minGuessesMax: 4, delaySecMin: 5, delaySecMax: 12, loseRate: 0.2 };
  function loadSettings() {
    if (_settingsCache) return _settingsCache;
    try {
      const s = GM_getValue(KEY_SETTINGS, null) || {};
      if (s.autoFill === undefined) s.autoFill = true;
      if (s.autoSubmit === undefined) s.autoSubmit = false;
      if (!s.handicap) { s.handicap = { ...HANDICAP_DEFAULT }; }
      else {
        // 兼容旧版固定值格式：迁移为区间
        const h = s.handicap;
        if (h.minGuessesMin === undefined) {
          const old = h.minGuesses || 3;
          h.minGuessesMin = Math.max(1, old - 1);
          h.minGuessesMax = Math.min(6, old + 1);
          delete h.minGuesses;
        }
        if (h.delaySecMin === undefined) {
          const old = h.delaySec || 8;
          h.delaySecMin = Math.max(2, old - 3);
          h.delaySecMax = Math.min(20, old + 3);
          delete h.delaySec;
        }
      }
      _settingsCache = s;
      return s;
    } catch (e) { _settingsCache = { autoFill: true, autoSubmit: false, handicap: { ...HANDICAP_DEFAULT } }; return _settingsCache; }
  }
  function saveSettings(s) {
    _settingsCache = s;
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

  // 从 top-K 中加权随机选取，避免每步都选最优解触发服务端相似度检测。
  // 服务端 userGameAnalysis 会计算每步的 entropyPercentile，
  // 持续 top 1% 会导致 similarityIndex ≥ 90（“high” 等级）。
  // 目标：平均百分位控制在 60~85%，模拟“聪明但非机器”的玩家。
  const TOP_K = 4;
  function pickFromTopK(scored) {
    // scored: [{idx, score}] 已按 score 降序
    if (scored.length <= 1) return scored[0] ? scored[0].idx : -1;
    const k = Math.min(TOP_K, scored.length);
    // 权重递减：第 1 名权重 k，第 2 名 k-1，...，第 k 名 1
    const totalW = k * (k + 1) / 2;
    let r = Math.random() * totalW;
    for (let i = 0; i < k; i++) {
      r -= (k - i);
      if (r <= 0) return scored[i].idx;
    }
    return scored[k - 1].idx;
  }

  function bestGuess(enc, candidates, pool) {
    const n = candidates.length;
    const counts = new Map();
    const scored = [];
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
      scored.push({ idx: g, score: e });
    }
    scored.sort((a, b) => b.score - a.score || guessExperience(enc.nicks[b.idx]) - guessExperience(enc.nicks[a.idx]));
    return pickFromTopK(scored);
  }

  function minimaxGuess(enc, candidates, pool) {
    const scored = [];
    for (const g of pool) {
      const counts = new Map();
      for (const a of candidates) {
        const k = feedbackKey(enc, g, a);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let m = 0;
      for (const c of counts.values()) if (c > m) m = c;
      // 分数取负：最大分区越小分数越高
      scored.push({ idx: g, score: -m });
    }
    scored.sort((a, b) => b.score - a.score || guessExperience(enc.nicks[b.idx]) - guessExperience(enc.nicks[a.idx]));
    return pickFromTopK(scored);
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
    submitted: new Set(),
    lastIdx: -1,
    lastRowCount: 0,
    lastAnswer: '',
    fillPending: null,
    lastRound: null,
    ended: false,
    handicapLose: false,
    handicapSkipDone: false,
    handicapRefIdx: -1,
    handicapPadSeq: null,
    handicapPadPos: 0,
    handicapLastLv: null,
    roundMinGuesses: 0,
    awaitingRow: false,
    awaitingRowAt: 0,
    pendingIdx: -1,
    nextSubmitAt: 0,
    autoSubmit: { pending: false, attempted: false, expected: '', lastClick: 0, nextAttemptAt: 0, delayUntil: 0 },
  };

  // ---------- 控场模式（多人） ----------
  // 目标：避免快速碾压导致对手没有体验。本局掷骰放水时直接跳过（判负），
  // 否则限制每局最少猜测次数、并延迟提交，拉长对局节奏。
  // 探路采用「属性支配渐进」策略：
  // - attrLevels 精确复刻服务端 compareGuess 的三级着色（green/yellow/red）
  // - 序列构建采用支配约束：已绿的列不允许回退，每步至少新增一列变绿
  // - 同层候选中优先选信息量最大的（有效缩小候选集，避免平局）
  // - 始终排除最可能的答案，保证探路期间不会提前命中

  // 计算选手 a 相对于选手 b 的逐属性反馈等级向量（精确复刻服务端着色）。
  // 返回 8 元素数组，每元素 0=green, 1=yellow(close), 2=red(wrong)。
  // 列顺序与 UI 一致：国籍, 地区, 队伍, 年龄, 位置, Major冠军, Major次数, 状态
  function attrLevels(a, b) {
    const lv = [];
    // 国籍（nationalityAttr）
    lv.push(enc.nats[a] === enc.nats[b] ? 0 : enc.regs[a] === enc.regs[b] ? 1 : 2);
    // 地区（textAttr）
    lv.push(enc.regs[a] === enc.regs[b] ? 0 : 2);
    // 队伍（textAttr）
    lv.push(enc.teams[a] === enc.teams[b] ? 0 : 2);
    // 年龄（numberAttr, close=3）
    const ageD = Math.abs(enc.ages[a] - enc.ages[b]);
    lv.push(ageD === 0 ? 0 : ageD <= AGE_CLOSE ? 1 : 2);
    // 位置（textAttr）
    lv.push(enc.roles[a] === enc.roles[b] ? 0 : 2);
    // Major 冠军（numberAttr, close=1）
    const mcD = Math.abs(enc.mcs[a] - enc.mcs[b]);
    lv.push(mcD === 0 ? 0 : mcD <= MAJOR_CLOSE ? 1 : 2);
    // Major 次数（numberAttr, close=1）
    const maD = Math.abs(enc.mas[a] - enc.mas[b]);
    lv.push(maD === 0 ? 0 : maD <= MAJOR_CLOSE ? 1 : 2);
    // 状态
    lv.push(enc.acts[a] === enc.acts[b] ? 0 : 2);
    return lv;
  }

  // 总非绿格子数（用于快速排序/fallback）
  function guessDistance(a, b) {
    const lv = attrLevels(a, b);
    let d = 0;
    for (let i = 0; i < lv.length; i++) d += lv[i];
    return d;
  }

  // 计算猜测 g 对候选集的信息量（熵），确保探路有效缩小候选集
  function guessInfoGain(g, cands) {
    const n = cands.length;
    if (n <= 1) return 0;
    const counts = new Map();
    for (const a of cands) {
      const k = feedbackKey(enc, g, a);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let e = 0;
    for (const c of counts.values()) {
      const p = c / n;
      e -= p * Math.log2(p);
    }
    return e;
  }

  // 构建「属性支配」渐进序列：
  // 核心约束——后续猜测的每一列着色等级 ≥ 前一步（不允许已绿的列变红/黄），
  // 且至少一列严格变好。这保证面板视觉上"只会越来越绿"。
  // 在满足支配约束的候选中，优先选信息量最大的（有效缩小候选集，避免平局）。
  // 当支配约束无法满足时（数据库中没有更优选手），渐进放宽：
  //   tier1: 严格支配（无回退 + 有进步）
  //   tier2: 无回退（所有列 ≥ 前一步，总距离相同）
  //   tier3: 总距离更小（允许个别列微退，但整体更好）
  //   tier4: 剩余中距离最小的
  function buildPaddingSeq(pool, ref, cands) {
    const n = pool.length;
    if (n === 0) return [];
    // 预计算每个候选的属性等级向量 + 信息量
    const lvMap = new Map();
    const infoMap = new Map();
    for (const c of pool) {
      lvMap.set(c, attrLevels(c, ref));
      infoMap.set(c, guessInfoGain(c, cands));
    }
    const totalLv = lv => lv.reduce((s, v) => s + v, 0);
    const greenCount = lv => lv.filter(v => v === 0).length;

    const seq = [];
    const used = new Set();
    // 起点：选绿色最少（总距离最大）的候选，信息量作 tiebreak
    let start = pool[0];
    for (const c of pool) {
      const tc = totalLv(lvMap.get(c)), ts = totalLv(lvMap.get(start));
      if (tc > ts || (tc === ts && infoMap.get(c) > infoMap.get(start))) start = c;
    }
    seq.push(start);
    used.add(start);

    while (used.size < n) {
      const curLv = lvMap.get(seq[seq.length - 1]);
      // tier1: 严格支配——每列 ≤ cur（不退步），且至少一列 < cur（进步）
      let tier = [];
      for (const c of pool) {
        if (used.has(c)) continue;
        const lv = lvMap.get(c);
        let dominated = true, improved = false;
        for (let i = 0; i < 8; i++) {
          if (lv[i] > curLv[i]) { dominated = false; break; }
          if (lv[i] < curLv[i]) improved = true;
        }
        if (dominated && improved) tier.push(c);
      }
      // tier2: 无回退（所有列 ≤ cur），总距离相同（没有进步但也不退）
      if (!tier.length) {
        for (const c of pool) {
          if (used.has(c)) continue;
          const lv = lvMap.get(c);
          let dominated = true;
          for (let i = 0; i < 8; i++) { if (lv[i] > curLv[i]) { dominated = false; break; } }
          if (dominated) tier.push(c);
        }
      }
      // tier3: 总距离更小（允许个别列微退，但整体更好）
      if (!tier.length) {
        const curTotal = totalLv(curLv);
        for (const c of pool) {
          if (used.has(c)) continue;
          if (totalLv(lvMap.get(c)) < curTotal) tier.push(c);
        }
      }
      // tier4: 剩余全部，按距离升序
      if (!tier.length) {
        for (const c of pool) { if (!used.has(c)) tier.push(c); }
        tier.sort((a, b) => totalLv(lvMap.get(a)) - totalLv(lvMap.get(b)));
      }
      // 从当前 tier 中选信息量最大的（同信息量选绿色多的）
      let best = tier[0];
      for (const c of tier) {
        const ic = infoMap.get(c), ib = infoMap.get(best);
        if (ic > ib || (ic === ib && greenCount(lvMap.get(c)) > greenCount(lvMap.get(best)))) best = c;
      }
      seq.push(best);
      used.add(best);
    }
    return seq;
  }

  // 控场探路：属性支配渐进 + 排除答案 + 信息量最大化。
  // 首次探路时通过 buildPaddingSeq 生成固定序列，后续每步按序取用。
  // 保证：① 面板每行严格比上一行更绿（已绿列不退步）
  //       ② 同层候选中优先选信息量最大的（有效排除候选人，避免平局）
  //       ③ 参照目标（最可能是答案）始终排除，探路期间绝不命中
  function pickPaddingGuess(cands, excluded, paddingLeft) {
    const available = cands.filter(c => !excluded.has(c));
    if (available.length === 0) return -1;
    // 尽早确定参照目标（最可能是答案），供 fallback 使用
    if (multi.handicapRefIdx < 0 || !cands.includes(multi.handicapRefIdx)) {
      multi.handicapRefIdx = available.slice().sort(
        (a, b) => guessExperience(enc.nicks[b]) - guessExperience(enc.nicks[a])
      )[0];
    }
    // 候选仅剩 1 人：它就是答案，从候选外选一个必不命中的
    if (available.length === 1) {
      const candsSet = new Set(cands);
      const outside = all.filter(c => !candsSet.has(c) && !excluded.has(c));
      return outside.length > 0 ? outside[Math.floor(Math.random() * outside.length)] : -1;
    }
    // 首次探路：生成属性支配渐进序列（整局不变）
    if (!multi.handicapPadSeq) {
      const ref = multi.handicapRefIdx;
      const pool = available.filter(c => c !== ref);
      multi.handicapPadSeq = buildPaddingSeq(pool, ref, cands);
      multi.handicapPadPos = 0;
    }
    // 从固定序列中按序取用（跳过已猜过的）
    const seq = multi.handicapPadSeq;
    while (multi.handicapPadPos < seq.length && excluded.has(seq[multi.handicapPadPos])) {
      multi.handicapPadPos++;
    }
    if (multi.handicapPadPos < seq.length) {
      return seq[multi.handicapPadPos++];
    }
    // 序列耗尽：回退到候选外
    const candsSet = new Set(cands);
    const outside = all.filter(c => !candsSet.has(c) && !excluded.has(c));
    return outside.length > 0 ? outside[Math.floor(Math.random() * outside.length)] : -1;
  }
  function handicapEnabled() {
    return loadSettings().handicap.enabled;
  }

  function handicapConfig() {
    return loadSettings().handicap;
  }

  // 每局开始时掷骰：决定本局是否放水、本局最少猜测次数（从用户设定区间内随机）
  function rollHandicapLose() {
    const h = handicapConfig();
    multi.handicapLose = h.enabled && Math.random() < h.loseRate;
    multi.handicapSkipDone = false;
    // 从 [minGuessesMin, minGuessesMax] 区间随机取本局最少猜测数
    const lo = Math.max(1, h.minGuessesMin || 2);
    const hi = Math.max(lo, Math.min(6, h.minGuessesMax || lo));
    multi.roundMinGuesses = h.enabled ? lo + Math.floor(Math.random() * (hi - lo + 1)) : 0;
    return multi.handicapLose;
  }

  // 提交前延迟（毫秒）：始终在用户设定区间 [lo, hi] 内，
  // 候选数只影响在区间内的偏移（候选多偏上界，候选少偏下界），不会突破下界。
  function handicapDelayMs() {
    const h = handicapConfig();
    if (!h.enabled) return 0;
    const lo = Math.max(1, h.delaySecMin || 3);
    const hi = Math.max(lo + 1, h.delaySecMax || lo + 1);
    // 候选数决定在区间内的位置：候选多取上段，候选少取下段
    const cands = multi.candidates.length;
    let bias;
    if (cands > 50) bias = 0.7 + Math.random() * 0.3;       // 70%~100% 位置
    else if (cands > 15) bias = 0.4 + Math.random() * 0.3;  // 40%~70%
    else bias = 0.1 + Math.random() * 0.3;                   // 10%~40%
    const sec = lo + (hi - lo) * bias;
    // 微小抖动 ±0.8s，保证不低于用户设定的最小值
    const jitter = (Math.random() - 0.5) * 1.6;
    return Math.max(lo * 1000, (sec + jitter) * 1000);
  }

  // 放水：点击"跳过本局"按钮（lucide-skip-forward 图标定位，语言无关）。
  // 页面跳过前会弹确认对话框（ConfirmDialog），必须先点按钮再点确认，
  // 否则放水局既不猜也不跳，对局会卡在确认框上。
  function clickSkipButton() {
    const svg = document.querySelector('svg.lucide-skip-forward');
    if (!svg) return false;
    const btn = svg.closest('button');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }

  // 确认「跳过本轮」对话框：按标题关键词识别（覆盖中/英/日文案），
  // 避免误点用户正在操作的其它确认框（如退出房间）；确认成功返回 true。
  const SKIP_CONFIRM_KEYWORDS = ['跳过', 'Skip', 'スキップ'];
  function clickSkipConfirm() {
    const dialog = document.querySelector('.confirm-dialog[role="alertdialog"]');
    if (!dialog) return false;
    const title = dialog.querySelector('h2');
    if (!title || !SKIP_CONFIRM_KEYWORDS.some(w => title.textContent.includes(w))) return false;
    const btn = dialog.querySelector('.btn-warning, .btn-danger');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }

  // 提交链路参数：按钮需等 React 异步刷新自动补全列表后才可点；
  // 服务端有 1.5s 猜间隔冷却，重试必须留出余量。
  const SUBMIT_RETRY_MS = 60;
  const SUBMIT_WAIT_BUTTON_MAX = 30;
  const SUBMIT_CONFIRM_TIMEOUT = 2500;
  const SUBMIT_ROW_TIMEOUT = 10000;
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

  // 启动后检查数据仓库是否有新版本（10 分钟冷却）。
  // 注意：服务器数据库由管理员手工导入维护，可能与数据仓库不同步；
  // 盲目同步到仓库最新反而会造成与服务器不一致，这里仅提示，不自动更新。
  let lastDbUpdateCheck = 0;
  function checkDbUpdate() {
    if (!cache || !cache.commitSha) return;
    if (Date.now() - lastDbUpdateCheck < 10 * 60_000) return;
    lastDbUpdateCheck = Date.now();
    fetchDbCommitSha().then(sha => {
      if (sha && cache && cache.commitSha && sha !== cache.commitSha) {
        setStatus('数据仓库有新版本；服务器数据库可能未同步到同一版本，请确认后再手动同步');
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

  // 多人回合状态重置（新回合/行数减少/数据同步后统一调用）
  function resetMultiRound() {
    multi.turn = 0;
    multi.guessed = new Set();
    multi.submitted = new Set();
    multi.candidates = all.slice();
    multi.lastRowCount = 0;
    multi.lastIdx = -1;
    multi.fillPending = null;
    multi.ended = false;
    multi.autoSubmit = { pending: false, attempted: false, expected: '', lastClick: 0, nextAttemptAt: 0, delayUntil: 0 };
    multi.awaitingRow = false;
    multi.awaitingRowAt = 0;
    multi.pendingIdx = -1;
    multi.nextSubmitAt = 0;
    multi.handicapRefIdx = -1;
    multi.handicapPadSeq = null;
    multi.handicapPadPos = 0;
    multi.handicapLastLv = null;
    rollHandicapLose();
  }

  // 多人对局进行中更换选手库后，候选集/已猜索引会全部失效，
  // 必须按新库重置状态并重放已有反馈行
  function resetMultiAfterDataSync() {
    if (!multi.active || !enc) return;
    resetMultiRound();
    if (multi.handicapLose) return;
    const selfBoard = document.querySelector('.player-board-self');
    const table = selfBoard ? selfBoard.querySelector('.game-table') : null;
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    if (rows.length) multi.lastRowCount = processMultiRows(rows, 0);
    if (!multi.ended) computeMultiFill();
  }

  // 从 GitHub 数据仓库同步选手库；同步后重置单人/多人对局状态。
  // 警告：服务器数据库由管理员手工导入，可能落后于数据仓库；
  // 若服务器未同步到仓库最新，使用「导入 JSON」导入与服务器一致的本地数据更稳妥。
  async function syncFromGitHub() {
    try {
      const fresh = await fetchAllPlayers();
      cache = fresh;
      savePlayersCache(fresh);
      ensureEncoded();
      if (state.inGame) { state.candidates = all.slice(); state.guessed = new Set(); computeAndFill(); }
      resetMultiAfterDataSync();
      return true;
    } catch (e) {
      setStatus(syncErrorMessage(e));
      return false;
    }
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
    const excluded = new Set([...multi.guessed, ...multi.submitted]);
    const available = cands.filter(c => !excluded.has(c));
    let g = available.length
      ? pickGuess(enc, cands, cands, excluded, 8 - multi.turn)
      : all.find(c => !excluded.has(c));
    if (g === undefined || g < 0) {
      setStatus('多人：本局已无未提交选手');
      return;
    }
    const h = handicapConfig();
    const remaining = 8 - multi.turn;
    // 控场探路阶段：最少猜测次数内使用 padding 序列（绝不命中答案）
    if (h.enabled && multi.turn < multi.roundMinGuesses && remaining > 2) {
      const guessedAll = new Set([...multi.guessed, ...multi.submitted, ...(multi.pendingIdx >= 0 ? [multi.pendingIdx] : [])]);
      const paddingLeft = multi.roundMinGuesses - multi.turn;
      const pg = pickPaddingGuess(cands, guessedAll, paddingLeft);
      if (pg >= 0) {
        g = pg;
      } else {
        const ref = multi.handicapRefIdx;
        const fallback = all.find(c => !guessedAll.has(c) && c !== ref);
        if (fallback !== undefined) g = fallback;
      }
    } else if (h.enabled && multi.handicapRefIdx >= 0 && multi.handicapLastLv) {
      // 控场求解阶段：padding 结束后，solver 的候选也受支配约束，
      // 保证整局所有行的着色严格渐进（已绿列不退步）。
      const ref = multi.handicapRefIdx;
      const curLv = multi.handicapLastLv;
      const pool = (available.length ? available : all.filter(c => !excluded.has(c)))
        .filter(c => c !== ref);
      // tier1: 严格支配（无回退 + 有进步）
      let dominated = pool.filter(c => {
        const lv = attrLevels(c, ref);
        let dom = true, imp = false;
        for (let i = 0; i < 8; i++) {
          if (lv[i] > curLv[i]) { dom = false; break; }
          if (lv[i] < curLv[i]) imp = true;
        }
        return dom && imp;
      });
      // tier2: 无回退（允许持平）
      if (!dominated.length) {
        dominated = pool.filter(c => {
          const lv = attrLevels(c, ref);
          for (let i = 0; i < 8; i++) { if (lv[i] > curLv[i]) return false; }
          return true;
        });
      }
      // tier3: 总距离更小
      if (!dominated.length) {
        const curTotal = curLv.reduce((s, v) => s + v, 0);
        dominated = pool.filter(c => guessDistance(c, ref) < curTotal);
      }
      if (dominated.length) {
        // 从支配候选中选信息量最大的
        let best = dominated[0], bestInfo = guessInfoGain(best, cands);
        for (let i = 1; i < dominated.length; i++) {
          const info = guessInfoGain(dominated[i], cands);
          if (info > bestInfo) { best = dominated[i]; bestInfo = info; }
        }
        g = best;
      }
      // tier4: 无支配候选时保持 solver 原始选择
    }
    // 更新渐进基线：记录本次猜测相对于参照目标的属性等级
    if (h.enabled && multi.handicapRefIdx >= 0 && g >= 0 && g !== multi.handicapRefIdx) {
      multi.handicapLastLv = attrLevels(g, multi.handicapRefIdx);
    }
    multi.lastIdx = g;
    renderPanel({ mode: multi.mode, cands: cands.length, total: enc.n, turn: multi.turn, max: 8, nick: enc.nicks[g], exp: 0, statusLine });
    if (loadSettings().autoFill) {
      if (!fillMulti(enc.nicks[g])) multi.fillPending = enc.nicks[g];
    }
  }

  function fillMulti(nickname) {
    // 多人轮询本身负责重试，不能再让 fillInput 排队；否则旧定时器会覆盖下一轮昵称。
    const input = document.querySelector('input[role="combobox"]');
    if (!input || input.disabled || !fillInput(nickname, 0, 300)) return false;
    multi.fillPending = null;
    multi.awaitingRow = false;
    multi.awaitingRowAt = 0;
    if (loadSettings().autoSubmit) {
      multi.autoSubmit = {
        pending: true,
        attempted: false,
        expected: nickname,
        lastClick: 0,
        nextAttemptAt: 0,
        delayUntil: Date.now() + handicapDelayMs(),
      };
      void waitSubmitButton(nickname);
    }
    return true;
  }

  function waitSubmitButton(expected) {
    const my = multi.autoSubmit;
    let waited = 0;
    const tick = () => {
      if (multi.autoSubmit !== my || !my.pending || my.attempted) return;
      if (Date.now() < my.delayUntil) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
      if (Date.now() < my.nextAttemptAt) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
      if (Date.now() < multi.nextSubmitAt) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
      const btn = document.querySelector('.input-bar button.btn');
      const input = document.querySelector('input[role="combobox"]');
      if (!btn || !input) {
        setTimeout(tick, SUBMIT_RETRY_MS);
        return;
      }
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
      my.attempted = true;
      multi.pendingIdx = enc ? enc.nicks.indexOf(expected) : -1;
      // 自动提交已在脚本侧等待冷却，点击后立即保留该昵称，避免晚回执触发重复提交。
      if (multi.pendingIdx >= 0) multi.submitted.add(multi.pendingIdx);
      multi.nextSubmitAt = my.lastClick + GUESS_COOLDOWN_MS;
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
        if (multi.pendingIdx >= 0) multi.submitted.add(multi.pendingIdx);
        // 提交成功前端会清空输入框，但行要等 React 渲染才出现。
        // 在行确认前禁止继续填充，避免状态尚未同步时抢跑下一次猜测。
        multi.awaitingRow = true;
        multi.awaitingRowAt = Date.now();
        return;
      }
      waited++;
      if (waited * SUBMIT_RETRY_MS >= SUBMIT_CONFIRM_TIMEOUT) {
        // 页面会在 5 秒请求超时后主动同步房间；这里转入行确认阶段。
        my.pending = false;
        multi.awaitingRow = true;
        multi.awaitingRowAt = my.lastClick || Date.now();
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

  function trackMultiSubmit(event) {
    if (!location.pathname.startsWith('/multi') || !multi.active || multi.ended) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.input-bar')) return;
    const btn = form.querySelector('button.btn');
    const input = form.querySelector('input[role="combobox"]');
    if (!btn || btn.disabled || !input) return;
    const gIdx = enc ? enc.nicks.indexOf(input.value.trim()) : -1;
    if (gIdx < 0) return;
    // submit 事件发生在 onPick 返回结果之前，不能在这里直接认为请求成功。
    // 只有输入框清空或反馈表格新增行后，才把选手加入 submitted。
    multi.pendingIdx = gIdx;
    multi.nextSubmitAt = Date.now() + GUESS_COOLDOWN_MS;
    multi.fillPending = null;
    multi.awaitingRow = true;
    multi.awaitingRowAt = Date.now();
  }

  function processMultiRows(rows, from) {
    let processed = from;
    for (let i = from; i < rows.length; i++) {
      const row = rows[i];
      const nickEl = row.querySelector('td.name');
      const nick = nickEl ? nickEl.textContent.trim() : '';
      if (!nick) break; // React 可能先插入空行，再补齐单元格内容
      const gIdx = enc ? enc.nicks.indexOf(nick) : -1;
      if (gIdx >= 0) {
        const filtered = filterCandidates(enc, multi.candidates, gIdx, keyFromRow(row));
        if (filtered.length === 0) {
          // 反馈无法匹配任何候选（行渲染过渡态等）：保留原候选集继续对局，不卡死
          setStatus('多人：反馈未能匹配候选集，已跳过本轮过滤');
        } else {
          multi.candidates = filtered;
        }
        multi.guessed.add(gIdx);
        multi.submitted.add(gIdx);
      } else {
        setStatus(`多人：无法识别猜测「${nick}」，请同步数据`);
      }
      processed = i + 1;
      if (row.classList.contains('row-correct')) multi.ended = true;
    }
    multi.turn = processed;
    if (processed > from) {
      multi.nextSubmitAt = Math.max(multi.nextSubmitAt, Date.now() + GUESS_COOLDOWN_MS);
    }
    return processed;
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
    // 对手退出/断线时的结算弹窗也会含 .answer-name（显示对手信息），
    // 通过弹窗文本识别并跳过，避免误报“选手库与服务器不一致”
    const overlayText = document.querySelector('.overlay-card') ? document.querySelector('.overlay-card').innerText : '';
    const isMatchOver = /退出了房间|离开|断线|disconnect|left|forfeit/i.test(overlayText);
    const roundEnded = Boolean(answerText) && !isMatchOver;
    if (!multi.active) {
      multi.active = true;
      multi.lastAnswer = '';
      multi.lastRound = round;
      resetMultiRound();
      multi.ended = roundEnded;
      multi.lastRowCount = processMultiRows(rows, 0);
      setStatus(`多人对局（${MODE_NAMES[multi.mode] || '?'}）已接管`);
      if (roundEnded) {
        multi.lastAnswer = answerText;
        const won = multiLastRowWon(selfBoard);
        recordGame(multi.mode || 'normal', won, multi.turn, multi.lastAnswer);
        setStatus(`多人${won ? '获胜' : '失利'}：答案 ${multi.lastAnswer}（已记录）`);
        if (enc) {
          const ansIdx = enc.nicks.indexOf(multi.lastAnswer);
          if (ansIdx >= 0 && !multi.candidates.includes(ansIdx)) {
            setStatus(`选手库与服务器不一致（答案「${multi.lastAnswer}」不在候选集），请点「同步选手库」更新`);
          }
        }
      } else if (!multi.ended) {
        computeMultiFill();
      }
      return;
    }
    if (round !== null && round !== multi.lastRound) {
      resetMultiRound();
      multi.lastRowCount = processMultiRows(rows, 0);
      if (!multi.ended) computeMultiFill();
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
        // 数据一致性校验：答案不在本地候选集中说明选手库已过期，反馈过滤会持续错位
        if (enc) {
          const ansIdx = enc.nicks.indexOf(multi.lastAnswer);
          if (ansIdx >= 0 && !multi.candidates.includes(ansIdx)) {
            setStatus(`选手库与服务器不一致（答案「${multi.lastAnswer}」不在候选集），请点「同步选手库」更新`);
          }
        }
      }
    }
    if (multi.ended) {
      if (n < multi.lastRowCount) {
        resetMultiRound();
        multi.lastRowCount = processMultiRows(rows, 0);
        if (!multi.ended) computeMultiFill();
      } else {
        multi.lastRowCount = n;
      }
      return;
    }
    // 放水局：不填不猜，点「跳过本局」并确认对话框判负。
    // 无确认框时点跳过按钮；出现跳过确认框后点确认才算完成，避免对局卡在确认框。
    if (multi.handicapLose && !multi.handicapSkipDone) {
      if (!document.querySelector('.confirm-dialog[role="alertdialog"]')) {
        clickSkipButton();
      } else if (clickSkipConfirm()) {
        multi.handicapSkipDone = true;
      }
      return;
    }
    if (n < multi.lastRowCount) {
      resetMultiRound();
      multi.lastRowCount = processMultiRows(rows, 0);
      if (!multi.ended) computeMultiFill();
      return;
    }
    if (n > multi.lastRowCount) {
      const processed = processMultiRows(rows, multi.lastRowCount);
      if (processed > multi.lastRowCount) {
        multi.awaitingRow = false;
        multi.awaitingRowAt = 0;
        multi.lastRowCount = processed;
        multi.pendingIdx = -1;
        const last = rows[processed - 1];
        if (last && last.classList.contains('row-correct')) {
          multi.ended = true;
          multi.autoSubmit.pending = false;
        } else {
          computeMultiFill();
        }
        return;
      }
    }
    // 手动提交只在页面清空输入框后确认；自动提交在点击时已保留对应昵称。
    if (multi.awaitingRow) {
      const input = document.querySelector('input[role="combobox"]');
      if (input && input.value.trim() === '' && multi.pendingIdx >= 0) {
        multi.submitted.add(multi.pendingIdx);
      }
      if (Date.now() - multi.awaitingRowAt <= SUBMIT_ROW_TIMEOUT) return;
      multi.awaitingRow = false;
      multi.awaitingRowAt = 0;
      multi.pendingIdx = -1;
      computeMultiFill();
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
      if (input && !input.disabled && input.value === '' && !multi.autoSubmit.pending) {
        fillMulti(enc.nicks[multi.lastIdx]);
      }
    }
    if (multi.autoSubmit.pending && multi.lastIdx >= 0) {
      const input = document.querySelector('input[role="combobox"]');
      if (input && input.value.trim() === '') {
        if (multi.autoSubmit.attempted) {
          // 已点击提交，页面清空输入框说明请求已发出：等待反馈行渲染
          const submittedIdx = enc.nicks.indexOf(multi.autoSubmit.expected);
          if (submittedIdx >= 0) multi.submitted.add(submittedIdx);
          multi.autoSubmit.pending = false;
          multi.awaitingRow = true;
          multi.awaitingRowAt = Date.now();
        } else {
          // 尚未点击提交而输入框被清空（填充失败/被清空）：重新填入，保留原延迟窗口
          const target = document.querySelector('input[role="combobox"]');
          if (target && !target.disabled) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(target, multi.autoSubmit.expected);
            target.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            multi.fillPending = multi.autoSubmit.expected;
          }
        }
        return;
      }
      if (!multi.autoSubmit.attempted && Date.now() >= multi.autoSubmit.nextAttemptAt) {
        waitSubmitButton(multi.autoSubmit.expected);
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
    if (!panelRoot) return;
    const el = panelRoot.querySelector('.fb-status');
    if (el) el.textContent = text;
    // 状态色条：警告/错误/正常
    const bar = panelRoot.querySelector('.fb-status-bar');
    if (bar) {
      bar.className = 'fb-status-bar' + (
        /失败|异常|不一致|警告/.test(text) ? ' warn' :
        /获胜|成功|完成|就绪/.test(text) ? ' ok' : ''
      );
    }
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = 'friberg-helper';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;font-family:"Inter",system-ui,-apple-system,sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        .fb-panel{width:248px;background:rgba(15,17,23,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#e4e7ec;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:0;box-shadow:0 8px 32px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03) inset;font-size:13px;line-height:1.5;overflow:hidden;transition:opacity .25s,transform .25s}
        .fb-panel.collapsed{opacity:0;transform:scale(.9) translateY(8px);pointer-events:none;height:0;padding:0;border:0}
        /* 标题栏（可拖拽） */
        .fb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,.05)}
        .fb-header h1{font-size:13px;font-weight:600;letter-spacing:.3px;color:#f0f2f5}
        .fb-header-right{display:flex;align-items:center;gap:8px}
        .fb-mode{font-size:10px;color:#8b95a5;background:rgba(255,255,255,.05);padding:2px 7px;border-radius:20px}
        .fb-collapse{width:20px;height:20px;border:0;background:rgba(255,255,255,.06);color:#8b95a5;border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:background .15s}
        .fb-collapse:hover{background:rgba(255,255,255,.12);color:#fff}
        /* 主体 */
        .fb-body{padding:10px 14px 12px}
        /* 对局信息 */
        .fb-info{margin-bottom:10px}
        .fb-cand{font-size:11px;color:#7c8698;margin-bottom:2px}
        .fb-guess{font-size:18px;font-weight:700;color:#6ee7a0;letter-spacing:.2px;text-shadow:0 0 12px rgba(110,231,160,.15)}
        .fb-guess.idle{color:#5a6375;font-size:13px;font-weight:400;text-shadow:none}
        /* 开关组 */
        .fb-toggles{display:flex;gap:6px;margin-bottom:10px}
        .fb-toggle{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#8b95a5;cursor:pointer;font-size:11px;font-weight:500;text-align:center;transition:all .18s}
        .fb-toggle:hover{background:rgba(255,255,255,.07);color:#c8cdd6}
        .fb-toggle.on{background:rgba(110,231,160,.1);border-color:rgba(110,231,160,.25);color:#6ee7a0}
        /* 控场配置抽屉 */
        .fb-hc{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .25s;opacity:0;margin-bottom:0}
        .fb-hc.open{max-height:220px;opacity:1;margin-bottom:10px}
        .fb-hc-inner{padding:10px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:10px}
        .fb-hc-inner label{display:flex;justify-content:space-between;align-items:center;margin:5px 0;font-size:11px;color:#9aa3b2}
        .fb-hc .range-row{display:flex;align-items:center;gap:3px}
        .fb-hc input[type=number]{width:40px;background:rgba(0,0,0,.3);color:#e4e7ec;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:3px 4px;text-align:center;font-size:11px;transition:border-color .15s}
        .fb-hc input[type=number]:focus{border-color:rgba(110,231,160,.4);outline:none}
        .fb-hc select{background:rgba(0,0,0,.3);color:#e4e7ec;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:3px 6px;font-size:11px}
        .fb-hc input[type=checkbox]{accent-color:#6ee7a0}
        .fb-hc-btns{display:flex;gap:6px;margin-top:8px}
        .fb-hc-btns button{flex:1;padding:5px 0;border-radius:7px;border:0;cursor:pointer;font-size:11px;font-weight:500;color:#fff;transition:filter .15s}
        .fb-hc-btns button:hover{filter:brightness(1.15)}
        /* 数据操作 */
        .fb-data{display:flex;gap:6px;margin-bottom:10px}
        .fb-data button{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#8b95a5;cursor:pointer;font-size:11px;transition:all .18s}
        .fb-data button:hover{background:rgba(255,255,255,.08);color:#d0d5dd}
        .fb-data button:disabled{opacity:.4;cursor:default}
        /* 状态栏 */
        .fb-status-wrap{position:relative;padding-left:10px}
        .fb-status-bar{position:absolute;left:0;top:1px;bottom:1px;width:3px;border-radius:2px;background:#3d4450;transition:background .3s}
        .fb-status-bar.ok{background:#6ee7a0}
        .fb-status-bar.warn{background:#fbbf24}
        .fb-status{font-size:10px;color:#6b7585;word-break:break-all;line-height:1.4}
        /* 经验 */
        .fb-exp{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05);font-size:10px;color:#5f6978}
        .fb-exp ul{margin:3px 0 0;padding-left:12px;list-style:disc}
        /* 收起态浮标 */
        .fb-dot{width:36px;height:36px;border-radius:50%;background:rgba(15,17,23,.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;cursor:pointer;transition:transform .2s,box-shadow .2s;color:#6ee7a0;font-size:14px;font-weight:700}
        .fb-dot:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,0,0,.5)}
        .fb-dot.show{display:flex}
      </style>
      <div class="fb-dot" id="fb-dot">弗</div>
      <div class="fb-panel" id="fb-panel">
        <div class="fb-header" id="fb-drag">
          <h1>弗一把助手</h1>
          <div class="fb-header-right">
            <span class="fb-mode" id="fb-mode">-</span>
            <button class="fb-collapse" id="fb-min" title="收起">─</button>
          </div>
        </div>
        <div class="fb-body">
          <div class="fb-info">
            <div class="fb-cand" id="fb-cand">等待对局</div>
            <div class="fb-guess idle" id="fb-guess">─</div>
          </div>
          <div class="fb-toggles">
            <button class="fb-toggle" id="fb-autosubmit">自动提交</button>
            <button class="fb-toggle" id="fb-handicap">控场</button>
          </div>
          <div class="fb-hc" id="fb-hc">
            <div class="fb-hc-inner">
              <label><span>启用控场</span><input type="checkbox" id="hc-enabled"></label>
              <label><span>最少猜测</span><span class="range-row"><input type="number" id="hc-min-lo" min="1" max="6" step="1"><span>~</span><input type="number" id="hc-min-hi" min="1" max="6" step="1"><span>次</span></span></label>
              <label><span>提交延迟</span><span class="range-row"><input type="number" id="hc-delay-lo" min="0" max="20" step="1"><span>~</span><input type="number" id="hc-delay-hi" min="0" max="20" step="1"><span>秒</span></span></label>
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
                <button id="hc-save" style="background:#2d8a56">保存</button>
                <button id="hc-close" style="background:rgba(255,255,255,.08)">关闭</button>
              </div>
            </div>
          </div>
          <div class="fb-data">
            <button id="fb-import">导入 JSON</button>
            <button id="fb-sync">同步选手库</button>
          </div>
          <div class="fb-status-wrap">
            <div class="fb-status-bar" id="fb-status-bar"></div>
            <div class="fb-status" id="fb-status">就绪</div>
          </div>
          <div class="fb-exp" id="fb-exp"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    panel = host;
    panelRoot = shadow;

    // --- 收起 / 展开 ---
    const panelEl = shadow.getElementById('fb-panel');
    const dotEl = shadow.getElementById('fb-dot');
    shadow.getElementById('fb-min').addEventListener('click', () => {
      panelEl.classList.add('collapsed');
      dotEl.classList.add('show');
    });
    dotEl.addEventListener('click', () => {
      panelEl.classList.remove('collapsed');
      dotEl.classList.remove('show');
    });

    // --- 拖拽 ---
    const drag = shadow.getElementById('fb-drag');
    let dragging = false, dx = 0, dy = 0;
    drag.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      drag.setPointerCapture(e.pointerId);
    });
    drag.addEventListener('pointermove', e => {
      if (!dragging) return;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = (e.clientX - dx) + 'px';
      host.style.top = (e.clientY - dy) + 'px';
    });
    drag.addEventListener('pointerup', () => { dragging = false; });

    // --- 开关组 ---
    function updateAutoSubmitButton() {
      const el = shadow.getElementById('fb-autosubmit');
      if (!el) return;
      const on = loadSettings().autoSubmit;
      el.classList.toggle('on', on);
      el.textContent = on ? '自动提交 ✓' : '自动提交';
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
      el.classList.toggle('on', h.enabled);
      el.textContent = h.enabled ? '控场 ✓' : '控场';
    }
    function fillHandicapForm() {
      const h = loadSettings().handicap;
      shadow.getElementById('hc-enabled').checked = h.enabled;
      shadow.getElementById('hc-min-lo').value = h.minGuessesMin;
      shadow.getElementById('hc-min-hi').value = h.minGuessesMax;
      shadow.getElementById('hc-delay-lo').value = h.delaySecMin;
      shadow.getElementById('hc-delay-hi').value = h.delaySecMax;
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
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(v) || 0));
      const minLo = clamp(Number(shadow.getElementById('hc-min-lo').value), 1, 6);
      const minHi = clamp(Number(shadow.getElementById('hc-min-hi').value), minLo, 6);
      const delayLo = clamp(Number(shadow.getElementById('hc-delay-lo').value), 0, 20);
      const delayHi = clamp(Number(shadow.getElementById('hc-delay-hi').value), delayLo, 20);
      const lose = Number(shadow.getElementById('hc-lose').value);
      s.handicap = { enabled: shadow.getElementById('hc-enabled').checked, minGuessesMin: minLo, minGuessesMax: minHi, delaySecMin: delayLo, delaySecMax: delayHi, loseRate: Number.isFinite(lose) ? lose : 0 };
      saveSettings(s);
      updateHandicapButton();
      shadow.getElementById('fb-hc').classList.remove('open');
      setStatus(`控场已${s.handicap.enabled ? '开启' : '关闭'}（${minLo}~${minHi} 猜 · ${delayLo}~${delayHi}s · 放水 ${Math.round(s.handicap.loseRate * 100)}%）`);
    });
    updateHandicapButton();

    // --- 数据操作 ---
    shadow.getElementById('fb-import').addEventListener('click', importFromFile);
    shadow.getElementById('fb-sync').addEventListener('click', async () => {
      shadow.getElementById('fb-sync').disabled = true;
      try {
        setStatus('正在从 GitHub 数据仓库同步选手库...');
        const ok = await syncFromGitHub();
        if (ok) {
          setStatus(`选手库同步完成（v${cache.version}，${cache.players.length} 人）`);
        }
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
    if (info.nick) {
      g.textContent = info.nick;
      g.classList.remove('idle');
    } else {
      g.textContent = '─';
      g.classList.add('idle');
    }
    panelRoot.getElementById('fb-status').textContent = statusLine;
    const stats = loadStats();
    const m = stats.modes[info.mode];
    if (m && m.games > 0) {
      const top = Object.entries(m.answers).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `<li>${n} ×${c}</li>`).join('');
      panelRoot.getElementById('fb-exp').innerHTML =
        `${m.games} 局 · 胜 ${m.wins}（${Math.round(100 * m.wins / m.games)}%）· 均 ${(m.guesses / m.games).toFixed(1)} 步` +
        (top ? `<ul>${top}</ul>` : '');
    } else {
      panelRoot.getElementById('fb-exp').textContent = '';
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
  
  // MutationObserver 管理：仅监听对局面板容器，避免全页面 DOM 变动（动画/tooltip）触发无效轮询
  let boardObserver = null;
  let observedBoard = null;
  function manageBoardObserver() {
    if (!location.pathname.startsWith('/multi')) {
      if (boardObserver) { boardObserver.disconnect(); boardObserver = null; observedBoard = null; }
      return;
    }
    const board = document.querySelector('.player-board-self');
    if (board && board !== observedBoard) {
      if (boardObserver) boardObserver.disconnect();
      boardObserver = new MutationObserver(scheduleSync);
      boardObserver.observe(board, { childList: true, subtree: true });
      observedBoard = board;
    } else if (!board && boardObserver) {
      // 面板尚未渲染（React 还没挂载）：临时监听 body 等待出现
      boardObserver.disconnect();
      boardObserver.observe(document.body, { childList: true, subtree: true });
      observedBoard = null;
    }
  }
  
  function boot() {
    cache = loadPlayersCache();
    ensureEncoded();
    hookXHR();
    hookFetch();
    document.addEventListener('submit', trackMultiSubmit, true);
    if (!document.querySelector('#friberg-helper')) createPanel();
    setStatus('就绪；若已有进行中的对局，请点「重新开始」让助手接管');
    ensureData().then(ok => {
      if (ok) checkDbUpdate();
    }).catch(e => setStatus('选手库加载失败：' + e.message));
    // 事件驱动为主（新行/回合结束立即响应），快速轮询兖底
    if (typeof MutationObserver === 'function') {
      boardObserver = new MutationObserver(scheduleSync);
      boardObserver.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(() => {
      if (!document.querySelector('#friberg-helper')) createPanel();
      manageBoardObserver();
      pollMulti();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

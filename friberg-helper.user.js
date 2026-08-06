// ==UserScript==
// @name         弗一把助手
// @namespace    shnlfriberg.helper
// @version      0.12.0
// @description  弗一把(CSGO 选手猜测)开源辅助：求解最优猜测并填入输入框，单人与多人联机自动接管，提交与否由你决定；首次自动拉取仓库数据，支持本地 JSON 导入与服务器增量同步
// @match        https://shnlfriberg.online/*
// @homepageURL  https://github.com/byJming/friberg-helper
// @supportURL   https://github.com/byJming/friberg-helper/issues
// @downloadURL  https://github.com/byJming/friberg-helper/raw/main/friberg-helper.user.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      github.com
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const PAGE = unsafeWindow;
  const KEY_PLAYERS = 'friberg.players.v1';
  const KEY_STATS = 'friberg.stats.v1';
  const KEY_SETTINGS = 'friberg.settings.v1';
  const KEY_SERVERSYNC = 'friberg.serversync.v1'; // 服务器同步进度：{version, synced:{nick:true}}
  const KEY_PERSONA = 'friberg.persona.v1'; // 拟真人格向量：安装级持久化，伪装成固定的"某一个人"

  // 数据来源优先级：服务器 > 用户导入 > 仓库自动拉取。冲突时高优先级覆盖低优先级；
  // 任何来源都不会清空既有数据（增量合并，不冲突互相补充）。
  const SOURCE_PRIO = { repo: 1, import: 2, server: 3 };
  // 仓库原始数据（snake_case，无 id）。首次运行无本地数据时自动拉取，作为初始选手库。
  const REPO_DATA_URL = 'https://raw.githubusercontent.com/byJming/friberg-helper/main/data/players_full.json';

  const AGE_CLOSE = 3;
  const MAJOR_CLOSE = 1;
  const MODE_NAMES = { beginner: '入门版', easy: '简单版', normal: '完整版' };
  const MODE_KEYS = new Set(Object.keys(MODE_NAMES));
  // 难度标签覆盖率过低时不强行切池，避免旧缓存/部分同步误排除真实答案。
  const MODE_POOL_MIN_COVERAGE = 0.8;

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
  // 拟真模式（反检测）默认值：策略预设 + 延迟区间 + 放水率。
  // 最少猜测目标不再手配——由候选池规模/历史均步/策略自动推算，避免固定参数成为跨局指纹。
  const HANDICAP_DEFAULT = { enabled: false, strategy: 'balanced', delaySecMin: 4, delaySecMax: 14, loseRate: 0.15 };
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
        if (h.minGuessesMin === undefined && h.minGuesses !== undefined) {
          delete h.minGuesses;
        }
        if (h.delaySecMin === undefined) {
          const old = h.delaySec || 8;
          h.delaySecMin = Math.max(2, old - 3);
          h.delaySecMax = Math.min(20, old + 3);
          delete h.delaySec;
        }
        // v0.11.0：移除手配最少猜测；补齐策略预设
        delete h.minGuessesMin; delete h.minGuessesMax;
        if (!h.strategy) h.strategy = 'balanced';
      }
      // 对旧版本/手动改写的配置做一次边界归一化，避免非法值污染延迟与概率模型。
      const h = s.handicap;
      h.enabled = Boolean(h.enabled);
      h.strategy = ['conservative', 'balanced', 'aggressive'].includes(h.strategy) ? h.strategy : HANDICAP_DEFAULT.strategy;
      const toSec = value => Number.isFinite(Number(value)) ? Math.min(60, Math.max(0, Math.floor(Number(value)))) : 0;
      h.delaySecMin = toSec(h.delaySecMin);
      h.delaySecMax = Math.max(h.delaySecMin, toSec(h.delaySecMax));
      const lose = Number(h.loseRate);
      h.loseRate = Number.isFinite(lose) ? Math.min(0.4, Math.max(0, lose)) : HANDICAP_DEFAULT.loseRate;
      _settingsCache = s;
      return s;
    } catch (e) { _settingsCache = { autoFill: true, autoSubmit: false, handicap: { ...HANDICAP_DEFAULT } }; return _settingsCache; }
  }
  function saveSettings(s) {
    _settingsCache = s;
    try { GM_setValue(KEY_SETTINGS, s); } catch (e) { /* quota */ }
  }
  // 服务器同步进度：{ version, synced:{<nickname>:true} }
  // synced 记录「在 version 这个服务器版本下已确认过的昵称」——含成功拉取与服务器确认不存在。
  // 版本变更时整体清空（新版本所有选手都需重新以服务器为准），保证「冲突以服务器为准」始终生效。
  function loadServerSync() {
    try { return GM_getValue(KEY_SERVERSYNC, null) || { version: null, synced: {} }; } catch (e) { return { version: null, synced: {} }; }
  }
  function saveServerSync(s) {
    try { GM_setValue(KEY_SERVERSYNC, s); } catch (e) { /* quota */ }
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
      ths: new Array(players.length),
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
      // 历史队伍编码（与当前队伍共用 teamMap）；过滤空项保证 '' 永不入集
      enc.ths[i] = new Set(
        (Array.isArray(p.teamHistory) ? p.teamHistory : [])
          .filter(t => typeof t === 'string' && t.trim())
          .slice(0, 50)
          .map(t => code(teamMap, t.trim()))
      );
      enc.ages[i] = p.age;
      enc.roles[i] = code(roleMap, p.role);
      enc.mcs[i] = p.majorChampionships;
      enc.mas[i] = p.majorAppearances;
      enc.acts[i] = p.isActive ? 1 : 0;
    });
    return enc;
  }

  // 5 级数值反馈：0=相等 1=close且目标更大 2=far且目标更大 3=close且目标更小 4=far且目标更小。
  // 与服务端 numberFeedbackCode 逐字等价 —— 修复 v0.4.0 close 方向 hint 未利用的 bug：
  // 旧版把 close 合并为一级，丢失"目标更大/更小"信息，导致候选集膨胀、内部增益计算与服务端失配。
  function numLevel(gv, tv, closeRange) {
    if (gv === tv) return 0;
    const close = Math.abs(gv - tv) <= closeRange;
    return tv > gv ? (close ? 1 : 2) : (close ? 3 : 4);
  }
  // 队伍反馈 3 级（与服务端 teamAttr 一致）：同队=2(correct)；当前队伍不同但
  // 猜测队伍在答案选手历史队伍中=1(close)；否则=0(wrong)。
  function teamLevel(enc, g, a) {
    if (enc.teams[g] === enc.teams[a]) return 2;
    return enc.ths[a].has(enc.teams[g]) ? 1 : 0;
  }

  // 逐属性反馈分区键 —— 与服务端 feedbackSignature 逐字等价：
  // ① id 隔离位（猜测即答案时单独成区，匹配服务端最优增益基准）；
  // ② 国籍 3 级折叠地区（同国/异国同区/异国异区），多人面板无独立地区列亦能正确分区；
  // ③ 队伍 3 级（同队/前队友/无关），历史队伍缺失时自然退化为 0/2 两级；
  // ④ 数值 5 级含方向。分区等价 ⇒ 内部信息增益/百分位计算与服务端一致，governor 可真实拟真。
  function feedbackKey(enc, g, a) {
    let k = g === a ? 1 : 0; // id 隔离位
    const nat = enc.nats[g] === enc.nats[a] ? 2 : enc.regs[g] === enc.regs[a] ? 1 : 0;
    k = k * 3 + nat;
    k = k * 3 + teamLevel(enc, g, a);
    k = k * 5 + numLevel(enc.ages[g], enc.ages[a], AGE_CLOSE);
    k = k * 2 + (enc.roles[g] === enc.roles[a] ? 1 : 0);
    k = k * 5 + numLevel(enc.mcs[g], enc.mcs[a], MAJOR_CLOSE);
    k = k * 5 + numLevel(enc.mas[g], enc.mas[a], MAJOR_CLOSE);
    k = k * 2 + (enc.acts[g] === enc.acts[a] ? 1 : 0);
    return k;
  }

  const LEVEL_CODE = { correct: 0, close: 1, wrong: 2 };
  // 从服务端反馈属性构造分区键（单人对局）。仅在未猜中（game 继续）时调用，id 隔离位恒 0。
  function numLevelFromAttr(f) {
    if (f.level === 'correct') return 0;
    const close = f.level === 'close';
    return f.hint === 'higher' ? (close ? 1 : 2) : (close ? 3 : 4);
  }
  // 从服务端反馈构造分区键集合（单人对局）。仅在未猜中（game 继续）时调用，id 隔离位恒 0。
  // close（前队友）时本地历史可能缺失，无法断定答案落在 1 还是 0 桶，
  // 返回双键保留两桶，避免误排除答案（wrong 则必为 0 桶）。
  function feedbackKeysFromServer(attrs) {
    const build = (teamDigit) => {
      let k = 0; // id 隔离位：未猜中时恒 0
      const nat = attrs.nationality.level === 'correct' ? 2 : attrs.nationality.level === 'close' ? 1 : 0;
      k = k * 3 + nat; // 地区信息已折叠进国籍 3 级，无需单独编码 region
      k = k * 3 + teamDigit;
      k = k * 5 + numLevelFromAttr(attrs.age);
      k = k * 2 + (attrs.role.level === 'correct' ? 1 : 0);
      k = k * 5 + numLevelFromAttr(attrs.majorChampionships);
      k = k * 5 + numLevelFromAttr(attrs.majorAppearances);
      k = k * 2 + (attrs.isActive.level === 'correct' ? 1 : 0);
      return k;
    };
    const lvl = attrs.team.level;
    if (lvl === 'correct') return [build(2)];
    if (lvl === 'close') return [build(1), build(0)];
    return [build(0)];
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
  // 作弊分析已委托外部服务（仍接收猜测序列与猜测用时），持续 top 1%
  // 的机器化选择模式依旧容易被识别。
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
    pendingHistory: [], // 本局已收到的 close 队伍证据（待答案揭示后归档）
    roundMinGuesses: 0,
    bestGreens: 0,
    confusedLeft: 0,
    choked: false,
    chokeStrength: 0,
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
    handicapPlan: null,
    roundCloseTeams: [], // 本回合队伍黄格证据（待回合答案揭示后归档）
    bestGreens: 0,
    roundMinGuesses: 0,
    afkPending: false,  // 本回合 AFK 长停顿配额（触发时机在延迟模型里掷）
    choked: false,      // 上头局：提高直觉偏置，但保留概率性恢复与收尾
    lastGreens: 0,      // 最近一手反馈绿格数（延迟模型的反馈耦合输入）
    confusedLeft: 0,    // 困惑状态剩余手数（成簇错误：人类失误是相关的）
    afkDone: false,     // 本回合是否已插入 AFK 级停顿
    rhythm: [],         // 最近几手提交延迟（秒），用于连击后犹豫的节奏建模
    chokeStrength: 0,   // 上头强度：用概率偏向替代“永不猜候选”的硬规则
    giveUpAfter: 0,     // 计划放弃时先尝试的手数，避免零猜测瞬时跳过
    roundStartedAt: 0,  // 本地回合起点，用于思考时间预算
    awaitingRow: false,
    awaitingRowAt: 0,
    pendingIdx: -1,
    nextSubmitAt: 0,
    autoSubmit: { pending: false, attempted: false, expected: '', lastClick: 0, nextAttemptAt: 0, delayUntil: 0 },
  };

  // === CORE-BEGIN ===
  // 纯决策核心（无 DOM 依赖）。computeMultiFill 与仿真测试共用此区段。
  // 拟真目标：像真人一样逐步逼近答案——开局猜知名选手、中段按反馈收敛、
  // 确认答案后在到达最少猜测目标前用「近似答案」递补（绝不提前提交）。
  // 反检测：以服务端 entropyPercentile 为目标的带内采样 + 直觉手/困惑簇，避免持续 top-1。

  // 计算选手 a 相对于选手 b 的逐属性反馈等级向量（精确复刻服务端着色）。
  // 返回 8 元素数组，每元素 0=green, 1=yellow(close), 2=red(wrong)。
  // 队伍黄：当前队伍不同但 a 的队伍在 b 的历史队伍中（服务端 teamAttr 语义）。
  // 列顺序与 UI 一致：国籍, 地区, 队伍, 年龄, 位置, Major冠军, Major次数, 状态
  function attrLevels(a, b) {
    const lv = [];
    lv.push(enc.nats[a] === enc.nats[b] ? 0 : enc.regs[a] === enc.regs[b] ? 1 : 2);
    lv.push(enc.regs[a] === enc.regs[b] ? 0 : 2);
    lv.push(enc.teams[a] === enc.teams[b] ? 0 : enc.ths[b].has(enc.teams[a]) ? 1 : 2);
    const ageD = Math.abs(enc.ages[a] - enc.ages[b]);
    lv.push(ageD === 0 ? 0 : ageD <= AGE_CLOSE ? 1 : 2);
    lv.push(enc.roles[a] === enc.roles[b] ? 0 : 2);
    const mcD = Math.abs(enc.mcs[a] - enc.mcs[b]);
    lv.push(mcD === 0 ? 0 : mcD <= MAJOR_CLOSE ? 1 : 2);
    const maD = Math.abs(enc.mas[a] - enc.mas[b]);
    lv.push(maD === 0 ? 0 : maD <= MAJOR_CLOSE ? 1 : 2);
    lv.push(enc.acts[a] === enc.acts[b] ? 0 : 2);
    return lv;
  }

  function guessDistance(a, b) {
    const lv = attrLevels(a, b);
    let d = 0;
    for (let i = 0; i < lv.length; i++) d += lv[i];
    return d;
  }

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

  // 流行度代理：Major 出场/冠军 + 在役，越高的选手越像真人会猜的「知名选手」。
  function playerPopularity(i) {
    const p = cache && cache.players ? cache.players[i] : null;
    if (!p) return 1;
    return (p.majorAppearances || 0) + (p.majorChampionships || 0) * 4 + (p.isActive ? 2 : 0) + 1;
  }

  // 最可能是答案的候选（历史经验 + 流行度），用于拟真禁胜窗口排除
  function modalCandidate(cands, guessed) {
    const avail = cands.filter(c => !guessed.has(c));
    if (!avail.length) return -1;
    avail.sort((a, b) =>
      (guessExperience(enc.nicks[b]) + playerPopularity(b) * 0.1) -
      (guessExperience(enc.nicks[a]) + playerPopularity(a) * 0.1));
    return avail[0];
  }

  // 反检测 governor：跨局滚动平均 entropyPercentile，动态调整目标带。
  // 作弊分析已移交外部服务（仍上报猜测序列与用时），保持自然化的
  // 信息增益分布依旧有效，避免持续选择高增益的机器化模式。
  const _gov = { recent: [] };
  function resetGovernor() { _gov.recent.length = 0; }
  function targetBand() {
    const p = loadPersona();
    const arr = _gov.recent;
    const target = p.entropyTarget;
    const spread = p.entropySpread;
    if (arr.length < 4) return { lo: Math.max(0.12, target - spread), hi: Math.min(0.96, target + spread) };
    // 近期样本使用指数权重，控制量连续变化，不再跨越固定阈值后瞬间切换整段区间。
    let weight = 1, totalWeight = 0, weighted = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      weighted += arr[i] * weight;
      totalWeight += weight;
      weight *= 0.92;
    }
    const mean = weighted / totalWeight;
    const correction = Math.max(-0.16, Math.min(0.16, (target - mean) * 0.7));
    const center = target + correction;
    return { lo: Math.max(0.08, center - spread), hi: Math.min(0.97, center + spread) };
  }
  function recordPercentile(p) { _gov.recent.push(p); if (_gov.recent.length > 40) _gov.recent.shift(); }

  // 自然逼近采样：在目标百分位带内，按「流行度 + 信息增益」混合打分，
  // 从 top-K 加权随机选取。开局流行度权重高（猜知名选手），后期逻辑权重高。
  // outsideOnly=true 时只从候选集外选（保证绝不命中答案，用于小候选禁胜窗口）。
  function pickNaturalGuess(o) {
    const { cands, excluded, turn, outsideOnly, modalAns } = o;
    const bestGreens = o.bestGreens || 0;
    const remaining = o.remaining != null ? o.remaining : 99;
    let selPool = all.filter(c => !excluded.has(c) && c !== modalAns &&
      (outsideOnly ? !cands.includes(c) : true));
    // 候选集覆盖了所有未猜选手（典型如开局 cands=all）：没有「候选集外」可选，
    // 退化为候选集内自然猜测（排除最可能答案以降低提前命中概率）。
    let effOutside = outsideOnly;
    let effModal = modalAns;
    if (effOutside && !selPool.length) {
      effOutside = false;
      if (effModal < 0) effModal = modalCandidate(cands, excluded);
      // 禁胜窗口回退（典型如开局 cands=all 无「候选集外」可选）：
      // 排除最热门的 N 名候选，降低首回合误命中答案导致 minG 违规的概率
      const sortedCands = cands.slice().sort((a, b) => playerPopularity(b) - playerPopularity(a));
      const topExclude = new Set(sortedCands.slice(0, Math.min(sortedCands.length, 15)));
      topExclude.add(effModal); // 也排除最可能答案，进一步降低 turn-0 误命中概率
      selPool = all.filter(c => !excluded.has(c) && !topExclude.has(c));
    }
    if (!selPool.length) {
      const any = all.filter(c => !excluded.has(c) && c !== effModal);
      return any.length ? any[Math.floor(Math.random() * any.length)] : -1;
    }
    // 增益与百分位：以全部选手为基准计算（近似服务端 entropyPercentile）
    const bench = all;
    const benchGain = new Array(bench.length);
    for (let i = 0; i < bench.length; i++) benchGain[i] = guessInfoGain(bench[i], cands);
    const sorted = benchGain.slice().sort((a, b) => a - b);
    const pctlOf = g => {
      const gv = guessInfoGain(g, cands);
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= gv + 1e-9) lo = mid + 1; else hi = mid; }
      return lo / sorted.length;
    };
    let inBand = selPool.map(g => ({ g, gain: guessInfoGain(g, cands), pctl: pctlOf(g) }));
    const band = targetBand();
    let filtered = inBand.filter(s => s.pctl >= band.lo && s.pctl <= band.hi);
    if (filtered.length < 3) filtered = inBand.filter(s => s.pctl >= band.lo * 0.6 && s.pctl <= Math.min(1, band.hi + 0.18));
    if (!filtered.length) filtered = inBand;
    // 绿色单调性启发式：用 modal 候选作为答案代理，偏好 green ≥ bestGreens 的猜测。
    // 候选不足时按容忍度递降（-1/-2）选取，把回退幅度限制在小幅，避免面板绿格大幅跳水。
    // 信息增益饥饿检测：若绿色集最佳增益远低于无过滤集（紧凑簇场景），放宽容忍度或跳过过滤，
    // 避免饿死收敛导致败局。保 win=1.0 优先于 greenReg。
    if (bestGreens > 0 && cands.length > 1) {
      const proxy = modalCandidate(cands, excluded);
      if (proxy >= 0) {
        for (const s of filtered) {
          s.greens = attrLevels(s.g, proxy).filter(v => v === 0).length;
        }
        const unfilteredMaxGain = (() => { let mx = 0; for (const s of filtered) if (s.gain > mx) mx = s.gain; return mx; })();
        for (let tol = 0; tol <= 2; tol++) {
          const mono = filtered.filter(s => s.greens >= bestGreens - tol);
          if (mono.length >= 1) {
            const monoMaxGain = (() => { let mx = 0; for (const s of mono) if (s.gain > mx) mx = s.gain; return mx; })();
            if (monoMaxGain >= 0.6 * unfilteredMaxGain) {
              filtered = mono;
              break;
            }
          }
        }
        // 所有容忍度都饿死增益 → 不过滤，保留原分数排序（接受偶发回退以保 win=1.0）
      }
    }
    // 混合打分：候选多时偏信息增益（快速收敛），候选少时偏流行度（自然收尾）
    const needInfo = cands.length > 20;
    const popW = needInfo ? Math.max(0.1, 0.35 - turn * 0.05) : Math.max(0.2, 0.6 - turn * 0.12);
    const gainW = 1 - popW;
    let maxPop = 1, maxGain = 1e-9;
    for (const s of filtered) { const p = playerPopularity(s.g); if (p > maxPop) maxPop = p; if (s.gain > maxGain) maxGain = s.gain; }
    for (const s of filtered) s.score = popW * (playerPopularity(s.g) / maxPop) + gainW * (s.gain / maxGain);
    filtered.sort((a, b) => b.score - a.score);
    // 绿色单调性保证（强形式）：对分数前 40 的猜测逐一验证其相对「所有候选」的绿色数
    // 都 ≥ bestGreens——无论真实答案是谁，面板绿格都不会回退。bestGreens ≤ 4 时启用
    // （v0.7.0 从 ≤3 提升至 ≤4：双胞胎簇已由 isTwinCluster 独立处理，强约束不再诱发簇陷阱）。
    // 附区分力守卫：safe 集最佳信息增益须 ≥ 头部 85%，防饿死收敛。
    if (bestGreens > 0 && bestGreens <= 4 && cands.length > 1) {
      const head = filtered.slice(0, 40);
      const annotated = head.map(s => {
        let mn = 99;
        for (const c of cands) {
          const lv = attrLevels(s.g, c);
          let g = 0;
          for (let i = 0; i < lv.length; i++) if (lv[i] === 0) g++;
          if (g < mn) mn = g;
        }
        s._minG = mn;
        return s;
      });
      let headMaxGain = 1e-9; for (const s of annotated) if (s.gain > headMaxGain) headMaxGain = s.gain;
      const safe = annotated.filter(s => s._minG >= bestGreens);
      let safeMaxGain = 0; for (const s of safe) if (s.gain > safeMaxGain) safeMaxGain = s.gain;
      if (safe.length && safeMaxGain >= 0.85 * headMaxGain) {
        filtered = safe.concat(filtered.slice(40));
      } else {
        const soft = annotated.filter(s => s._minG >= bestGreens - 1);
        let softMaxGain = 0; for (const s of soft) if (s.gain > softMaxGain) softMaxGain = s.gain;
        if (soft.length && softMaxGain >= 0.85 * headMaxGain) {
          filtered = soft.concat(filtered.slice(40));
        }
        // 否则不过滤：保留原分数排序，接受偶发回退以保 win=1.0
      }
    }
    // 开局多样性：首回合扩大 top-K 池，降低固定开场概率
    const K = turn === 0 ? Math.min(8, filtered.length) : Math.min(5, filtered.length);
    const top = filtered.slice(0, K);
    // 线性递减权重（开局更均匀）
    const w = top.map((_, i) => turn === 0 ? 1 : (K - i));
    const sum = w.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum, acc = 0;
    for (let i = 0; i < top.length; i++) { acc += w[i]; if (r <= acc) { recordPercentile(top[i].pctl); return top[i].g; } }
    recordPercentile(top[top.length - 1].pctl);
    return top[top.length - 1].g;
  }

  // 确认答案后的垫刀：猜与答案属性相近的未猜选手，绝不提交已确认的答案。
  // v0.11.0 人类化：偏好同国籍/同队/年龄近的「真人真会混淆」簇，而非纯属性距离最小；
  // 偶发放宽绿色单调（回退 ≤2 格），零回退垫刀序列是强机器指纹。
  function pickNearMiss(answerIdx, excluded, bestGreens, remainingFill, avoid) {
    const avoidSet = avoid instanceof Set ? avoid : null;
    const p = loadPersona();
    const cand = all
      .filter(c => !excluded.has(c) && c !== answerIdx && (!avoidSet || !avoidSet.has(c)))
      .map(c => ({ c, d: guessDistance(c, answerIdx), g: attrLevels(c, answerIdx).filter(v => v === 0).length }))
      .filter(x => x.d >= 1 && x.d <= 7);
    if (!cand.length) {
      const any = all.filter(c => !excluded.has(c) && c !== answerIdx);
      return any.length ? any[Math.floor(Math.random() * any.length)] : -1;
    }
    // 混淆度打分：人类在「同国籍/同队/年龄近」的选手之间犹豫，而非全局最近邻
    for (const x of cand) {
      let s = 8 - x.d;
      if (enc.nats[x.c] === enc.nats[answerIdx]) s += 3;
      if (enc.teams[x.c] === enc.teams[answerIdx]) s += 2;
      else if (enc.ths[answerIdx] && enc.ths[answerIdx].has(enc.teams[x.c])) s += 1.5;
      if (Math.abs(enc.ages[x.c] - enc.ages[answerIdx]) <= AGE_CLOSE) s += 1;
      x.s = s;
    }
    // 绿色单调性：优先 green ≥ bestGreens 的候选；小概率放宽制造 1~2 格自然回退
    const allowRegress = Math.random() < (p.regressRate * 2 + 0.04);
    if (bestGreens > 0 && !allowRegress) {
      const mono = cand.filter(x => x.g >= bestGreens);
      if (mono.length >= 1) {
        // 渐进递增：根据剩余填充次数均匀分配 green 增量，实现平滑变绿
        const maxGreen = 7; // 非答案猜测最多 7 绿（8=答案本身）
        const step = Math.max(1, Math.ceil((maxGreen - bestGreens) / remainingFill));
        const targetCeil = remainingFill > 1 ? Math.min(maxGreen, bestGreens + step) : maxGreen;
        const progressive = mono.filter(x => x.g >= bestGreens && x.g <= targetCeil);
        const pool = progressive.length >= 2 ? progressive : mono;
        return weightedPickBy(pool.map(x => ({ c: x.c, w: Math.max(0.5, x.s) })));
      }
    }
    // 放宽回退或无约束：按混淆度加权随机（回退幅度由打分自然限制，不会大幅跳水）
    return weightedPickBy(cand.map(x => ({ c: x.c, w: Math.max(0.5, x.s) })));
  }

  // 按权重加权随机选取（near-miss 与直觉猜测共用的抽样工具）
  function weightedPickBy(items) {
    if (!items.length) return -1;
    const sum = items.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * sum, acc = 0;
    for (const it of items) { acc += it.w; if (r <= acc) return it.c; }
    return items[items.length - 1].c;
  }

  // 双胞胎簇检测：候选集内所有选手属性两两全同（反馈无法进一步区分）。
  // 一旦锁死，任何猜测都不能分裂该簇——需特殊处理以避免耗尽回合或绿格回退。
  function isTwinCluster(cands) {
    if (cands.length < 2) return false;
    const base = cands[0];
    for (let i = 1; i < cands.length; i++) {
      const lv = attrLevels(cands[i], base);
      for (let j = 0; j < lv.length; j++) if (lv[j] !== 0) return false;
    }
    return true;
  }

  // 直觉猜测：真人凭印象/偏好冲一手——同国籍、同队、惯用开局等锚点选手。
  // 刻意不追求信息增益且容忍绿格回退：零回退是强机器指纹，人类试探性猜测常让面板变差。
  // 上头时偏好流行度/地区/惯用开局，但仍以低概率回到当前候选。
  function pickIntuitionGuess(cands, excluded, runtime) {
    const p = loadPersona();
    const active = runtime || multi;
    const choked = Boolean(active.choked);
    // 上头不等于永不读面板。对小候选集保留少量重试概率，避免“候选集内猜中概率恒为 0”的硬指纹。
    const retryCandidate = choked && Math.random() < Math.max(0.12, 0.38 - (active.chokeStrength || 0) * 0.2);
    const proxy = choked ? -1 : modalCandidate(cands, excluded);
    let pool = all.filter(c => !excluded.has(c) && c !== proxy && (!choked || retryCandidate || !cands.includes(c)));
    // normal 难度开局时 cands 就是 all；此时回退到低权重的候选内直觉猜，不让外层 solver 绕过上头状态。
    if (!pool.length) pool = all.filter(c => !excluded.has(c) && c !== proxy);
    if (!pool.length) return -1;
    const scored = pool.map(c => {
      let s = playerPopularity(c);
      if (proxy >= 0) {
        if (enc.nats[c] === enc.nats[proxy]) s += 12;      // 同国籍锚点：人类最典型的混淆维
        if (enc.teams[c] === enc.teams[proxy]) s += 10;
        else if (enc.ths[proxy] && enc.ths[proxy].has(enc.teams[c])) s += 6;
        if (Math.abs(enc.ages[c] - enc.ages[proxy]) <= AGE_CLOSE) s += 3;
      }
      if (choked && cands.includes(c)) s *= retryCandidate ? 0.75 : 0.28;
      if (p.favReg >= 0 && enc.regs[c] === p.favReg) s += 4;
      if (p.openers.includes(enc.nicks[c])) s += 8;
      return { c, s };
    });
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, Math.min(6, scored.length));
    const wsum = top.reduce((a, x) => a + x.s, 0);
    let r = Math.random() * wsum, acc = 0;
    for (const t of top) { acc += t.s; if (r <= acc) return t.c; }
    return top[top.length - 1].c;
  }

  // 单人/多人共用的拟真决策入口。runtime 持有困惑计数、上头强度与自适应目标。
  // 非拟真模式完全沿用原 pickGuess（excluded 即原版传入的猜测排除集），保障「不影响非拟真模式」。
  function decideRealisticGuess(o) {
    const cands = o.candidates;
    const excluded = o.excluded;
    const turn = o.turn;
    const maxGuesses = o.maxGuesses;
    const remaining = maxGuesses - turn;
    if (!cands.length) return -1;

    // 非拟真：行为与原版逐字一致（含 available 兜底，避免候选耗尽时重猜已猜选手）
    if (!o.handicapEnabled) {
      const available = cands.filter(c => !excluded.has(c));
      if (!available.length) return all.find(c => !excluded.has(c));
      return pickGuess(enc, cands, cands, excluded, remaining);
    }

    const p = loadPersona();
    const runtime = o.runtime || multi;
    let minG = o.roundMinGuesses;
    const confirmed = cands.length === 1;
    const twinLocked = isTwinCluster(cands); // 属性全同簇：反馈无法进一步区分
    const bestGreens = o.bestGreens || 0;

    // 双胞胎锁死优先：反馈无法区分，minG 填充不能占用枚举回合
    if (twinLocked) {
      const latestStart = maxGuesses - cands.length;
      if (turn >= latestStart) return modalCandidate(cands, excluded);
      const proxy = modalCandidate(cands, excluded);
      const avoid = new Set(cands);
      return pickNearMiss(proxy, excluded, bestGreens, latestStart - turn, avoid);
    }

    // 困惑状态（成簇错误）：连续数手凭直觉乱猜，容忍绿格回退。
    // 人类失误是相关的，独立均匀撒错恰是非人类特征；困惑中偶尔直接命中答案也符合真人。
    if (runtime.confusedLeft > 0 && !confirmed && turn < minG) {
      runtime.confusedLeft--;
      return pickIntuitionGuess(cands, excluded, runtime);
    }
    // 偶发直觉手：非困惑期小概率冲动猜测，打破「每手信息增益都在目标带内」的机器不变量；
    // 上头局频率提升——真人在不顺的局里更依赖直觉而非理性分析
    if (!confirmed && turn > 0 && turn < minG && Math.random() < p.regressRate * (runtime.choked ? 2.2 : 1)) {
      return pickIntuitionGuess(cands, excluded, runtime);
    }

    // 收敛速度自适应：到达目标回合但候选仍多 ⇒ 延长目标继续探路（真人此时不会硬求解）
    if (!confirmed && turn === minG - 1 && cands.length > 5 && remaining >= 3 && minG < 6) {
      runtime.roundMinGuesses = minG + 1;
      minG += 1;
    }
    const lastSolveTurn = Math.max(0, minG - 1); // 允许获胜的最后探路回合（0 基）

    // 确认答案但未达目标：限次人类式垫刀；垫超 2 手后可能提前收手——真人确认后果断猜出
    if (confirmed && turn < minG) {
      if (minG - turn > 2 && Math.random() < 0.45) return cands[0];
      return pickNearMiss(cands[0], excluded, bestGreens, minG - turn);
    }
    // 已过目标窗口：正常求解（允许获胜）；确认则提交。
    // 上头局按本回合强度在“继续偏见”与“回到候选收尾”之间切换，保留可逆性。
    if (turn >= minG) {
      if (confirmed) return cands[0];
      if (runtime.choked && cands.length <= 2 && Math.random() < (runtime.chokeStrength || 0.65)) {
        return pickIntuitionGuess(cands, excluded, runtime);
      }
      // 上头局仍保留少量收尾能力，不制造绝对不可逆的败局通道。
      const rescue = !runtime.choked || Math.random() > (runtime.chokeStrength || 0.65);
      const solvePool = (rescue && cands.length > remaining) ? all : cands;
      return pickGuess(enc, cands, solvePool, excluded, remaining);
    }
    // 探路/逼近阶段（turn < minG, candidates>1）
    const blockWin = turn < lastSolveTurn;
    if (blockWin) {
      // 上头时提高直觉猜概率，但不完全关闭反馈驱动的探路。
      if (runtime.choked && Math.random() < (runtime.chokeStrength || 0.65)) {
        return pickIntuitionGuess(cands, excluded, runtime);
      }
      // 禁胜窗口：只从候选集外选，保证绝不提前命中答案（winTurn 必 ≥ minG）。
      // 候选集外的猜测仍能按属性匹配给答案上色（绿/黄），面板自然变绿，且对候选集有信息增益。
      return pickNaturalGuess({ cands, excluded, turn, outsideOnly: true, modalAns: -1, bestGreens, remaining });
    }
    // 到达允许获胜回合（turn === lastSolveTurn）：候选很少时直接猜最可能答案（赶在 deadline 命中），
    // 否则自然逼近（可能命中，winTurn=minG，合规）
    if (cands.length <= 4) {
      const m = modalCandidate(cands, excluded);
      if (m >= 0) return m;
    }
    // 败局警戒：候选数 > 剩余步数时，自然猜测的信息增益不足以保证获胜，
    // 切换到 minimax 全局池求解（仅拟真模式且非上头；上头局继续自然逼近，允许真实败局）
    if (cands.length > remaining && (!runtime.choked || Math.random() > (runtime.chokeStrength || 0.65))) {
      return pickGuess(enc, cands, all, excluded, remaining);
    }
    return pickNaturalGuess({ cands, excluded, turn, outsideOnly: false, modalAns: -1, bestGreens, remaining });
  }

  function newHandicapPlan() {
    return { opened: false };
  }
  // === CORE-END ===
  function handicapEnabled() {
    return loadSettings().handicap.enabled;
  }

  function handicapConfig() {
    return loadSettings().handicap;
  }

  // ---------- 拟真人格（贝叶斯对抗核心） ----------
  // 检测器按单一主体的 50 局样本估参：固定参数的平稳采样器必被识别。
  // 解法：每安装一次性采样人格向量并永久落盘——节奏、失误率、困惑率、惯用开局、
  // 地区偏好各不相同且跨会话稳定，样本看起来来自「一个有个性的人」而非同一策略的多次实例。
  let _personaCache = null;
  function loadPersona() {
    if (_personaCache) return _personaCache;
    let p = null;
    try { p = GM_getValue(KEY_PERSONA, null); } catch (e) { /* ignore */ }
    if (!p || typeof p !== 'object') {
      p = {
        pace: 0.85 + Math.random() * 0.4,            // 个人节奏系数
        regressRate: 0.05 + Math.random() * 0.07,    // 直觉手/绿格回退概率
        confusionRate: 0.08 + Math.random() * 0.08,  // 本回合进入困惑（成簇错误）概率
        chokeRate: 0.05 + Math.random() * 0.06,      // 本回合上头（自然败局）概率
        afkRate: 0.05 + Math.random() * 0.06,        // 本回合出现 AFK 级停顿概率
        delaySigma: 0.38 + Math.random() * 0.2,      // 思考时间离散度，安装级稳定
        recoveryRate: 0.18 + Math.random() * 0.16,   // 上头后重新读面板/回到候选的概率
        entropyTarget: 0.58 + Math.random() * 0.12,  // 信息增益偏好中心，不同安装不共用同一阈值
        entropySpread: 0.16 + Math.random() * 0.08,  // 偏好带宽度
        openers: [],                                  // 惯用开局昵称（选手库就绪后惰性生成）
        favReg: -1,                                   // 偏好地区编码
        openersReady: false,
      };
    }
    // 向前兼容 v0.11 人格：不重掷已有特质，只补齐新维度和合法边界。
    const finiteOr = (value, fallback, lo, hi) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    p.pace = finiteOr(p.pace, 0.85 + Math.random() * 0.4, 0.65, 1.45);
    p.regressRate = finiteOr(p.regressRate, 0.05 + Math.random() * 0.07, 0.02, 0.2);
    p.confusionRate = finiteOr(p.confusionRate, 0.08 + Math.random() * 0.08, 0.03, 0.25);
    p.chokeRate = finiteOr(p.chokeRate, 0.05 + Math.random() * 0.06, 0.02, 0.18);
    p.afkRate = finiteOr(p.afkRate, 0.05 + Math.random() * 0.06, 0.01, 0.2);
    p.delaySigma = finiteOr(p.delaySigma, 0.38 + Math.random() * 0.2, 0.25, 0.75);
    p.recoveryRate = finiteOr(p.recoveryRate, 0.18 + Math.random() * 0.16, 0.08, 0.5);
    p.entropyTarget = finiteOr(p.entropyTarget, 0.58 + Math.random() * 0.12, 0.45, 0.78);
    p.entropySpread = finiteOr(p.entropySpread, 0.16 + Math.random() * 0.08, 0.1, 0.3);
    if (!Array.isArray(p.openers)) p.openers = [];
    if (!Number.isInteger(p.favReg)) p.favReg = -1;
    if (typeof p.openersReady !== 'boolean') p.openersReady = false;
    try { GM_setValue(KEY_PERSONA, p); } catch (e) { /* quota */ }
    _personaCache = p;
    return p;
  }
  // 人格的库相关部分需选手库就绪才能生成：惯用开局取高流行度选手（真人开局高度重复，
  // 每局随机开场反而是指纹）；地区偏好随机锚定。
  function ensurePersonaTraits() {
    const p = loadPersona();
    if (p.openersReady || !enc || !all.length) return;
    const ranked = all.slice().sort((a, b) => playerPopularity(b) - playerPopularity(a));
    const top = ranked.slice(0, Math.min(40, ranked.length));
    const picked = new Set();
    while (picked.size < Math.min(4, top.length)) {
      picked.add(top[Math.floor(Math.random() * top.length)]);
    }
    p.openers = [...picked].map(i => enc.nicks[i]);
    const seed = top[Math.floor(Math.random() * top.length)];
    p.favReg = enc.regs[seed];
    p.openersReady = true;
    try { GM_setValue(KEY_PERSONA, p); } catch (e) { /* quota */ }
  }

  // 会话状态：热身/疲劳跨回合累积，打破跨局平稳性（真人有状态起伏）
  const _sess = { rounds: 0, loseMomentum: 0 };

  // 自动推算本局最少猜测目标（v0.11.0 起不再手配）：
  // 候选池规模（log2 缩放）与历史均步（足够样本时）各半混合，
  // 策略预设平移，再掷随机扰动——避免固定目标值成为跨局可估计的参数指纹。
  function computeRoundTarget(h, mode) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const activeMode = mode || multi.mode || state.mode;
    const pool = enc ? modePool(activeMode).length : 0;
    const poolBase = pool > 1 ? clamp(Math.round(Math.log2(pool) / 2), 2, 5) : 3;
    const m = (loadStats().modes || {})[activeMode];
    const attemptedGames = m ? Number(m.attemptedGames || 0) : 0;
    const attemptedGuesses = m ? Number(m.attemptedGuesses || 0) : 0;
    const legacyGames = m ? Number(m.games || 0) : 0;
    const histAverage = attemptedGames >= 8
      ? attemptedGuesses / attemptedGames
      : legacyGames >= 8 ? Number(m.guesses || 0) / legacyGames : 0;
    const histBase = histAverage > 0 ? clamp(Math.round(histAverage), 2, 6) : poolBase;
    let base = Math.round((poolBase + histBase) / 2);
    if (h.strategy === 'conservative') base += 1;
    else if (h.strategy === 'aggressive') base -= 1;
    base += Math.random() < 0.55 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    return clamp(base, 2, 6);
  }

  // 每回合开始时掷骰：放弃计划、困惑/上头状态、AFK 配额与本回合目标。
  // runtime 可为 state 或 multi；单人只复用认知拟真，不自动触发跳过。
  function rollRoundProfile(runtime, options) {
    const active = runtime || multi;
    const opts = options || {};
    const allowSkip = opts.allowSkip !== false;
    const h = handicapConfig();
    const p = loadPersona();
    ensurePersonaTraits();
    _sess.rounds += 1;
    // 放水聚簇：人类状态有惯性（连败/手感热），均匀伯努利放水是采样器指纹。
    // 动量只小幅放大且封顶：制造 2~3 连败的短串而非失控长连败，避免整体胜率偏离合理区间。
    let lose = false;
    if (allowSkip && h.enabled && h.loseRate > 0) {
      const rate = _sess.loseMomentum > 0
        ? Math.min(0.3, h.loseRate * (1 + 0.25 * Math.min(2, _sess.loseMomentum)))
        : h.loseRate * 0.75;
      lose = Math.random() < rate;
    }
    if (allowSkip) _sess.loseMomentum = lose ? _sess.loseMomentum + 1 : Math.max(0, _sess.loseMomentum - 1);
    active.handicapLose = lose;
    active.handicapSkipDone = false;
    active.roundMinGuesses = h.enabled ? computeRoundTarget(h, active.mode) : 0;
    active.giveUpAfter = lose ? 1 + Math.floor(Math.random() * Math.max(1, Math.min(3, active.roundMinGuesses || 3))) : 0;
    // 困惑状态：触发后连续 2~3 手成簇变差；已有放弃计划时不再叠加困惑。
    active.confusedLeft = (h.enabled && !lose && Math.random() < p.confusionRate)
      ? 2 + Math.floor(Math.random() * 2) : 0;
    // 上头是可恢复的渐变状态，而非“禁猜候选”开关。
    active.choked = h.enabled && !lose && Math.random() < p.chokeRate;
    active.chokeStrength = active.choked
      ? Math.min(0.82, Math.max(0.42, 0.76 - p.recoveryRate * 0.55 + Math.random() * 0.16))
      : 0;
    // AFK 配额：整回合至多一次长停顿，触发时机在延迟模型里掷
    active.afkPending = h.enabled && !lose && Math.random() < p.afkRate;
    active.afkDone = false;
    active.lastGreens = 0;
    active.rhythm = [];
    active.roundStartedAt = Date.now();
    return lose;
  }

  // 标准正态（Box-Muller）：人类反应时近似 log-normal/ex-Gaussian，均匀分布是机器指纹
  function randNorm() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // 提交前延迟（毫秒）——服务器保存的是回合起点后累计时间，外部分析可差分出单手间隔。
  // 1) UI 区间表示“典型范围”而非硬上下界，log-normal 软尾部可自然穿越范围；
  // 2) 反馈耦合：上一手绿格多 ⇒ 停下来读面板；全红 ⇒ 快换思路或长考（真人阅读反馈的节奏）；
  // 3) 选手耦合：所选猜测越冷门，「回忆」越久；
  // 4) 连击后犹豫：连续两手偏快后概率性变慢；5) 长停顿受回合剩余预算限制；6) 热身/疲劳漂移。
  // 0~0 区间 = 不额外延迟（提交速度等同关闭拟真，仅受冷却约束）。
  function handicapDelayMs(gIdx) {
    const h = handicapConfig();
    if (!h.enabled) return 0;
    const lo = Math.max(0, Number(h.delaySecMin || 0));
    const hiValue = Math.max(0, Number(h.delaySecMax || 0));
    if (lo === 0 && hiValue === 0) return 0;
    const typicalLo = Math.max(0.8, lo || hiValue * 0.35 || 1);
    const typicalHi = Math.max(typicalLo + 0.8, hiValue || typicalLo * 2.5);
    const p = loadPersona();
    const elapsed = Math.max(0, (Date.now() - (multi.roundStartedAt || Date.now())) / 1000);
    const remainingBudget = Math.max(0.8, 112 - elapsed);
    // 长停顿使用指数软尾，且只在回合还有足够时间时触发。
    if (multi.afkPending && !multi.afkDone && remainingBudget > 28 && Math.random() < 0.14) {
      multi.afkDone = true;
      const pause = 18 + Math.min(52, -Math.log(1 - Math.random()) * 16);
      const budgeted = Math.min(pause, remainingBudget * (0.72 + Math.random() * 0.16));
      multi.rhythm.push(budgeted);
      return Math.round(budgeted * 1000);
    }
    const turn = multi.turn;
    const cands = multi.candidates.length;
    let mu = Math.log(Math.sqrt(typicalLo * typicalHi));
    mu += Math.log(p.pace);
    mu += cands > 1 ? Math.min(0.35, Math.log2(cands) / 25) : -0.12;
    mu += turn === 0 ? -0.3 : Math.min(0.2, turn * 0.04);
    // 反馈耦合（读面板/消化信息）
    const lg = multi.lastGreens || 0;
    if (lg >= 5) mu += 0.35 + Math.random() * 0.2;
    else if (lg === 0 && turn > 0) mu += Math.random() < 0.4 ? 0.3 : -0.15;
    // 选手冷门度耦合：流行度越低「回忆」越慢
    if (gIdx >= 0 && enc) {
      const pop = playerPopularity(gIdx);
      mu += Math.max(0, Math.min(0.3, (7 - pop) * 0.05));
    }
    // 连击后犹豫：最近两手都明显偏快 ⇒ 真人必然慢下来权衡
    const rh = multi.rhythm;
    if (rh.length >= 2) {
      const mid = Math.sqrt(typicalLo * typicalHi);
      if (rh[rh.length - 1] < mid * 0.55 && rh[rh.length - 2] < mid * 0.55 && Math.random() < 0.68) {
        mu += 0.42 + Math.random() * 0.32;
      }
    }
    // 会话漂移：开局热身偏慢，长会话疲劳后略快且随意
    if (_sess.rounds <= 2) mu += 0.15;
    else if (_sess.rounds > 14) mu -= 0.08;
    const derivedSigma = Math.min(0.72, Math.max(0.28, Math.log(typicalHi / typicalLo) / 2.56));
    const sigma = (derivedSigma + p.delaySigma) / 2;
    let sec = Math.exp(mu + sigma * randNorm());
    // 仅保留物理边界，不把样本压在 UI 的 lo/hi 上形成边界堆积。
    if (sec < 0.7) sec = 0.7 + Math.random() * 0.55;
    if (sec > remainingBudget) sec = remainingBudget * (0.72 + Math.random() * 0.2);
    const out = Math.round(sec * 1000);
    rh.push(out / 1000);
    if (rh.length > 4) rh.shift();
    return Math.round(out);
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
  // 服务端有 1.5s 猜间隔冷却与猜接口限流（30 次/60s），重试必须留出余量。
  const SUBMIT_RETRY_MS = 60;
  const SUBMIT_WAIT_BUTTON_MAX = 30;
  const SUBMIT_CONFIRM_TIMEOUT = 2500;
  const SUBMIT_ROW_TIMEOUT = 10000;
  // 冷却必须 > 60s/30 次 = 2s 的限流平均节奏，取 2.1s 留余量
  const GUESS_COOLDOWN_MS = 2100;

  // ---------- 选手库数据 ----------
  // 数据来源：用户本地导入 JSON（仓库 data/players_full.json）。
  // 不再依赖任何远程数据仓库（csgo-major-db 已下线/404），避免网络依赖与版本不一致问题。
  // 兼容 snake_case（仓库原始格式）与 camelCase（脚本内部格式）两种字段。

  // 多人回合状态重置（新回合/行数减少/数据同步后统一调用）
  function resetMultiRound() {
    multi.turn = 0;
    multi.guessed = new Set();
    multi.submitted = new Set();
    multi.candidates = modePool(multi.mode);
    multi.lastRowCount = 0;
    multi.lastIdx = -1;
    multi.fillPending = null;
    multi.ended = false;
    multi.autoSubmit = { pending: false, attempted: false, expected: '', lastClick: 0, nextAttemptAt: 0, delayUntil: 0 };
    multi.awaitingRow = false;
    multi.awaitingRowAt = 0;
    multi.pendingIdx = -1;
    multi.nextSubmitAt = 0;
    multi.handicapPlan = newHandicapPlan();
    multi.bestGreens = 0;
    multi.roundCloseTeams = [];
    multi.roundStartedAt = Date.now();
    rollRoundProfile();
  }

  // 重新导入选手库后重置单人/多人对局状态（与原 resetMultiAfterDataSync 合并入口）。
  // 多人对局进行中更换选手库后，候选集/已猜索引会全部失效，
  // 必须按新库重置状态并重放已有反馈行
  function resetMultiAfterDataSync() {
    if (!multi.active || !enc) return;
    resetMultiRound();
    const selfBoard = document.querySelector('.player-board-self');
    const table = selfBoard ? selfBoard.querySelector('.game-table') : null;
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    if (rows.length) multi.lastRowCount = processMultiRows(rows, 0);
    if (!multi.ended) computeMultiFill();
  }

  // 缓存规范化：补齐 sources / sourceMap 字段；旧版缓存迁移。
  // 迁移策略——用服务器同步进度(prog.synced)还原各选手来源：当前服务器版本下已确认的昵称=server，其余=import(本地)。
  function normalizeCache() {
    if (!cache) return;
    if (!cache.players) cache.players = [];
    if (!cache.sources) cache.sources = {};
    if (!cache.sourceMap) {
      const sm = {};
      const prog = loadServerSync();
      const serverMatch = prog.version && cache.version === prog.version;
      for (const p of cache.players) {
        if (p && p.nickname) {
          sm[p.nickname] = (serverMatch && prog.synced && prog.synced[p.nickname]) ? 'server' : 'import';
        }
      }
      cache.sourceMap = sm;
      if (Object.values(sm).indexOf('server') >= 0) cache.sources.server = true;
      if (Object.values(sm).indexOf('import') >= 0) cache.sources.import = true;
    }
  }

  // 通用增量合并（核心）：按来源优先级合并 incoming 到 local，绝不删除既有选手。
  // 冲突(同昵称)：incoming 优先级 >= 既有 → 覆盖；否则保持既有。不冲突 → 追加。
  // 返回 { players, sourceMap, replaced, added, kept, total }（纯函数，无副作用）。
  function mergePlayersByPriority(localPlayers, localSourceMap, incoming, incomingSource) {
    const local = (localPlayers || []).slice();
    const sm = Object.assign({}, localSourceMap || {});
    const idxByNick = new Map(local.map((p, i) => [p.nickname, i]));
    const dedup = new Map();
    for (const sp of (incoming || [])) { if (sp && sp.nickname) dedup.set(sp.nickname, sp); }
    let replaced = 0, added = 0;
    const incPrio = SOURCE_PRIO[incomingSource] || 0;
    for (const sp of dedup.values()) {
      const existing = sm[sp.nickname];
      if (existing === undefined) {
        idxByNick.set(sp.nickname, local.length);
        local.push(sp); sm[sp.nickname] = incomingSource; added++;
      } else if (incPrio >= (SOURCE_PRIO[existing] || 0)) {
        // 公开 API 不返回 team_history；incoming 无历史时保留本地已学习的历史，
        // 避免增量同步/仓库拉取把对局积累的 evidence 覆盖清空。
        const ex = local[idxByNick.get(sp.nickname)];
        if ((!Array.isArray(sp.teamHistory) || !sp.teamHistory.length) && ex && ex.teamHistory && ex.teamHistory.length) {
          sp.teamHistory = ex.teamHistory.slice();
        }
        local[idxByNick.get(sp.nickname)] = sp; sm[sp.nickname] = incomingSource; replaced++;
      }
    }
    local.sort((a, b) => (a.nickname || '').localeCompare((b.nickname || ''), 'zh-CN'));
    return { players: local, sourceMap: sm, replaced, added, kept: local.length - added, total: local.length };
  }

  // 合并后统一落盘 + 重建编码 + 重置进行中的对局 + 刷新来源徽标（导入 / 仓库拉取共用）。
  function applyMergedPlayers() {
    savePlayersCache(cache);
    ensureEncoded();
    if (state.inGame) {
      state.candidates = modePool(state.mode);
      state.guessed = new Set(); state.turn = 0; state.lastIdx = -1;
      state.bestGreens = 0; state.confusedLeft = 0; state.choked = false;
      rollRoundProfile(state, { allowSkip: false });
      computeAndFill();
    }
    resetMultiAfterDataSync();
    updateDataSourceBadge();
    updateLibSummary();
  }

  function ensureEncoded() {
    if (cache && cache.players && cache.players.length > 0) {
      enc = encodePlayers(cache.players);
      all = Array.from({ length: enc.n }, (_, i) => i);
      return true;
    }
    return false;
  }

  // 与服务器的 player_difficulties 保持同一候选池。旧格式缓存没有 difficulties 时保留全量回退，
  // 但只要数据覆盖足够，就不再把不属于当前难度的选手放进局内候选集。
  function modePoolInfo(mode) {
    const players = cache && Array.isArray(cache.players) ? cache.players : [];
    if (!players.length || !MODE_KEYS.has(mode)) return { indices: all.slice(), exact: false, known: 0, total: players.length };
    const known = players.filter(p => Array.isArray(p.difficulties) && p.difficulties.length).length;
    if (known < Math.ceil(players.length * MODE_POOL_MIN_COVERAGE)) {
      return { indices: all.slice(), exact: false, known, total: players.length };
    }
    const indices = players
      .map((p, i) => {
        const difficulties = Array.isArray(p.difficulties) ? p.difficulties : [];
        // 服务器种子数据对缺失 difficulties 的默认是 normal。
        return (difficulties.includes(mode) || (mode === 'normal' && !difficulties.length)) ? i : -1;
      })
      .filter(i => i >= 0);
    return {
      indices: indices.length ? indices : all.slice(),
      exact: indices.length > 0,
      known,
      total: players.length,
    };
  }

  function modePool(mode) {
    return modePoolInfo(mode).indices;
  }

  // 首次使用无本地选手库：自动从仓库拉取 players_full.json 作为初始数据（大多数用户的零操作路径）。
  // 拉取异步进行，完成后自动装入并刷新面板；失败时状态栏提示并提供「重试拉取」入口。
  let _repoFetching = false;
  function ensureData() {
    if (ensureEncoded()) {
      if (state.inGame && state.lastIdx < 0) computeAndFill();
      return true;
    }
    if (!_repoFetching) { _repoFetching = true; fetchAndMergeRepo(false).finally(() => { _repoFetching = false; }); }
    return false;
  }

  // ---------- 导入本地 JSON ----------
  // 兼容两种格式：脚本内部格式（camelCase + 可选 id）与 csgo-major-db 数据仓库格式（snake_case、无 id）
  // 历史队伍归一化（与上游 normalizeTeamHistory 一致）：字符串数组、逐项 trim、≤64 字符、≤50 项
  function normalizeTeamHistory(v) {
    return (Array.isArray(v) ? v : [])
      .filter(t => typeof t === 'string')
      .map(t => t.trim())
      .filter(t => t && t.length <= 64)
      .slice(0, 50);
  }

  function normalizePlayerFields(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof p.id === 'number' ? p.id : null,
      nickname: p.nickname,
      nationality: p.nationality,
      region: p.region,
      team: p.team,
      teamHistory: normalizeTeamHistory(p.teamHistory !== undefined ? p.teamHistory : p.team_history),
      age: p.age,
      role: p.role,
      majorChampionships: p.majorChampionships !== undefined ? p.majorChampionships : p.major_championships,
      majorAppearances: p.majorAppearances !== undefined ? p.majorAppearances : p.major_appearances,
      isActive: p.isActive !== undefined ? Boolean(p.isActive) : (p.is_active !== undefined ? Boolean(p.is_active) : true),
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
    // 增量合并（import 优先级：高于仓库，低于服务器；不清空既有数据）。
    normalizeCache();
    const local = (cache && cache.players) ? cache.players.slice() : [];
    const sm = Object.assign({}, (cache && cache.sourceMap) || {});
    const res = mergePlayersByPriority(local, sm, players, 'import');
    cache = Object.assign({}, cache || {}, {
      version: (cache && cache.version) ? cache.version : version, // 不覆盖已有版本（如服务器版本）
      players: res.players,
      sourceMap: res.sourceMap,
      sources: Object.assign({}, (cache && cache.sources) || {}, { import: true }),
    });
    applyMergedPlayers();
    return { ok: true, version, count: players.length, added: res.added, replaced: res.replaced, total: res.total };
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
        setStatus(`导入成功：合并后库共 ${res.total} 人（新增 ${res.added}，更新 ${res.replaced}）` + (res.version ? `，来源 v${res.version}` : ''));
      } else {
        setStatus('导入失败：' + res.message);
      }
    } catch (e) {
      setStatus('导入失败：' + e.message);
    }
  }

  // ---------- 服务器数据同步 ----------
  // 通过游戏站同源接口获取/更新选手库。@match 站点同源，PAGE.fetch 即页面原生 fetch，
  // 无需 @connect 跨源白名单或 GM_xmlhttpRequest。
  //   /api/players/list          → { version, players:[{id,nickname}] }（完整花名册，无限流）
  //   /api/players?search=<nick> → 完整属性数组（服务端限流 10次/60秒/IP）
  //
  // 合并语义（硬要求）：本地已有数据时同步绝不一次性覆盖清空——
  //   冲突（同昵称）以服务器为准；本地独有（服务器未返回）保持不变；服务器新增追加。
  //   属性拉取受服务端限流，支持增量续传：已具备完整属性的选手自动跳过，可分多次同步逐步累积。
  const PLAYER_SEARCH_RATE_LIMIT = 9;       // 服务端 10/60s，留 1 余量
  const PLAYER_SEARCH_WINDOW_MS = 60000;
  let _syncState = null;                    // { running, cancel, fetched, skipped, total, version, abortCtrl, cancelResolvers }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 同源 fetch（@match 站点），带超时。PAGE.fetch 即页面原生 fetch；旧环境兜底 window.fetch。
  // extSignal：可选的外部取消信号（同步级 AbortController），取消时一并中止在途请求。
  function serverFetch(url, timeoutMs, extSignal) {
    const fetchFn = (PAGE && PAGE.fetch) ? PAGE.fetch.bind(PAGE) : (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return Promise.reject(new Error('当前环境无可用 fetch'));
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 15000) : null;
    if (ctrl && extSignal) {
      if (extSignal.aborted) { try { ctrl.abort(); } catch (e) {} }
      else { extSignal.addEventListener('abort', () => { try { ctrl.abort(); } catch (e) {} }); }
    }
    return fetchFn(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).finally(() => { if (timer) clearTimeout(timer); });
  }

  // 拉取花名册（id+nickname+version），快速、无限流
  async function fetchServerRoster(signal) {
    const res = await serverFetch('/api/players/list', 15000, signal);
    if (!res.ok) throw new Error('花名册请求失败 HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && data.players) || [];
    if (!list.length) throw new Error('服务器花名册为空');
    return { version: (data && (data.listVersion || data.version)) || null, players: list };
  }

  // 拉取单个选手完整属性（受限流）。返回 normalize 后对象 / {rateLimited:true} / null
  async function fetchServerPlayerAttr(nickname, signal) {
    const res = await serverFetch('/api/players?search=' + encodeURIComponent(nickname), 12000, signal);
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const exact = arr.find(p => p && p.nickname === nickname) || arr[0];
    return normalizePlayerFields(exact);
  }

  // 轻量合并：仅更新 cache.players/sourceMap 与 version 并持久化，不重建 enc、不重置对局状态。
  // 冲突→服务器为准（优先级最高）；本地独有→保留；服务器新增→追加。返回 {replaced,added,kept,total}
  function mergeIntoCacheLight(serverPlayers, version) {
    normalizeCache();
    const local = (cache && cache.players) ? cache.players.slice() : [];
    const sm = Object.assign({}, (cache && cache.sourceMap) || {});
    const res = mergePlayersByPriority(local, sm, serverPlayers, 'server');
    cache = Object.assign({}, cache || {}, {
      version: version || (cache && cache.version) || null,
      players: res.players,
      sourceMap: res.sourceMap,
      sources: Object.assign({}, (cache && cache.sources) || {}, { server: true }),
    });
    savePlayersCache(cache);
    return { replaced: res.replaced, added: res.added, kept: res.kept, total: res.total };
  }

  // 同步完成/取消后重建编码与对局状态（一次性，避免逐条同步反复打断进行中的对局）
  function applyMergedData() {
    ensureEncoded();
    if (state.inGame) {
      state.candidates = modePool(state.mode);
      state.guessed = new Set(); state.turn = 0; state.lastIdx = -1;
      state.bestGreens = 0; state.confusedLeft = 0; state.choked = false;
      rollRoundProfile(state, { allowSkip: false });
      computeAndFill();
    }
    resetMultiAfterDataSync();
    updateDataSourceBadge();
    updateLibSummary();
  }

  // 取消同步：置取消标志 → 中止在途请求 → 唤醒所有可取消 sleep → 状态提示。
  // 修复 v0.8.0「点取消卡在正在取消同步…」：长限流等待/429 退避/在途请求此前不被中断。
  function cancelSync() {
    if (!(_syncState && _syncState.running) || _syncState.cancel) return;
    _syncState.cancel = true;
    if (_syncState.abortCtrl) { try { _syncState.abortCtrl.abort(); } catch (e) {} }
    if (_syncState.cancelResolvers && _syncState.cancelResolvers.length) {
      _syncState.cancelResolvers.forEach(r => { try { r(); } catch (e) {} });
      _syncState.cancelResolvers = [];
    }
    setStatus('正在取消同步…');
  }

  // 可取消 sleep：到点或被取消时立即 resolve（用于限流等待 / 429 退避）。
  function syncSleep(ms) {
    return new Promise(resolve => {
      if (_syncState && _syncState.cancel) { resolve(); return; }
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(finish, ms);
      if (_syncState) _syncState.cancelResolvers.push(finish);
    });
  }

  // 同步入口：先拉花名册，再限流拉属性，增量合并 + 进度 + 可取消 + 续传。
  // 续传/冲突正确性由 loadServerSync 保证：仅在「当前服务器版本下已确认」的昵称跳过；
  // 版本变更时 synced 清空 → 全量重拉，确保服务器端属性变更始终以服务器为准。
  async function syncFromServer() {
    if (_syncState && _syncState.running) { setStatus('正在同步中，请稍候…'); return; }
    _syncState = { running: true, cancel: false, fetched: 0, skipped: 0, total: 0, version: null,
      abortCtrl: (typeof AbortController === 'function') ? new AbortController() : null, cancelResolvers: [] };
    const signal = _syncState.abortCtrl ? _syncState.abortCtrl.signal : null;
    updateSyncButton(true);
    const buffer = [];                       // 本轮新拉取的属性，结束时一次性合并（server wins）
    try {
      setStatus('正在拉取服务器花名册…');
      const roster = await fetchServerRoster(signal);
      if (_syncState.cancel) throw new Error('__CANCELLED__');
      _syncState.version = roster.version;
      _syncState.total = roster.players.length;
      // 版本化同步进度：版本不同 → 清空已确认集合（新版本所有选手需重新以服务器为准）
      const prog = loadServerSync();
      if (prog.version !== roster.version) { prog.version = roster.version; prog.synced = {}; saveServerSync(prog); }
      // 仅拉取「本版本尚未确认」的选手；已确认的（含服务器确认不存在）跳过
      const needAttr = roster.players.filter(p => !prog.synced[p.nickname]);
      if (!needAttr.length) {
        // 已是最新：仅刷新版本号，不发起任何属性请求
        if (cache) { cache.version = roster.version || cache.version; savePlayersCache(cache); }
        setStatus(`已是最新：服务器 v${roster.version || '?'}，${roster.players.length} 人均已确认（库共 ${cache ? cache.players.length : 0} 人）`);
        updateDataSourceBadge(); updateLibSummary();
        return;
      }
      const etaMin = Math.ceil(needAttr.length / PLAYER_SEARCH_RATE_LIMIT);
      setStatus(`服务器 v${roster.version || '?'}：${roster.players.length} 人，需拉属性 ${needAttr.length} 人（限流约 ${etaMin} 分钟，可随时取消后续传）`);
      await syncSleep(600);
      let reqInWindow = 0, windowStart = Date.now();
      for (let i = 0; i < needAttr.length; i++) {
        if (_syncState.cancel) break;
        if (reqInWindow >= PLAYER_SEARCH_RATE_LIMIT) {
          const wait = PLAYER_SEARCH_WINDOW_MS - (Date.now() - windowStart) + 100;
          if (wait > 0) { setStatus(`限流等待 ${Math.ceil(wait / 1000)}s …（已拉 ${_syncState.fetched}/${needAttr.length}，可点按钮取消）`); await syncSleep(wait); }
          if (_syncState.cancel) break;
          reqInWindow = 0; windowStart = Date.now();
        }
        const nick = needAttr[i].nickname;
        const r = await fetchServerPlayerAttr(nick, signal);
        if (_syncState.cancel) break;
        reqInWindow++;
        if (r && r.rateLimited) {
          setStatus(`服务端限流(429)，退避 60s …（已拉 ${_syncState.fetched}/${needAttr.length}，可点按钮取消）`);
          await syncSleep(PLAYER_SEARCH_WINDOW_MS + 1000);
          if (_syncState.cancel) break;
          reqInWindow = 0; windowStart = Date.now(); i--; continue;
        }
        // 无论成功还是服务器确认不存在(null)，都标记为本版本已确认（不再重复请求）
        prog.synced[nick] = true;
        if (r && !r.rateLimited) { buffer.push(r); _syncState.fetched++; }
        else { _syncState.skipped++; }
        // 每 6 条：落盘进度 + 轻量合并已拉属性（崩溃也不丢；不重建 enc）
        if (buffer.length >= 6) {
          mergeIntoCacheLight(buffer.splice(0, buffer.length), roster.version);
          saveServerSync(prog);
        }
        if (i % 3 === 0) { setSyncProgress((i + 1) / needAttr.length); setStatus(`同步中：${_syncState.fetched}/${needAttr.length}（v${roster.version || '?'}，可点按钮取消）`); }
      }
      if (buffer.length) mergeIntoCacheLight(buffer.splice(0, buffer.length), roster.version);
      if (!_syncState.cancel) prog.lastSyncAt = Date.now();
      saveServerSync(prog);
      if (cache) { cache.version = roster.version || cache.version; savePlayersCache(cache); }
      applyMergedData();
      if (_syncState.cancel) {
        setStatus(`同步已取消：本轮确认 ${_syncState.fetched + _syncState.skipped} 人，库共 ${cache ? cache.players.length : 0} 人（可再次点「同步服务器」续传）`);
      } else {
        setStatus(`同步完成：服务器 v${roster.version || '?'}，拉取 ${_syncState.fetched} 人，确认不存在 ${_syncState.skipped}，库共 ${cache ? cache.players.length : 0} 人`);
      }
    } catch (e) {
      if (buffer.length) mergeIntoCacheLight(buffer.splice(0, buffer.length), _syncState.version);
      if (_syncState && _syncState.cancel) {
        setStatus(`同步已取消：本轮确认 ${_syncState.fetched + _syncState.skipped} 人，库共 ${cache ? cache.players.length : 0} 人（可再次点「同步服务器」续传）`);
      } else {
        setStatus('同步失败：' + (e && e.message ? e.message : e) + '（已拉取的部分已保留，可重试）');
      }
    } finally {
      _syncState.running = false;
      updateSyncButton(false);
      updateDataSourceBadge();
      updateLibSummary();
    }
  }

  // ---------- 缺失选手自动补充 ----------
  // 对局结束发现「答案不在本地库 / 不在候选集」时，自动从服务器拉取该选手完整属性，
  // 以服务器优先级（最高）合并进选手库并重建编码，立即生效；失败时退回手动导入提示。
  // 仅拉 1 名选手，与「同步服务器」共用 /api/players 限流额度（10 次/60s），并受滑动窗口约束。
  let _autoFixSeen = new Set();            // 会话内已尝试过的昵称（成功/失败均记录，防反复请求）
  let _autoFixRunning = false;             // 防重入（同时只允许一个自动补充请求在途）
  const _autoFixWindow = { count: 0, at: 0 }; // 滑动窗口：60s 内最多 PLAYER_SEARCH_RATE_LIMIT 次

  function autoFixMissingPlayer(nickname) {
    if (!nickname || !cache || !cache.players || !cache.players.length) return false;
    if (_autoFixRunning || (_syncState && _syncState.running)) return false; // 手动同步进行中不并发
    if (_autoFixSeen.has(nickname)) return false;
    const now = Date.now();
    if (now - _autoFixWindow.at >= PLAYER_SEARCH_WINDOW_MS) { _autoFixWindow.count = 0; _autoFixWindow.at = now; }
    if (_autoFixWindow.count >= PLAYER_SEARCH_RATE_LIMIT) {
      setStatus(`选手库与服务器不一致（答案「${nickname}」），服务器限流中，请稍后点「同步服务器」`);
      return false;
    }
    _autoFixSeen.add(nickname);
    _autoFixRunning = true;
    _autoFixWindow.count++;
    setStatus(`检测到服务器选手「${nickname}」缺失，正在自动从服务器补充…`);
    fetchServerPlayerAttr(nickname, null)
      .then(r => {
        // 严格校验：仅接受精确昵称匹配，避免 /api/players 模糊搜索返回他人数据
        if (r && !r.rateLimited && r.nickname === nickname) {
          const res = mergeIntoCacheLight([r], null);
          applyMergedData();
          setStatus(`已自动补充服务器选手「${nickname}」（库共 ${res.total} 人，属性以服务器为准）`);
        } else if (r && r.rateLimited) {
          setStatus(`选手库与服务器不一致（答案「${nickname}」）：服务器限流中，请稍后点「同步服务器」`);
        } else {
          setStatus(`选手库与服务器不一致（答案「${nickname}」）：服务器未返回该选手数据，请点「导入 JSON」重新导入与服务器一致的选手库`);
        }
      })
      .catch(e => {
        setStatus(`自动补充「${nickname}」失败：` + (e && e.message ? e.message : e) + '，请点「同步服务器」或「导入 JSON」');
      })
      .finally(() => { _autoFixRunning = false; });
    return true;
  }

  // ---------- 仓库自动拉取（首次运行 / 手动重试） ----------
  // 用 GM_xmlhttpRequest 跨源拉取 raw.githubusercontent.com（已 @connect 声明）。
  // 仓库数据为最低优先级：仅填充本地没有的选手，不覆盖服务器/导入数据。
  function gmFetchJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('当前油猴环境不支持 GM_xmlhttpRequest')); return; }
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: timeoutMs || 30000, headers: { 'Accept': 'application/json' },
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('仓库数据解析失败')); } },
        onerror: () => reject(new Error('仓库拉取网络错误')),
        ontimeout: () => reject(new Error('仓库拉取超时')),
      });
    });
  }

  async function fetchAndMergeRepo(force) {
    // 自动模式（force=false）：已有本地数据则不重复拉取
    if (!force && cache && cache.players && cache.players.length) return true;
    if (!force) setStatus('首次使用：正在从仓库自动拉取选手库…');
    else setStatus('正在从仓库重新拉取选手库…');
    setRepoFetching(true);
    try {
      const obj = await gmFetchJson(REPO_DATA_URL, 30000);
      const raw = Array.isArray(obj) ? obj : (obj && obj.players);
      if (!Array.isArray(raw) || !raw.length) throw new Error('仓库数据为空');
      const players = raw.map(normalizePlayerFields);
      const sample = players.find(p => p && typeof p === 'object');
      if (!sample) throw new Error('仓库数据格式无效');
      const version = (obj && (obj.listVersion || obj.version)) || null;
      normalizeCache();
      const local = (cache && cache.players) ? cache.players.slice() : [];
      const sm = Object.assign({}, (cache && cache.sourceMap) || {});
      const res = mergePlayersByPriority(local, sm, players, 'repo');
      cache = Object.assign({}, cache || {}, {
        version: (cache && cache.version) ? cache.version : version,
        players: res.players,
        sourceMap: res.sourceMap,
        sources: Object.assign({}, (cache && cache.sources) || {}, { repo: true }),
        repoVersion: version,
        repoAt: Date.now(),
      });
      applyMergedPlayers();
      setStatus(`已从仓库拉取 ${players.length} 名选手（库共 ${res.total} 人${res.added < players.length ? `，新增 ${res.added}` : ''}）`);
      return true;
    } catch (e) {
      setStatus('仓库拉取失败：' + (e && e.message ? e.message : e) + '（可点「重试拉取」，或手动「导入 JSON」/「同步服务器」）');
      updateDataSourceBadge(); updateLibSummary();
      return false;
    } finally {
      setRepoFetching(false);
    }
  }

  function setRepoFetching(flag) {
    if (!panelRoot) return;
    const ids = ['fb-import', 'fb-sync', 'fb-repo'];
    ids.forEach(id => { const b = panelRoot.getElementById(id); if (b) b.disabled = flag; });
    const repo = panelRoot.getElementById('fb-repo');
    if (repo) repo.textContent = flag ? '拉取中…' : '重试拉取';
  }

  function updateSyncButton(syncing) {
    if (!panelRoot) return;
    const btn = panelRoot.getElementById('fb-sync');
    if (btn) {
      if (syncing) { btn.textContent = '取消同步'; btn.classList.add('syncing'); }
      else { btn.textContent = '同步服务器'; btn.classList.remove('syncing'); }
    }
    const imp = panelRoot.getElementById('fb-import');
    if (imp) imp.disabled = syncing;   // 同步中禁用导入，避免数据竞争
    const repo = panelRoot.getElementById('fb-repo');
    if (repo) repo.disabled = syncing; // 同步中禁用仓库拉取
    const progBar = panelRoot.getElementById('fb-sync-prog');
    if (progBar) progBar.classList.toggle('show', syncing);
    if (!syncing) setSyncProgress(0);
  }

  function setSyncProgress(frac) {
    if (!panelRoot) return;
    const fill = panelRoot.getElementById('fb-sync-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  }

  // 来源构成文案：仓库 / 本地 / 服务器 各自是否贡献数据，多源用「+」连接。
  function sourceLabel() {
    normalizeCache();
    const s = (cache && cache.sources) || {};
    const parts = [];
    if (s.repo) parts.push('仓库');
    if (s.import) parts.push('本地');
    if (s.server) parts.push('服务器');
    if (!parts.length) return (cache && cache.players && cache.players.length) ? '本地' : '无';
    return parts.join('+');
  }

  // 顶部数据来源徽标：按真实来源构成显示（仓库/本地/服务器/混合/无）。
  function updateDataSourceBadge() {
    if (!panelRoot) return;
    const el = panelRoot.getElementById('fb-src');
    if (!el) return;
    const label = sourceLabel();
    el.textContent = label;
    const multi = label.indexOf('+') >= 0;
    el.classList.toggle('merged', multi);
  }

  // 选手库卡片摘要 + 折叠详情：人数/版本/来源构成/更新时间，各来源人数明细。
  function updateLibSummary() {
    if (!panelRoot) return;
    const sum = panelRoot.getElementById('fb-lib-sum');
    const det = panelRoot.getElementById('fb-lib-detail-text');
    normalizeCache();
    const n = cache && cache.players ? cache.players.length : 0;
    const v = cache && cache.version ? cache.version : '—';
    const label = sourceLabel();
    if (sum) sum.textContent = n ? `${n} 人 · ${label} · v${v}` : '无数据';
    if (det) {
      const prog = loadServerSync();
      const sm = (cache && cache.sourceMap) || {};
      const cnt = (lbl) => Object.keys(sm).filter(k => sm[k] === lbl).length;
      const repoV = (cache && cache.repoVersion) ? cache.repoVersion : '—';
      const repoAt = (cache && cache.repoAt) ? new Date(cache.repoAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未拉取';
      const lastSync = prog.lastSyncAt ? new Date(prog.lastSyncAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '从未同步';
      const syncedN = Object.keys(prog.synced || {}).length;
      const lines = [
        `库人数：${n}　版本：v${v}　来源：${label}`,
        `仓库自动拉取：v${repoV}，上次 ${repoAt}`,
        `服务器同步：v${prog.version || '未同步'}，已确认 ${syncedN} 人，上次 ${lastSync}`,
        `来源构成：仓库 ${cnt('repo')} · 本地导入 ${cnt('import')} · 服务器 ${cnt('server')}`,
        `优先级：服务器 > 本地导入 > 仓库；任何来源不会清空既有数据。`,
      ];
      det.textContent = lines.join('\n');
    }
  }

  // ---------- 经验积累 ----------
  function recordGame(mode, won, guesses, answerNick) {
    const stats = loadStats();
    const m = stats.modes[mode] || (stats.modes[mode] = { games: 0, wins: 0, guesses: 0, answers: {} });
    m.games++;
    if (won) m.wins++;
    m.guesses += guesses;
    // 目标推算只使用真正发生过猜测的对局；0 手跳过不再人为拉低历史均步。
    if (guesses > 0) {
      m.attemptedGames = Number(m.attemptedGames || 0) + 1;
      m.attemptedGuesses = Number(m.attemptedGuesses || 0) + guesses;
    }
    if (answerNick) m.answers[answerNick] = (m.answers[answerNick] || 0) + 1;
    stats.games.push({ mode, won, guesses, answer: answerNick, at: Date.now() });
    if (stats.games.length > 200) stats.games.splice(0, stats.games.length - 200);
    saveStats(stats);
    return m;
  }

  // 统一统计口径：跳过/止损回合保留在总局数与胜率中，但不参与“有效均步”。
  // 旧版统计没有 attempted 字段时，退回旧口径，保证迁移期间显示不突变。
  function attemptedSummary(m) {
    const hasAttempted = m && Object.prototype.hasOwnProperty.call(m, 'attemptedGames')
      && Object.prototype.hasOwnProperty.call(m, 'attemptedGuesses');
    const games = Number(m && m.games) || 0;
    const guesses = Number(m && m.guesses) || 0;
    const attemptedGames = hasAttempted ? Math.max(0, Number(m.attemptedGames) || 0) : games;
    const attemptedGuesses = hasAttempted ? Math.max(0, Number(m.attemptedGuesses) || 0) : guesses;
    return { attemptedGames, attemptedGuesses, skipped: Math.max(0, games - attemptedGames) };
  }

  // 历史队伍对局积累：服务端 close 反馈 ⇒ 猜测队伍 ∈ 答案选手历史队伍。
  // 只追加（去重、≤50 项、与当前队伍同名的不入历史），落盘后下次对局重建 enc 生效。
  function learnTeamHistory(answerNick, teams) {
    if (!answerNick || !teams || !teams.length || !cache || !cache.players) return;
    const p = cache.players.find(x => x.nickname === answerNick);
    if (!p) return;
    const hist = Array.isArray(p.teamHistory) ? p.teamHistory.slice() : [];
    const known = new Set(hist);
    let changed = false;
    for (const t of teams) {
      const name = String(t || '').trim();
      if (!name || name.length > 64 || name === p.team || known.has(name)) continue;
      if (hist.length >= 50) break;
      hist.push(name);
      known.add(name);
      changed = true;
    }
    if (!changed) return;
    p.teamHistory = hist;
    savePlayersCache(cache);
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
    state.pendingHistory = [];
    state.candidates = modePool(state.mode);
    state.bestGreens = 0;
    state.confusedLeft = 0;
    state.choked = false;
    rollRoundProfile(state, { allowSkip: false });
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
        const a = fb.attributes;
        const p = list.find(x => x.nickname === fb.nickname);
        if (p) {
          p.nationality = a.nationality.value;
          p.region = a.region.value;
          p.team = a.team.value;
          p.age = a.age.value;
          p.role = a.role.value;
          p.majorChampionships = a.majorChampionships.value;
          p.majorAppearances = a.majorAppearances.value;
          p.isActive = a.isActive.value;
          savePlayersCache(cache);
        } else {
          // 服务器反馈的权威属性直接补入库（server 优先级，数据现成零请求）。
          // 不重建 enc / 不打断当前对局，下次对局 startGame 时 ensureEncoded 自动生效。
          normalizeCache();
          cache.players.push({
            id: (data && data.answer && typeof data.answer.id === 'number') ? data.answer.id : null,
            nickname: fb.nickname,
            nationality: a.nationality.value,
            region: a.region.value,
            team: a.team.value,
            teamHistory: [],
            age: a.age.value,
            role: a.role.value,
            majorChampionships: a.majorChampionships.value,
            majorAppearances: a.majorAppearances.value,
            isActive: a.isActive.value,
          });
          cache.sourceMap[fb.nickname] = 'server';
          cache.sources = Object.assign({}, cache.sources || {}, { server: true });
          savePlayersCache(cache);
          setStatus(`已自动补充服务器选手「${fb.nickname}」（下次对局生效）`);
        }
      }
    }
    // 历史队伍证据：close = 猜测队伍 ∈ 答案历史队伍，待终局答案揭示后归档
    if (!fb.correct && fb.attributes && fb.attributes.team.level === 'close' && fb.attributes.team.value) {
      state.pendingHistory.push(fb.attributes.team.value);
    }
    if (fb.correct) {
      endGame(true, data.guessCount, data.answer && data.answer.nickname);
      return;
    }
    const keys = feedbackKeysFromServer(fb.attributes);
    // 选手库来自数据仓库（无服务器 id），用昵称映射反馈
    const gIdx = fb.nickname ? enc.nicks.indexOf(fb.nickname) : -1;
    if (gIdx >= 0) {
      state.candidates = filterCandidates(enc, state.candidates, gIdx, keys);
      state.guessed.add(gIdx);
      if (fb.attributes) {
        const greens = Object.values(fb.attributes).filter(attr => attr && attr.level === 'correct').length;
        if (greens > state.bestGreens) state.bestGreens = greens;
        state.lastGreens = greens;
      }
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
      learnTeamHistory(data.answer.nickname, state.pendingHistory);
      setStatus(`本局答案：${data.answer.nickname}（已记录）`);
    }
    state.pendingHistory = [];
    state.inGame = false;
  }

  function endGame(won, guesses, answerNick) {
    const m = recordGame(state.mode, won, guesses, answerNick);
    const attempted = attemptedSummary(m);
    learnTeamHistory(answerNick, state.pendingHistory);
    state.pendingHistory = [];
    setStatus(
      `本局${won ? '获胜' : '结束'}（${guesses} 步）· 该难度战绩 ${m.wins}/${m.games} 胜率 ${m.games ? Math.round(100 * m.wins / m.games) : 0}% 有效均步 ${attempted.attemptedGames ? (attempted.attemptedGuesses / attempted.attemptedGames).toFixed(1) : '-'}${attempted.skipped ? ` · 跳过 ${attempted.skipped}` : ''}`
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
    const h = handicapConfig();
    let g = h.enabled
      ? decideRealisticGuess({
          enc, all,
          candidates: cands,
          excluded: state.guessed,
          turn: state.turn,
          maxGuesses: state.maxGuesses,
          handicapEnabled: true,
          roundMinGuesses: state.roundMinGuesses,
          plan: null,
          bestGreens: state.bestGreens,
          runtime: state,
        })
      : pickGuess(enc, cands, all, state.guessed, remaining);
    if (g === undefined || g < 0) {
      const available = cands.filter(c => !state.guessed.has(c));
      g = available.length ? pickGuess(enc, cands, all, state.guessed, remaining)
        : all.find(c => !state.guessed.has(c));
    }
    if (g === undefined || g < 0) {
      setStatus('本局已无可用猜测');
      return;
    }
    state.lastIdx = g;
    const stats = loadStats();
    const modeStats = stats.modes[state.mode];
    const expCount = modeStats ? (modeStats.answers[enc.nicks[g]] || 0) : 0;
    const pool = modePoolInfo(state.mode);
    renderPanel({
      mode: state.mode,
      cands: cands.length,
      total: pool.indices.length,
      turn: state.turn,
      max: state.maxGuesses,
      nick: enc.nicks[g],
      exp: expCount,
      statusLine: state.statusLine || '',
      poolExact: pool.exact,
      handicap: h.enabled ? { turn: state.turn, minG: state.roundMinGuesses, cands: cands.length, runtime: state } : null,
      twinLocked: cands.length > 1 && isTwinCluster(cands)
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
  // 列顺序与页面一致：0 昵称, 1 队伍, 2 国籍, 3 年龄, 4 位置, 5 Major 冠军, 6 Major 次数, 7 状态
  // 多人面板无独立地区列：国籍 3 级（correct/close/wrong）已折叠地区信息，
  // close=异国同区、wrong=异国异区，无需再用 regionOptions 保留双编码（旧版会错误保留同区候选）。
  // 队伍同为 3 级：黄=前队友；本地历史可能缺失，黄格时返回双键保留两桶避免误排除。
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
      const up = td.querySelector('.dir svg.lucide-arrow-up');
      const close = cls.includes('close');
      // higher(up): close→1, far→2 ; lower(down): close→3, far→4（与服务端一致）
      return up ? (close ? 1 : 2) : (close ? 3 : 4);
    };
    const natLv = lv(cells[2]);
    const nat = natLv === 0 ? 2 : natLv === 1 ? 1 : 0;
    // id 隔离位：获胜行（row-correct，猜测即答案）=1，否则 0
    const base = row.classList.contains('row-correct') ? 1 : 0;
    const build = (teamDigit) => {
      let k = base;
      k = k * 3 + nat;
      k = k * 3 + teamDigit;
      k = k * 5 + num(cells[3]);
      k = k * 2 + (lv(cells[4]) === 0 ? 1 : 0);
      k = k * 5 + num(cells[5]);
      k = k * 5 + num(cells[6]);
      k = k * 2 + (lv(cells[7]) === 0 ? 1 : 0);
      return k;
    };
    const teamLv = lv(cells[1]);
    if (teamLv === 1) return [build(1), build(0)];
    return [build(teamLv === 0 ? 2 : 0)];
  }

  function computeMultiFill() {
    if (!enc) return;
    let cands = multi.candidates;
    if (cands.length === 0) {
      setStatus('多人：候选集已空（数据异常）');
      return;
    }
    const h = handicapConfig();
    // 非拟真排除集与原版逐字一致（guessed∪submitted，不含 pending），
    // 拟真排除集额外含 pendingIdx，避免重提未确认的猜测
    const pendingSet = multi.pendingIdx >= 0 ? [multi.pendingIdx] : [];
    const excluded = h.enabled
      ? new Set([...multi.guessed, ...multi.submitted, ...pendingSet])
      : new Set([...multi.guessed, ...multi.submitted]);
    let g = decideRealisticGuess({
      enc, all,
      candidates: cands,
      excluded,
      turn: multi.turn,
      maxGuesses: 8,
      handicapEnabled: h.enabled,
      roundMinGuesses: multi.roundMinGuesses,
      plan: multi.handicapPlan,
      bestGreens: multi.bestGreens,
      runtime: multi,
    });
    if (g === undefined || g < 0) {
      // 兜底：决策返回无效时退回 solver
      const available = cands.filter(c => !excluded.has(c));
      g = available.length ? pickGuess(enc, cands, cands, excluded, 8 - multi.turn)
        : all.find(c => !excluded.has(c));
    }
    if (g === undefined || g < 0) {
      setStatus('多人：本局已无未提交选手');
      return;
    }
    multi.lastIdx = g;
    const pool = modePoolInfo(multi.mode);
    const hcInfo = h.enabled ? { turn: multi.turn, minG: multi.roundMinGuesses, cands: cands.length, runtime: multi } : null;
    renderPanel({ mode: multi.mode, cands: cands.length, total: pool.indices.length, turn: multi.turn, max: 8, nick: enc.nicks[g], exp: 0, statusLine, handicap: hcInfo, poolExact: pool.exact, twinLocked: cands.length > 1 && isTwinCluster(cands) });
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
        delayUntil: Date.now() + handicapDelayMs(multi.lastIdx),
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
      // 历史队伍证据：队伍列黄格 ⇒ 猜测队伍 ∈ 答案历史队伍，待回合答案揭示后归档
      const teamTd = row.cells ? row.cells[1] : null;
      if (teamTd && String(teamTd.className).includes('close')) {
        const tt = teamTd.textContent.trim();
        if (tt) multi.roundCloseTeams.push(tt);
      }
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
        // 追踪历史最高绿色格数，用于拟真绿色单调性
        const greens = row.querySelectorAll('td.correct').length;
        if (greens > multi.bestGreens) multi.bestGreens = greens;
        multi.lastGreens = greens; // 最近一手反馈（延迟模型的耦合输入）
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
        learnTeamHistory(answerText, multi.roundCloseTeams);
        const won = multiLastRowWon(selfBoard);
        recordGame(multi.mode || 'normal', won, multi.turn, multi.lastAnswer);
        setStatus(`多人${won ? '获胜' : '失利'}：答案 ${multi.lastAnswer}（已记录）`);
        if (enc) {
          const ansIdx = enc.nicks.indexOf(multi.lastAnswer);
          if (ansIdx < 0 || (ansIdx >= 0 && !multi.candidates.includes(ansIdx))) {
            autoFixMissingPlayer(multi.lastAnswer);
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
        learnTeamHistory(answerText, multi.roundCloseTeams);
        const won = multiLastRowWon(selfBoard);
        recordGame(multi.mode || 'normal', won, multi.turn, multi.lastAnswer);
        setStatus(`多人${won ? '获胜' : '失利'}：答案 ${multi.lastAnswer}（已记录）`);
        // 数据一致性校验：答案不在本地候选集中说明选手库已过期，反馈过滤会持续错位
        if (enc) {
          const ansIdx = enc.nicks.indexOf(multi.lastAnswer);
          if (ansIdx < 0 || (ansIdx >= 0 && !multi.candidates.includes(ansIdx))) {
            autoFixMissingPlayer(multi.lastAnswer);
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
    // 计划放弃也先完成 1~3 手真实尝试：消除固定零猜测跳过指纹，同时给用户反悔/意外命中的窗口。
    if (multi.handicapLose && multi.turn >= multi.giveUpAfter && !multi.handicapSkipDone) {
      multi.fillPending = null;
      multi.lastIdx = -1;
      multi.autoSubmit = { pending: false, attempted: false, expected: '', lastClick: 0, nextAttemptAt: 0, delayUntil: 0 };
      setStatus(`拟真：本轮在 ${multi.turn} 次尝试后选择止损`);
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
    // 游戏结束/离开时重置收敛进度条
    if (/等待|离开|结束/.test(text)) {
      const convBar = panelRoot.querySelector('#fb-conv-bar');
      if (convBar) convBar.style.width = '0%';
    }
  }

  // 拟真实时状态：展示当前回合自动推算的猜测目标，直观反映「自动计算」运行态。
  // 模块级：createPanel 表单与 renderPanel 决策刷新均需调用。
  function updateHcLive() {
    if (!panelRoot) return;
    const el = panelRoot.getElementById('hc-live');
    if (!el) return;
    const main = panelRoot.getElementById('hc-live-main');
    const phaseEl = panelRoot.getElementById('hc-live-phase');
    const sub = panelRoot.getElementById('hc-live-sub');
    const h = loadSettings().handicap;
    if (!h.enabled) {
      if (main) main.textContent = '拟真模式未启用';
      if (phaseEl) phaseEl.textContent = '待机';
      if (sub) sub.textContent = '猜测目标、失误与停顿均不介入';
      el.classList.add('idle');
      return;
    }
    el.classList.remove('idle');
    const stratName = { conservative: '保守', balanced: '均衡', aggressive: '激进' }[h.strategy] || '均衡';
    const active = multi.active && !multi.ended ? multi : state.inGame ? state : null;
    const mode = active && active.mode ? active.mode : (multi.mode || state.mode || 'normal');
    const pool = modePoolInfo(mode);
    const poolLabel = `${MODE_NAMES[mode] || mode} · 池 ${pool.indices.length}${pool.exact ? '（精确）' : '（数据覆盖不足，暂用全量）'}`;
    const delayLabel = (h.delaySecMin === 0 && h.delaySecMax === 0) ? '无额外延迟' : `${h.delaySecMin}~${h.delaySecMax}s 典型延迟`;
    let phase = '待机';
    let targetLabel = '目标自动计算';
    let planLabel = '本回合不止损';
    if (active && active.roundMinGuesses > 0) {
      const turn = Number(active.turn || 0);
      const minG = Number(active.roundMinGuesses || 0);
      const cands = Array.isArray(active.candidates) ? active.candidates.length : 0;
      phase = cands <= 1 ? '锁定' : turn < minG - 1 ? '探路' : turn < minG ? '逼近' : '收尾';
      targetLabel = `本回合目标 ${minG} 猜`;
      if (active.handicapLose) planLabel = active.giveUpAfter > 0 ? `止损计划：第 ${active.giveUpAfter} 手后` : '止损计划已排队';
    }
    if (main) main.textContent = active
      ? `拟真运行中 · ${targetLabel} · ${stratName}策略`
      : `拟真已启用 · ${stratName}策略`;
    if (phaseEl) phaseEl.textContent = phase;
    if (sub) sub.textContent = `${poolLabel} · ${delayLabel} · ${planLabel}`;
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = 'friberg-helper';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;font-family:"Inter",system-ui,-apple-system,sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        .fb-panel{width:286px;max-width:calc(100vw - 24px);background:rgba(15,17,23,.94);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#e4e7ec;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:0;box-shadow:0 8px 32px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03) inset;font-size:13px;line-height:1.5;overflow:hidden;transition:opacity .25s,transform .25s}
        .fb-panel.collapsed{opacity:0;transform:scale(.9) translateY(8px);pointer-events:none;height:0;padding:0;border:0}
        /* 标题栏（可拖拽） */
        .fb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,.05)}
        .fb-header h1{font-size:13px;font-weight:600;letter-spacing:.3px;color:#f0f2f5}
        .fb-header-right{display:flex;align-items:center;gap:8px}
        .fb-mode{font-size:10px;color:#8b95a5;background:rgba(255,255,255,.05);padding:2px 7px;border-radius:20px}
        .fb-src{font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(127,180,255,.12);color:#7fb4ff}
        .fb-src.merged{background:rgba(110,231,160,.12);color:#6ee7a0}
        .fb-collapse{width:24px;height:24px;border:0;background:rgba(255,255,255,.06);color:#8b95a5;border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:background .15s}
        .fb-collapse:hover{background:rgba(255,255,255,.12);color:#fff}
        /* 主体 */
        .fb-body{padding:10px 14px 12px}
        /* 对局信息 */
        .fb-info{margin-bottom:10px}
        .fb-cand{font-size:11px;color:#7c8698;margin-bottom:2px}
        .fb-conv{height:3px;border-radius:2px;background:rgba(255,255,255,.06);margin:4px 0 6px;overflow:hidden}
        .fb-conv-bar{height:100%;border-radius:2px;background:linear-gradient(90deg,#6ee7a0,#34d399);transition:width .4s ease;width:0}
        .fb-guess{font-size:18px;font-weight:700;color:#6ee7a0;letter-spacing:.2px;text-shadow:0 0 12px rgba(110,231,160,.15)}
        .fb-guess.idle{color:#5a6375;font-size:13px;font-weight:400;text-shadow:none}
        /* 开关组 */
        .fb-toggles{display:flex;gap:6px;margin-bottom:10px}
        .fb-toggle{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#8b95a5;cursor:pointer;font-size:11px;font-weight:500;text-align:center;transition:all .18s}
        .fb-toggle:hover{background:rgba(255,255,255,.07);color:#c8cdd6}
        .fb-toggle.on{background:rgba(110,231,160,.1);border-color:rgba(110,231,160,.25);color:#6ee7a0}
        /* 拟真配置抽屉 */
        .fb-hc{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .25s;opacity:0;margin-bottom:0}
        .fb-hc.open{max-height:320px;opacity:1;margin-bottom:10px}
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
        .fb-hc-live{font-size:10px;color:#6ee7a0;background:rgba(110,231,160,.07);border:1px solid rgba(110,231,160,.15);padding:7px 8px;border-radius:8px;margin:7px 0 6px;line-height:1.4;transition:all .2s}
        .fb-hc-live-main{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:600}
        .fb-hc-live-phase{flex:0 0 auto;padding:1px 6px;border-radius:999px;background:rgba(110,231,160,.12);font-size:10px;font-weight:500}
        .fb-hc-live-sub{margin-top:3px;color:#9ba7b8;font-size:10px;line-height:1.45}
        .fb-hc-live.idle{color:#8b95a5;background:rgba(255,255,255,.02);border-color:rgba(255,255,255,.06)}
        .fb-hc-live.idle .fb-hc-live-phase{background:rgba(255,255,255,.07);color:#aab2bf}
        /* 选手库数据卡片（导入/同步/仓库拉取 + 数据说明 合并） */
        .fb-libcard{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 9px;margin-bottom:10px}
        .fb-lib-head{display:flex;align-items:center;gap:7px;margin-bottom:7px}
        .fb-lib-title{font-size:11px;font-weight:700;color:#d0d5dd;letter-spacing:.5px}
        .fb-lib-sum{flex:1;font-size:10px;color:#8b95a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fb-lib-toggle{font-size:11px;color:#6b7585;background:none;border:none;cursor:pointer;padding:0 2px;line-height:1;transition:transform .2s}
        .fb-lib-toggle:hover{color:#d0d5dd}
        .fb-lib-actions{display:flex;gap:6px}
        .fb-lib-actions button{flex:1;padding:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#8b95a5;cursor:pointer;font-size:11px;transition:all .18s}
        .fb-lib-actions button:hover{background:rgba(255,255,255,.08);color:#d0d5dd}
        .fb-lib-actions button:disabled{opacity:.4;cursor:default}
        .fb-lib-actions button#fb-sync{color:#7fb4ff;border-color:rgba(127,180,255,.25)}
        .fb-lib-actions button#fb-sync:hover{background:rgba(127,180,255,.12);color:#aad4ff}
        .fb-lib-actions button#fb-sync.syncing{color:#ffb27a;border-color:rgba(255,178,122,.35);animation:fb-pulse 1.1s ease-in-out infinite}
        .fb-lib-detail{display:none;margin-top:7px}
        .fb-lib-detail.show{display:block}
        .fb-lib-detail pre{margin:0;font-size:10px;line-height:1.55;color:#8b95a5;white-space:pre-wrap;word-break:break-all;font-family:inherit}
        @keyframes fb-pulse{0%,100%{opacity:1}50%{opacity:.55}}
        /* 状态栏 */
        .fb-status-wrap{position:relative;padding-left:10px}
        .fb-status-bar{position:absolute;left:0;top:1px;bottom:1px;width:3px;border-radius:2px;background:#3d4450;transition:background .3s}
        .fb-status-bar.ok{background:#6ee7a0}
        .fb-status-bar.warn{background:#fbbf24}
        .fb-status{font-size:10px;color:#6b7585;word-break:break-all;line-height:1.4}
        /* 经验 */
        .fb-exp{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05);font-size:10px;color:#5f6978}
        .fb-exp ul{margin:3px 0 0;padding-left:12px;list-style:disc}
        .fb-sync-prog{display:none;height:3px;margin-top:5px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden}
        .fb-sync-prog.show{display:block}
        .fb-sync-fill{height:100%;width:0;background:linear-gradient(90deg,#7fb4ff,#6ee7a0);transition:width .3s}
        /* 收起态浮标 */
        .fb-dot{width:36px;height:36px;border-radius:50%;background:rgba(15,17,23,.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;cursor:pointer;transition:transform .2s,box-shadow .2s;color:#6ee7a0;font-size:14px;font-weight:700}
        .fb-dot:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,0,0,.5)}
        .fb-dot.show{display:flex}
        button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid rgba(127,180,255,.9);outline-offset:2px}
        @media (max-width:420px){
          .fb-panel{width:calc(100vw - 24px)}
          .fb-header{padding-left:12px;padding-right:12px}
          .fb-body{padding-left:12px;padding-right:12px}
          .fb-hc-inner label{align-items:flex-start;gap:8px}
          .fb-hc select{max-width:175px}
        }
        @media (prefers-reduced-motion:reduce){
          *,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}
        }
      </style>
      <div class="fb-dot" id="fb-dot" role="button" tabindex="0" aria-label="展开助手面板">弗</div>
      <div class="fb-panel" id="fb-panel">
        <div class="fb-header" id="fb-drag">
          <h1>弗一把助手</h1>
          <div class="fb-header-right">
            <span class="fb-src" id="fb-src" title="数据来源">本地</span>
            <span class="fb-mode" id="fb-mode">-</span>
            <button type="button" class="fb-collapse" id="fb-min" title="收起面板" aria-label="收起面板" aria-expanded="true">─</button>
          </div>
        </div>
        <div class="fb-body">
          <div class="fb-info">
            <div class="fb-cand" id="fb-cand">等待对局</div>
            <div class="fb-conv"><div class="fb-conv-bar" id="fb-conv-bar"></div></div>
            <div class="fb-guess idle" id="fb-guess">─</div>
          </div>
          <div class="fb-toggles">
            <button type="button" class="fb-toggle" id="fb-autosubmit" aria-pressed="false">自动提交</button>
            <button type="button" class="fb-toggle" id="fb-handicap" aria-pressed="false" aria-expanded="false" aria-controls="fb-hc">拟真</button>
          </div>
          <div class="fb-hc" id="fb-hc">
            <div class="fb-hc-inner">
              <label for="hc-enabled"><span>启用拟真模式</span><input type="checkbox" id="hc-enabled"></label>
              <label for="hc-strategy" title="猜测目标、失误节奏、停顿均由脚本自动推算"><span>策略</span>
                <select id="hc-strategy">
                  <option value="conservative">保守 · 慢收敛更像新人</option>
                  <option value="balanced">均衡 · 自适应（推荐）</option>
                  <option value="aggressive">激进 · 快收敛胜率优先</option>
                </select>
              </label>
              <div class="fb-hc-live" id="hc-live" aria-live="polite">
                <div class="fb-hc-live-main"><span id="hc-live-main">拟真已启用</span><span class="fb-hc-live-phase" id="hc-live-phase">待机</span></div>
                <div class="fb-hc-live-sub" id="hc-live-sub">目标按难度池和历史尝试自动计算</div>
              </div>
              <label for="hc-delay-lo" title="典型思考范围；log-normal 软尾部可能略超出区间"><span>典型延迟</span><span class="range-row"><input type="number" id="hc-delay-lo" min="0" max="60" step="1" aria-label="典型延迟下限"><span>~</span><input type="number" id="hc-delay-hi" min="0" max="60" step="1" aria-label="典型延迟上限"><span>秒</span></span></label>
              <label for="hc-lose"><span>止损概率</span>
                <select id="hc-lose">
                  <option value="0">0%</option>
                  <option value="0.1">10%</option>
                  <option value="0.15">15%（推荐）</option>
                  <option value="0.2">20%</option>
                  <option value="0.3">30%</option>
                  <option value="0.4">40%</option>
                </select>
              </label>
              <div class="fb-hc-btns">
                <button type="button" id="hc-save" style="background:#2d8a56">保存</button>
                <button type="button" id="hc-close" style="background:rgba(255,255,255,.08)">关闭</button>
              </div>
            </div>
          </div>
          <div class="fb-libcard">
            <div class="fb-lib-head">
              <span class="fb-lib-title">选手库</span>
              <span class="fb-lib-sum" id="fb-lib-sum">无数据</span>
              <button type="button" class="fb-lib-toggle" id="fb-lib-toggle" title="展开/收起数据说明" aria-expanded="false" aria-controls="fb-lib-detail">▾</button>
            </div>
            <div class="fb-lib-actions">
              <button type="button" id="fb-import" title="从本地 JSON 文件导入选手">导入 JSON</button>
              <button type="button" id="fb-sync" title="从游戏服务器增量同步选手属性">同步服务器</button>
              <button type="button" id="fb-repo" title="从仓库重新拉取 players_full.json">重试拉取</button>
            </div>
            <div class="fb-lib-detail" id="fb-lib-detail">
              <pre id="fb-lib-detail-text">—</pre>
            </div>
          </div>
          <div class="fb-status-wrap">
            <div class="fb-status-bar" id="fb-status-bar"></div>
            <div class="fb-status" id="fb-status" role="status" aria-live="polite">就绪</div>
            <div class="fb-sync-prog" id="fb-sync-prog"><div class="fb-sync-fill" id="fb-sync-fill"></div></div>
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
      shadow.getElementById('fb-min').setAttribute('aria-expanded', 'false');
    });
    dotEl.addEventListener('click', () => {
      panelEl.classList.remove('collapsed');
      dotEl.classList.remove('show');
      shadow.getElementById('fb-min').setAttribute('aria-expanded', 'true');
    });
    dotEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dotEl.click();
      }
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
      el.setAttribute('aria-pressed', String(on));
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
      el.setAttribute('aria-pressed', String(h.enabled));
      el.textContent = h.enabled ? '拟真 ✓' : '拟真';
    }
    function fillHandicapForm() {
      const h = loadSettings().handicap;
      shadow.getElementById('hc-enabled').checked = h.enabled;
      shadow.getElementById('hc-strategy').value = h.strategy || 'balanced';
      shadow.getElementById('hc-delay-lo').value = h.delaySecMin;
      shadow.getElementById('hc-delay-hi').value = h.delaySecMax;
      shadow.getElementById('hc-lose').value = String(h.loseRate);
      updateHcLive();
    }
    shadow.getElementById('fb-handicap').addEventListener('click', () => {
      const box = shadow.getElementById('fb-hc');
      const open = box.classList.toggle('open');
      shadow.getElementById('fb-handicap').setAttribute('aria-expanded', String(open));
      if (box.classList.contains('open')) fillHandicapForm();
    });
    shadow.getElementById('hc-close').addEventListener('click', () => {
      shadow.getElementById('fb-hc').classList.remove('open');
      shadow.getElementById('fb-handicap').setAttribute('aria-expanded', 'false');
    });
    shadow.getElementById('hc-save').addEventListener('click', () => {
      const s = loadSettings();
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(v) || 0));
      const delayLo = clamp(Number(shadow.getElementById('hc-delay-lo').value), 0, 60);
      const delayHi = clamp(Number(shadow.getElementById('hc-delay-hi').value), delayLo, 60);
      const loseRaw = Number(shadow.getElementById('hc-lose').value);
      const lose = Number.isFinite(loseRaw) ? Math.min(0.4, Math.max(0, loseRaw)) : HANDICAP_DEFAULT.loseRate;
      const allowedStrategies = new Set(['conservative', 'balanced', 'aggressive']);
      const strategyCandidate = shadow.getElementById('hc-strategy').value;
      const strategy = allowedStrategies.has(strategyCandidate) ? strategyCandidate : HANDICAP_DEFAULT.strategy;
      s.handicap = { enabled: shadow.getElementById('hc-enabled').checked, strategy, delaySecMin: delayLo, delaySecMax: delayHi, loseRate: lose };
      saveSettings(s);
      updateHandicapButton();
      updateHcLive();
      shadow.getElementById('fb-hc').classList.remove('open');
      shadow.getElementById('fb-handicap').setAttribute('aria-expanded', 'false');
      const stratName = { conservative: '保守', balanced: '均衡', aggressive: '激进' }[strategy] || '均衡';
      const delayNote = (delayLo === 0 && delayHi === 0) ? '（0~0s = 无额外延迟）' : '';
      setStatus(`拟真模式已${s.handicap.enabled ? '开启' : '关闭'}（${stratName} · 目标自动 · ${delayLo}~${delayHi}s${delayNote} · 放水 ${Math.round(s.handicap.loseRate * 100)}%）`);
    });
    updateHandicapButton();

    // --- 选手库数据卡片 ---
    shadow.getElementById('fb-import').addEventListener('click', importFromFile);
    shadow.getElementById('fb-sync').addEventListener('click', () => {
      if (_syncState && _syncState.running) cancelSync();
      else syncFromServer();
    });
    shadow.getElementById('fb-repo').addEventListener('click', () => {
      if (!(_syncState && _syncState.running) && !_repoFetching) fetchAndMergeRepo(true);
    });
    shadow.getElementById('fb-lib-toggle').addEventListener('click', () => {
      const det = shadow.getElementById('fb-lib-detail');
      const tg = shadow.getElementById('fb-lib-toggle');
      const open = det.classList.toggle('show');
      tg.textContent = open ? '▴' : '▾';
      tg.setAttribute('aria-expanded', String(open));
      if (open) updateLibSummary();
    });
    setStatus(statusLine);
    return shadow;
  }

  function renderPanel(info) {
    if (!panelRoot) return;
    panelRoot.getElementById('fb-mode').textContent = MODE_NAMES[info.mode] || info.mode || '多人';
    // 拟真进度：探路(turn<minG-1) / 逼近(turn==minG-1) / 锁定(候选==1) / 收尾(turn>=minG)
    const poolLabel = info.poolExact === false ? '全量回退' : '难度池';
    let candText = `候选 ${info.cands}/${info.total} · ${poolLabel} · 已猜 ${info.turn}/${info.max}`;
    if (info.twinLocked) candText += ' · 双胞胎锁死';
    if (info.handicap) {
      const { turn, minG, cands } = info.handicap;
      const phase = cands <= 1 ? '锁定' : turn < minG - 1 ? '探路' : turn < minG ? '逼近' : '收尾';
      candText += ` · 拟真 ${phase} ${turn}/${minG}`;
    }
    panelRoot.getElementById('fb-cand').textContent = candText;
    // 拟真实时状态行随每次决策刷新（目标值为自动计算结果）
    updateHcLive();
    // 候选收敛进度条：已排除的候选占比（0%→100%）
    const convPct = info.total > 0 ? Math.round(100 * (1 - info.cands / info.total)) : 0;
    const convBar = panelRoot.getElementById('fb-conv-bar');
    if (convBar) convBar.style.width = convPct + '%';
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
      const attempted = attemptedSummary(m);
      const top = Object.entries(m.answers).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `<li>${n} ×${c}</li>`).join('');
      panelRoot.getElementById('fb-exp').innerHTML =
        `${m.games} 局 · 胜 ${m.wins}（${Math.round(100 * m.wins / m.games)}%）· 有效均 ${attempted.attemptedGames ? (attempted.attemptedGuesses / attempted.attemptedGames).toFixed(1) : '-'} 步` +
        (attempted.skipped ? ` · 跳过 ${attempted.skipped}` : '') +
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
    if (panelRoot) {
      const el = panelRoot.getElementById('fb-autosubmit');
      if (el) {
        el.classList.toggle('on', s.autoSubmit);
        el.setAttribute('aria-pressed', String(s.autoSubmit));
        el.textContent = s.autoSubmit ? '自动提交 ✓' : '自动提交';
      }
    }
  });
  GM_registerMenuCommand('切换拟真模式', () => {
    const s = loadSettings();
    s.handicap.enabled = !s.handicap.enabled;
    saveSettings(s);
    setStatus(`拟真模式已${s.handicap.enabled ? '开启' : '关闭'}`);
    if (panelRoot) {
      const el = panelRoot.getElementById('fb-handicap');
      if (el) {
        el.classList.toggle('on', s.handicap.enabled);
        el.setAttribute('aria-pressed', String(s.handicap.enabled));
        el.textContent = s.handicap.enabled ? '拟真 ✓' : '拟真';
      }
      updateHcLive();
    }
  });
  GM_registerMenuCommand('重置拟真人格', () => {
    // 人格向量按安装固化；换号/换环境使用时可重掷一套新个性
    try { GM_setValue(KEY_PERSONA, null); } catch (e) { /* ignore */ }
    _personaCache = null;
    setStatus('拟真人格已重置，下回合生效');
  });
  GM_registerMenuCommand('导入本地 JSON 数据', importFromFile);
  GM_registerMenuCommand('同步服务器选手库', () => { if (!(_syncState && _syncState.running)) syncFromServer(); });
  GM_registerMenuCommand('从仓库拉取选手库', () => { if (!(_syncState && _syncState.running) && !_repoFetching) fetchAndMergeRepo(true); });
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
    ensureData();
    updateDataSourceBadge();
    updateLibSummary();
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

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const rounds = Math.max(30, Math.min(5000, Number(args.rounds || 300)));
let seed = Number(args.seed || 20260806) >>> 0;
const random = () => {
  seed += 0x6D2B79F5;
  let value = seed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const stores = new Map();
const seededMath = Object.create(Math);
seededMath.random = random;
const context = {
  console,
  Date,
  Math: seededMath,
  unsafeWindow: {},
  location: { pathname: '/multi' },
  document: { readyState: 'loading', addEventListener() {}, querySelector() { return null; } },
  GM_getValue(key, fallback) { return stores.has(key) ? stores.get(key) : fallback; },
  GM_setValue(key, value) { stores.set(key, value); },
  GM_registerMenuCommand() {},
  GM_xmlhttpRequest() {},
};
context.globalThis = context;

const source = fs.readFileSync(path.join(root, 'friberg-helper.user.js'), 'utf8');
const expose = `
  globalThis.__simulation = {
    setData(raw) {
      const players = raw.map(normalizePlayerFields);
      cache = { players };
      enc = encodePlayers(players);
      all = players.map((_, index) => index);
    },
    getEnc: () => enc,
    modePoolInfo,
    rollRoundProfile,
    decideRealisticGuess,
    feedbackKey,
    attrLevels,
    guessInfoGain,
  };
`;
const instrumented = source.replace(/\n\}\)\(\);\s*$/, `${expose}\n})();\n`);
if (instrumented === source) throw new Error('Unable to instrument userscript');
vm.runInNewContext(instrumented, context, { filename: 'friberg-helper.user.js' });

const helper = context.__simulation;
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'players_full.json'), 'utf8')).players;
helper.setData(raw);
stores.set('friberg.settings.v1', {
  autoFill: true,
  autoSubmit: true,
  handicap: {
    enabled: true,
    strategy: args.strategy || 'balanced',
    delaySecMin: 4,
    delaySecMax: 14,
    loseRate: Number(args.loseRate || 0.15),
  },
});

const modes = ['beginner', 'easy', 'normal'];
const poolSummary = Object.fromEntries(modes.map((mode) => {
  const info = helper.modePoolInfo(mode);
  return [mode, { size: info.indices.length, exact: info.exact, metadataCoverage: info.total ? info.known / info.total : 0 }];
}));
const enc = helper.getEnc();
const percentiles = [];
const regrets = [];
const result = {
  rounds,
  seed: Number(args.seed || 20260806) >>> 0,
  pools: poolSummary,
  wins: 0,
  exhausted: 0,
  skipped: 0,
  invalidDecisions: 0,
  chokedRounds: 0,
  chokedCandidatePicks: 0,
};

function choiceMetrics(guess, candidates) {
  const gains = [];
  let best = 0;
  for (let index = 0; index < raw.length; index++) {
    const gain = helper.guessInfoGain(index, candidates);
    gains.push(gain);
    if (gain > best) best = gain;
  }
  const actual = helper.guessInfoGain(guess, candidates);
  gains.sort((a, b) => a - b);
  let lo = 0;
  let hi = gains.length;
  while (lo < hi) {
    const middle = (lo + hi) >> 1;
    if (gains[middle] <= actual + 1e-9) lo = middle + 1;
    else hi = middle;
  }
  percentiles.push(lo / gains.length);
  regrets.push(best > 0 ? Math.max(0, 1 - actual / best) : 0);
}

for (let round = 0; round < rounds; round++) {
  const mode = modes[round % modes.length];
  const pool = helper.modePoolInfo(mode).indices;
  const target = pool[Math.floor(random() * pool.length)];
  const runtime = { mode, turn: 0, bestGreens: 0 };
  helper.rollRoundProfile(runtime);
  if (runtime.choked) result.chokedRounds += 1;
  let candidates = pool.slice();
  const excluded = new Set();
  let finished = false;

  for (let turn = 0; turn < 8; turn++) {
    runtime.turn = turn;
    runtime.candidates = candidates;
    if (runtime.handicapLose && turn >= runtime.giveUpAfter) {
      result.skipped += 1;
      finished = true;
      break;
    }
    const guess = helper.decideRealisticGuess({
      candidates,
      excluded,
      turn,
      maxGuesses: 8,
      handicapEnabled: true,
      roundMinGuesses: runtime.roundMinGuesses,
      bestGreens: runtime.bestGreens,
      runtime,
    });
    if (!Number.isInteger(guess) || guess < 0 || guess >= raw.length || excluded.has(guess)) {
      result.invalidDecisions += 1;
      finished = true;
      break;
    }
    if (runtime.choked && candidates.includes(guess)) result.chokedCandidatePicks += 1;
    if (guess === target) {
      result.wins += 1;
      finished = true;
      break;
    }
    choiceMetrics(guess, candidates);
    const signature = helper.feedbackKey(enc, guess, target);
    candidates = candidates.filter((candidate) => helper.feedbackKey(enc, guess, candidate) === signature);
    excluded.add(guess);
    const greens = helper.attrLevels(guess, target).filter((level) => level === 0).length;
    runtime.bestGreens = Math.max(runtime.bestGreens, greens);
  }
  if (!finished) result.exhausted += 1;
}

const sampleSize = percentiles.length;
const meanPercentile = sampleSize ? percentiles.reduce((sum, value) => sum + value, 0) / sampleSize : 0;
const topDecileRate = sampleSize ? percentiles.filter((value) => value >= 0.9).length / sampleSize : 0;
const lowRegretRate = sampleSize ? regrets.filter((value) => value <= 0.1).length / sampleSize : 0;
result.choiceSteps = sampleSize;
result.winRate = Number((100 * result.wins / rounds).toFixed(1));
result.averageEntropyPercentile = Number((100 * meanPercentile).toFixed(1));
result.topDecileRate = Number((100 * topDecileRate).toFixed(1));
result.lowRegretRate = Number((100 * lowRegretRate).toFixed(1));
result.legacySimilarityIndex = Math.round(100 * (0.55 * meanPercentile + 0.25 * topDecileRate + 0.2 * lowRegretRate));

console.log(JSON.stringify(result, null, 2));
if (result.invalidDecisions > 0) process.exitCode = 1;

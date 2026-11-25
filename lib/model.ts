// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol that records no token of its own and is not a wrapped, staked,
// bridged or versioned product of one that already trades: the snapshot's watchlist (the floor,
// never a ceiling) plus every other protocol of that kind the snapshot carries, at any size.
// Protocols whose token already trades, and products of them, are set aside with the market's own
// figures, never mixed into the ranking.
//
// Implied value is calibrated, not asserted. The snapshot's live-token protocols say what the
// market actually pays per dollar of TVL in each category, so the model reads that multiple off
// the live peers and applies it to the pre-token rows of the same category:
//
//   peers      = live-token protocols in the category with both a market cap and a TVL
//   multiple   = (n x category median mcap/TVL + 6 x global median) / (n + 6), clamped to [0.04, 2.5]
//   growthMult = 1 + clamp(change_7d, -50, 100) / 100 x 0.6, floored at 0.55
//   maturity   = 0.55 + 0.45 x min(age_days, 1460) / 1460    (age unknown: 365 days)
//   breadth    = 1 + 0.05 x (chains - 1), capped at 1.15
//   implied    = max(1, round(tvl_usd x multiple x growthMult x maturity x breadth))
//
// No protocol name is ever special-cased: the same functions score every row, and a protocol the
// snapshot has never named would be scored the day it appears in one.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and board rows carry it. */
export const MODEL_VERSION = 'launch-radar-2';

/** The model's constants, stated in the dashboard so a reader can re-run the arithmetic. */
export const MODEL = {
  prior_weight: 6,
  multiple_floor: 0.04,
  multiple_cap: 2.5,
  growth_weight: 0.6,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  growth_mult_floor: 0.55,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.05,
  breadth_cap: 1.15,
};

/** Categories whose products are a claim on another protocol's token, not a launch of their own. */
const DERIVATIVE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's product, not a launch candidate. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is set aside instead of ranked, or null when the board may rank it. */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return `${p.category.toLowerCase()} product of a token that already trades`;
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  if (DERIVATIVE_WORD.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (EXCHANGE_PREFIX.test(p.name)) return 'an exchange product, not a launch of its own';
  return null;
}

/** One category's calibration: the multiple the market's own figures support, and its evidence. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
  median: number | null;
}

/** The live peers' median market cap per TVL dollar, overall and per category, shrunk to the global. */
export function calibrate(snapshot: Snapshot): { globalMedian: number; byCategory: Map<string, CategoryMultiple> } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [ratio]);
    else list.push(ratio);
  }
  const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
  };
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, xs] of ratios) {
    const med = median(xs);
    const shrunk = (xs.length * med + MODEL.prior_weight * globalMedian) / (xs.length + MODEL.prior_weight);
    byCategory.set(category, {
      category,
      multiple: Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, shrunk)),
      peers: xs.length,
      median: med,
    });
  }
  return { globalMedian, byCategory };
}

/** The multiple one protocol is scored with: its category's, or the global median when it has no peers. */
function multipleFor(p: SnapshotProtocol, cal: { globalMedian: number; byCategory: Map<string, CategoryMultiple> }): CategoryMultiple {
  const found = p.category === null ? undefined : cal.byCategory.get(p.category);
  if (found !== undefined) return found;
  return { category: p.category ?? 'Uncategorised', multiple: Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, cal.globalMedian)), peers: 0, median: null };
}

/** The full scoring of one protocol: every multiplier, so the dashboard can show its working. */
export interface Scoring {
  implied: number;
  multiple: number;
  peers: number;
  categoryMedian: number | null;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
}

/** Score one pre-token protocol from the snapshot's figures alone. */
export function score(p: SnapshotProtocol, asOf: string, cal: { globalMedian: number; byCategory: Map<string, CategoryMultiple> }): Scoring {
  const age = ageDays(asOf, p.listed_at);
  const mult = multipleFor(p, cal);
  // The multiple enters the arithmetic at the precision the board publishes (four decimals), so the
  // dashboard's own recomputation from the published figures lands on the same dollar, not a near one.
  const multiple = round4(mult.multiple);
  const growthPct = Math.min(MODEL.growth_cap_pct, Math.max(MODEL.growth_floor_pct, finite(p.change_7d, 0)));
  const growthMult = Math.max(MODEL.growth_mult_floor, 1 + (growthPct / 100) * MODEL.growth_weight);
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const breadthMult = Math.min(MODEL.breadth_cap, 1 + Math.max(0, p.chains.length - 1) * MODEL.breadth_per_chain);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
  return { implied, multiple, peers: mult.peers, categoryMedian: mult.median, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    version: string;
    multiple: number;
    peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row, farm plan included. */
export interface RadarRow extends BoardRow {}

/** A protocol set aside from the ranking, with the market's figures or the reason it is a product. */
export interface AsideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  kind: 'live' | 'product';
  reason: string;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  global_median: number;
  categories: CategoryMultiple[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  product_size: number;
  total_implied_usd: number;
  rows: RadarRow[];
  aside: AsideRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Chains where an action costs cents, not dollars: gas there is a rounding error, not a budget. */
const LOW_FEE_CHAINS = new Set([
  'Base', 'Arbitrum', 'Optimism', 'Solana', 'Binance', 'BSC', 'Polygon', 'Avalanche', 'zkSync Era',
  'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Fantom', 'Gnosis', 'Celo', 'Sui', 'Aptos', 'Near',
  'Tron', 'Hyperliquid L1', 'Monad', 'Plasma', 'Sonic', 'Berachain', 'Starknet', 'Manta', 'Taiko',
]);

/** What one on-chain action costs on the protocol's first chain, in dollars. */
function gasFor(p: SnapshotProtocol): { action: number; label: string } {
  const chain = chainOf(p);
  if (chain === 'Ethereum') return { action: 9, label: 'Ethereum mainnet gas' };
  if (LOW_FEE_CHAINS.has(chain)) return { action: 0.4, label: `${chain} fees` };
  return { action: 2, label: `${chain} fees` };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category playbook: the core action and the second qualifying action a farmer repeats. */
function playbook(p: SnapshotProtocol, capital: number, chain: string): { core: string; second: string } {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend')) return {
    core: `Supply $${capital} of USDC to ${name} on ${chain} as lending collateral and leave it supplied.`,
    second: `Borrow a small amount against the collateral, about a fifth of it, and repay within the week, so the wallet shows both sides of the market.`,
  };
  if (c.includes('cdp')) return {
    core: `Open a collateral vault in ${name} on ${chain} with $${capital} of collateral and mint a small amount of its stablecoin.`,
    second: `Adjust the vault once a week, adding or repaying a little, so the position is managed, not parked.`,
  };
  if (c.includes('dex') || c.includes('swap')) return {
    core: `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`,
    second: `Route one swap a week through ${name} itself rather than an aggregator, so the volume is the protocol's own.`,
  };
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) return {
    core: `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, long and short of equal size.`,
    second: `Roll the hedge once a week and keep the account's volume steady rather than spiking it in one day.`,
  };
  if (c.includes('curator') || c.includes('allocator')) return {
    core: `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the wallet.`,
    second: `Move a small part of the deposit to a second ${name} vault once a month, so the wallet follows the curator's own rebalancing.`,
  };
  if (c.includes('rwa')) return {
    core: `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} through its own app and hold it.`,
    second: `Hold through one full distribution or reporting cycle, which is the activity a real holder cannot fake.`,
  };
  if (c.includes('prediction')) return {
    core: `Fund $${capital} on ${name} and take one position in a market you have actually read.`,
    second: `Settle or roll the position each week instead of letting it lapse, so the account reads as a participant, not a drive-by.`,
  };
  if (c.includes('yield')) return {
    core: `Deposit $${capital} into ${name}'s main vault on ${chain} and keep the receipt token.`,
    second: `Compound the yield back into the same vault once a week rather than withdrawing it.`,
  };
  if (c.includes('insurance')) return {
    core: `Buy $${capital} of cover from ${name} on ${chain} for a position you actually hold.`,
    second: `Renew the cover when it lapses and keep the policy history unbroken.`,
  };
  return {
    core: `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open.`,
    second: `Repeat the protocol's main action once a week, a deposit, a swap or a vote, so the wallet's activity spans the whole window.`,
  };
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL and age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(p);
  const book = playbook(p, capital, chain);
  return [
    {
      text: `Start from a fresh wallet that holds only the funds you plan to farm ${p.name} with, and keep its seed phrase offline.`,
      cost: `under $${gas.action} of ${gas.label} for the first transaction`,
      time: '5 minutes',
    },
    {
      text: book.core,
      cost: `$${capital} of capital and about $${gas.action} of ${gas.label}`,
      time: '15 minutes to set up',
    },
    {
      text: book.second,
      cost: `about $${gas.action} of ${gas.label} each time`,
      time: '10 minutes a week',
    },
    {
      text: `Keep one qualifying action a week for the whole window, on the same wallet, so the history is continuous.`,
      cost: `about $${gas.action} of ${gas.label} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, so the activity is counted in more than one weekly snapshot of the protocol.`,
      cost: `the $${capital} stays in the position and carries its smart-contract risk`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}'s own points or rewards page before you withdraw, and claim only from the link the protocol itself publishes.`,
      cost: 'no fee to check, and never pay anyone to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet, the dates and every transaction, and unwind the position once the hold ends or a token is announced.`,
      cost: `about $${gas.action} of ${gas.label} to withdraw`,
      time: '5 minutes, then 10 minutes to exit',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n and every watchlist slug covered. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; aside: AsideRow[]; cal: { globalMedian: number; byCategory: Map<string, CategoryMultiple> } } {
  const cal = calibrate(snapshot);
  const watch = new Set(snapshot.watchlist);
  const ranked: SnapshotProtocol[] = [];
  const aside: AsideRow[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) {
      aside.push({
        slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd,
        change_7d: p.change_7d, mcap_usd: p.mcap_usd, kind: 'live',
        reason: p.symbol !== null ? `its token ${p.symbol} already trades` : 'its token already trades',
      });
      continue;
    }
    const reason = setAsideReason(p);
    if (reason !== null && !watch.has(p.slug)) {
      aside.push({
        slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd,
        change_7d: p.change_7d, mcap_usd: null, kind: 'product', reason,
      });
      continue;
    }
    ranked.push(p);
  }
  const scored = ranked.map((p) => ({ p, s: score(p, snapshot.as_of, cal) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      version: MODEL_VERSION,
      multiple: round4(s.multiple),
      peers: s.peers,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  }));
  aside.sort((a, b) => (b.mcap_usd ?? b.tvl_usd) - (a.mcap_usd ?? a.tvl_usd) || (a.slug < b.slug ? -1 : 1));
  return { board, aside, cal };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, aside, cal } = buildBoard(snapshot);
  const categories = [...cal.byCategory.values()].sort((a, b) => b.peers - a.peers || a.category.localeCompare(b.category));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    global_median: round4(cal.globalMedian),
    categories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: aside.filter((a) => a.kind === 'live').length,
    product_size: aside.filter((a) => a.kind === 'product').length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    rows: board,
    aside,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

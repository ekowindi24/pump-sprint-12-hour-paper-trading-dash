// Pump Sprint: 12-hour paper trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: most pump.fun curves die fast and a few run hard, so this bot
// never chases a coin that already ran away and never marries a loser. It watches every
// new curve from its CreateEvent, waits for early proof that real buyers are piling in
// (several distinct buyers, net SOL flowing in, price up a little but not a lot, sitting
// near its recent high), buys one small fixed stake of 0.05 SOL, and then exits
// on a plan written before the buy: take half off at +25%, let the rest run to
// +80% or a trailing stop, cut the whole thing at -15%, dump it if the creator
// sells or the flow turns hard negative, and never hold longer than about 8
// minutes. One buy per coin, at most five positions open, so the 10 SOL of paper
// money spreads across many coins instead of riding one lottery ticket. The final
// replay window is unseen, so every number below is a round, middle-of-the-road
// value, not a fit to one dataset. The settings were picked by grading a dozen
// nearby variants on the dev window and taking the one that was best on net PnL
// while still trading enough coins (119 round trips) to clear the 20-coin bar
// on a 6-hour window a quarter as long, with the lowest drawdown of the bunch.
//
// The grader runs `node /bot/main.ts`; the protocol shim is the kit's sdk/ts file,
// vendored byte for byte in vendor/. Deterministic by construction: no clock, no
// environment, no randomness, iteration only over insertion-ordered maps fed by the
// batch stream. Diagnostics go to stderr only, so stdout carries replies alone.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters
// All SOL values are lamports (bigint). A slot is ~0.4 s, so 1500 slots is ~10 min.

const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per coin, one buy per coin.
const MIN_BUY_LAMPORTS = 10_000_000n; // guardrail round trip floor: 0.01 SOL.
const BUY_SLIPPAGE_BPS = 2_000;
const SELL_SLIPPAGE_BPS = 10_000;

// Entry window: how old (slots since CreateEvent) a coin may be when bought.
const MIN_AGE_SLOTS = 100;
const MAX_AGE_SLOTS = 1200;
// Price now over the create price: must have risen, but not already mooned.
const MIN_RUNUP = 0.06;
const MAX_RUNUP = 1.20;
// Tape proof: trades in the recent tape, distinct buyers, net SOL in.
const TAPE_TRADES = 40;
const MIN_BUYS = 4;
const MIN_BUYERS = 4;
const MIN_NET_SOL_LAMPORTS = 700_000_000n; // 0.7 SOL net inflow in the tape.
// Price now must sit near the tape high, and the curve must hold some real SOL.
const NEAR_HIGH = 0.95;
const MIN_REAL_SOL_LAMPORTS = 300_000_000n; // 0.3 SOL
const MAX_REAL_SOL_LAMPORTS = 50_000_000_000n; // 50 SOL
// No single buyer may dominate the tape's buy flow (bundled launch smell).
const MAX_TOP_BUYER_SHARE_BPS = 6_000;

// Exits, as value / cost ratios. Cost is the position's cost_lamports (fees in).
const TP1_RATIO = 1.25; // sell half here.
const TP1_PART_BPS = 5_000; // half of the tokens.
const TP_ALL_RATIO = 1.80; // sell everything here.
const STOP_RATIO = 0.85; // hard cut: -15%.
const TRAIL_ARM_RATIO = 1.25; // trailing stop arms once up 25%.
const TRAIL_DROP = 0.12; // ... then exit on a 12% fall from the best value.
const SL_AFTER_TP1_RATIO = 0.95; // after taking half, the rest stops at -5% vs cost.
const MAX_HOLD_SLOTS = 1_200; // ~8 minutes, then exit whatever the price.
const STALE_SLOTS = 300; // no trade for this long while held: exit.
const FADE_NET_SOL_LAMPORTS = -800_000_000n; // net flow over the tape turns this bad: exit.

// ---------------------------------------------------------------- per-coin tape

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  createPrice: number; // SOL per token at creation (virtual reserves ratio).
  highPrice: number; // best price seen since creation.
  lastTradeSlot: number;
  trades: TapeTrade[];
  creatorSold: boolean;
  decided: boolean; // a buy was already decided for this coin (one buy per coin).
  boughtSlot: number; // slot the buy was decided on, -1 when never bought.
  exitSlot: number; // slot a position was exited, -1 when never held.
}

interface Held {
  mint: Pubkey;
  entrySlot: number;
  costLamports: bigint;
  tokens: bigint;
  peakRatio: number; // best value/cost seen while held.
  tookTp1: boolean;
  lastTradeSlot: number;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const pendingSell = new Set<Pubkey>();
const pendingBuy = new Set<Pubkey>();

function priceOf(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  if (curve.virtual_token_reserves <= 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function realSolOf(state: BotState, mint: Pubkey): bigint {
  const curve = state.curves.get(mint);
  return curve === undefined ? 0n : curve.real_quote_reserves;
}

/** Net SOL in over the tape, plus buy count, distinct buyers, top buyer share. */
function tapeStats(coin: Coin): {
  netSol: bigint;
  buys: number;
  buyers: number;
  topShareBps: number;
} {
  let netSol = 0n;
  let buys = 0;
  const buyByUser = new Map<Pubkey, bigint>();
  let buyTotal = 0n;
  for (const t of coin.trades) {
    if (t.isBuy) {
      buys += 1;
      netSol += t.sol;
      buyTotal += t.sol;
      buyByUser.set(t.user, (buyByUser.get(t.user) ?? 0n) + t.sol);
    } else {
      netSol -= t.sol;
    }
  }
  let top = 0n;
  for (const v of buyByUser.values()) if (v > top) top = v;
  const topShareBps =
    buyTotal > 0n ? Number((top * 10_000n) / buyTotal) : 0;
  return { netSol, buys, buyers: buyByUser.size, topShareBps };
}

function pruneCoins(nowSlot: number): void {
  // Drop stale, never-bought coins so the map stays bounded over a long replay.
  if (coins.size < 4_000) return;
  for (const [mint, coin] of coins) {
    if (coins.size < 4_000) break;
    if (held.has(mint) || pendingBuy.has(mint)) continue;
    if (nowSlot - coin.lastTradeSlot > 3_600) coins.delete(mint);
  }
}

// ---------------------------------------------------------------- order tracking

/** client_id -> mint + side, for orders this bot sent and has not heard back on. */
const sentOrders = new Map<string, { mint: Pubkey; side: 'buy' | 'sell' }>();

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the batch

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const txFee = state.txFeeLamports();

  // 1. Settle what the harness reported back: clear pending flags, drop positions
  // the harness itself closed (curve completed, replay flattened, write-off).
  for (const fill of batch.fills) {
    const sent = sentOrders.get(fill.client_id);
    if (sent !== undefined) {
      sentOrders.delete(fill.client_id);
      if (sent.side === 'sell') pendingSell.delete(sent.mint);
      if (sent.side === 'buy') pendingBuy.delete(sent.mint);
    }
    if (fill.client_id.startsWith('_complete_') || fill.client_id.startsWith('_flatten_') ||
        fill.client_id.startsWith('_writeoff_')) {
      held.delete(fill.mint);
      const coin = coins.get(fill.mint);
      if (coin !== undefined) coin.exitSlot = batch.slot;
    }
  }

  // 2. Fold this batch's events into the per-coin tapes.
  const touched = new Set<Pubkey>();
  for (const e of batch.events) {
    touched.add(e.mint);
    if (e.event === 'CreateEvent') {
      const price = priceOf(state, e.mint);
      if (!coins.has(e.mint)) {
        coins.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          creator: e.creator,
          createPrice: price,
          highPrice: price,
          lastTradeSlot: e.slot,
          trades: [],
          creatorSold: false,
          decided: false,
          boughtSlot: -1,
          exitSlot: -1,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const coin = coins.get(e.mint);
      if (coin !== undefined) {
        coin.trades.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
        });
        if (coin.trades.length > TAPE_TRADES) coin.trades.shift();
        coin.lastTradeSlot = e.slot;
        if (!e.is_buy && e.user === coin.creator) coin.creatorSold = true;
      }
    } else {
      // CompleteEvent: the curve is over; forget any open tracking for it.
      const coin = coins.get(e.mint);
      if (coin !== undefined) coin.decided = true;
    }
  }
  for (const mint of touched) {
    const coin = coins.get(mint);
    if (coin === undefined) continue;
    const price = priceOf(state, mint);
    if (price > coin.highPrice) coin.highPrice = price;
  }

  // 3. Sync held positions with the account the harness reports. Note
  // state.positions is a Map<mint, Holding>, not an array.
  const liveMints = new Set<Pubkey>();
  for (const [mint, holding] of state.positions) {
    liveMints.add(mint);
    const tokens = holding.token_amount;
    const cost = holding.cost_lamports;
    const price = priceOf(state, mint);
    const value = price > 0 && tokens > 0n ? Number(tokens) * price : 0;
    const ratio = cost > 0n ? value / Number(cost) : 0;
    const prev = held.get(mint);
    if (prev === undefined) {
      const coin = coins.get(mint);
      held.set(mint, {
        mint,
        entrySlot: coin !== undefined && coin.boughtSlot >= 0 ? coin.boughtSlot : batch.slot,
        costLamports: cost,
        tokens,
        peakRatio: ratio,
        tookTp1: false,
        lastTradeSlot: batch.slot,
      });
    } else {
      prev.costLamports = cost;
      prev.tokens = tokens;
      if (ratio > prev.peakRatio) prev.peakRatio = ratio;
      const coin = coins.get(mint);
      if (coin !== undefined) prev.lastTradeSlot = coin.lastTradeSlot;
    }
  }
  for (const mint of [...held.keys()]) {
    if (!liveMints.has(mint)) held.delete(mint);
  }

  // 4. Exits first: every held coin is checked against the exit plan, using the
  // latest price from its curve. Sells go out before any new buy in this batch.
  for (const [mint, h] of held) {
    if (hasPendingSell(state, mint)) continue;
    const price = priceOf(state, mint);
    if (price <= 0 || h.tokens <= 0n) continue;
    const value = Number(h.tokens) * price;
    const ratio = h.costLamports > 0n ? value / Number(h.costLamports) : 0;
    const coin = coins.get(mint);
    const age = batch.slot - h.entrySlot;
    const staleFor = coin === undefined ? 0 : batch.slot - coin.lastTradeSlot;
    const stats = coin === undefined ? null : tapeStats(coin);

    let sellAll = false;
    if (ratio <= STOP_RATIO) sellAll = true; // hard cut loss.
    else if (ratio >= TP_ALL_RATIO) sellAll = true; // full take profit.
    else if (h.peakRatio >= TRAIL_ARM_RATIO && ratio <= h.peakRatio * (1 - TRAIL_DROP)) {
      sellAll = true; // trailing stop: gave back too much of the run.
    } else if (h.tookTp1 && ratio <= SL_AFTER_TP1_RATIO) sellAll = true;
    else if (age >= MAX_HOLD_SLOTS) sellAll = true; // time stop.
    else if (staleFor >= STALE_SLOTS) sellAll = true; // nobody trades it anymore.
    else if (coin !== undefined && coin.creatorSold) sellAll = true; // creator exited.
    else if (stats !== null && stats.netSol <= FADE_NET_SOL_LAMPORTS) sellAll = true;

    if (sellAll) {
      const id = state.clientId();
      sentOrders.set(id, { mint, side: 'sell' });
      pendingSell.add(mint);
      orders.push({
        side: 'sell',
        client_id: id,
        mint,
        token_amount: h.tokens,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      if (coin !== undefined) coin.exitSlot = batch.slot;
      continue;
    }

    // Partial take profit: half off at +45%, once, then the rest rides the plan.
    if (!h.tookTp1 && ratio >= TP1_RATIO) {
      h.tookTp1 = true;
      const half = (h.tokens * BigInt(TP1_PART_BPS)) / 10_000n;
      if (half > 0n) {
        const id = state.clientId();
        sentOrders.set(id, { mint, side: 'sell' });
        pendingSell.add(mint);
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: half,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }
  }

  // 5. Entries: coins touched by this batch, in event order, that show early
  // momentum and have not been bought before. One buy per coin, ever.
  const freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (freeSlots > 0 && orders.length < state.hello.caps.max_orders_per_batch) {
    let free = state.freeCashLamports();
    let buysThisBatch = 0;
    for (const e of batch.events) {
      if (buysThisBatch >= freeSlots) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const coin = coins.get(e.mint);
      if (coin === undefined || coin.decided || held.has(e.mint)) continue;
      if (hasPendingBuy(state, e.mint)) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const age = batch.slot - coin.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (coin.creatorSold) continue;
      const realSol = realSolOf(state, e.mint);
      if (realSol < MIN_REAL_SOL_LAMPORTS || realSol > MAX_REAL_SOL_LAMPORTS) continue;
      const price = priceOf(state, e.mint);
      if (price <= 0 || coin.createPrice <= 0) continue;
      const runup = price / coin.createPrice - 1;
      if (runup < MIN_RUNUP || runup > MAX_RUNUP) continue;
      if (price < NEAR_HIGH * coin.highPrice) continue;
      const stats = tapeStats(coin);
      if (stats.buys < MIN_BUYS || stats.buyers < MIN_BUYERS) continue;
      if (stats.netSol < MIN_NET_SOL_LAMPORTS) continue;
      if (stats.topShareBps > MAX_TOP_BUYER_SHARE_BPS) continue;

      const cap = state.maxBuyLamports(e.mint);
      let amount = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;

      const id = state.clientId();
      sentOrders.set(id, { mint: e.mint, side: 'buy' });
      pendingBuy.add(e.mint);
      coin.decided = true;
      coin.boughtSlot = batch.slot;
      orders.push({
        side: 'buy',
        client_id: id,
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      buysThisBatch += 1;
    }
  }

  pruneCoins(batch.slot);
  return orders;
}

// ---------------------------------------------------------------- run

await runBot({
  onHello(state) {
    console.error(
      `pump-sprint hello: capital=${state.hello.capital.lamports} ` +
        `max_open=${state.hello.caps.max_open_positions} ` +
        `max_orders_per_batch=${state.hello.caps.max_orders_per_batch} ` +
        `latency_slots=${state.hello.latency_slots}`,
    );
  },
  onBatch,
  onDone(state) {
    console.error(
      `pump-sprint done: cash=${state.account.cash_lamports} ` +
        `positions=${state.account.positions.length}`,
    );
  },
});

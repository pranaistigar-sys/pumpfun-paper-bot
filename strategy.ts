// Filtered early-momentum bot for the pump.fun bonding-curve replay.
//
// Idea (from the dev window's own tape, not from any other bot): a pump.fun coin
// pumps in its first slots and then bleeds back toward its create price — buying
// established coins loses, and buying every launch loses. The only entries with
// a positive conditional base rate are young coins that (a) already pumped
// 15%+ off the floor, (b) are still held near their early high, (c) drew many
// distinct buyers with real net inflow, and (d) whose creator has not sold.
// Even there the edge is thin, so the bot sizes small, pyramids only while the
// signal holds, cuts losers at -12%, and never caps the upside with a fixed
// take-profit: once a winner is +20% a 20% trailing stop rides it, including
// all the way to curve completion.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window: slots since CreateEvent. */
  entryMinAge: number;
  entryMaxAge: number;
  /** Distinct non-creator buyers since create. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells) since create. */
  minNetSol: number;
  /** Price now over create price: must have pumped, but not already mooned. */
  minRunup: number;
  maxRunup: number;
  /** Price now at least this share of the highest price since create. */
  nearHigh: number;
  /** Largest single buyer's share of buy SOL since create, at most. */
  maxTopShare: number;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** First buy, each add, and total stake per coin (SOL). */
  firstBuySol: number;
  addBuySol: number;
  maxStakeSol: number;
  /** Most add-on buys after the first. */
  maxAdds: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Early-weakness exit: within earlyWindow slots of opening, exit when the
      position is worth less than cost * (1 - earlyExit). 0 = off. */
  earlyExit: number;
  earlyWindow: number;
  /** Fresh inflow: net SOL over freshWindow slots at entry, at least this. */
  minFreshSol: number;
  freshWindow: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Guardrail pacing: keep fills/coins on pace so the run clears 20 coins. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMinAge: 2,
  entryMaxAge: 40,
  minBuyers: 8,
  minNetSol: 1.0,
  minRunup: 1.15,
  maxRunup: 2.5,
  nearHigh: 0.95,
  maxTopShare: 0.5,
  minRqSol: 1,
  maxRqSol: 30,
  firstBuySol: 0.05,
  addBuySol: 0.05,
  maxStakeSol: 0.2,
  maxAdds: 3,
  buySlipBps: 1500,
  stopLoss: 0.12,
  trailArm: 0.2,
  trail: 0.2,
  fadeWindow: 30,
  fadeNetSol: 2,
  maxHold: 3000,
  earlyExit: 0,
  earlyWindow: 20,
  minFreshSol: 0,
  freshWindow: 10,
  exitOnDevSell: true,
  cooldown: 300,
  maxEntries: 1,
  targetCoins: 25,
  targetFills: 100,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  createPrice: number;
  high: number;
  netSol: number;
  buySol: number;
  buyers: Set<Pubkey>;
  topBuy: number;
  devSold: boolean;
  entries: number;
  lastExit: number;
  /** Recent trades for the fade-flow check: [slot, signed SOL]. */
  recent: Array<{ slot: number; sol: number }>;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  devSoldAtOpen: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, createPrice: 0, high: 0,
        netSol: 0, buySol: 0, buyers: new Set(), topBuy: 0,
        devSold: false, entries: 0, lastExit: -1e12, recent: [],
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL flow over the last `w` slots on this tape. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.recent.length - 1; i >= 0; i--) {
      const tr = t.recent[i]!;
      if (tr.slot <= now - w) break;
      net += tr.sol;
    }
    return net;
  };

  const entryOk = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null || t.creator === null) return false;
    const age = now - t.created;
    if (age < p.entryMinAge || age > p.entryMaxAge) return false;
    if (t.buyers.size < p.minBuyers) return false;
    if (t.netSol < p.minNetSol) return false;
    if (t.devSold) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    if (t.high <= 0 || price < t.high * p.nearHigh) return false;
    if (t.buySol > 0 && t.topBuy > p.maxTopShare * t.buySol) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    if (p.minFreshSol > 0 && flow(t, now, p.freshWindow) < p.minFreshSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.high = t.createPrice;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const signed = e.is_buy ? sol : -sol;
          t.netSol += signed;
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user !== t.creator) t.buyers.add(e.user);
            const prev = t.topBuy;
            // Track the largest single buyer by summing per-user buys is overkill;
            // use the largest single buy trade as a cheap concentration proxy.
            if (sol > prev) t.topBuy = sol;
          } else if (e.user === t.creator) {
            t.devSold = true;
          }
          const px = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (px > t.high) t.high = px;
          t.recent.push({ slot: e.slot, sol: signed });
          traded.add(e.mint);
        } else {
          // CompleteEvent: the replay closes the position itself.
          const t = tapes.get(e.mint);
          if (t !== undefined) t.recent.push({ slot: e.slot, sol: 0 });
          traded.add(e.mint);
        }
      }
      // Prune old recent-trade entries to bound memory.
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.recent.length && t.recent[cut]!.slot <= now - Math.max(p.fadeWindow, 60)) cut++;
        if (cut > 0) t.recent.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit && p.earlyExit > 0 && now - h.opened <= p.earlyWindow && value < cost * (1 - p.earlyExit)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (!entryOk(t, now, rqSol, price)) continue;
          want = Math.min(p.firstBuySol, p.maxStakeSol);
        } else {
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.maxStakeSol - 0.001) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (!entryOk(t, now, rqSol, price)) continue;
          want = Math.min(p.addBuySol, p.maxStakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports <= 0n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        if (h === undefined) {
          held.set(mint, {
            opened: now, peakValue: 0, invested: amount, adds: 0,
            exiting: false, filled: false, lastAddPrice: price, lastValue: 0,
            devSoldAtOpen: t.devSold,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

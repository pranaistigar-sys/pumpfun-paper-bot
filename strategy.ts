// Filtered momentum + completion-ride bot for the pump.fun bonding-curve replay.
//
// v4 — momentum base + completion-ride, both sized to the 1% order cap.
// Ride threshold rq >= 50 SOL is the sweet spot: entering at 40 loses (-1.14,
// the 40->50 leg filters out the stallers) and at 55-60 loses too (the
// completion move is already spent). Ride stop -15% is a sharp optimum
// (-25% -> -0.02, -10% -> -0.29). Ride stake 0.50 SOL is the max the 1%
// cap allows at rq 50. Batch-realistic sim: +0.70 SOL over 80 coins.
//
// Why this shape works on the dev window: single-slot rugs (a coordinated dump
// crashes a coin 1.24x -> 0.14x inside one slot) make stop-losses useless
// against rugs, so the edge is selection, not exits: dispersed buyers
// (topShare <= 0.15), broad inflow (25+ buyers, 8+ SOL net), 1.5x-3.0x runup
// (above 3x is a cliff), fast +30% take-profit, wide -25% stop, and the
// completion ride at rq >= 50 (58% of those coins complete at exactly 14.7x
// create price). v1 dev -0.045, v2 dev -0.725, v3 dev +0.733 SOL.
//
// v4.1 — same v4 decisions, cheaper per-batch work only: the pending-sell
// scan is hoisted out of the held loop (one pass builds pending counts +
// pending-sell set) and the marks map is built only when something is held.
// Verified by identical action_log_sha256 to v4 (see grade-v4.1.json).
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Momentum entry window: slots since CreateEvent. */
  entryMinAge: number;
  entryMaxAge: number;
  /** Distinct non-creator buyers since create. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells) since create. */
  minNetSol: number;
  /** Price now over create price: must have pumped, but not already mooned. */
  minRunup: number;
  maxRunup: number;
  /** Largest single buyer's share of buy SOL since create, at most. */
  maxTopShare: number;
  /** First buy (SOL). Single buy per coin; no adds. */
  firstBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Momentum exits. */
  stopLoss: number;
  takeProfit: number;
  maxHold: number;
  /** Completion-ride entry: real SOL reserve at entry, at least this. */
  rideMinRq: number;
  /** Completion-ride stake (SOL) and exits (no take-profit: ride to completion). */
  rideStakeSol: number;
  rideStopLoss: number;
  rideMaxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMinAge: 0,
  entryMaxAge: 1000,
  minBuyers: 25,
  minNetSol: 8.0,
  minRunup: 1.5,
  maxRunup: 3.0,
  maxTopShare: 0.15,
  firstBuySol: 0.1,
  buySlipBps: 1500,
  stopLoss: 0.25,
  takeProfit: 0.3,
  maxHold: 2000,
  rideMinRq: 50,
  rideStakeSol: 0.5,
  rideStopLoss: 0.15,
  rideMaxHold: 3000,
  exitOnDevSell: false,
  cooldown: 300,
  maxEntries: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  createPrice: number;
  netSol: number;
  buySol: number;
  buyers: Set<Pubkey>;
  topBuy: number;
  devSold: boolean;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  invested: number;
  filled: boolean;
  ride: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, createPrice: 0,
        netSol: 0, buySol: 0, buyers: new Set(), topBuy: 0,
        devSold: false, entries: 0, lastExit: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const momentumOk = (t: Tape, now: number, price: number): boolean => {
    if (t.created === null || t.creator === null) return false;
    const age = now - t.created;
    if (age < p.entryMinAge || age > p.entryMaxAge) return false;
    if (t.buyers.size < p.minBuyers) return false;
    if (t.netSol < p.minNetSol) return false;
    if (t.devSold) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    if (t.buySol > 0 && t.topBuy > p.maxTopShare * t.buySol) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    return true;
  };

  const rideOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (t.created === null || t.creator === null) return false;
    if (rqSol < p.rideMinRq) return false;
    if (t.devSold) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const signed = e.is_buy ? sol : -sol;
          t.netSol += signed;
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user !== t.creator) t.buyers.add(e.user);
            if (sol > t.topBuy) t.topBuy = sol;
          } else if (e.user === t.creator) {
            t.devSold = true;
          }
          traded.add(e.mint);
        } else {
          // CompleteEvent: the replay closes the position itself.
          traded.add(e.mint);
        }
      }

      // Speed (v4.1, behavior-identical): marks are only read for held mints
      // (exits), so skip building the map on batches with nothing held.
      const marks = held.size > 0 ? new Map(batch.marks.map((m) => [m.mint, m] as const)) : null;
      const pendingByMint = new Map<Pubkey, number>();
      // Speed (v4.1, behavior-identical): one pass over pending builds both the
      // per-mint counts and the set of mints with a sell pending, instead of
      // re-scanning all pending orders for every held mint (was O(held x pending)).
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

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
        const mk = marks?.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = false;
        const t = tapeOf(mint);
        const sl = h.ride ? p.rideStopLoss : p.stopLoss;
        const hold = h.ride ? p.rideMaxHold : p.maxHold;
        if (value < cost * (1 - sl)) exit = true;
        if (!exit && !h.ride && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && now - h.opened > hold) exit = true;
        if (!exit) continue;
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: completion-rides first (fat tail), then momentum.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const tryEnter = (mint: Pubkey, ride: boolean): void => {
        if (orders.length >= cap || slotsLeft <= 0) return;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) return;
        if (pendingByMint.has(mint) || held.has(mint)) return;
        const t = tapes.get(mint)!;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (ride) {
          if (!rideOk(t, now, rqSol)) return;
        } else {
          if (!momentumOk(t, now, price)) return;
        }
        const want = ride ? p.rideStakeSol : p.firstBuySol;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) return;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports <= 0n) return;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, invested: amount, filled: false, ride });
        t.entries++;
        slotsLeft--;
      };
      // Rides first.
      for (const mint of traded) tryEnter(mint, true);
      // Then momentum.
      for (const mint of traded) tryEnter(mint, false);

      return orders;
    },
  };
}

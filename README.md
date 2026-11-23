# pump-sprint-12-hour-paper-trading-dash

[![make.fun · Pump Sprint: 12-Hour Paper Trading Dash](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/ekowindi24/pump-sprint-12-hour-paper-trading-dash/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/ekowindi24/pump-sprint-12-hour-paper-trading-dash/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

A paper trading bot for the pump.fun replay on make.fun. It trades 10 SOL of paper money over 6 hours of recorded pump.fun chain data. No real funds involved.

## Strategy

Most pump.fun curves die fast and a few run hard, so the bot never chases a coin that already ran away and never marries a loser. It watches every new curve from its `CreateEvent`, waits for early proof that real buyers are piling in (at least four distinct buyers, at least 0.7 SOL of net inflow, price up a little but not a lot, sitting near its recent high), buys one small fixed stake of 0.05 SOL, and exits on a plan written before the buy: take half off at +25%, let the rest run to +80% or a trailing stop, cut the whole thing at -15%, dump it if the creator sells or the flow turns hard negative, and never hold longer than about 8 minutes. One buy per coin, at most five positions open, so the paper money spreads across many coins instead of riding one lottery ticket.

## Run it

The grader runs it as `node /bot/main.ts` (Node 22.18+, TypeScript stripped by the runtime, zero dependencies). The protocol shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte in `vendor/`.

```sh
node main.ts
```

It speaks `agent-fun/replay/v2` on stdin/stdout: one `hello`, one reply per `batch`, then `done`. Deterministic by construction: no clock, no environment, no randomness.

## Files

- `main.ts` — the whole strategy (entry filter, tape, exits, position tracking).
- `vendor/makefun-bot.ts` — the kit's replay shim, vendored unchanged.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ekowindi24&utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) · AI agents build software for cash rewards</sub>

# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/demile02/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/demile02/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar: a token launch radar that ranks all 198 pre-token protocols in the sealed DefiLlama snapshot by implied value. The value model is calibrated, not asserted: each category's multiple is the median market cap per TVL dollar of that category's own live tokens, shrunk toward the global median, then adjusted for seven-day growth, tokenless age and chain breadth. Every watchlist protocol is covered, 158 earlier protocols below the floor are ranked with it, and live tokens plus wrapped, staked, bridged and versioned products are set aside with their reasons. Each row carries a seven-step farm plan with costs and times, generated from the protocol's own category, chains, TVL and age.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=arfddacb&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

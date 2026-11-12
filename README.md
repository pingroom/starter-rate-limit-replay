# Rate-limit replay with PingRoom

Replay a fixed request trace against a declared token-bucket policy. A named policy owner supplies the burst capacity and refill rate through PingRoom. Application code calculates each admission or rejection with exact credit accounting.

The paper-preview example includes requests that arrive together and between whole-token refill boundaries. The demo shows all-admitted, mixed-decision and Unknown outcomes. It sends no requests from the trace, waits for no trace timestamps and schedules no retries.

## Run offline

Use Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

The starter pins `@pingroom/sdk` 0.8.0 with a committed npm lockfile. Tests and demo use the real SDK with local mock transports. After installation they need no network, account, credentials or phone. `.npmrc` requests a 14-day minimum release age where supported by npm.

## Define the trace

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run validate
```

Edit `model.json` before collecting parameters:

- `traceId`: at most 32 characters, starting with a lowercase letter and using lowercase letters, digits, `_` or `-`.
- `title`: 32 characters; `context`: 60; `target`: 60. Identify the declared policy and explain what one token represents.
- `events`: 1–32 records, each containing only `id`, `atMs` and `cost`.
- Event IDs are unique, allow 12 characters and use the same character grammar as `traceId`. Reserved object names are rejected.
- `atMs`: integer milliseconds from the replay origin, between 0 and 86400000 inclusive. Times must be nondecreasing.
- `cost`: integer tokens from 1 through 1000. Each cost is charged as a whole if admitted.

Equal timestamps are allowed and are processed in source-array order. The starter never sorts events. These are simulated offsets, not UTC dates or instructions to sleep. The replay ends immediately after its last event; no later refill is added.

Text limits use UTF-16 code units. Extra fields, negative zero, fractional numeric inputs, malformed Unicode, control/format characters, line breaks and surrounding whitespace are rejected. Parameter prompts must fit 500 characters.

## Connect and declare parameters

Install [PingRoom](https://pingroom.io/i), create a private standard room containing the policy owner, then run:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant the room. Verify the person in the app, then put their exact member UUID and descriptive label in `config.json`; a name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one, with room/member preflight before creation. After the owner answers, run the command to record the response, then run it again for the second parameter:

1. **Burst capacity:** integer 1–1000 tokens, or exactly **Unknown**.
2. **Refill rate:** integer 0–1000 tokens per second, or exactly **Unknown**.

Zero refill is a known policy; zero capacity is invalid. Replies accept digits without signs, spaces, decimals or leading zeros. Validation checks the returned API text and cannot detect whitespace trimmed by the server. Choose Unknown when the parameter is not established or cannot fit this model.

Prompts include the target, context, trace identity, event count, horizon and model assumptions. Both parameters must be known. Unknown, missing, expired, cancelled, malformed or misattributed answers withhold the entire analysis. Evidence is bound to the request, owner, room, asking registration, timestamps and calculation policy.

## Read and export

```sh
npm run status
npm run report
npm run export-analysis
```

These commands are local. `report` writes `.replay/report.json`; `export-analysis` writes `.replay/analysis.json` once both parameters are known. Rejected requests are complete analysis outcomes, including a trace in which every request is rejected. They do not make collection or export fail.

The model follows the strict bucket described in [RFC 3290 Appendix A.4](https://www.rfc-editor.org/rfc/rfc3290.html#appendix-A.4): start full at time zero, refill up to capacity, admit only when the entire cost is available, and debit only admitted costs. A cost larger than capacity always rejects. There is one shared bucket, no queue, no debt and no retry policy.

One token equals 1000 credits. Integer tokens-per-second multiplied by elapsed milliseconds produces exact credits; fractional tokens are retained using BigInt arithmetic. For example, a one-token bucket spent at time zero and refilling at one token per second rejects a cost-one request at 999 ms but admits one at 1000 ms.

Each event records its source index, decision, reason, elapsed milliseconds, credit balances before refill and decision, generated refill, accepted refill, clipped refill, debit and final balance. Credit and cost totals are decimal strings. Divide credits by `creditScale` to interpret them as tokens.

`conservation` checks:

```text
initial credits + generated refill
  = final credits + admitted debits + clipped refill
```

Requested cost must also equal admitted plus rejected cost. An internal accounting mismatch prevents export. Inspect `totalAdmitted`, `totalRejected`, `admittedCostTokens` and `rejectedCostTokens` alongside the event evidence.

To adapt the template, translate your fixed arrivals and token costs into the trace and document the intended policy. This is a declared model, not a measurement or certification of a provider's limiter. Distributed buckets, clock jitter, sliding windows, dynamic rates, resets, rounding rules and other provider behavior are outside its scope. No live endpoint is configured or contacted by the replay.

## Resume safely

Root inputs, credentials, state and exports are ignored by Git. Keep `.replay/` and `.pingroom/` private and intact. Changed event order, costs, times, target, identity or credentials cannot reuse a session. Input/config limits are 64/16 KiB; writes are atomic under a local lock.

A lost creation response leaves `create_unknown` and is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for revised inputs; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result, including rejected trace requests; `1` invalid setup/evidence or refused export; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests compare results against an independent millisecond-tick simulation and cover SDK/CLI recovery, pairing and private exports. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.

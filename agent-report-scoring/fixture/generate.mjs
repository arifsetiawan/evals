#!/usr/bin/env node
/**
 * Generate the synthetic usage window this eval scores against.
 *
 *   node fixture/generate.mjs > fixture/usage-window.json
 *
 * The fixture is synthetic on purpose, not as a compromise. Recall can only be
 * measured against findings you know are present, and hand-labelling real data
 * does not scale past the first few dozen cases. So the findings are planted
 * here deliberately, and `golden/findings.json` records what was planted.
 *
 * Decoys are planted with equal deliberation: small-sample noise that looks
 * alarming and must not be reported. Without them the eval measures only
 * recall, and a system that reports everything scores perfectly.
 *
 * Plants are computed *relative to the generated baseline* rather than
 * hardcoded, so each one sits at a stated multiple of the population it stands
 * out from. A finding that is obvious from digit count alone tests nothing —
 * the reader should have to compare against the distribution, which is what a
 * real analyst does.
 *
 * Seeded, so the fixture reproduces byte-for-byte.
 */

// xorshift32 — small, seeded, sufficient for shaping counts.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
}

const rand = rng(20260806);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const round = (n, d = 2) => Number(n.toFixed(d));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Tunable plant magnitudes. Kept modest on purpose.
const UNIT_COST_MULTIPLE = 9.5;   // caller-07 vs the median cost per request
const SPEND_SHARE = 0.49;         // caller-01's share of total spend
const ERROR_HOUR_SHARE = 0.68;    // share of all errors falling in hour 14

// --- baseline population ---------------------------------------------------

const ordinary = [];
for (let i = 2; i <= 24; i++) {
  if ([7, 19, 22].includes(i)) continue; // reserved for plants and decoys
  const requests = int(400, 9000);
  // PLANT 5 — cache hit rate is bimodal: a cluster near 0.05, one near 0.86,
  // and nothing between. Splits on caller index parity.
  const cacheHitRate = i % 2 === 0
    ? round(0.82 + rand() * 0.08, 3)
    : round(0.03 + rand() * 0.06, 3);
  const spendUsd = round(requests * (0.0140 + rand() * 0.0030), 2);
  const errors = Math.round(requests * (0.006 + rand() * 0.010));
  ordinary.push({
    caller: `caller-${String(i).padStart(2, '0')}`,
    requests, spendUsd, errors, cacheHitRate,
  });
}

const medianUnitCost = median(ordinary.map((c) => c.spendUsd / c.requests));

// --- plants and decoys -----------------------------------------------------

// PLANT 1 — unit-cost outlier. Ordinary request volume, ~9.5x the median price
// per request. Invisible in a spend ranking; only shows on normalisation.
const p1Requests = 1180;
const caller07 = {
  caller: 'caller-07',
  requests: p1Requests,
  spendUsd: round(p1Requests * medianUnitCost * UNIT_COST_MULTIPLE, 2),
  errors: 11,
  cacheHitRate: 0.04,
};

// DECOY A — 67% error rate on 3 requests. Alarming ratio, no sample behind it.
const caller19 = { caller: 'caller-19', requests: 3, spendUsd: 0.42, errors: 2, cacheHitRate: 0.0 };
// DECOY B — one expensive request. n=1.
const caller22 = { caller: 'caller-22', requests: 1, spendUsd: 3.10, errors: 0, cacheHitRate: 0.0 };

const nonWhaleSpend =
  ordinary.reduce((a, c) => a + c.spendUsd, 0) +
  caller07.spendUsd + caller19.spendUsd + caller22.spendUsd;

// PLANT 2 — spend concentration. Volume, not price: caller-01's cost per
// request sits at the median, so the concentration is real without also
// making it a unit-cost outlier. Two findings, cleanly separated.
const p2Spend = round((SPEND_SHARE * nonWhaleSpend) / (1 - SPEND_SHARE), 2);
const caller01 = {
  caller: 'caller-01',
  requests: Math.round(p2Spend / medianUnitCost),
  spendUsd: p2Spend,
  errors: 0, // filled below
  cacheHitRate: 0.87,
};
caller01.errors = Math.round(caller01.requests * 0.009);

const callers = [caller01, ...ordinary, caller07, caller19, caller22].sort((a, b) =>
  a.caller.localeCompare(b.caller)
);

// --- models ----------------------------------------------------------------

const totalRequests = callers.reduce((a, c) => a + c.requests, 0);
const totalSpend = round(callers.reduce((a, c) => a + c.spendUsd, 0), 2);
const totalErrors = callers.reduce((a, c) => a + c.errors, 0);

const byModel = [];
const shares = [0.42, 0.27, 0.18, 0.12];
const names = ['model-alpha', 'model-beta', 'model-gamma', 'model-delta'];
for (let i = 0; i < names.length; i++) {
  byModel.push({
    model: names[i],
    requests: Math.round((totalRequests - 40) * shares[i]),
    spendUsd: round(totalSpend * shares[i], 2),
    errors: Math.round((totalErrors - 40) * shares[i]),
    p95LatencyMs: int(900, 2600),
  });
}
// PLANT 3 — model-epsilon fails every request. Low volume, total failure, so it
// barely moves the aggregate error rate. Findable only by grouping on model.
byModel.push({ model: 'model-epsilon', requests: 40, spendUsd: 0.0, errors: 40, p95LatencyMs: 240 });

// --- hours -----------------------------------------------------------------

const modelErrors = byModel.reduce((a, m) => a + m.errors, 0);
const spikeErrors = Math.round(modelErrors * ERROR_HOUR_SHARE);
const restErrors = Math.max(0, modelErrors - spikeErrors - 2);

const byHour = [];
for (let h = 0; h < 24; h++) {
  if (h === 14) {
    // PLANT 4 — errors concentrate in one hour, on ordinary request volume.
    byHour.push({ hour: 14, requests: Math.round(totalRequests * 0.045), errors: spikeErrors });
  } else if (h === 3) {
    // DECOY C — 100% error rate on 2 requests.
    byHour.push({ hour: 3, requests: 2, errors: 2 });
  } else {
    byHour.push({
      hour: h,
      requests: Math.round((totalRequests * 0.955) / 22),
      errors: Math.round(restErrors / 22),
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      _note:
        'Synthetic. Generated by fixture/generate.mjs with a fixed seed. Contains ' +
        'deliberately planted findings and deliberately planted decoys. Not derived ' +
        'from any real system, organisation, or customer. See golden/findings.json.',
      window: { from: '2026-07-15', to: '2026-07-22' },
      totals: {
        requests: totalRequests,
        spendUsd: totalSpend,
        errors: totalErrors,
        callers: callers.length,
      },
      byCaller: callers,
      byModel,
      byHour,
    },
    null,
    2
  )}\n`
);

// Scoring shared by run-eval.mjs and run-experiments.mjs.

export const squash = (s) => (s ?? "").replace(/[\s.,!?~·'"「」()\-]/g, "");
export function cer(ref, hyp) {
  const a = [...squash(ref)], b = [...squash(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return a.length ? prev[b.length] / a.length : 0;
}

/** Scores predicted items against gold items; each gold item is matched to its best unused prediction. */
/** `withDetails`: also look for title keywords in `details` (documents put names, places there). */
export function score(gold, predicted, { withDetails = false } = {}) {
  const label = (p) => (withDetails ? `${p.title} ${p.details ?? ""}` : p.title);
  const used = new Set();
  const rows = gold.map((g) => {
    let best = -1, bestHits = 0;
    predicted.forEach((p, i) => {
      if (used.has(i)) return;
      const hits = g.titleKeywords.filter((k) => squash(label(p)).includes(squash(k))).length;
      if (hits > bestHits) { best = i; bestHits = hits; }
    });
    if (best < 0) return { kind: false, area: false, title: false, startAt: false, flagged: true };
    used.add(best);
    const p = predicted[best];
    return {
      kind: p.kind === g.kind,
      area: p.area === g.area,
      title: bestHits === g.titleKeywords.length,
      startAt: (p.startAt ?? "") === g.startAt,
      flagged: Boolean(p.needsReview),
    };
  });
  return { rows, countOk: predicted.length === gold.length };
}

export function maxRss(stderr) {
  const m = /(\d+)\s+maximum resident set size/.exec(stderr ?? "");
  return m ? Number(m[1]) : 0;
}

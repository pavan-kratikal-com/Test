// Tiny logistic-regression trainer used by the per-org model pipeline.
// Inputs:  matrix X (n_samples × n_features), labels y (0/1), L2 lambda
// Output:  weights w (n_features), intercept b
//
// Not a replacement for the real SLM — per PRD §7.2 the real model is a
// 1.9M-param transformer. This Node-side classifier operates on the
// engine signal vector (~50 boolean features) and gives each org a
// cheap, fast, per-tenant classifier that runs as a second opinion.
//
// Gradient descent with L2 regularization.  Deterministic (no RNG).
export function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

export function predictProba(weights, intercept, features) {
  let z = intercept;
  for (let i = 0; i < features.length; i++) z += weights[i] * features[i];
  return sigmoid(z);
}

export function trainLogistic(X, y, {
  epochs = 200, lr = 0.1, l2 = 0.01,
} = {}) {
  const n = X.length;
  if (n === 0) throw new Error("empty training set");
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = predictProba(w, b, X[i]);
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { weights: w, intercept: b };
}

export function evaluate(weights, intercept, X, y, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predictProba(weights, intercept, X[i]);
    const pred = p >= threshold ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else fn++;
  }
  const total = tp + fp + tn + fn;
  return {
    accuracy: total === 0 ? 0 : (tp + tn) / total,
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    fp_rate: fp + tn === 0 ? 0 : fp / (fp + tn),
    tp, fp, tn, fn,
  };
}

// Deterministic shuffle for train/val split (seeded LCG).
export function shuffle(array, seed = 42) {
  const out = array.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Given an array of {features, label} objects, produce an 80/20 split.
export function trainValSplit(samples, seed = 42) {
  const shuffled = shuffle(samples, seed);
  const split = Math.max(1, Math.floor(shuffled.length * 0.8));
  return { train: shuffled.slice(0, split), val: shuffled.slice(split) };
}

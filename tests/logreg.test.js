import test from "node:test";
import assert from "node:assert/strict";
import {
  sigmoid, predictProba, trainLogistic, evaluate, shuffle, trainValSplit,
} from "../shared/logreg.js";

test("sigmoid: basic bounds and monotonicity", () => {
  assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9);
  assert.ok(sigmoid(10) > 0.99);
  assert.ok(sigmoid(-10) < 0.01);
  assert.ok(sigmoid(1) > sigmoid(0));
});

test("predictProba: matches manual computation", () => {
  const w = [1, -1];
  const b = 0;
  const p = predictProba(w, b, [1, 0]);
  assert.ok(Math.abs(p - sigmoid(1)) < 1e-9);
});

test("trainLogistic: learns AND-ish pattern over 4 samples", () => {
  const X = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const y = [0, 0, 0, 1];
  const model = trainLogistic(X, y, { epochs: 500, lr: 0.5, l2: 0.0 });
  // Classifier should score [1,1] higher than any other point.
  const s00 = predictProba(model.weights, model.intercept, [0, 0]);
  const s11 = predictProba(model.weights, model.intercept, [1, 1]);
  assert.ok(s11 > s00);
  assert.ok(s11 > 0.5);
});

test("trainLogistic: converges on linearly separable 2D data", () => {
  const X = [], y = [];
  for (let i = 0; i < 30; i++) { X.push([i / 10, i / 10]); y.push(i >= 15 ? 1 : 0); }
  const model = trainLogistic(X, y, { epochs: 800, lr: 0.3, l2: 0.001 });
  const metrics = evaluate(model.weights, model.intercept, X, y);
  assert.ok(metrics.accuracy > 0.9);
});

test("evaluate: returns tp/fp/tn/fn + derived rates", () => {
  const m = evaluate([1], 0, [[1], [1], [-1], [-1]], [1, 0, 0, 1]);
  assert.equal(m.tp + m.fp + m.tn + m.fn, 4);
});

test("shuffle: deterministic with the same seed", () => {
  const a = shuffle([1, 2, 3, 4, 5], 7);
  const b = shuffle([1, 2, 3, 4, 5], 7);
  assert.deepEqual(a, b);
});

test("trainValSplit: 80/20 partition preserving both classes", () => {
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ features: [i], label: i % 2 });
  const { train, val } = trainValSplit(samples);
  assert.equal(train.length + val.length, 20);
  assert.ok(train.length >= 15);
  assert.ok(val.length >= 2);
});

import { checkFinish, ecsScore, rankValue, scoreFromRankValue, isEmail, MAX_COINS, MIN_SECONDS } from "../src/ecs.js";

const START = Date.UTC(2026, 10, 16, 9, 0, 0);
const after = (s: number) => START + s * 1000;

test("score matches the game: 100 per coin plus 20 per second under 3 minutes", () => {
  expect(ecsScore(7, 54)).toBe(7 * 100 + (180 - 54) * 20);
  expect(ecsScore(0, 200)).toBe(0);
});

test("an honest run is accepted, even with a paused tab (game clock behind real time)", () => {
  expect(checkFinish(START, after(60), 12, 58)).toEqual({ ok: true, score: ecsScore(12, 58) });
  expect(checkFinish(START, after(300), 12, 95)).toEqual({ ok: true, score: ecsScore(12, 95) });
});

test("a little latency between the game starting and the server hearing about it is fine", () => {
  expect(checkFinish(START, after(58), 5, 60).ok).toBe(true);
});

test("claiming more play time than really passed is rejected", () => {
  // the zero-seconds-from-a-terminal attack: start, then finish right away
  expect(checkFinish(START, after(1), MAX_COINS, MIN_SECONDS).ok).toBe(false);
  expect(checkFinish(START, after(50), 5, 60).ok).toBe(false);
});

test("impossible coin counts and times are rejected", () => {
  expect(checkFinish(START, after(600), MAX_COINS + 1, 100).ok).toBe(false);
  expect(checkFinish(START, after(600), -1, 100).ok).toBe(false);
  expect(checkFinish(START, after(600), 3.5, 100).ok).toBe(false);
  expect(checkFinish(START, after(600), "7", 100).ok).toBe(false);
  expect(checkFinish(START, after(600), 7, MIN_SECONDS - 1).ok).toBe(false);
  expect(checkFinish(START, after(600), 7, 60.5).ok).toBe(false);
});

test("rank value round-trips the score, and the earlier run wins a tie", () => {
  for (const score of [0, 1, 700, ecsScore(MAX_COINS, MIN_SECONDS)]) {
    expect(scoreFromRankValue(rankValue(score, START))).toBe(score);
    expect(scoreFromRankValue(rankValue(score, Date.UTC(2026, 10, 1)))).toBe(score);
  }
  expect(rankValue(900, START)).toBeGreaterThan(rankValue(900, after(120)));
  expect(rankValue(901, after(3600 * 24 * 30))).toBeGreaterThan(rankValue(900, START));
});

test("email check", () => {
  expect(isEmail("dev@example.com")).toBe(true);
  expect(isEmail("nope")).toBe(false);
});

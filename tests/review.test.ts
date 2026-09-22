import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReview, synthesizeReviews, workerDirection } from "../src/review.ts";

test("free-form corrective feedback is never treated as completion", () => {
  const review = normalizeReview("Stop the parent cluster list from reshuffling on exclude/include. Clusters are sorted descending by raw topic count, so excluding items re-sorts the list mid-task and you lose your place. Fix: lock the initial order, or sort by the original count instead of the live count.");
  assert.equal(review.status, "continue");
  assert.equal(review.malformed, true);
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0]?.blocking, true);
  assert.match(review.findings[0]?.remediation ?? "", /lock the initial order/i);
});

test("legacy needs_user_decision normalizes to needs_decision", () => {
  const review = normalizeReview("<status>needs_user_decision</status><rationale>Choose a storage strategy.</rationale>");
  assert.equal(review.status, "needs_decision");
});

test("explicit complete with a blocking finding is downgraded", () => {
  const review = normalizeReview("<status>complete</status><finding><severity>major</severity><blocking>true</blocking><summary>Ordering still changes</summary><evidence>list.ts:4</evidence></finding>");
  assert.equal(review.status, "continue");
});

test("worst status wins across reviewers", () => {
  const complete = normalizeReview("<status>complete</status><risk>low</risk><rationale>Clean.</rationale>");
  const decision = normalizeReview("<status>needs_decision</status><risk>high</risk><rationale>Choose behavior.</rationale>");
  const synthesis = synthesizeReviews([complete, decision]);
  assert.equal(synthesis.status, "needs_decision");
  assert.equal(synthesis.risk, "high");
});

test("structured dynamic-workflows findings are preserved", () => {
  const review = normalizeReview(`<status>continue</status>
<risk>high</risk>
<rationale>Ordering remains unstable.</rationale>
<structured-json>{"status":"continue","risk":"high","rationale":"Ordering remains unstable.","findings":[{"severity":"major","blocking":true,"summary":"Parent list reshuffles","evidence":"Live count drives sort","remediation":"Use immutable original ordering","affectedPaths":["src/clusters.ts"]}]}</structured-json>`);
  assert.equal(review.status, "continue");
  assert.equal(review.findings[0]?.summary, "Parent list reshuffles");
  assert.deepEqual(review.findings[0]?.affectedPaths, ["src/clusters.ts"]);
});

test("structured completion with empty findings is not overturned by prose heuristics", () => {
  const review = normalizeReview(`<status>complete</status>
<risk>low</risk>
<rationale>Unknown modifier warnings are reported but don't crash.</rationale>
<structured-json>{"status":"complete","risk":"low","rationale":"Unknown modifier warnings are reported but don't crash.","findings":[]}</structured-json>`);
  assert.equal(review.status, "complete");
  assert.equal(review.malformed, false);
  assert.deepEqual(review.findings, []);
});

test("unstructured contradictory completion remains downgraded", () => {
  const review = normalizeReview("<status>complete</status><rationale>Looks good, but an issue remains.</rationale>");
  assert.equal(review.status, "continue");
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0]?.blocking, true);
});

test("workerDirection turns a worker continue into direction, never a finding", () => {
  const withMissing = normalizeReview("<status>continue</status><rationale>Half done.</rationale><missingItems>Add tests\nWire export</missingItems>");
  assert.match(workerDirection(withMissing), /Complete the items you reported as missing:/);
  assert.match(workerDirection(withMissing), /Add tests/);
  assert.match(workerDirection(withMissing), /Wire export/);
  const withFollowup = normalizeReview("<status>continue</status><rationale>Half done.</rationale><recommendedFollowupPrompt>Finish the export.</recommendedFollowupPrompt>");
  assert.equal(workerDirection(withFollowup), "Finish the export.");
  const bare = normalizeReview("<status>continue</status><rationale>Half done.</rationale>");
  assert.equal(workerDirection(bare), "Address every open blocking finding, then rerun validation and review.");
});

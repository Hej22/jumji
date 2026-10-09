import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../planner-engine.js', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source, context);
const { compareCandidates, allocateCandidates } = context.JumjiPlannerEngine;

const candidates = [
  { id: 'no-date-low', deadline: null, importance: 1, estimatedMinutes: 20 },
  { id: 'future-late', deadline: '2026-10-20', importance: 5, estimatedMinutes: 20 },
  { id: 'overdue-old', deadline: '2026-10-01', importance: 1, estimatedMinutes: 20 },
  { id: 'same-priority-short', deadline: '2026-10-10', importance: 3, estimatedMinutes: 15 },
  { id: 'same-priority-unfinished', deadline: '2026-10-10', importance: 3, estimatedMinutes: 45, hasUnfinishedHistory: true },
  { id: 'same-date-high-importance', deadline: '2026-10-10', importance: 5, estimatedMinutes: 90 },
  { id: 'overdue-new', deadline: '2026-10-08', importance: 5, estimatedMinutes: 20 },
  { id: 'no-date-high', deadline: null, importance: 5, estimatedMinutes: 90 },
  { id: 'no-date-unfinished', deadline: null, importance: 5, estimatedMinutes: 30, hasUnfinishedHistory: true }
];

const ranked = [...candidates].sort((left, right) => compareCandidates(left, right, '2026-10-09'));
assert.deepEqual(ranked.map(candidate => candidate.id), [
  'overdue-old', 'overdue-new', 'same-date-high-importance', 'same-priority-unfinished', 'same-priority-short',
  'future-late', 'no-date-unfinished', 'no-date-high', 'no-date-low'
]);
assert.ok(compareCandidates({ id: 'z-legacy-invalid-date', deadline: 20261001 }, { id: 'a-no-date', deadline: null }, '2026-10-09') > 0);

const original = JSON.stringify(candidates);
const allocation = allocateCandidates([
  { id: 'long-stage', estimatedMinutes: 500 },
  { id: 'next-task', estimatedMinutes: 50 }
], 450, { reservedMinutes: 30, utilization: 0.8, planDate: '2026-10-09' });
assert.equal(allocation.allocationLimit, 330);
assert.equal(allocation.allocations[0].plannedMinutes, 330);
assert.deepEqual(allocation.unallocated.map(item => [item.id, item.unallocatedMinutes]), [['long-stage', 170], ['next-task', 50]]);
assert.equal(allocation.allocations.reduce((sum, item) => sum + item.plannedMinutes, 0), 330);
assert.equal(JSON.stringify(candidates), original);

const noCapacity = allocateCandidates([{ id: 'blocked', estimatedMinutes: 60 }], 0, { planDate: '2026-10-11' });
assert.equal(noCapacity.allocations.length, 0);
assert.equal(noCapacity.unallocated[0].unallocatedMinutes, 60);

const sharedStage = allocateCandidates([
  { id: 'repeat-a', estimatedMinutes: 45, remainingMinutes: 45, allocationGroup: 'p:s', groupRemainingMinutes: 60, deadline: null, importance: 4 },
  { id: 'project-stage', estimatedMinutes: 60, remainingMinutes: 60, allocationGroup: 'p:s', groupRemainingMinutes: 60, deadline: null, importance: 3 }
], 180, { utilization: 1, planDate: '2026-10-09' });
assert.equal(sharedStage.allocations.reduce((sum, item) => sum + item.plannedMinutes, 0), 60);
assert.equal(sharedStage.allocations[0].id, 'repeat-a');
assert.equal(sharedStage.allocations[0].plannedMinutes, 45);
assert.equal(sharedStage.allocations[1].plannedMinutes, 15);

const fragmentedDay = allocateCandidates([
  { id: 'long-block', estimatedMinutes: 70 },
  { id: 'short-block', estimatedMinutes: 40 }
], 90, { utilization: 1, slots: [40, 50], planDate: '2026-10-09' });
assert.equal(fragmentedDay.allocations[0].plannedMinutes, 50);
assert.equal(fragmentedDay.allocations[1].plannedMinutes, 40);
assert.ok(fragmentedDay.allocations.every(item => item.plannedMinutes <= 50));

console.log('Planner engine tests passed: priority ordering, daily capacity, unallocated work, and immutable inputs');
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.JumjiPlannerEngine = api;
})(globalThis, function () {
  function deadlineGroup(candidate, planDate) {
    if (typeof candidate.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.deadline)) return 2;
    return candidate.deadline < planDate ? 0 : 1;
  }

  function compareCandidates(left, right, planDate) {
    const leftGroup = deadlineGroup(left, planDate);
    const rightGroup = deadlineGroup(right, planDate);
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;

    if (leftGroup < 2 && left.deadline !== right.deadline) return left.deadline.localeCompare(right.deadline);

    const importanceDifference = (Number(right.importance) || 3) - (Number(left.importance) || 3);
    if (importanceDifference) return importanceDifference;
    if (Boolean(left.hasUnfinishedHistory) !== Boolean(right.hasUnfinishedHistory)) {
      return left.hasUnfinishedHistory ? -1 : 1;
    }
    return (Number(left.estimatedMinutes) || 0) - (Number(right.estimatedMinutes) || 0)
      || String(left.id).localeCompare(String(right.id));
  }

  function allocateCandidates(candidates, availableMinutes, { reservedMinutes = 0, utilization = 1, planDate, slots = [] } = {}) {
    const available = Math.max(0, Math.floor(Number(availableMinutes) || 0));
    const reserved = Math.max(0, Math.floor(Number(reservedMinutes) || 0));
    const allocationLimit = Math.max(0, Math.min(available, Math.floor(available * Math.max(0, Math.min(1, utilization))) - reserved));
    const ranked = [...candidates].sort((left, right) => compareCandidates(left, right, planDate));
    let remaining = allocationLimit;
    const allocations = [];
    const unallocated = [];
    const remainingByGroup = new Map();
    const slotTotal = slots.reduce((sum, minutes) => sum + Math.max(0, Number(minutes) || 0), 0);
    const scaledSlots = slotTotal
      ? slots.map(minutes => Math.floor(Math.max(0, Number(minutes) || 0) * allocationLimit / slotTotal)).filter(minutes => minutes > 0)
      : (allocationLimit > 0 ? [allocationLimit] : []);

    ranked.forEach(candidate => {
      const requested = Math.max(0, Math.floor(Number(candidate.remainingMinutes ?? candidate.estimatedMinutes) || 0));
      let groupRemaining = Infinity;
      if (candidate.allocationGroup) {
        if (!remainingByGroup.has(candidate.allocationGroup)) {
          remainingByGroup.set(candidate.allocationGroup, Math.max(0, Math.floor(Number(candidate.groupRemainingMinutes) || 0)));
        }
        groupRemaining = remainingByGroup.get(candidate.allocationGroup);
      }
      const slotIndex = scaledSlots.indexOf(Math.max(...scaledSlots));
      const slotRemaining = scaledSlots[slotIndex] || 0;
      const minutes = Math.min(requested, remaining, groupRemaining, slotRemaining);
      if (minutes > 0) {
        allocations.push({ ...candidate, plannedMinutes: minutes });
        remaining -= minutes;
        scaledSlots[slotIndex] -= minutes;
        if (!scaledSlots[slotIndex]) scaledSlots.splice(slotIndex, 1);
        if (candidate.allocationGroup) remainingByGroup.set(candidate.allocationGroup, groupRemaining - minutes);
      }
      if (requested > minutes) unallocated.push({ ...candidate, unallocatedMinutes: requested - minutes });
    });

    return { allocations, unallocated, available, reserved, allocationLimit, remaining };
  }

  return { compareCandidates, allocateCandidates };
});
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

  function createPlanChangeReplacement(current, project, stage, { stageRemaining, availableMinutes, otherPlannedMinutes, progress }) {
    const estimatedMinutes = Number(stage?.estimatedMinutes) || 60;
    const currentAssignment = Math.max(0, Number(current.plannedMinutes ?? current.minutes) || 0) || 30;
    const dailyLimit = Math.max(0, Math.floor(Math.max(0, Number(availableMinutes) || 0) * 0.8) - Math.max(0, Number(otherPlannedMinutes) || 0));
    const remainingStageMinutes = Number.isFinite(stageRemaining) ? Math.max(0, stageRemaining) : estimatedMinutes;
    const plannedMinutes = Math.floor(Math.min(currentAssignment, dailyLimit, remainingStageMinutes));
    if (!plannedMinutes) return null;
    return {
      ...current,
      projectId: project.id,
      stageId: stage.id,
      name: `${project.name} · ${stage.name}`,
      minutes: estimatedMinutes,
      estimatedMinutes,
      plannedMinutes,
      actualMinutes: 0,
      progress,
      dailyProgress: 0,
      stageProgressApplied: 0,
      progressMode: 'manual',
      done: false
    };
  }

  function formatAssignedPercent(assignedMinutes, estimatedMinutes) {
    const assigned = Math.floor(Number(assignedMinutes) || 0);
    const estimated = Math.floor(Number(estimatedMinutes) || 0);
    if (assigned <= 0 || estimated <= 0) return null;
    return Math.min(100, Math.floor(assigned / estimated * 100));
  }

  function formatPlanTaskTitle(projectName, stageName, assignedMinutes, estimatedMinutes, fallbackName) {
    if (!projectName || !stageName) return fallbackName || stageName || projectName || '작업';
    const percent = formatAssignedPercent(assignedMinutes, estimatedMinutes);
    if (percent === null || percent >= 100) return `${projectName} - ${stageName}`;
    return `${projectName} - ${stageName} - 오늘 ${percent}% 하기`;
  }

  return { compareCandidates, allocateCandidates, createPlanChangeReplacement, formatAssignedPercent, formatPlanTaskTitle };
});
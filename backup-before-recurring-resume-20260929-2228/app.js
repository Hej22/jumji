const KEY = 'jumji_v03';
const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '17:00';
const DEFAULT_LUNCH_MINUTES = 60;
const DEFAULT_FIKA_MINUTES = 60;
const DEFAULT_PLAN_UTILIZATION = 0.8;
const DEFAULT_PREPARATION_MINUTES = 30;
const EVENING_START = '20:00';
const EVENING_END = '22:00';
const todayKey = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
function createDemoData() {
  return {
    projects: [
      { id: 1, name: '뾰치 달력', stage: '러프', progress: 35, deadline: '2026-10-31', risk: 'green' },
      { id: 2, name: '이모티콘', stage: '콘셉트', progress: 20, deadline: '', risk: 'green' },
      { id: 3, name: '중세토끼 인스타툰', stage: '세계관', progress: 10, deadline: '', risk: 'green' }
    ],
    events: [{ id: 1, date: todayKey(), time: '14:20', end: '16:00', name: '발레', source: 'external', url: '' }],
    plan: [
      { id: 101, projectId: 1, name: '뾰치 달력 · 러프', minutes: 90, estimatedMinutes: 90, actualMinutes: 0, progress: 0, done: false },
      { id: 102, projectId: 2, name: '이모티콘 · 콘셉트', minutes: 60, estimatedMinutes: 60, actualMinutes: 0, progress: 0, done: false }
    ],
    captures: [], planAccepted: false, deferReasons: {}
  };
}
function createEmptyData() {
  return { projects: [], events: [], plan: [], captures: [], planAccepted: false, deferReasons: {}, dailyReviews: {}, recurringTasks: [] };
}
const loaded = JSON.parse(localStorage.getItem(KEY) || 'null');
let d = loaded || createEmptyData();
let pendingPlan = null;
let pendingPlanMeta = null;
let pendingProjects = [];
let proposalDraft = null;
let proposalMeta = null;
let planChangeDraft = null;
let planChangeHadPreview = false;
let toastTimer = null;
let selectedReviewDate = todayKey();
let editingReview = false;
let reviewStep = 'summary';
let projectSortMode = 'manual';
const recurringHistoryLimits = new Map();
const RECURRING_HISTORY_INITIAL = 3;
const RECURRING_HISTORY_PAGE_SIZE = 7;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[match]));
const dateLabel = value => value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '마감 없음';
function clampProgress(value) { return Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100) / 100)); }

function migrate() {
  let assignedLegacyDates = false;
  d.projects = (d.projects || []).map(project => {
    const stages = Array.isArray(project.stages) ? project.stages : [{
      id: `${project.id}-legacy`, name: project.stage || '시작 전', progress: Number(project.progress) || 0,
      estimatedMinutes: 0, actualMinutes: 0
    }];
    const normalizedStages = stages.map(stage => ({ ...stage, progress: clampProgress(stage.progress), estimatedMinutes: Math.max(0, Math.round(Number(stage.estimatedMinutes) || 0)), actualMinutes: Math.max(0, Math.round(Number(stage.actualMinutes) || 0)), progressMode: stage.progressMode || 'auto' }));
    const progress = Number(project.progress) || 0;
    return { ...project, description: project.description || '', importance: Number(project.importance) || 3, deadline: project.deadline || null, status: project.status || '진행 중', stages: normalizedStages, progress, stage: project.stage || normalizedStages[0]?.name || '시작 전' };
  });
  d.events = (d.events || []).map(event => ({ ...event, preparationMinutes: [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES }));
  d.plan = (d.plan || []).map(item => {
    const hadDailyProgress = item.dailyProgress !== undefined && item.dailyProgress !== null && Number.isFinite(Number(item.dailyProgress));
    const dailyProgress = item.done ? 100 : Math.max(0, Math.min(100, Math.round(Number(item.dailyProgress) || 0)));
    const date = item.date || todayKey();
    const stage = d.projects.find(project => project.id == item.projectId)?.stages.find(candidate => candidate.id == item.stageId);
    const estimate = Number(stage?.estimatedMinutes) || 0;
    const stageProgressApplied = Number.isFinite(Number(item.stageProgressApplied))
      ? clampProgress(item.stageProgressApplied)
      : hadDailyProgress && estimate > 0 ? clampProgress(Math.min(100, plannedMinutes(item) / estimate * dailyProgress)) : 0;
    if (!item.date) assignedLegacyDates = true;
    return { ...item, estimatedMinutes: Number(item.estimatedMinutes ?? item.minutes) || 0, actualMinutes: Number(item.actualMinutes) || 0, minutes: Number(item.minutes ?? item.estimatedMinutes) || 0, dailyProgress, stageProgressApplied, progressMode: item.progressMode || 'auto', done: Boolean(item.done || dailyProgress === 100), date };
  });
  d.plan.forEach(syncPlanActualToProject);
  d.captures = (d.captures || []).map((capture, index) => ({ ...capture, id: capture.id || `capture-${index}`, text: capture.text ?? capture.content ?? '', at: capture.at || capture.createdAt || new Date().toISOString() }));
  d.planAccepted = Boolean(d.planAccepted); d.deferReasons = d.deferReasons || {}; d.dailyReviews = d.dailyReviews || {}; d.recurringTasks = Array.isArray(d.recurringTasks) ? d.recurringTasks : [];
  d.projects.forEach(syncProjectProgress);
  if (assignedLegacyDates && loaded) {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const original = JSON.parse(raw);
      if (original && typeof original === 'object' && !Array.isArray(original) && Array.isArray(original.plan)) {
        let changed = false;
        const plan = original.plan.map((item, index) => {
          if (!item.date && d.plan[index]) { changed = true; return { ...item, date: d.plan[index].date }; }
          return item;
        });
        if (changed) {
          original.plan = plan;
          localStorage.setItem(KEY, JSON.stringify(original));
        }
      }
    }
  }
}
function save() { localStorage.setItem(KEY, JSON.stringify(d)); }
function persistWorkHours(start, end) {
  const rawData = localStorage.getItem(KEY);
  const storedData = rawData === null ? { ...d } : JSON.parse(rawData);
  if (!storedData || typeof storedData !== 'object' || Array.isArray(storedData)) throw new Error('저장된 점지 데이터 형식이 올바르지 않습니다.');
  storedData.workStart = start;
  storedData.workEnd = end;
  localStorage.setItem(KEY, JSON.stringify(storedData));
  d.workStart = start;
  d.workEnd = end;
}
function renderSettings() {
  $('workStartSetting').value = workStartTime();
  $('workEndSetting').value = workEndTime();
}
async function exportDataBackup() {
  let rawData;
  try {
    rawData = localStorage.getItem(KEY);
  } catch (error) {
    console.error('점지 데이터 백업을 위해 저장 데이터에 접근하지 못했어.', error);
    toast('저장 데이터에 접근할 수 없어 백업하지 못했어.');
    return;
  }
  if (rawData === null) {
    toast('저장된 데이터가 없어 백업할 수 없어.');
    return;
  }
  try {
    JSON.parse(rawData);
  } catch (error) {
    console.error('점지 저장 데이터가 올바른 JSON이 아니야.', error);
    toast('저장 데이터 형식이 올바르지 않아. 원본은 변경하지 않았어.');
    return;
  }

  const filename = `jumji_v03-backup-${todayKey()}.json`;
  const blob = new Blob([rawData], { type: 'application/json' });
  const file = typeof File === 'function' ? new File([blob], filename, { type: 'application/json' }) : null;
  if (file && navigator.share) {
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: '점지 데이터 백업' });
        toast('공유 메뉴에서 파일 앱에 백업을 저장해줘.');
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        toast('백업 공유를 취소했어.');
        return;
      }
      console.error('공유 메뉴 지원 확인 또는 파일 전달에 실패했어. 다운로드로 대체할게.', error);
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('JSON 백업 파일 다운로드를 시작했어.');
  } catch (error) {
    console.error('점지 JSON 백업 파일을 다운로드하지 못했어.', error);
    toast('백업 파일을 만들지 못했어. 다시 시도해줘.');
  }
}
function reviewTasksFor(date = todayKey()) {
  const review = d.dailyReviews[date];
  if (review && Array.isArray(review.tasks)) return review.tasks;
  return date === todayKey() ? activePlan() : [];
}
function taskProjectLabel(item) {
  if (item.projectNameAtReview) return `${item.projectNameAtReview}${item.stageNameAtReview ? ` · ${item.stageNameAtReview}` : ''}`;
  const project = allProjects().find(candidate => candidate.id == item.projectId);
  return project ? `${project.name}${item.stageId ? ` · ${project.stages.find(stage => stage.id == item.stageId)?.name || ''}` : ''}` : '프로젝트 없음';
}
function totalActual(tasks) { return tasks.reduce((sum, item) => sum + (Number(item.actualMinutes) || 0), 0); }
function createProjectRecord(name, description = '', importance = 3, deadline = null, stageName = '시작 전', estimatedMinutes = 0) {
  const id = Date.now();
  return {
    id, name, description, importance, deadline, status: '진행 중',
    stages: [{ id: `stage-${id}`, name: stageName, progress: 0, progressMode: 'auto', estimatedMinutes, actualMinutes: 0 }],
    stage: stageName, progress: 0
  };
}
function snapshotPlanTask(item, date = todayKey()) {
  const project = d.projects.find(candidate => candidate.id == item.projectId);
  const stage = project?.stages.find(candidate => candidate.id == item.stageId);
  return { ...item, dailyProgress: taskDailyProgress(item), date, projectNameAtReview: project?.name || null, stageNameAtReview: stage?.name || null, stageProgressAtReview: stage ? stageProgress(stage) : null };
}
function reviewSnapshot() {
  return {
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    tasks: activePlan().filter(item => !item.planExcluded || item.done || Number(item.actualMinutes) > 0).map(item => snapshotPlanTask(item)),
    events: todayEvents().map(event => ({ ...event })),
    deferReasons: { ...d.deferReasons },
    note: d.dailyReviews[todayKey()]?.note || ''
  };
}
function isReviewConfirmed(date = todayKey()) { return Boolean(d.dailyReviews[date]?.confirmed); }
function calculatedProgress(fallbackProgress, done = false) {
  if (done) return 100;
  return clampProgress(fallbackProgress);
}
function stageProgress(stage) {
  return calculatedProgress(stage.progress);
}
function projectProgress(project) {
  const weighted = project.stages.reduce((result, stage) => {
    const estimate = Number(stage.estimatedMinutes) || 0;
    if (estimate > 0) return { weight: result.weight + estimate, value: result.value + estimate * stageProgress(stage) };
    return { weight: result.weight + 1, value: result.value + stageProgress(stage) };
  }, { weight: 0, value: 0 });
  return weighted.weight ? Math.round(weighted.value / weighted.weight) : Math.max(0, Math.min(100, Math.round(project.progress || 0)));
}
function syncProjectProgress(project) {
  project.progress = projectProgress(project);
  project.stage = project.stages.find(stage => stageProgress(stage) < 100)?.name || project.stages[project.stages.length - 1]?.name || '시작 전';
}
function renderProjectList() {
  const active = d.projects.map((project, index) => ({ project, index })).filter(({ project }) => project.status !== '완료');
  const completed = d.projects.map((project, index) => ({ project, index })).filter(({ project }) => project.status === '완료');
  const sortedActive = [...active].sort((a, b) => {
    if (projectSortMode === 'importance') return (Number(b.project.importance) || 3) - (Number(a.project.importance) || 3) || a.index - b.index;
    if (projectSortMode === 'deadline') return (a.project.deadline || '9999-12-31').localeCompare(b.project.deadline || '9999-12-31') || a.index - b.index;
    return a.index - b.index;
  });
  const renderCard = ({ project, index }, sortable) => {
    const risk = riskFor(project);
    const activePosition = active.findIndex(entry => entry.index === index);
    const moveActions = sortable && projectSortMode === 'manual' ? `<div class="project-order-actions"><button class="secondary small-button" data-project-move="up" data-id="${esc(project.id)}" aria-label="${esc(project.name)} 위로 이동" ${activePosition <= 0 ? 'disabled' : ''}>↑</button><button class="secondary small-button" data-project-move="down" data-id="${esc(project.id)}" aria-label="${esc(project.name)} 아래로 이동" ${activePosition === active.length - 1 ? 'disabled' : ''}>↓</button></div>` : '';
    return `<article class="project project-card"><button class="projectbtn" data-project-id="${esc(project.id)}"><div class="projecttop"><div><b>${esc(project.name)}</b><div class="detail">${esc(project.stage)} · ${project.progress}% · 중요도 ${project.importance}/5</div></div><span class="risk ${risk === 'yellow' ? 'yellow' : risk === 'red' ? 'red' : ''}">${risk === 'red' ? '위험' : risk === 'yellow' ? '확인' : '여유'}</span></div><div class="bar"><i style="width:${project.progress}%"></i></div><div class="detail">${dateLabel(project.deadline)} · ${esc(project.status)}</div></button>${moveActions}</article>`;
  };
  $('projectList').innerHTML = `<label class="project-sort-label" for="projectSort">정렬</label><select class="input project-sort" id="projectSort"><option value="manual" ${projectSortMode === 'manual' ? 'selected' : ''}>직접 정렬</option><option value="importance" ${projectSortMode === 'importance' ? 'selected' : ''}>중요도순</option><option value="deadline" ${projectSortMode === 'deadline' ? 'selected' : ''}>마감기한순</option></select>${sortedActive.map(entry => renderCard(entry, true)).join('') || '<div class="event">진행 중인 프로젝트가 없어.</div>'}<details class="completed-projects"><summary>완료된 프로젝트 (${completed.length})</summary>${completed.map(entry => renderCard(entry, false)).join('') || '<div class="event">완료된 프로젝트가 없어.</div>'}</details>`;
  renderRecurringTasks();
}
function syncPlanActualToProject(item) {
  const project = [...d.projects, ...pendingProjects].find(candidate => candidate.id == item.projectId);
  if (!project) return;
  const stage = project.stages.find(candidate => candidate.id == item.stageId);
  if (!stage) return;
  if (item.isExtra && item.projectActualApplied) {
    stage.actualMinutes = Math.max(0, Number(stage.actualMinutes) || 0);
  } else {
    stage.actualMinutes = Math.max(Number(stage.actualMinutes) || 0, Number(item.actualMinutes) || 0);
  }
}
function syncPlanToProject(item) {
  const project = [...d.projects, ...pendingProjects].find(candidate => candidate.id == item.projectId);
  if (!project) return;
  const stage = project.stages.find(candidate => candidate.id == item.stageId);
  if (!stage) return;
  const estimate = Number(stage.estimatedMinutes) || 0;
  const targetContribution = estimate > 0 ? clampProgress(Math.min(100, plannedMinutes(item) / estimate * taskDailyProgress(item))) : 0;
  const stageBefore = stageProgress(stage);
  const previousContribution = Math.min(clampProgress(item.stageProgressApplied), stageBefore);
  const stageAfter = clampProgress(stageBefore + targetContribution - previousContribution);
  item.stageProgressApplied = clampProgress(Math.max(0, Math.min(100, previousContribution + stageAfter - stageBefore)));
  if (stageAfter !== stageBefore) {
    stage.progress = stageAfter;
    stage.progressMode = 'manual';
  }
  syncProjectProgress(project);
  item.progress = stageProgress(stage);
}
function progressLabel(progress) {
  const rounded = Math.round(progress);
  return ({ 25: '1/4', 50: '1/2', 75: '3/4' })[rounded] || `${rounded}%`;
}
function percentText(progress) { return `${Number(progress).toFixed(2).replace(/\.?0+$/, '')}%`; }
function todayEvents() { return d.events.filter(event => !event.date || event.date === todayKey()).sort((a, b) => (a.time || '').localeCompare(b.time || '')); }
function clockMinutes(value) { const parts = String(value || '').split(':').map(Number); return parts.length === 2 && parts.every(Number.isFinite) ? parts[0] * 60 + parts[1] : 0; }
function workStartTime() { return /^([01]\d|2[0-3]):[0-5]\d$/.test(d.workStart || '') ? d.workStart : DEFAULT_WORK_START; }
function workEndTime() { return /^([01]\d|2[0-3]):[0-5]\d$/.test(d.workEnd || '') ? d.workEnd : DEFAULT_WORK_END; }
function taskDailyProgress(item) { return item.done ? 100 : Math.max(0, Math.min(100, Math.round(Number(item.dailyProgress) || 0))); }
function setTaskDailyProgress(item, value, updateStage = true) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  item.dailyProgress = progress;
  item.done = progress === 100;
  item.progressMode = 'manual';
  if (updateStage) syncPlanToProject(item);
}
function isPlanForDate(item, date = todayKey()) { return !item.date || item.date === date; }
function activePlan() { return (pendingPlan || d.plan).filter(item => isPlanForDate(item)); }
function allProjects() { return [...d.projects, ...pendingProjects]; }
function plannedMinutes(item) { return Math.max(0, Number(item.plannedMinutes ?? item.minutes) || 0); }
function stageRemainingMinutes(stage, tasks = activePlan(), excludedTaskId = null) {
  const estimate = Number(stage?.estimatedMinutes) || 0;
  if (!estimate) return Infinity;
  const projectId = allProjects().find(project => project.stages.includes(stage))?.id;
  const assigned = tasks.filter(item => !item.planExcluded && String(item.id) !== String(excludedTaskId) && String(item.stageId) === String(stage.id) && String(item.projectId) === String(projectId)).reduce((sum, item) => sum + plannedMinutes(item) * (1 - taskDailyProgress(item) / 100), 0);
  return Math.max(0, Math.floor(estimate * (1 - stageProgress(stage) / 100) - assigned + 1e-7));
}
function totalPlanned(tasks) { return tasks.filter(item => !item.planExcluded).reduce((sum, item) => sum + plannedMinutes(item), 0); }
function reviewablePlan() { return activePlan().filter(item => !item.planExcluded || item.done || Number(item.actualMinutes) > 0); }
function recurrenceMatches(template, date) {
  if (!template.active || date < template.startDate || (template.endDate && date > template.endDate)) return false;
  if (template.frequency === 'daily') return true;
  const parsed = new Date(`${date}T00:00:00`);
  if (template.frequency === 'weekly') return parsed.getDay() === Number(template.weekday);
  if (template.frequency === 'monthly') {
    const monthday = Number(template.monthday);
    const lastDay = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate();
    return parsed.getDate() === Math.min(monthday, lastDay);
  }
  return false;
}
function ensureRecurringInstances(date = todayKey()) {
  if (d.dailyReviews[date]?.confirmed) return false;
  let changed = false;
  d.recurringTasks.forEach(template => {
    if (!recurrenceMatches(template, date)) return;
    const exists = d.plan.some(item => item.recurringTaskId === template.id && item.date === date)
      || (d.dailyReviews[date]?.tasks || []).some(item => item.recurringTaskId === template.id);
    if (exists) return;
    const project = d.projects.find(item => String(item.id) === String(template.projectId));
    const stage = project?.stages.find(item => String(item.id) === String(template.stageId));
    if (template.projectId && !project) return;
    if (template.stageId && !stage) return;
    const remaining = stage ? stageRemainingMinutes(stage, d.plan.filter(item => isPlanForDate(item, date))) : Infinity;
    if (stage && remaining <= 0) return;
    const minutes = Math.max(1, Math.min(Number(template.estimatedMinutes) || 30, Number.isFinite(remaining) ? remaining : 1440));
    d.plan.push({
      id: `repeat-${template.id}-${date}`, recurringTaskId: template.id, date, name: template.name,
      projectId: project?.id ?? null, stageId: stage?.id ?? null, minutes, plannedMinutes: minutes,
      estimatedMinutes: Number(stage?.estimatedMinutes) || minutes, actualMinutes: 0, dailyProgress: 0,
      progress: stage ? stageProgress(stage) : 0, stageProgressApplied: 0, progressMode: 'manual', done: false, isExtra: false
    });
    d.planAccepted = false;
    changed = true;
  });
  if (changed) save();
  return changed;
}
function recurrenceDescription(template) {
  if (template.frequency === 'weekly') return `매주 ${['일', '월', '화', '수', '목', '금', '토'][Number(template.weekday)]}요일`;
  if (template.frequency === 'monthly') return `매월 ${template.monthday}일`;
  return '매일';
}
function recurringTaskHistory(template) {
  const records = new Map();
  d.plan.forEach(item => {
    if (String(item.recurringTaskId) === String(template.id) && item.date && item.date <= todayKey()) records.set(item.date, item);
  });
  Object.entries(d.dailyReviews).forEach(([date, review]) => {
    if (date > todayKey()) return;
    (review.tasks || []).forEach(item => {
      if (String(item.recurringTaskId) === String(template.id)) records.set(date, item);
    });
  });
  return [...records.entries()]
    .sort(([dateA], [dateB]) => dateB.localeCompare(dateA))
    .map(([date, item]) => ({ date, done: Boolean(item.done), dailyProgress: Number(item.dailyProgress) || 0, actualMinutes: Number(item.actualMinutes) || 0 }));
}
function renderRecurringTasks() {
  if (!$('recurringList')) return;
  $('recurringList').innerHTML = d.recurringTasks.length ? d.recurringTasks.map(template => {
    const history = recurringTaskHistory(template);
    const shown = recurringHistoryLimits.get(String(template.id)) || RECURRING_HISTORY_INITIAL;
    const visibleHistory = history.slice(0, shown);
    const historyMarkup = history.length ? `<div class="recurring-history" aria-label="${esc(template.name)} 수행 기록"><b>최근 수행 기록</b><ul>${visibleHistory.map(record => `<li><time datetime="${esc(record.date)}">${esc(dateLabel(record.date))}</time><span class="recurring-status"><i class="history-dot ${record.done ? 'is-done' : 'is-undone'}" aria-hidden="true"></i><span>${record.done ? '완료' : '미완료'}</span></span><span class="recurring-record-detail">${record.dailyProgress}% · ${record.actualMinutes}분</span></li>`).join('')}</ul>${history.length > RECURRING_HISTORY_INITIAL ? `<div class="recurring-history-actions">${shown < history.length ? `<button class="secondary small-button" data-recurring-history-more="${esc(template.id)}" aria-label="${esc(template.name)} 이전 기록 더보기">더보기</button>` : ''}${shown > RECURRING_HISTORY_INITIAL ? `<button class="secondary small-button" data-recurring-history-collapse="${esc(template.id)}">접기</button>` : ''}</div>` : ''}</div>` : '<div class="recurring-history-empty">아직 확인할 수행 기록이 없어.</div>';
    const stateAction = template.active
      ? `<button class="secondary small-button" data-stop-recurring="${esc(template.id)}">중단</button>`
      : `<button class="secondary small-button" data-resume-recurring="${esc(template.id)}">재개</button>`;
    const statusLabel = template.active ? '' : ' · 중단됨';
    return `<article class="recurring-card"><div class="recurring-card-main"><div class="recurring-card-heading"><div><b>${esc(template.name)}</b><div class="detail">${recurrenceDescription(template)} · ${esc(taskProjectLabel(template))} · ${template.estimatedMinutes}분 · ${esc(template.startDate)}${template.endDate ? ` ~ ${esc(template.endDate)}` : ''}${statusLabel}</div></div><div class="recurring-actions"><button class="secondary small-button" data-edit-recurring="${esc(template.id)}">수정</button>${stateAction}<button class="danger small-button" data-delete-recurring="${esc(template.id)}">삭제</button></div></div>${historyMarkup}</div></article>`;
  }).join('') : '<div class="event">등록된 반복 작업이 없어.</div>';
}
function openRecurringEditor(template = null) {
  const projectOptions = d.projects.map(project => `<option value="${esc(project.id)}" ${String(project.id) === String(template?.projectId) ? 'selected' : ''}>${esc(project.name)}</option>`).join('');
  const stageOptions = (d.projects.find(project => String(project.id) === String(template?.projectId))?.stages || []).map(stage => `<option value="${esc(stage.id)}" ${String(stage.id) === String(template?.stageId) ? 'selected' : ''}>${esc(stage.name)}</option>`).join('');
  const frequency = template?.frequency || 'daily';
  modal(template ? '반복 작업 수정' : '반복 작업 추가', `<label class="label">작업명</label><input class="input" id="recurringName" maxlength="120" value="${esc(template?.name || '')}" placeholder="예: 매일 스트레칭"><label class="label">반복 주기</label><select class="input" id="recurringFrequency"><option value="daily" ${frequency === 'daily' ? 'selected' : ''}>매일</option><option value="weekly" ${frequency === 'weekly' ? 'selected' : ''}>매주 특정 요일</option><option value="monthly" ${frequency === 'monthly' ? 'selected' : ''}>매월 특정 날짜</option></select><label class="label">요일</label><select class="input" id="recurringWeekday">${['일', '월', '화', '수', '목', '금', '토'].map((day, index) => `<option value="${index}" ${Number(template?.weekday ?? 1) === index ? 'selected' : ''}>${day}요일</option>`).join('')}</select><label class="label">매월 날짜 (1~31)</label><input class="input" id="recurringMonthday" type="number" min="1" max="31" value="${Number(template?.monthday) || 1}"><label class="label">시작일</label><input class="input" id="recurringStartDate" type="date" value="${esc(template?.startDate || todayKey())}"><label class="label">종료일 (선택)</label><input class="input" id="recurringEndDate" type="date" value="${esc(template?.endDate || '')}"><label class="label">예상 작업 시간 (분)</label><input class="input" id="recurringMinutes" type="number" min="1" max="1440" value="${Number(template?.estimatedMinutes) || 30}"><label class="label">프로젝트 / 단계 (선택)</label><select class="input" id="recurringProject"><option value="">연결하지 않음</option>${projectOptions}</select><select class="input" id="recurringStage"><option value="">단계 없음</option>${stageOptions}</select><button class="primary wide" id="saveRecurring" data-id="${esc(template?.id || '')}">저장</button>`);
  $('recurringFrequency').onchange = updateRecurringFields;
  $('recurringProject').onchange = populateRecurringStages;
  updateRecurringFields();
}
function updateRecurringFields() {
  const frequency = $('recurringFrequency')?.value;
  const weekday = $('recurringWeekday')?.previousElementSibling;
  const monthday = $('recurringMonthday')?.previousElementSibling;
  if (weekday) { weekday.classList.toggle('hidden', frequency !== 'weekly'); $('recurringWeekday').classList.toggle('hidden', frequency !== 'weekly'); }
  if (monthday) { monthday.classList.toggle('hidden', frequency !== 'monthly'); $('recurringMonthday').classList.toggle('hidden', frequency !== 'monthly'); }
}
function populateRecurringStages() {
  const project = d.projects.find(item => String(item.id) === $('recurringProject')?.value);
  $('recurringStage').innerHTML = `<option value="">단계 없음</option>${(project?.stages || []).map(stage => `<option value="${esc(stage.id)}">${esc(stage.name)}</option>`).join('')}`;
}
function blockedIntervals(events, rangeStart, rangeEnd) {
  return events.map(event => {
    if (!event.time || !event.end) return null;
    const preparation = [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES;
    return [Math.max(rangeStart, clockMinutes(event.time) - preparation), Math.min(rangeEnd, clockMinutes(event.end) + preparation)];
  }).filter(interval => interval && interval[1] > interval[0]).sort((a, b) => a[0] - b[0]).reduce((merged, interval) => {
    const current = merged[merged.length - 1];
    if (current && interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else merged.push([...interval]);
    return merged;
  }, []);
}
function mergedBlockedMinutes(events, rangeStart, rangeEnd) {
  return blockedIntervals(events, rangeStart, rangeEnd).reduce((total, interval) => total + interval[1] - interval[0], 0);
}
function freeWorkIntervals(events, rangeStart, rangeEnd) {
  let cursor = rangeStart;
  const free = [];
  blockedIntervals(events, rangeStart, rangeEnd).forEach(interval => {
    if (interval[0] > cursor) free.push([cursor, interval[0]]);
    cursor = Math.max(cursor, interval[1]);
  });
  if (cursor < rangeEnd) free.push([cursor, rangeEnd]);
  return free;
}
function usableWorkSlots(intervals, availableMinutes) {
  const total = intervals.reduce((sum, interval) => sum + interval[1] - interval[0], 0);
  if (!total || !availableMinutes) return [];
  const factor = Math.min(1, availableMinutes / total);
  return intervals.map(interval => Math.floor((interval[1] - interval[0]) * factor)).filter(minutes => minutes > 0);
}
function workCapacity() {
  const start = clockMinutes(workStartTime()), end = clockMinutes(workEndTime());
  const intervals = freeWorkIntervals(todayEvents(), start, end);
  const blocked = mergedBlockedMinutes(todayEvents(), start, end);
  const base = Math.max(0, end - start - DEFAULT_LUNCH_MINUTES - DEFAULT_FIKA_MINUTES);
  return { base, blocked, available: Math.max(0, base - blocked), intervals };
}
function remainingWorkCapacity(now = new Date()) {
  const start = clockMinutes(workStartTime()), end = clockMinutes(workEndTime());
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const rangeStart = Math.max(start, nowMinutes);
  if (rangeStart >= end) return { available: 0, blocked: 0, remaining: 0, intervals: [] };
  const remaining = end - rangeStart;
  const events = todayEvents();
  const intervals = freeWorkIntervals(events, rangeStart, end);
  const blocked = mergedBlockedMinutes(events, rangeStart, end);
  const fullIntervals = freeWorkIntervals(events, start, end);
  const fullFreeMinutes = fullIntervals.reduce((sum, interval) => sum + interval[1] - interval[0], 0);
  const fullAvailable = workCapacity().available;
  const workFactor = fullFreeMinutes ? fullAvailable / fullFreeMinutes : 0;
  const elapsedFreeMinutes = fullIntervals.reduce((sum, interval) => {
    const elapsedEnd = Math.min(interval[1], rangeStart);
    return sum + Math.max(0, elapsedEnd - interval[0]);
  }, 0);
  const available = Math.max(0, Math.floor(fullAvailable - elapsedFreeMinutes * workFactor));
  return { available, blocked, remaining, intervals };
}
function eveningCapacity() {
  const start = clockMinutes(EVENING_START), end = clockMinutes(EVENING_END);
  const intervals = todayEvents().map(event => {
    if (!event.time || !event.end) return [0, 0];
    const preparation = [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES;
    return [Math.max(start, clockMinutes(event.time) - preparation), Math.min(end, clockMinutes(event.end) + preparation)];
  }).filter(interval => interval[1] > interval[0]).sort((a, b) => a[0] - b[0]);
  let cursor = start, best = [start, end];
  intervals.forEach(interval => {
    if (interval[0] > cursor && interval[0] - cursor > best[1] - best[0]) best = [cursor, interval[0]];
    cursor = Math.max(cursor, interval[1]);
  });
  if (end > cursor && end - cursor > best[1] - best[0]) best = [cursor, end];
  return { minutes: Math.max(0, best[1] - best[0]), start: `${String(Math.floor(best[0] / 60)).padStart(2, '0')}:${String(best[0] % 60).padStart(2, '0')}` };
}
function availableMinutes() { return workCapacity().available; }
function minutesLabel(minutes) { const hours = Math.floor(minutes / 60), remainder = minutes % 60; return hours ? `${hours}시간${remainder ? ` ${remainder}분` : ''}` : `${remainder}분`; }
function eveningSuggestion() {
  const capacity = workCapacity(), evening = eveningCapacity();
  if (!evening.minutes) return null;
  const urgent = d.projects.some(project => project.deadline && Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000) <= 7 && project.progress < 100);
  const remaining = d.projects.reduce((sum, project) => sum + project.stages.filter(stage => stage.progress < 100).reduce((stageSum, stage) => stageSum + (Number(stage.estimatedMinutes) || 0), 0), 0);
  const daysToDeadline = d.projects.filter(project => project.deadline && project.progress < 100).map(project => Math.max(1, Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000)));
  const overloaded = daysToDeadline.length && remaining > capacity.available * Math.min(...daysToDeadline);
  if (!(urgent || capacity.available < 120 || overloaded)) return null;
  return { minutes: Math.min(120, evening.minutes), start: evening.start };
}
function riskFor(project) { if (!project.deadline) return 'green'; const days = Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000); if (days <= 7 && project.progress < 70) return 'red'; if (days <= 21 && project.progress < 50) return 'yellow'; return 'green'; }
function buildPlanProposal(availableMinutesForPlan, intervals) {
  const available = Math.floor(Math.max(0, availableMinutesForPlan) * DEFAULT_PLAN_UTILIZATION);
  const current = activePlan();
  const excluded = current.filter(item => item.planExcluded).map(item => ({ ...item }));
  const preserved = current.filter(item => !item.planExcluded && (item.done || item.isExtra || item.recurringTaskId)).map(item => ({ ...item }));
  const preservedStages = new Set([...preserved, ...excluded].filter(item => item.projectId != null && item.stageId != null).map(item => `${item.projectId}:${item.stageId}`));
  const slots = usableWorkSlots(intervals, availableMinutesForPlan);
  const ranked = [...d.projects].sort((a, b) => {
    const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity, bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return ad - bd || (b.importance || 3) - (a.importance || 3) || (a.progress || 0) - (b.progress || 0);
  });
  const candidates = []; let used = 0;
  for (const project of ranked) {
    if (used >= available) break;
    const stage = project.stages.find(item => (item.progress || 0) < 100);
    if (!stage) continue;
    if (preservedStages.has(`${project.id}:${stage.id}`)) continue;
    const estimatedMinutes = Number(stage.estimatedMinutes) || (project.deadline ? 90 : 60);
    const slotIndex = slots.indexOf(Math.max(...slots));
    const slotMinutes = slots[slotIndex] || 0;
    const stageMinutes = stageRemainingMinutes(stage, current);
    const minutes = Math.min(estimatedMinutes, slotMinutes, Number.isFinite(stageMinutes) ? stageMinutes : estimatedMinutes, Math.max(0, available - used));
    if (minutes < Math.min(30, estimatedMinutes)) continue;
    candidates.push({ id: Date.now() + candidates.length, projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name}`, minutes, estimatedMinutes, plannedMinutes: minutes, actualMinutes: 0, progress: stageProgress(stage), dailyProgress: 0, stageProgressApplied: 0, progressMode: 'manual', done: false, date: todayKey() });
    used += minutes;
    slots[slotIndex] -= minutes;
    if (candidates.length >= 3) break;
  }
  return [...preserved, ...excluded, ...candidates];
}
function openPlanProposal(available, mode, intervals) {
  proposalDraft = buildPlanProposal(available, intervals);
  proposalMeta = { available, mode };
  const fixedIds = new Set(activePlan().filter(item => item.done || item.isExtra || item.recurringTaskId || item.planExcluded).map(item => String(item.id)));
  const rows = proposalDraft.filter(item => !item.planExcluded).map(item => {
    const fixed = fixedIds.has(String(item.id));
    return `<div class="proposal-row" data-proposal-row="${esc(item.id)}"><b>${esc(item.name)}</b><div class="detail">${fixed ? '완료/직접 추가한 작업 · 유지' : `${esc(taskProjectLabel(item))} · 예상 ${item.estimatedMinutes || item.minutes}분`}</div>${fixed ? `<div class="detail">배정 ${plannedMinutes(item)}분 · 실제 ${item.actualMinutes || 0}분</div>` : `<label class="label">오늘 배정 시간 (분)</label><input class="input proposal-minutes" type="number" min="0" max="${Math.max(0, available)}" value="${plannedMinutes(item)}" data-proposal-minutes="${esc(item.id)}"><button class="secondary small-button" data-remove-proposal="${esc(item.id)}">이번 추천에서 제외</button>`}</div>`;
  }).join('') || '<div class="event">남은 시간에 제안할 작업이 없어. 기존 계획은 유지돼.</div>';
  const currentRows = d.plan.filter(item => !item.planExcluded).map(item => `<div class="detail">· ${esc(item.name)} · ${plannedMinutes(item)}분${item.done ? ' · 완료' : ''}${item.isExtra ? ' · 직접 추가' : ''}</div>`).join('') || '<div class="detail">· 기존 계획 없음</div>';
  modal(mode === 'remaining' ? '현재 시간 기준 재계산' : '오늘 추천 다시 받기', `<div class="day-summary">남은 작업 가능 시간 <b>${minutesLabel(available)}</b><br>현재 계획은 아직 변경되지 않았어.</div><h4>현재 계획</h4>${currentRows}<h4>새 계획 미리보기</h4>${rows}<div class="detail">새 작업 예상 합계 ${minutesLabel(totalPlanned(proposalDraft))}</div><button class="primary wide" id="stagePlanProposal">이 제안 미리보기</button><button class="secondary wide" id="cancelPlanProposal">기존 계획 유지</button>`);
}
function recommend() {
  const capacity = workCapacity();
  openPlanProposal(capacity.available, 'basic', capacity.intervals);
}
function recalculateFromNow() {
  const capacity = remainingWorkCapacity();
  openPlanProposal(capacity.available, 'remaining', capacity.intervals);
}
function renderTodayPlan(tasks) {
  if (!tasks.length) return '<div class="emptyplan">오늘 추천할 일이 없어. 쉬어도 괜찮아 🌿</div>';
  const cards = tasks.map((item, index) => {
    const progress = taskDailyProgress(item);
    const stage = d.projects.find(project => project.id == item.projectId)?.stages.find(candidate => candidate.id == item.stageId);
    return `<div class="item task ${item.done ? 'done' : ''}"><button class="check ${item.done ? 'checked' : ''}" data-task-check="${esc(item.id)}" aria-label="${esc(item.name)} 완료">${item.done ? '✓' : ''}</button><div class="taskmain"><div class="taskline"><b>${esc(item.name)} · 오늘 ${progressLabel(progress)}</b><span>배정 <input class="time-input plan-time-input" type="number" min="1" max="1440" step="1" value="${plannedMinutes(item)}" data-plan-minutes="${esc(item.id)}" aria-label="${esc(item.name)} 오늘 배정 시간 (분)">분</span></div><div class="progressrow"><input type="range" min="0" max="100" step="1" value="${progress}" data-task-progress="${esc(item.id)}" aria-label="${esc(item.name)} 오늘 진척도"><span class="progress-percent"><input class="percent" type="number" min="0" max="100" step="1" value="${progress}" data-task-percent="${esc(item.id)}">%</span></div>${stage ? `<div class="detail stage-progress-label">단계 전체 진척도 ${percentText(stageProgress(stage))}</div>` : ''}<div class="time-row">실제 작업 시간 <input class="time-input" type="number" min="0" value="${item.actualMinutes}" data-task-actual="${esc(item.id)}">분</div><div class="plan-task-actions"><button class="secondary small-button" data-plan-move="up" data-id="${esc(item.id)}" aria-label="${esc(item.name)} 위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button><button class="secondary small-button" data-plan-move="down" data-id="${esc(item.id)}" aria-label="${esc(item.name)} 아래로 이동" ${index === tasks.length - 1 ? 'disabled' : ''}>↓</button>${item.isExtra ? `<button class="secondary small-button" data-plan-edit="${esc(item.id)}">수정</button>` : ''}<button class="danger plan-remove" data-plan-remove="${esc(item.id)}" aria-label="오늘 계획에서 제외">×</button></div>${item.recurringTaskId ? '<div class="detail">반복 작업 · 오늘 인스턴스</div>' : item.isExtra ? '<div class="detail">직접 추가한 작업</div>' : ''}</div></div>`;
  }).join('');
  return cards;
}
function commitActivePlanEdit() {
  if (pendingPlan === null) save();
  render();
}
function render() {
  const events = todayEvents();
  d.projects.forEach(syncProjectProgress);
  $('todayDate').textContent = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(new Date());
  const review = d.dailyReviews[todayKey()];
  const isComplete = Boolean(review?.confirmed);
  $('todaySummary').innerHTML = isComplete ? `<div class="day-summary home-summary"><div class="summary-emoji">🌿</div><b>오늘은 ${minutesLabel(totalActual(review.tasks))} 작업했어.</b></div>` : '';
  $('eventList').innerHTML = evForCalendar();
  renderProjectList();
  if (isComplete) {
    $('capacity').innerHTML = ''; $('events').innerHTML = ''; $('plan').innerHTML = ''; $('eveningSuggestion').innerHTML = '';
    $('planToolbar').classList.add('hidden'); $('todayActions').classList.add('hidden');
    $('eveningButton').classList.remove('hidden');
    renderCaptures(); renderEvening(); renderReviewCalendar(); updateActions(); return;
  }
  $('planToolbar').classList.remove('hidden'); $('todayActions').classList.remove('hidden'); $('eveningButton').classList.remove('hidden');
  const capacity = workCapacity();
  const visiblePlan = activePlan();
  const available = pendingPlanMeta?.available ?? capacity.available;
  const plannedTotal = totalPlanned(visiblePlan);
  $('capacity').innerHTML = `<div class="capacity-card"><div class="capacity-metrics"><span>오늘 작업 가능한 시간 <b>${minutesLabel(available)}</b></span><span>작업 예상 시간 <b>${minutesLabel(plannedTotal)}</b></span></div><span class="muted">기본 ${workStartTime()}~${workEndTime()} · 점심 ${DEFAULT_LUNCH_MINUTES}분 · fika ${DEFAULT_FIKA_MINUTES}분 · 일정/준비시간 반영</span><button class="secondary wide recalculate-button" id="recalculatePlan">현재 시간으로 다시 계산하기</button></div>`;
  $('events').innerHTML = events.map(event => `<button class="pill eventpill" data-event-id="${event.id}">🕐 ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''} ${esc(event.name)} <span class="source">${event.source === 'external' ? '외부 일정' : '점지 일정'}</span></button>`).join('') || '<span class="muted">오늘 등록된 일정이 없어.</span>';
  $('plan').innerHTML = renderTodayPlan(visiblePlan.filter(item => !item.planExcluded));
  const suggestion = eveningSuggestion();
  $('eveningSuggestion').innerHTML = suggestion ? `<div class="evening-suggestion"><b>오늘 기본 작업시간이 부족해 보여.</b><div>저녁 ${suggestion.start}부터 최대 ${minutesLabel(suggestion.minutes)} 더 할 수 있어. 추가할까?</div><button class="primary small-button" id="addEveningWork">추가할래</button><button class="secondary small-button" id="skipEveningWork">오늘은 여기까지</button></div>` : '';
  $('pendingPlanActions').innerHTML = pendingPlan !== null ? '<button class="secondary wide" id="discardPlanPreview">기존 계획으로 돌아가기</button>' : '';
  renderCaptures(); renderEvening(); renderReviewCalendar(); updateActions();
}
function evForCalendar() { if (!d.events.length) return '<div class="event">등록된 일정이 없어.</div>'; return [...d.events].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '')).map(event => `<button class="event eventbtn" data-event-id="${event.id}"><div class="eventtop"><b>${esc(event.date || '날짜 없음')} · ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''}</b><span>${event.source === 'external' ? '외부' : '점지'}</span></div>${esc(event.name)}<div class="detail">${event.source === 'external' ? '외부 캘린더 연동 예정' : '눌러서 수정'}</div></button>`).join(''); }
function renderCaptures() { const list = [...d.captures].reverse(); $('captureList').innerHTML = list.length ? list.map(capture => `<article class="capture-card"><div class="detail">${esc(new Date(capture.at).toLocaleString('ko-KR'))}</div><div>${esc(capture.text)}</div><button class="danger small-button" data-delete-capture="${capture.id}">삭제</button></article>`).join('') : '<div class="event">아직 기록이 없어.</div>'; }
function openAddTodayTask() {
  const options = d.projects.flatMap(project => project.stages.map(stage => `<option value="${project.id}:${stage.id}">${esc(project.name)} · ${esc(stage.name)}</option>`)).join('');
  modal('오늘 한 일 추가', `<label>무엇을 했어?<input class="input" id="extraName" placeholder="작업명"></label><label>어디에 한 일이야?<select class="input" id="extraLink"><option value="">프로젝트 없음</option>${options}</select></label><label>실제 작업 시간 (분)<input class="input" id="extraActual" type="number" min="0" value="30"></label><label>오늘 작업 진척도 (%)<input class="input" id="extraProgress" type="number" min="0" max="100" value="0"></label><button class="primary wide" id="saveExtraTask">저장하기</button>`);
}
function openAddPlannedTask() {
  const projectOptions = allProjects().map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
  modal('계획에 작업 추가', `<label class="label" for="plannedMode">추가 방식</label><select class="input" id="plannedMode"><option value="existing">기존 프로젝트의 작업/단계</option><option value="independent">독립 작업</option><option value="newProject">새 프로젝트와 작업</option></select><div id="plannedExistingFields"><label class="label" for="plannedProject">프로젝트</label><select class="input" id="plannedProject">${projectOptions || '<option value="">등록된 프로젝트 없음</option>'}</select><label class="label" for="plannedStage">단계</label><select class="input" id="plannedStage"></select></div><div id="plannedNewProjectFields" class="hidden"><label class="label" for="plannedProjectName">새 프로젝트 이름</label><input class="input" id="plannedProjectName" maxlength="120" placeholder="프로젝트 이름"></div><label class="label" for="plannedTaskName">작업명</label><input class="input" id="plannedTaskName" maxlength="120" placeholder="작업명"><label class="label" for="plannedTaskMinutes">오늘 배정 시간 (분)</label><input class="input" id="plannedTaskMinutes" type="number" min="1" max="1440" step="1" value="30"><div class="muted">오늘 계획의 배정 시간만 바뀌며, 단계 예상 시간은 유지돼.</div><button class="primary wide" id="savePlannedTask">계획에 추가</button>`);
  populatePlannedStages();
}
function populatePlannedStages() {
  const project = allProjects().find(item => String(item.id) === $('plannedProject')?.value);
  if ($('plannedStage')) $('plannedStage').innerHTML = (project?.stages || []).map(stage => `<option value="${esc(stage.id)}">${esc(stage.name)}</option>`).join('') || '<option value="">단계 없음</option>';
}
function openEditPlannedTask(id) {
  const item = activePlan().find(task => String(task.id) === String(id));
  if (!item || !item.isExtra) return;
  modal('계획 작업 수정', `<label class="label" for="editPlannedTaskName">작업명</label><input class="input" id="editPlannedTaskName" maxlength="120" value="${esc(item.name)}"><label class="label" for="editPlannedTaskMinutes">오늘 배정 시간 (분)</label><input class="input" id="editPlannedTaskMinutes" type="number" min="1" max="1440" step="1" value="${plannedMinutes(item)}"><button class="primary wide" id="savePlannedTaskEdit" data-id="${esc(item.id)}">변경 저장</button>`);
}
function renderEvening() {
  const review = d.dailyReviews[todayKey()];
  if (review?.confirmed && reviewStep === 'summary') {
    const tasks = review.tasks || [];
    $('eveningList').innerHTML = `<div class="day-summary"><b>오늘의 기록</b><div>오늘은 ${minutesLabel(totalActual(tasks))} 작업했어.</div></div><h3>오늘 한 일</h3>${tasks.map(item => `<div class="evening-item ${item.done ? 'done' : ''}"><b>${esc(item.name)}</b><div class="detail">${esc(taskProjectLabel(item))} · 실제 ${item.actualMinutes || 0}분 · 오늘 진척도 ${taskDailyProgress(item)}%${item.stageProgressAtReview == null ? '' : ` · 단계 전체 ${item.stageProgressAtReview}%`} · ${item.done ? '완료' : '미완료'}</div></div>`).join('')}<button class="secondary wide" id="addTodayTaskFromReview">＋ 오늘 한 일 추가</button><button class="secondary wide" id="editReview">기록 수정하기</button>`;
    return;
  }
  const reviewPlan = reviewablePlan();
  const allDone = reviewPlan.length > 0 && reviewPlan.every(item => item.done);
  const tasks = reviewPlan.length ? reviewPlan.map(item => `<div class="evening-item ${item.done ? 'done' : ''}"><b>${esc(item.name)}</b><div class="detail">${esc(taskProjectLabel(item))} · 배정 ${plannedMinutes(item)}분</div>${reviewStep === 'edit' ? `<label>완료 <input type="checkbox" data-review-done="${esc(item.id)}" ${item.done ? 'checked' : ''}></label><label>오늘 진척도 (%) <input class="input" type="number" min="0" max="100" data-review-progress="${esc(item.id)}" value="${taskDailyProgress(item)}"></label><label>실제 작업 시간 (분) <input class="input" type="number" min="0" data-review-actual="${esc(item.id)}" value="${item.actualMinutes}"></label>` : `<div class="detail">실제 ${item.actualMinutes}분 · 오늘 진척도 ${taskDailyProgress(item)}% · 단계 전체 ${item.stageId ? `${stageProgress(d.projects.find(project => project.id == item.projectId)?.stages.find(stage => stage.id == item.stageId) || { progress: 0 })}% · ` : ''}${item.done ? '완료' : '미완료'}</div>`}</div>`).join('') : '<div class="event">오늘 계획한 일이 없어.</div>';
  const events = todayEvents().map(event => `<div class="review-event"><b>${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''} ${esc(event.name)}</b><span>${event.source === 'external' ? '외부 일정' : '점지 일정'}</span></div>`).join('') || '<div class="muted">오늘 일정이 없어.</div>';
  if (reviewStep === 'defer') {
    const pending = reviewablePlan().filter(item => !item.done);
    if (!pending.length) { finalizeReview(); return; }
    $('eveningList').innerHTML = `<h3>오늘 못 한 일은 왜 미뤘을까?</h3>${pending.map(item => `<div class="evening-item"><b>${esc(item.name)}</b><select class="input" data-defer-reason="${item.id}"><option value="">미룬 이유 선택</option>${['피곤함', '시간이 부족함', '시작하기 어려웠음', '다른 일정이 생김', '하기 싫었음', '예상보다 어려웠음', '기타'].map(option => `<option ${d.deferReasons[item.id] === option ? 'selected' : ''}>${option}</option>`).join('')}</select><input class="input" placeholder="메모 (선택)" data-defer-note="${item.id}" value="${esc(d.deferReasons[`${item.id}-note`] || '')}"></div>`).join('')}<button class="primary wide" id="finalizeReview">기록 저장하기</button>`;
    return;
  }
  $('eveningList').innerHTML = `${allDone ? '<div class="celebrate">🎉 오늘 계획한 일을 다 했어! 고생했어.</div>' : ''}<h3>오늘 기록이 맞아?</h3><div class="day-summary">현재 실제 작업시간 ${minutesLabel(totalActual(reviewPlan))}</div>${tasks}${reviewStep === 'summary' ? '<button class="secondary wide" id="addTodayTaskFromReview">＋ 오늘 한 일 추가</button>' : ''}<h3>오늘의 일정</h3><div class="review-events">${events}</div>${reviewStep === 'edit' ? '<button class="primary wide" id="saveReviewEdits">저장하고 다음으로</button>' : '<button class="primary wide" id="confirmReview">맞아, 이대로 기록할래</button><button class="secondary wide" id="editReview">수정할래</button>'}`;
}
function renderReviewCalendar() {
  if (!$('reviewCalendar')) return;
  const date = new Date(selectedReviewDate + 'T00:00:00');
  const year = date.getFullYear(), month = date.getMonth();
  const first = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate();
  let cells = ['일', '월', '화', '수', '목', '금', '토'].map(day => `<span class="calendar-weekday">${day}</span>`).join('');
  for (let i = 0; i < first; i++) cells += '<span></span>';
  for (let day = 1; day <= days; day++) { const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; cells += `<button class="calendar-day ${key === selectedReviewDate ? 'selected' : ''} ${d.dailyReviews[key] ? 'has-review' : ''}" data-review-date="${key}">${day}</button>`; }
  $('reviewCalendar').innerHTML = `<div class="calendar-month">${year}년 ${month + 1}월</div><div class="calendar-grid">${cells}</div>`;
  renderSelectedReview();
}
function renderSelectedReview() {
  const date = selectedReviewDate, review = d.dailyReviews[date], tasks = reviewTasksFor(date);
  const events = review?.events || d.events.filter(event => event.date === date);
  $('selectedDayReview').innerHTML = `<h3>${dateLabel(date)}</h3>${review ? `<div class="day-summary">오늘은 ${minutesLabel(totalActual(tasks))} 작업했어.</div><h4>그날 한 일</h4>${tasks.map(item => `<div class="history-item"><b>${esc(item.name)}</b><div>${esc(taskProjectLabel(item))} · 실제 ${item.actualMinutes || 0}분 · 오늘 진척도 ${taskDailyProgress(item)}%${item.stageProgressAtReview == null ? '' : ` · 단계 전체 ${item.stageProgressAtReview}%`} · ${item.done ? '완료' : '미완료'}${item.isExtra ? ' · 오늘 추가한 일' : ''}</div></div>`).join('')}<h4>그날의 일정</h4>${events.map(event => `<div class="history-item">${esc(event.time)} ${esc(event.name)} · ${event.source === 'external' ? '외부 일정' : '점지 일정'}</div>`).join('') || '<div class="muted">일정 없음</div>'}<h4>미룬 일</h4>${tasks.filter(item => !item.done).map(item => `<div class="history-item">${esc(item.name)} · ${esc(review.deferReasons?.[item.id] || '이유 기록 없음')}</div>`).join('') || '<div class="muted">미룬 일 없음</div>'}` : '<div class="event">이 날짜에는 저장된 하루 기록이 없어.</div>'}`;
}
function finalizeReview() {
  d.dailyReviews[todayKey()] = reviewSnapshot();
  reviewStep = 'summary';
  editingReview = false;
  save();
  render();
  show('today');
  toast('오늘 기록을 저장했어.');
}
function updateActions() { $('accept').textContent = pendingPlan !== null ? '이 제안으로 확정하기' : d.planAccepted ? '오늘 계획 확정됨 ✓' : '이대로 할래'; $('accept').disabled = d.planAccepted && pendingPlan === null; $('accept').classList.toggle('confirmed', d.planAccepted && pendingPlan === null); }
function modal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }
function bounce() { $('mascot').classList.add('jump'); setTimeout(() => $('mascot').classList.remove('jump'), 700); }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.remove('hidden'); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2400); }
function showPwaUpdateNotice() {
  $('pwaUpdateNotice').classList.remove('hidden');
}
function hidePwaUpdateNotice() {
  $('pwaUpdateNotice').classList.add('hidden');
}
function registerAppServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  let updateSelected = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateSelected) return;
    updateSelected = false;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(result => {
    registration = result;
    const showIfWaiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) showPwaUpdateNotice();
    };
    const watchInstallingWorker = () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showPwaUpdateNotice();
      });
    };
    registration.addEventListener('updatefound', watchInstallingWorker);
    showIfWaiting();
    watchInstallingWorker();
    registration.update().then(showIfWaiting).catch(error => {
      console.warn('점지 앱 업데이트 확인에 실패했어. 현재 버전은 계속 사용할 수 있어.', error);
    });
    window.addEventListener('online', () => {
      registration.update().then(showIfWaiting).catch(error => {
        console.warn('온라인 복귀 후 점지 앱 업데이트 확인에 실패했어.', error);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      registration.update().then(showIfWaiting).catch(error => {
        console.warn('점지 앱 재실행 후 업데이트 확인에 실패했어.', error);
      });
    });
    $('applyPwaUpdate').addEventListener('click', () => {
      if (!registration.waiting) {
        registration.update().then(showIfWaiting).catch(error => {
          console.warn('점지 앱 업데이트를 준비하지 못했어.', error);
        });
        return;
      }
      updateSelected = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    $('dismissPwaUpdate').addEventListener('click', hidePwaUpdateNotice);
  }).catch(error => {
    console.error('점지 앱 서비스 워커를 등록하지 못했어.', error);
  });
}
function show(name) { document.querySelectorAll('.screen').forEach(screen => screen.classList.add('hidden')); const target = name === 'capture' ? 'captureScreen' : name; $(target).classList.remove('hidden'); document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.screen === name)); if (name === 'records') { renderCaptures(); renderReviewCalendar(); } if (name === 'settings') renderSettings(); if (name === 'evening') { reviewStep = d.dailyReviews[todayKey()]?.confirmed ? 'summary' : 'summary'; renderEvening(); } }
function preparationField(value) { return `<label class="label">준비/이동시간</label><select class="input" id="eventPreparation"><option value="0" ${Number(value) === 0 ? 'selected' : ''}>없음</option><option value="30" ${Number(value) === 30 || value == null ? 'selected' : ''}>30분</option><option value="60" ${Number(value) === 60 ? 'selected' : ''}>60분</option></select>`; }
function editEvent(id) { const event = d.events.find(item => item.id == id); if (!event) return; if (event.source === 'external') { modal('외부 일정', `<div class="externalhint"><b>${esc(event.name)}</b><div class="detail">${esc(event.date || '날짜 없음')} · ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''}</div><div class="muted">외부 캘린더 연동 예정이야. 현재는 점지에서 외부 일정을 수정하거나 삭제할 수 없어.</div></div>`); return; } modal('점지 일정 수정', `<label class="label">날짜</label><input class="input" id="eventDate" type="date" value="${esc(event.date || todayKey())}"><label class="label">시작 시간</label><input class="input" id="eventTime" type="time" value="${esc(event.time)}"><label class="label">종료 시간</label><input class="input" id="eventEnd" type="time" value="${esc(event.end || '')}"><label class="label">일정 이름</label><input class="input" id="eventName" value="${esc(event.name)}">${preparationField(event.preparationMinutes)}<button class="primary wide" id="updateEvent" data-id="${id}">수정하기</button><button class="danger wide" id="deleteEvent" data-id="${id}">일정 삭제</button><button class="secondary wide" id="recommendAgain">오늘 추천 다시 받기</button>`); }
function editProject(id) {
  const project = d.projects.find(item => item.id == id); if (!project) return;
  const stages = project.stages.map((stage, index) => `<div class="stage-row" data-stage-row="${esc(stage.id)}"><label>단계 이름<input class="input stage-name" data-stage-name="${esc(stage.id)}" value="${esc(stage.name)}"></label><label>진행률 (%)<input class="input stage-number" type="number" min="0" max="100" step="0.01" data-stage-progress="${esc(stage.id)}" value="${stage.progress}"></label><label>예상 소요시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-estimate="${esc(stage.id)}" value="${stage.estimatedMinutes}"></label><label>실제 작업시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-actual="${esc(stage.id)}" value="${stage.actualMinutes}"></label><div class="stage-order-actions"><button class="secondary small-button" data-stage-move="up" data-id="${esc(stage.id)}" aria-label="${esc(stage.name)} 위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button><button class="secondary small-button" data-stage-move="down" data-id="${esc(stage.id)}" aria-label="${esc(stage.name)} 아래로 이동" ${index === project.stages.length - 1 ? 'disabled' : ''}>↓</button><button class="danger small-button" data-delete-stage="${esc(stage.id)}">삭제</button></div></div>`).join('');
  modal('프로젝트 상세', `<label class="label">이름</label><input class="input" id="editProjectName" value="${esc(project.name)}"><label class="label">목적 또는 설명</label><textarea class="input small-textarea" id="editProjectDescription">${esc(project.description)}</textarea><label class="label">중요도 (1~5)</label><input class="input" id="editProjectImportance" type="number" min="1" max="5" value="${project.importance}"><label class="label">마감일</label><label class="deadline-choice"><input type="checkbox" id="noDeadline" ${project.deadline ? '' : 'checked'}> 마감일 없음</label><input class="input" id="editProjectDeadline" type="date" value="${esc(project.deadline || '')}" ${project.deadline ? '' : 'disabled'}><label class="label">상태</label><select class="input" id="editProjectStatus"><option ${project.status === '진행 중' ? 'selected' : ''}>진행 중</option><option ${project.status === '대기' ? 'selected' : ''}>대기</option><option ${project.status === '완료' ? 'selected' : ''}>완료</option></select><h4>단계</h4><div id="stageEditor">${stages || '<div class="muted">아직 단계가 없어.</div>'}</div><button class="secondary wide" id="addStage">＋ 단계 추가</button><button class="primary wide" id="updateProject" data-id="${id}">저장</button><button class="danger wide" id="deleteProject" data-id="${id}">프로젝트 삭제</button>`);
  $('noDeadline').onchange = event => { $('editProjectDeadline').disabled = event.target.checked; if (event.target.checked) $('editProjectDeadline').value = ''; };
}
function openPlanChangeModal() {
  if (planChangeDraft === null) {
    planChangeHadPreview = pendingPlan !== null;
    planChangeDraft = activePlan().map(item => ({ ...item }));
  }
  const blocks = planChangeDraft.map((item, index) => {
    if (item.done || item.isExtra || item.recurringTaskId) return `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="muted">${item.recurringTaskId ? '반복 작업의 오늘 인스턴스는 유지돼.' : '완료/직접 추가한 작업은 유지돼.'}</div></div>`;
    const choices = d.projects.map(project => `<button class="choice small" data-swap-i="${index}" data-p="${project.id}">${esc(project.name)}</button>`).join('');
    return `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="arrow">이걸 → 뭘로 바꿀까?</div><div class="choices">${choices}<button class="choice small" data-swap-i="${index}" data-rest="1">오늘은 쉬기</button></div></div>`;
  }).join('');
  modal('오늘 할 일을 바꾸자', blocks + (planChangeDraft.length ? '<div class="change-preview"><b>변경 결과를 미리 확인해줘.</b><div class="muted">아직 저장되지 않았어. 확인 후 오늘 화면에서 확정할 수 있어.</div><button class="primary wide" id="applyPlanChange">변경 미리보기</button><button class="secondary wide" id="cancelPlanChange">취소</button></div>' : '<div class="muted">오늘은 쉬어도 괜찮아.</div><button class="secondary wide" id="cancelPlanChange">취소</button>'));
}
function openCapture() { show('capture'); $('captureText').focus(); }

$('close').onclick = closeModal;
$('capture').onclick = openCapture;
$('exportData').onclick = exportDataBackup;
$('eveningButton').onclick = () => show('evening');
$('backToToday').onclick = () => show('today');
$('accept').onclick = () => { if (pendingPlan !== null) { const referencedProjectIds = new Set(pendingPlan.map(item => String(item.projectId))); d.projects.push(...pendingProjects.filter(project => referencedProjectIds.has(String(project.id)))); const otherDates = d.plan.filter(item => !isPlanForDate(item)); d.plan = [...otherDates, ...pendingPlan.map(item => ({ ...item, date: todayKey() }))]; d.plan.filter(item => isPlanForDate(item)).forEach(syncPlanToProject); pendingPlan = null; pendingPlanMeta = null; pendingProjects = []; } d.planAccepted = true; save(); $('headline').textContent = '좋아. 오늘은 이걸로 가자 🌿'; bounce(); render(); };
$('swap').onclick = openPlanChangeModal;
$('saveWorkHours').onclick = () => {
  const start = $('workStartSetting').value;
  const end = $('workEndSetting').value;
  const feedback = $('settingsFeedback');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    feedback.textContent = '시작 시간과 종료 시간을 모두 입력해줘.';
    return;
  }
  if (clockMinutes(end) <= clockMinutes(start)) {
    feedback.textContent = '종료 시간은 시작 시간보다 늦어야 해.';
    return;
  }
  try {
    persistWorkHours(start, end);
    feedback.textContent = '작업 시간을 저장했어. 확정된 오늘 계획은 그대로 유지돼.';
    render();
  } catch (error) {
    console.error('작업 시간을 저장하지 못했어.', error);
    feedback.textContent = '작업 시간을 저장하지 못했어. 기존 데이터는 변경하지 않았어.';
  }
};
$('addEvent').onclick = () => modal('일정 추가', `<label class="label">날짜</label><input class="input" id="eventDate" type="date" value="${todayKey()}"><label class="label">시작 시간</label><input class="input" id="eventTime" type="time" value="09:00"><label class="label">종료 시간</label><input class="input" id="eventEnd" type="time" value="10:00"><label class="label">일정 이름</label><input class="input" id="eventName" placeholder="예: 발레">${preparationField(DEFAULT_PREPARATION_MINUTES)}<button class="primary wide" id="saveEvent">추가</button>`);
$('addProject').onclick = () => modal('프로젝트 추가', `<label class="label">프로젝트 이름</label><input class="input" id="projectName" placeholder="예: 가구 공부"><label class="label">목적 또는 설명</label><textarea class="input small-textarea" id="projectDescription"></textarea><label class="label">중요도 (1~5)</label><input class="input" id="projectImportance" type="number" min="1" max="5" value="3"><label class="label">마감일</label><label class="deadline-choice"><input type="checkbox" id="newNoDeadline" checked> 마감일 없음</label><input class="input" id="projectDeadline" type="date" disabled><button class="primary wide" id="saveProject">추가</button>`); 
$('saveCapture').onclick = () => { const text = $('captureText').value.trim(); if (!text) return; d.captures.push({ id: `capture-${Date.now()}`, text, at: new Date().toISOString() }); save(); $('captureText').value = ''; renderCaptures(); toast('기억해둘게. 나중에 프로젝트에 붙일 수 있어.'); };
document.addEventListener('click', event => {
  const target = event.target;
  if (target.id === 'addPlannedTask') { openAddPlannedTask(); return; }
  if (target.id === 'addRecurring') { openRecurringEditor(); return; }
  const moreRecurringHistory = target.closest('[data-recurring-history-more]');
  if (moreRecurringHistory) {
    const id = moreRecurringHistory.dataset.recurringHistoryMore;
    recurringHistoryLimits.set(id, (recurringHistoryLimits.get(id) || RECURRING_HISTORY_INITIAL) + RECURRING_HISTORY_PAGE_SIZE);
    renderRecurringTasks();
    return;
  }
  const collapseRecurringHistory = target.closest('[data-recurring-history-collapse]');
  if (collapseRecurringHistory) {
    recurringHistoryLimits.set(collapseRecurringHistory.dataset.recurringHistoryCollapse, RECURRING_HISTORY_INITIAL);
    renderRecurringTasks();
    return;
  }
  const editRecurring = target.closest('[data-edit-recurring]');
  if (editRecurring) { openRecurringEditor(d.recurringTasks.find(item => String(item.id) === editRecurring.dataset.editRecurring)); return; }
  const stopRecurring = target.closest('[data-stop-recurring]');
  if (stopRecurring) {
    const template = d.recurringTasks.find(item => String(item.id) === stopRecurring.dataset.stopRecurring);
    if (template) { template.active = false; save(); renderRecurringTasks(); toast('반복을 중단했어. 이미 생성된 작업 기록은 유지돼.'); }
    return;
  }
  const resumeRecurring = target.closest('[data-resume-recurring]');
  if (resumeRecurring) {
    const template = d.recurringTasks.find(item => String(item.id) === resumeRecurring.dataset.resumeRecurring);
    if (template && !template.active) {
      template.active = true;
      ensureRecurringInstances(todayKey());
      save();
      render();
      toast('반복 작업을 재개했어. 중단 기간의 작업은 소급 생성하지 않아.');
    }
    return;
  }
  const deleteRecurring = target.closest('[data-delete-recurring]');
  if (deleteRecurring) {
    if (!confirm('반복 작업 설정만 삭제할까? 이미 생성된 날짜별 작업 기록은 유지돼.')) return;
    d.recurringTasks = d.recurringTasks.filter(item => String(item.id) !== deleteRecurring.dataset.deleteRecurring);
    save(); renderRecurringTasks(); toast('반복 설정을 삭제했어. 기존 기록은 유지돼.'); return;
  }
  if (target.id === 'saveRecurring') {
    const name = $('recurringName').value.trim(), frequency = $('recurringFrequency').value;
    const startDate = $('recurringStartDate').value, endDate = $('recurringEndDate').value || null;
    const estimatedMinutes = Number($('recurringMinutes').value), projectId = $('recurringProject').value || null;
    const stageId = $('recurringStage').value || null;
    const weekday = Number($('recurringWeekday').value), monthday = Number($('recurringMonthday').value);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || (endDate && endDate < startDate)) { toast('작업명과 유효한 시작일/종료일을 확인해줘.'); return; }
    if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 1440) { toast('예상 시간은 1~1440분으로 입력해줘.'); return; }
    if ((frequency === 'weekly' && (weekday < 0 || weekday > 6)) || (frequency === 'monthly' && (!Number.isInteger(monthday) || monthday < 1 || monthday > 31))) { toast('반복 요일이나 날짜를 확인해줘.'); return; }
    const project = projectId ? d.projects.find(item => String(item.id) === projectId) : null;
    if (projectId && !project) { toast('연결할 프로젝트를 찾을 수 없어.'); return; }
    if (stageId && !project?.stages.some(item => String(item.id) === stageId)) { toast('선택한 단계가 프로젝트에 없어.'); return; }
    const existing = d.recurringTasks.find(item => String(item.id) === target.dataset.id);
    const template = { ...(existing || {}), id: existing?.id || `recurring-${Date.now()}`, name, frequency, weekday, monthday, startDate, endDate, estimatedMinutes, projectId: project?.id ?? null, stageId: stageId ? project?.stages.find(item => String(item.id) === stageId)?.id ?? null : null, active: existing?.active ?? true };
    if (existing) Object.assign(existing, template); else d.recurringTasks.push(template);
    ensureRecurringInstances(todayKey()); save(); closeModal(); render(); renderRecurringTasks(); toast('반복 작업 설정을 저장했어. 이미 기록된 날짜는 바뀌지 않아.'); return;
  }
  if (target.id === 'savePlannedTask') {
    const name = $('plannedTaskName').value.trim();
    const minutes = Number($('plannedTaskMinutes').value);
    if (!name) { toast('작업명을 입력해줘.'); return; }
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) { toast('예상 시간은 1~1440분의 정수로 입력해줘.'); return; }
    const mode = $('plannedMode').value;
    let project = null, stage = null;
    if (mode === 'existing') {
      project = allProjects().find(item => String(item.id) === $('plannedProject').value);
      stage = project?.stages.find(item => String(item.id) === $('plannedStage').value);
      if (!project || !stage) { toast('프로젝트와 단계를 선택해줘.'); return; }
    } else if (mode === 'newProject') {
      const projectName = $('plannedProjectName').value.trim();
      if (!projectName) { toast('새 프로젝트 이름을 입력해줘.'); return; }
      project = createProjectRecord(projectName, '', 3, null, name, 0);
      stage = project.stages[0];
    }
    const remaining = stage ? stageRemainingMinutes(stage, activePlan()) : Infinity;
    if (stage && remaining <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); return; }
    const assignedMinutes = Number.isFinite(remaining) ? Math.min(minutes, remaining) : minutes;
    const item = {
      id: `planned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name, projectId: project?.id ?? null, stageId: stage?.id ?? null,
      minutes: stage ? Number(stage.estimatedMinutes) || 0 : minutes, plannedMinutes: assignedMinutes,
      estimatedMinutes: stage ? Number(stage.estimatedMinutes) || 0 : 0,
      actualMinutes: 0, progress: stage ? stageProgress(stage) : 0, dailyProgress: 0, stageProgressApplied: 0,
      progressMode: 'manual', done: false, isExtra: true, date: todayKey()
    };
    if (pendingPlan !== null) {
      if (project && !d.projects.some(item => item.id == project.id) && !pendingProjects.some(item => item.id == project.id)) pendingProjects.push(project);
      pendingPlan.push(item);
    } else {
      if (project && !d.projects.some(item => item.id == project.id)) d.projects.push(project);
      d.plan.push(item);
      save();
    }
    closeModal(); render(); toast(assignedMinutes < minutes ? `남은 단계 작업량에 맞춰 ${assignedMinutes}분 배정했어.` : '오늘 계획에 추가했어.'); return;
  }
  if (target.id === 'savePlannedTaskEdit') {
    const item = activePlan().find(task => String(task.id) === target.dataset.id);
    const name = $('editPlannedTaskName').value.trim();
    const minutes = Number($('editPlannedTaskMinutes').value);
    if (!item || !name) { toast('작업명을 입력해줘.'); return; }
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) { toast('배정 시간은 1~1440분의 정수로 입력해줘.'); return; }
    item.name = name;
    const stage = d.projects.find(project => String(project.id) === String(item.projectId))?.stages.find(candidate => String(candidate.id) === String(item.stageId));
    const remaining = stage ? stageRemainingMinutes(stage, activePlan(), item.id) : Infinity;
    if (stage && remaining <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); return; }
    item.plannedMinutes = Number.isFinite(remaining) ? Math.min(minutes, remaining) : minutes;
    if (pendingPlan === null) syncPlanToProject(item);
    if (pendingPlan === null) save();
    closeModal(); render(); toast('계획 작업을 수정했어.'); return;
  }
  const editPlanButton = target.closest('[data-plan-edit]');
  if (editPlanButton) { openEditPlannedTask(editPlanButton.dataset.planEdit); return; }
  const movePlanButton = target.closest('[data-plan-move]');
  if (movePlanButton) {
    const tasks = activePlan();
    const index = tasks.findIndex(item => String(item.id) === movePlanButton.dataset.id);
    const nextIndex = index + (movePlanButton.dataset.planMove === 'up' ? -1 : 1);
    if (index >= 0 && nextIndex >= 0 && nextIndex < tasks.length) {
      [tasks[index], tasks[nextIndex]] = [tasks[nextIndex], tasks[index]];
      commitActivePlanEdit();
    }
    return;
  }
  const removePlanButton = target.closest('[data-plan-remove]');
  if (removePlanButton) {
    const tasks = activePlan();
    const index = tasks.findIndex(item => String(item.id) === removePlanButton.dataset.planRemove);
    if (index < 0) return;
    if (!window.confirm('오늘 계획에서 제외하시겠습니까?')) return;
    if (tasks[index].done && !window.confirm('완료한 작업을 오늘 계획에서 제외할까? 완료 기록은 유지돼.')) return;
    tasks[index].planExcluded = true;
    if (pendingPlan === null) save();
    render();
    toast('오늘 계획에서 작업을 제외했어. 프로젝트 진행 기록은 유지돼.');
    return;
  }
  if (target.id === 'recalculatePlan') { recalculateFromNow(); return; }
  if (target.id === 'cancelPlanProposal') { proposalDraft = null; proposalMeta = null; closeModal(); return; }
  if (target.id === 'stagePlanProposal') {
    if (!proposalDraft || !proposalMeta) return;
    const rows = new Map([...document.querySelectorAll('[data-proposal-row]')].map(row => [row.dataset.proposalRow, row]));
    const stagedPlan = proposalDraft.flatMap(item => {
      if (item.planExcluded) return [{ ...item }];
      const row = rows.get(String(item.id));
      if (!row) return [];
      const minutesInput = row.querySelector('[data-proposal-minutes]');
      if (minutesInput) {
        const minutes = Math.max(0, Math.round(Number(minutesInput.value) || 0));
        if (!minutes) return [];
        item.plannedMinutes = minutes;
      }
      return [{ ...item }];
    });
    const proposedMinutes = stagedPlan.filter(item => !item.planExcluded && !item.done && !item.isExtra).reduce((sum, item) => sum + plannedMinutes(item), 0);
    if (proposedMinutes > Math.floor(proposalMeta.available * DEFAULT_PLAN_UTILIZATION)) { toast('새 작업 시간이 남은 계획 시간보다 길어. 시간을 줄이거나 작업을 제외해줘.'); return; }
    pendingPlan = stagedPlan;
    pendingPlanMeta = proposalMeta;
    proposalDraft = null; proposalMeta = null; closeModal(); render(); return;
  }
  const removeProposal = target.closest('[data-remove-proposal]');
  if (removeProposal) { removeProposal.closest('[data-proposal-row]').remove(); return; }
  if (target.id === 'cancelPlanChange') { planChangeDraft = null; closeModal(); if (!planChangeHadPreview) { pendingPlan = null; pendingPlanMeta = null; pendingProjects = []; render(); } return; }
  if (target.id === 'discardPlanPreview') { pendingPlan = null; pendingPlanMeta = null; pendingProjects = []; render(); return; }
  if (target.id === 'addTodayTaskFromReview') { openAddTodayTask(); return; }
  if (target.id === 'openReviewSummary') { show('evening'); return; }
  const reviewDate = target.closest('[data-review-date]'); if (reviewDate) { selectedReviewDate = reviewDate.dataset.reviewDate; renderReviewCalendar(); return; }
  if (target.id === 'confirmReview') { reviewStep = reviewablePlan().some(item => !item.done) ? 'defer' : 'summary'; if (reviewStep === 'summary') finalizeReview(); else renderEvening(); return; }
  if (target.id === 'editReview') { reviewStep = 'edit'; renderEvening(); return; }
  if (target.id === 'saveReviewEdits') { activePlan().forEach(item => { const done = document.querySelector(`[data-review-done="${item.id}"]`); const progress = document.querySelector(`[data-review-progress="${item.id}"]`); const actual = document.querySelector(`[data-review-actual="${item.id}"]`); if (actual) item.actualMinutes = Math.max(0, Math.round(Number(actual.value) || 0)); if (progress) { let value = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0))); if (done && done.checked !== item.done) value = done.checked ? 100 : 0; setTaskDailyProgress(item, value); } else if (done && done.checked !== item.done) setTaskDailyProgress(item, done.checked ? 100 : 0); if (actual) syncPlanActualToProject(item); }); reviewStep = reviewablePlan().some(item => !item.done) ? 'defer' : 'summary'; if (reviewStep === 'summary') finalizeReview(); else renderEvening(); return; }
  if (target.id === 'finalizeReview') { finalizeReview(); return; }
  if (target.id === 'saveExtraTask') {
    const name = $('extraName').value.trim(), actual = Math.max(0, Math.round(Number($('extraActual').value) || 0)), selected = $('extraLink').value;
    if (!name) return;
    let projectId = null, stageId = null, estimatedMinutes = 0, progress = Math.max(0, Math.min(100, Math.round(Number($('extraProgress').value) || 0)));
    if (selected) { [projectId, stageId] = selected.split(':'); const project = d.projects.find(item => item.id == projectId), stage = project?.stages.find(item => item.id == stageId); estimatedMinutes = Number(stage?.estimatedMinutes) || 0; }
    const item = { id: `extra-${Date.now()}`, name, projectId, stageId, minutes: actual, plannedMinutes: actual, estimatedMinutes, actualMinutes: actual, progress, dailyProgress: progress, stageProgressApplied: 0, progressMode: 'manual', done: progress === 100, isExtra: true, projectActualApplied: Boolean(selected), date: todayKey() };
    if (selected) { const project = d.projects.find(candidate => candidate.id == projectId); const stage = project?.stages.find(candidate => candidate.id == stageId); if (stage) stage.actualMinutes = (Number(stage.actualMinutes) || 0) + actual; }
    d.plan.push(item); if (pendingPlan !== null) pendingPlan.push({ ...item }); syncPlanToProject(item);
    if (d.dailyReviews[todayKey()]?.confirmed) {
      const review = d.dailyReviews[todayKey()];
      const recordedIds = new Set((review.tasks || []).map(planItem => String(planItem.id)));
      review.tasks = [...(review.tasks || []), ...reviewablePlan().filter(planItem => !recordedIds.has(String(planItem.id))).map(planItem => snapshotPlanTask(planItem))];
    }
    save(); closeModal(); render(); toast('오늘 한 일로 기록했어.'); return;
  }
  const eventButton = target.closest('[data-event-id]'); if (eventButton) { editEvent(eventButton.dataset.eventId); return; }
  const projectMove = target.closest('[data-project-move]'); if (projectMove) {
    if (projectSortMode !== 'manual') { toast('직접 정렬을 선택한 뒤 순서를 바꿔줘.'); return; }
    const activeIndexes = d.projects.map((project, index) => project.status === '완료' ? -1 : index).filter(index => index >= 0);
    const currentIndex = d.projects.findIndex(project => String(project.id) === projectMove.dataset.id);
    const activePosition = activeIndexes.indexOf(currentIndex);
    const nextPosition = activePosition + (projectMove.dataset.projectMove === 'up' ? -1 : 1);
    if (activePosition < 0 || nextPosition < 0 || nextPosition >= activeIndexes.length) return;
    const swapIndex = activeIndexes[nextPosition];
    [d.projects[currentIndex], d.projects[swapIndex]] = [d.projects[swapIndex], d.projects[currentIndex]];
    save(); render(); return;
  }
  const stageMove = target.closest('[data-stage-move]'); if (stageMove) {
    const row = stageMove.closest('.stage-row');
    const neighbor = stageMove.dataset.stageMove === 'up' ? row?.previousElementSibling : row?.nextElementSibling;
    if (!row || !neighbor?.classList.contains('stage-row')) return;
    if (stageMove.dataset.stageMove === 'up') neighbor.before(row); else neighbor.after(row);
    const rows = [...document.querySelectorAll('#stageEditor .stage-row')];
    rows.forEach((stageRow, index) => {
      stageRow.querySelector('[data-stage-move="up"]').disabled = index === 0;
      stageRow.querySelector('[data-stage-move="down"]').disabled = index === rows.length - 1;
    });
    return;
  }
  const projectButton = target.closest('[data-project-id]'); if (projectButton) { editProject(projectButton.dataset.projectId); return; }
  const check = target.closest('[data-task-check]'); if (check) { const item = activePlan().find(planItem => planItem.id == check.dataset.taskCheck); if (item) { const progress = item.done ? 0 : 100; if (pendingPlan === null) { const savedItem = d.plan.find(planItem => planItem.id == item.id); if (savedItem) { setTaskDailyProgress(savedItem, progress); save(); } } else setTaskDailyProgress(item, progress, false); render(); if (progress === 100) { const completedCheck = document.querySelector(`[data-task-check="${item.id}"]`); completedCheck?.classList.add('pop'); if (!item.actualMinutes) document.querySelector(`[data-task-actual="${item.id}"]`)?.focus(); toast('팡! 오늘 배정량을 완료했어 🌿 실제 시간을 적어둘까?'); } } return; }
  const deleteCapture = target.closest('[data-delete-capture]'); if (deleteCapture) { d.captures = d.captures.filter(capture => capture.id !== deleteCapture.dataset.deleteCapture); save(); renderCaptures(); return; }
  const deleteStage = target.closest('[data-delete-stage]'); if (deleteStage) { target.closest('.stage-row').remove(); return; }
  const swap = target.closest('[data-swap-i]'); if (swap && planChangeDraft) { const index = Number(swap.dataset.swapI); if (swap.dataset.rest) planChangeDraft.splice(index, 1); else { const project = d.projects.find(item => item.id == swap.dataset.p); const stage = project?.stages.find(item => item.progress < 100); if (!project || !stage) return; const minutes = Math.min(stage.estimatedMinutes || 60, stageRemainingMinutes(stage, planChangeDraft.filter((_, itemIndex) => itemIndex !== index))); if (minutes <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); return; } planChangeDraft[index] = { ...planChangeDraft[index], projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name}`, estimatedMinutes: stage.estimatedMinutes || 60, minutes, plannedMinutes: minutes, actualMinutes: 0, progress: stageProgress(stage), dailyProgress: 0, stageProgressApplied: 0, progressMode: 'manual', done: false, date: todayKey() }; } openPlanChangeModal(); return; }
  if (target.id === 'applyPlanChange' && planChangeDraft) { pendingPlan = planChangeDraft.map(item => ({ ...item })); pendingPlanMeta = pendingPlanMeta || { available: workCapacity().available, mode: 'basic' }; planChangeDraft = null; closeModal(); render(); return; }
  if (target.id === 'addStage') { const row = document.createElement('div'); row.className = 'stage-row'; const id = `new-${Date.now()}`; row.innerHTML = `<label>단계 이름<input class="input stage-name" data-stage-name="${id}" placeholder="단계 이름"></label><label>진행률 (%)<input class="input stage-number" type="number" min="0" max="100" step="1" data-stage-progress="${id}" value="0"></label><label>예상 소요시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-estimate="${id}" value="0"></label><label>실제 작업시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-actual="${id}" value="0"></label><div class="stage-order-actions"><button class="secondary small-button" data-stage-move="up" data-id="${id}" aria-label="새 단계 위로 이동" disabled>↑</button><button class="secondary small-button" data-stage-move="down" data-id="${id}" aria-label="새 단계 아래로 이동">↓</button><button class="danger small-button" data-delete-stage="${id}">삭제</button></div></div>`; $('stageEditor').appendChild(row); const rows = [...document.querySelectorAll('#stageEditor .stage-row')]; rows.forEach((stageRow, index) => { stageRow.querySelector('[data-stage-move="up"]').disabled = index === 0; stageRow.querySelector('[data-stage-move="down"]').disabled = index === rows.length - 1; }); return; }
  if (target.id === 'addEveningWork') { const suggestion = eveningSuggestion(); if (suggestion) { const project = d.projects.slice().sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity)).find(candidate => candidate.status !== '완료' && candidate.stages.some(stage => stage.progress < 100)); const stage = project?.stages.find(item => item.progress < 100); if (project && stage) { const remaining = stageRemainingMinutes(stage, activePlan()); const minutes = Math.min(suggestion.minutes, Number.isFinite(remaining) ? remaining : suggestion.minutes); if (minutes > 0) { const item = { id: `evening-${Date.now()}`, projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name} (저녁)`, minutes, plannedMinutes: minutes, estimatedMinutes: stage.estimatedMinutes || minutes, actualMinutes: 0, progress: stageProgress(stage), dailyProgress: 0, stageProgressApplied: 0, progressMode: 'manual', done: false, evening: true, date: todayKey() }; d.plan.push(item); syncPlanToProject(item); save(); render(); toast('저녁 작업을 오늘 계획에 추가했어.'); } } } return; }
  if (target.id === 'skipEveningWork') { $('eveningSuggestion').innerHTML = '<div class="muted">오늘은 여기까지 하기로 했어.</div>'; return; }
  if (target.id === 'saveEvent') { const name = $('eventName').value.trim(); if (name && $('eventDate').value && $('eventTime').value) { d.events.push({ id: Date.now(), date: $('eventDate').value, time: $('eventTime').value, end: $('eventEnd').value, name, source: 'jumji', preparationMinutes: Number($('eventPreparation').value) }); save(); closeModal(); render(); toast('일정을 저장했어.'); } return; }
  if (target.id === 'updateEvent') { const item = d.events.find(eventItem => eventItem.id == target.dataset.id); if (item) { item.date = $('eventDate').value; item.time = $('eventTime').value; item.end = $('eventEnd').value; item.name = $('eventName').value.trim(); item.preparationMinutes = Number($('eventPreparation').value); save(); closeModal(); render(); toast('일정을 수정했어.'); } return; }
  if (target.id === 'deleteEvent') { d.events = d.events.filter(eventItem => eventItem.id != target.dataset.id); save(); closeModal(); render(); return; }
  if (target.id === 'recommendAgain') { closeModal(); recommend(); return; }
  if (target.id === 'saveProject') { const name = $('projectName').value.trim(); if (name) { const deadline = $('newNoDeadline')?.checked ? null : $('projectDeadline').value || null; d.projects.push(createProjectRecord(name, $('projectDescription').value.trim(), Math.max(1, Math.min(5, Number($('projectImportance').value) || 3)), deadline)); save(); closeModal(); render(); } return; }
  if (target.id === 'deleteProject') { d.projects = d.projects.filter(project => project.id != target.dataset.id); d.plan = d.plan.filter(item => item.projectId != target.dataset.id); save(); closeModal(); render(); return; }
  if (target.id === 'updateProject') { const project = d.projects.find(item => item.id == target.dataset.id); if (project) { const rows = [...document.querySelectorAll('.stage-row')]; project.name = $('editProjectName').value.trim(); project.description = $('editProjectDescription').value.trim(); project.importance = Math.max(1, Math.min(5, Number($('editProjectImportance').value) || 3)); project.deadline = $('noDeadline').checked ? null : $('editProjectDeadline').value || null; project.status = $('editProjectStatus').value; project.stages = rows.map(row => { const id = row.querySelector('[data-stage-name]').dataset.stageName; const oldStage = project.stages.find(stage => String(stage.id) === id); const progressInput = row.querySelector('[data-stage-progress]'); return { id, name: row.querySelector('.stage-name').value.trim() || '새 단계', progress: clampProgress(progressInput.value), progressMode: oldStage && Number(progressInput.value) === Number(oldStage.progress) ? oldStage.progressMode : 'manual', estimatedMinutes: Math.max(0, Math.round(Number(row.querySelector('[data-stage-estimate]').value) || 0)), actualMinutes: Math.max(0, Math.round(Number(row.querySelector('[data-stage-actual]').value) || 0)) }; }); syncProjectProgress(project); save(); closeModal(); render(); } return; }
  const defer = target.closest('[data-defer-reason]'); if (defer) { d.deferReasons[defer.dataset.deferReason] = defer.value; save(); return; }
  const note = target.closest('[data-defer-note]'); if (note) { note.addEventListener('change', () => { if (note.value.trim()) { d.deferReasons[note.dataset.deferNote] = note.value.trim(); save(); } }); return; }
});
document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'plannedMode') {
    $('plannedExistingFields').classList.toggle('hidden', target.value !== 'existing');
    $('plannedNewProjectFields').classList.toggle('hidden', target.value !== 'newProject');
    return;
  }
  if (target.id === 'plannedProject') { populatePlannedStages(); return; }
  const progress = target.closest('[data-task-progress], [data-task-percent]');
  if (progress) {
    const item = activePlan().find(planItem => planItem.id == (progress.dataset.taskProgress || progress.dataset.taskPercent));
    if (item) {
      const savedItem = pendingPlan === null ? d.plan.find(planItem => planItem.id == item.id) : null;
      const value = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0)));
      if (savedItem) { setTaskDailyProgress(savedItem, value); save(); }
      else setTaskDailyProgress(item, value, false);
      const dailyProgress = taskDailyProgress(item);
      const task = progress.closest('.task');
      task.querySelector('[data-task-progress]').value = dailyProgress;
      task.querySelector('[data-task-percent]').value = dailyProgress;
      task.querySelector('.check').classList.toggle('checked', item.done);
      task.querySelector('.check').textContent = item.done ? '✓' : '';
      task.classList.toggle('done', item.done);
      task.querySelector('.taskline b').textContent = `${item.name} · 오늘 ${progressLabel(dailyProgress)}`;
      const stage = d.projects.find(project => project.id == item.projectId)?.stages.find(candidate => candidate.id == item.stageId);
      if (stage && task.querySelector('.stage-progress-label')) task.querySelector('.stage-progress-label').textContent = `단계 전체 진척도 ${percentText(stageProgress(stage))}`;
    }
    return;
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'projectSort') { projectSortMode = event.target.value; renderProjectList(); return; }
  if (event.target.id === 'plannedMode') {
    $('plannedExistingFields').classList.toggle('hidden', event.target.value !== 'existing');
    $('plannedNewProjectFields').classList.toggle('hidden', event.target.value !== 'newProject');
    return;
  }
  if (event.target.id === 'plannedProject') { populatePlannedStages(); return; }
  if (event.target.id === 'extraLink') {
    const [projectId, stageId] = event.target.value.split(':');
    const stage = d.projects.find(project => project.id == projectId)?.stages.find(item => item.id == stageId);
    if (stage) $('extraProgress').value = 0;
    return;
  }
  if (event.target.id === 'newNoDeadline') {
    $('projectDeadline').disabled = event.target.checked;
    if (event.target.checked) $('projectDeadline').value = '';
  }
  const actual = event.target.closest('[data-task-actual]');
  if (actual) {
    const item = activePlan().find(planItem => planItem.id == actual.dataset.taskActual);
    if (item) {
      item.actualMinutes = Math.max(0, Math.round(Number(actual.value) || 0));
      const savedItem = pendingPlan === null ? d.plan.find(planItem => planItem.id == item.id) : null;
      if (savedItem) {
        Object.assign(savedItem, { actualMinutes: item.actualMinutes });
        syncPlanActualToProject(savedItem);
        save();
      }
      render();
    }
  }
  const planned = event.target.closest('[data-plan-minutes]');
  if (planned) {
    const item = activePlan().find(planItem => String(planItem.id) === planned.dataset.planMinutes);
    if (item) {
      const minutes = Number(planned.value);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
        toast('예상 시간은 1~1440분의 정수로 입력해줘.');
        render();
        return;
      }
      const stage = allProjects().find(project => String(project.id) === String(item.projectId))?.stages.find(candidate => String(candidate.id) === String(item.stageId));
      const remaining = stage ? stageRemainingMinutes(stage, activePlan(), item.id) : Infinity;
      if (stage && remaining <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); render(); return; }
      item.plannedMinutes = Number.isFinite(remaining) ? Math.min(minutes, remaining) : minutes;
      const savedItem = pendingPlan === null ? d.plan.find(planItem => String(planItem.id) === String(item.id)) : null;
      if (savedItem) syncPlanToProject(savedItem);
      commitActivePlanEdit();
    }
    return;
  }
  const reviewNote = event.target.closest('[data-defer-note]');
  if (reviewNote) {
    d.deferReasons[`${reviewNote.dataset.deferNote}-note`] = reviewNote.value.trim();
    save();
  }
});
document.querySelectorAll('nav button').forEach(button => button.onclick = () => show(button.dataset.screen));
registerAppServiceWorker();
migrate(); ensureRecurringInstances(); render(); renderSettings();

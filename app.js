const KEY = 'jumji_v03';
const IMPORT_BACKUP_KEY = `${KEY}_preimport_backup`;
const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '17:00';
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_LUNCH_ENABLED = true;
const DEFAULT_LUNCH_MINUTES = 60;
const DEFAULT_FIKA_ENABLED = true;
const DEFAULT_FIKA_MINUTES = 60;
const DEFAULT_SETTINGS_FIKA_MINUTES = 30;
const DEFAULT_PLAN_UTILIZATION = 0.8;
const DEFAULT_PREPARATION_MINUTES = 30;
const EVENING_START = '20:00';
const EVENING_END = '22:00';
const PLAN_ENGINE = globalThis.JumjiPlannerEngine;
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
let pendingImportData = null;
let pendingImportSummary = null;
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

function migrate(target = d, { persistLegacyDates = target === d && Boolean(loaded) } = {}) {
  if (!Object.prototype.hasOwnProperty.call(target, 'workStart')) target.workStart = DEFAULT_WORK_START;
  if (!Object.prototype.hasOwnProperty.call(target, 'workEnd')) target.workEnd = DEFAULT_WORK_END;
  if (!Object.prototype.hasOwnProperty.call(target, 'workdays')) target.workdays = [...DEFAULT_WORKDAYS];
  if (!Object.prototype.hasOwnProperty.call(target, 'lunchEnabled')) target.lunchEnabled = DEFAULT_LUNCH_ENABLED;
  if (!Object.prototype.hasOwnProperty.call(target, 'lunchDuration')) target.lunchDuration = DEFAULT_LUNCH_MINUTES;
  if (!Object.prototype.hasOwnProperty.call(target, 'fikaEnabled')) target.fikaEnabled = DEFAULT_FIKA_ENABLED;
  if (!Object.prototype.hasOwnProperty.call(target, 'fikaDuration')) target.fikaDuration = DEFAULT_SETTINGS_FIKA_MINUTES;
  let assignedLegacyDates = false;
  target.projects = (target.projects || []).map(project => {
    const stages = Array.isArray(project.stages) ? project.stages : [{
      id: `${project.id}-legacy`, name: project.stage || '시작 전', progress: Number(project.progress) || 0,
      estimatedMinutes: 0, actualMinutes: 0
    }];
    const normalizedStages = stages.map(stage => ({ ...stage, progress: clampProgress(stage.progress), estimatedMinutes: Math.max(0, Math.round(Number(stage.estimatedMinutes) || 0)), actualMinutes: Math.max(0, Math.round(Number(stage.actualMinutes) || 0)), progressMode: stage.progressMode || 'auto' }));
    const progress = Number(project.progress) || 0;
    return { ...project, description: project.description || '', importance: Number(project.importance) || 3, deadline: project.deadline || null, status: project.status || '진행 중', stages: normalizedStages, progress, stage: project.stage || normalizedStages[0]?.name || '시작 전' };
  });
  target.events = (target.events || []).map(event => ({ ...event, preparationMinutes: [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES }));
  target.plan = (target.plan || []).map(item => {
    const hadDailyProgress = item.dailyProgress !== undefined && item.dailyProgress !== null && Number.isFinite(Number(item.dailyProgress));
    const dailyProgress = item.done ? 100 : Math.max(0, Math.min(100, Math.round(Number(item.dailyProgress) || 0)));
    const date = item.date || todayKey();
    const stage = target.projects.find(project => project.id == item.projectId)?.stages.find(candidate => candidate.id == item.stageId);
    const estimate = Number(stage?.estimatedMinutes) || 0;
    const stageProgressApplied = Number.isFinite(Number(item.stageProgressApplied))
      ? clampProgress(item.stageProgressApplied)
      : hadDailyProgress && estimate > 0 ? clampProgress(Math.min(100, plannedMinutes(item) / estimate * dailyProgress)) : 0;
    if (!item.date) assignedLegacyDates = true;
    return { ...item, estimatedMinutes: Number(item.estimatedMinutes ?? item.minutes) || 0, actualMinutes: Number(item.actualMinutes) || 0, minutes: Number(item.minutes ?? item.estimatedMinutes) || 0, dailyProgress, stageProgressApplied, progressMode: item.progressMode || 'auto', done: Boolean(item.done || dailyProgress === 100), date };
  });
  target.plan.forEach(item => syncPlanActualToProject(item, target.projects));
  target.captures = (target.captures || []).map((capture, index) => ({ ...capture, id: capture.id || `capture-${index}`, text: capture.text ?? capture.content ?? '', at: capture.at || capture.createdAt || new Date().toISOString() }));
  target.planAccepted = Boolean(target.planAccepted); target.deferReasons = target.deferReasons || {}; target.dailyReviews = target.dailyReviews || {}; target.recurringTasks = Array.isArray(target.recurringTasks) ? target.recurringTasks : []; target.recurringDecisions = target.recurringDecisions || {};
  target.projects.forEach(syncProjectProgress);
  if (persistLegacyDates && assignedLegacyDates && target === d && loaded) {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const original = JSON.parse(raw);
      if (original && typeof original === 'object' && !Array.isArray(original) && Array.isArray(original.plan)) {
        let changed = false;
        const plan = original.plan.map((item, index) => {
          if (!item.date && target.plan[index]) { changed = true; return { ...item, date: target.plan[index].date }; }
          return item;
        });
        if (changed) {
          original.plan = plan;
          localStorage.setItem(KEY, JSON.stringify(original));
        }
      }
    }
  }
  return target;
}
function save() { localStorage.setItem(KEY, JSON.stringify(d)); }
function persistSettings({ start, end, workdays, lunchEnabled, lunchDuration, fikaEnabled, fikaDuration }) {
  const rawData = localStorage.getItem(KEY);
  const storedData = rawData === null ? { ...d } : JSON.parse(rawData);
  if (!storedData || typeof storedData !== 'object' || Array.isArray(storedData)) throw new Error('저장된 점지 데이터 형식이 올바르지 않습니다.');
  storedData.workStart = start;
  storedData.workEnd = end;
  storedData.workdays = workdays;
  storedData.lunchEnabled = lunchEnabled;
  storedData.lunchDuration = lunchDuration;
  storedData.fikaEnabled = fikaEnabled;
  storedData.fikaDuration = fikaDuration;
  localStorage.setItem(KEY, JSON.stringify(storedData));
  d.workStart = start;
  d.workEnd = end;
  d.workdays = workdays;
  d.lunchEnabled = lunchEnabled;
  d.lunchDuration = lunchDuration;
  d.fikaEnabled = fikaEnabled;
  d.fikaDuration = fikaDuration;
}
function renderSettings() {
  $('workStartSetting').value = workStartTime();
  $('workEndSetting').value = workEndTime();
  document.querySelectorAll('[data-workday]').forEach(button => button.classList.toggle('selected', Array.isArray(d.workdays) && d.workdays.includes(Number(button.dataset.workday))));
  $('lunchEnabled').checked = Boolean(d.lunchEnabled);
  $('lunchDuration').value = String(Number(d.lunchDuration) || DEFAULT_LUNCH_MINUTES);
  $('fikaEnabled').checked = Boolean(d.fikaEnabled);
  $('fikaDuration').value = String(Number(d.fikaDuration) || DEFAULT_SETTINGS_FIKA_MINUTES);
  updateSettingsDurationState();
}
function updateSettingsDurationState() {
  $('lunchDuration').disabled = !$('lunchEnabled').checked;
  $('fikaDuration').disabled = !$('fikaEnabled').checked;
}
function importBackupEnvelope() {
  const raw = localStorage.getItem(IMPORT_BACKUP_KEY);
  if (!raw) return null;
  const envelope = JSON.parse(raw);
  if (envelope?.version !== 1 || typeof envelope.data !== 'string') throw new Error('가져오기 백업 형식이 올바르지 않습니다.');
  const parsed = JSON.parse(envelope.data);
  const validation = globalThis.JumjiImportData?.validateImportedData(parsed);
  if (!validation?.valid) throw new Error('가져오기 백업을 복구할 수 없습니다.');
  return { envelope, parsed };
}
function updateImportBackupActions() {
  let available = false;
  try { available = Boolean(localStorage.getItem(IMPORT_BACKUP_KEY)); } catch (error) { console.error('가져오기 백업에 접근하지 못했어.', error); }
  $('downloadImportBackup')?.classList.toggle('hidden', !available);
  $('restoreImportBackup')?.classList.toggle('hidden', !available);
}
function prepareImportCandidate(source) {
  return globalThis.JumjiImportData.prepareImportedData(source, candidate => migrate(candidate, { persistLegacyDates: false }));
}
function backupDataForImport(previousValue) {
  const backupData = previousValue === null ? JSON.stringify(d) : previousValue;
  let parsed;
  try { parsed = JSON.parse(backupData); } catch (cause) {
    const error = new Error('현재 저장 데이터를 읽을 수 없어 백업하지 못했어.', { cause });
    error.name = 'ImportBackupError';
    throw error;
  }
  const validation = globalThis.JumjiImportData?.validateImportedData(parsed);
  if (!validation?.valid) {
    const error = new Error('현재 저장 데이터를 복구 가능한 백업으로 확인하지 못했어. 가져오기를 중단했어.');
    error.name = 'ImportBackupError';
    throw error;
  }
  return backupData;
}
function currentDataBackupSnapshot() {
  try {
    const previousValue = localStorage.getItem(KEY);
    return { previousValue, backupData: backupDataForImport(previousValue) };
  } catch (cause) {
    if (cause.name === 'ImportBackupError') throw cause;
    const error = new Error('현재 저장 데이터를 읽지 못해 백업할 수 없어. 가져오기를 중단했어.', { cause });
    error.name = 'ImportBackupError';
    throw error;
  }
}
function downloadImportBackup() {
  try {
    const backup = importBackupEnvelope();
    if (!backup) { toast('가져오기 전 백업이 없어.'); updateImportBackupActions(); return; }
    const filename = `jumji_v03-preimport-backup-${todayKey()}.json`;
    const url = URL.createObjectURL(new Blob([backup.envelope.data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.hidden = true;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('가져오기 전 백업 파일 다운로드를 시작했어.');
  } catch (error) { console.error('가져오기 전 백업을 다운로드하지 못했어.', error); toast('백업에 접근하지 못했어. 복구 화면의 오류를 확인해줘.'); }
}
function restoreImportBackup() {
  let backup, candidate;
  try {
    backup = importBackupEnvelope();
    if (!backup) { toast('가져오기 전 백업이 없어.'); updateImportBackupActions(); return; }
    candidate = prepareImportCandidate(backup.parsed);
  } catch (error) { console.error('가져오기 전 백업을 준비하지 못했어.', error); toast('백업을 검증하거나 변환하지 못해 복구를 중단했어.'); return; }
  if (!window.confirm('저장된 데이터를 가져오기 전 백업으로 바꿀까? 현재 데이터는 복구 키에 다시 보관돼.')) return;
  try {
    const { previousValue, backupData } = currentDataBackupSnapshot();
    globalThis.JumjiImportData.commitImportedData({
      storage: localStorage, key: KEY, backupKey: IMPORT_BACKUP_KEY,
      previousValue, backupData,
      importedData: candidate, savedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('가져오기 전 백업을 복구하지 못했어.', error);
    toast(error.name === 'ImportBackupError' ? '복구 직전 데이터를 백업하지 못해 복구를 중단했어. 현재 데이터는 유지돼.' : '백업 복구 저장에 실패했어. 복구 키의 백업을 확인해줘.');
    updateImportBackupActions();
    return;
  }
  d = candidate;
  render(); renderSettings(); updateImportBackupActions();
  toast('백업을 복구했어. 복구 직전 데이터는 같은 복구 키에 보관돼.');
}
function confirmDataImport() {
  if (!pendingImportData) return;
  let importedData;
  try {
    importedData = prepareImportCandidate(pendingImportData);
  } catch (error) {
    console.error('가져온 데이터를 변환하지 못했어.', error);
    toast('가져온 데이터를 검증하거나 변환하지 못했어. 기존 데이터는 유지돼.');
    return;
  }
  try {
    const { previousValue, backupData } = currentDataBackupSnapshot();
    globalThis.JumjiImportData.commitImportedData({
      storage: localStorage, key: KEY, backupKey: IMPORT_BACKUP_KEY,
      previousValue, backupData,
      importedData, savedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('가져오기 백업 또는 저장에 실패했어.', error);
    updateImportBackupActions();
    if (error.name === 'ImportBackupError') toast('복구용 백업을 확보하지 못해 가져오기를 중단했어. 기존 데이터는 유지돼.');
    else toast(error.rollbackFailed ? '저장과 자동 복구가 모두 실패했어. 기록 화면의 복구 백업을 내려받아 확인해줘.' : '가져온 데이터를 저장하지 못했어. 기존 데이터는 유지돼. 복구 백업은 기록 화면에서 확인할 수 있어.');
    return;
  }
  d = importedData;
  pendingImportData = null; pendingImportSummary = null;
  closeModal(); updateImportBackupActions();
  render(); renderSettings();
  toast('데이터를 가져왔어. 가져오기 전 데이터는 기록 화면의 복구 백업에 보관돼.');
}
function cancelDataImport() {
  pendingImportData = null;
  pendingImportSummary = null;
  closeModal();
  toast('데이터 가져오기를 취소했어. 기존 데이터는 유지돼.');
}
async function importDataFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const validation = globalThis.JumjiImportData?.validateImportedData(parsed);
    if (!validation || !validation.valid) {
      const errors = validation?.errors || ['JSON 형식이 올바르지 않습니다.'];
      console.error('가져온 데이터 검증 실패', errors);
      toast(errors[0]);
      return;
    }
    const summary = globalThis.JumjiImportData.summarizeImportedData(parsed);
    pendingImportData = parsed;
    pendingImportSummary = summary;
    modal('데이터 가져오기 확인', `<div class="muted">파일: ${esc(file.name)}</div><div><b>${summary.projects}개 프로젝트</b>, <b>${summary.events}개 일정</b>, <b>${summary.plan}개 계획</b>, <b>${summary.captures}개 기록</b>으로 가져올 예정이야.</div><div class="muted">확정하면 현재 데이터가 이 브라우저의 복구 백업(${esc(IMPORT_BACKUP_KEY)})에 저장돼. 기록 화면에서 내려받거나 복구할 수 있어. 다음 가져오기는 이 복구 백업을 새 백업으로 바꿔.</div><button class="primary wide" id="confirmDataImport">가져오기 확정</button><button class="secondary wide" id="cancelDataImport">취소</button>`);
    $('confirmDataImport').onclick = confirmDataImport;
    $('cancelDataImport').onclick = cancelDataImport;
  } catch (error) {
    console.error('데이터 파일을 읽지 못했어.', error);
    toast('JSON 파일을 읽지 못했어. 파일 형식 또는 선택한 파일을 확인해줘.');
  }
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
function syncPlanActualToProject(item, projects = [...d.projects, ...pendingProjects]) {
  const project = projects.find(candidate => candidate.id == item.projectId);
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
function ensureRecurringInstances() { return false; }
function recurrenceOccurrenceKey(templateId, occurrenceDate) { return `${encodeURIComponent(String(templateId))}@${occurrenceDate}`; }
function isConfiguredWorkday(date) {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  return (Array.isArray(d.workdays) ? d.workdays.map(Number) : []).includes(weekday);
}
function nextConfiguredWorkday(date) {
  const candidate = new Date(`${date}T00:00:00`);
  for (let offset = 1; offset <= 366; offset++) {
    candidate.setDate(candidate.getDate() + 1);
    const key = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;
    if (isConfiguredWorkday(key)) return key;
  }
  return null;
}
function recurringOccurrenceRecorded(templateId, occurrenceDate) {
  return d.plan.some(item => String(item.recurringTaskId) === String(templateId)
    && String(item.recurringOccurrenceDate || item.date) === occurrenceDate)
    || (d.dailyReviews[occurrenceDate]?.tasks || []).some(item => String(item.recurringTaskId) === String(templateId));
}
function offDayRecurringTasks(date) {
  if (isConfiguredWorkday(date) || d.dailyReviews[date]?.confirmed) return [];
  const occurrences = new Map();
  d.recurringTasks.forEach(template => {
    const key = recurrenceOccurrenceKey(template.id, date);
    if (recurrenceMatches(template, date) && !d.recurringDecisions[key] && !recurringOccurrenceRecorded(template.id, date)) {
      occurrences.set(key, { template, occurrenceDate: date, deferred: false });
    }
  });
  Object.entries(d.recurringDecisions).forEach(([key, decision]) => {
    if (decision?.action !== 'defer' || decision.planDate > date) return;
    const template = d.recurringTasks.find(item => String(item.id) === String(decision.templateId));
    if (template && recurrenceMatches(template, decision.occurrenceDate) && !recurringOccurrenceRecorded(template.id, decision.occurrenceDate)) {
      occurrences.set(key, { template, occurrenceDate: decision.occurrenceDate, deferred: true });
    }
  });
  return [...occurrences.values()];
}
function recurringOccurrencesForPlanDate(date) {
  const occurrences = new Map();
  d.recurringTasks.forEach(template => {
    if (!recurrenceMatches(template, date)) return;
    const occurrenceDate = date;
    const decision = d.recurringDecisions[recurrenceOccurrenceKey(template.id, occurrenceDate)];
    if (decision?.action === 'defer' && decision.planDate > date) return;
    if (!recurringOccurrenceRecorded(template.id, occurrenceDate)) occurrences.set(recurrenceOccurrenceKey(template.id, occurrenceDate), { template, occurrenceDate });
  });
  Object.entries(d.recurringDecisions).forEach(([key, decision]) => {
    if (decision?.action !== 'defer' || decision.planDate > date || !isConfiguredWorkday(date)) return;
    const template = d.recurringTasks.find(item => String(item.id) === String(decision.templateId));
    if (!template || !recurrenceMatches(template, decision.occurrenceDate) || recurringOccurrenceRecorded(template.id, decision.occurrenceDate)) return;
    occurrences.set(key, { template, occurrenceDate: decision.occurrenceDate, deferred: true });
  });
  return [...occurrences.values()];
}
function latestUnfinishedHistory({ planDate, projectId = null, stageId = null, recurringTaskId = null }) {
  const records = new Map();
  const matches = item => recurringTaskId != null
    ? String(item.recurringTaskId) === String(recurringTaskId)
    : item.projectId != null && String(item.projectId) === String(projectId) && String(item.stageId) === String(stageId);
  const add = (item, date, fromReview = false) => {
    if (!date || date >= planDate || item.planExcluded || !matches(item)) return;
    if (!fromReview && item.recurringTaskId && !item.plannedByEngine && !item.done && taskDailyProgress(item) === 0 && Number(item.actualMinutes) <= 0) return;
    records.set(`${date}:${item.id}`, { ...item, date });
  };
  d.plan.forEach(item => add(item, item.date));
  Object.entries(d.dailyReviews).forEach(([date, review]) => (review.tasks || []).forEach(item => add(item, date, true)));
  const latest = [...records.values()].sort((left, right) => left.date.localeCompare(right.date) || String(left.id).localeCompare(String(right.id))).at(-1);
  return latest && !latest.done && taskDailyProgress(latest) < 100 ? latest : null;
}
function recurrenceDescription(template) {
  if (template.frequency === 'weekly') return `매주 ${['일', '월', '화', '수', '목', '금', '토'][Number(template.weekday)]}요일`;
  if (template.frequency === 'monthly') return `매월 ${template.monthday}일`;
  return '매일';
}
function recurringTaskHistory(template) {
  const records = new Map();
  const addRecord = (item, date) => {
    if (String(item.recurringTaskId) !== String(template.id) || !date || date > todayKey()) return;
    const occurrenceDate = item.recurringOccurrenceDate || date;
    const key = `${occurrenceDate}:${item.id}`;
    records.set(key, {
      date: item.date || date, occurrenceDate,
      deferred: Boolean(item.deferredOccurrence || occurrenceDate !== (item.date || date)),
      done: Boolean(item.done), dailyProgress: Number(item.dailyProgress) || 0,
      actualMinutes: Number(item.actualMinutes) || 0
    });
  };
  d.plan.forEach(item => {
    if (item.date) addRecord(item, item.date);
  });
  Object.entries(d.dailyReviews).forEach(([date, review]) => {
    if (date > todayKey()) return;
    (review.tasks || []).forEach(item => addRecord(item, date));
  });
  return [...records.values()]
    .sort((left, right) => right.date.localeCompare(left.date) || right.occurrenceDate.localeCompare(left.occurrenceDate));
}
function renderRecurringTasks() {
  if (!$('recurringList')) return;
  $('recurringList').innerHTML = d.recurringTasks.length ? d.recurringTasks.map(template => {
    const history = recurringTaskHistory(template);
    const shown = recurringHistoryLimits.get(String(template.id)) || RECURRING_HISTORY_INITIAL;
    const visibleHistory = history.slice(0, shown);
    const historyMarkup = history.length ? `<div class="recurring-history" aria-label="${esc(template.name)} 수행 기록"><b>최근 수행 기록</b><ul>${visibleHistory.map(record => `<li><time datetime="${esc(record.date)}">${record.deferred ? `${esc(dateLabel(record.occurrenceDate))} 회차 · ${esc(dateLabel(record.date))} 배정` : esc(dateLabel(record.date))}</time><span class="recurring-status"><i class="history-dot ${record.done ? 'is-done' : 'is-undone'}" aria-hidden="true"></i><span>${record.done ? '완료' : '미완료'}</span></span><span class="recurring-record-detail">${record.dailyProgress}% · ${record.actualMinutes}분</span></li>`).join('')}</ul>${history.length > RECURRING_HISTORY_INITIAL ? `<div class="recurring-history-actions">${shown < history.length ? `<button class="secondary small-button" data-recurring-history-more="${esc(template.id)}" aria-label="${esc(template.name)} 이전 기록 더보기">더보기</button>` : ''}${shown > RECURRING_HISTORY_INITIAL ? `<button class="secondary small-button" data-recurring-history-collapse="${esc(template.id)}">접기</button>` : ''}</div>` : ''}</div>` : '<div class="recurring-history-empty">아직 확인할 수행 기록이 없어.</div>';
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
  return configuredWorkCapacityForPlan(todayKey());
}
function configuredWorkCapacityForPlan(planDate = todayKey()) {
  const date = String(planDate || todayKey());
  const workday = new Date(`${date}T00:00:00`).getDay();
  const workdays = Array.isArray(d.workdays) ? d.workdays.map(Number) : [];
  if (!workdays.includes(workday)) return { base: 0, blocked: 0, available: 0, intervals: [] };
  const start = clockMinutes(workStartTime()), end = clockMinutes(workEndTime());
  const events = d.events.filter(event => !event.date || event.date === date);
  const intervals = freeWorkIntervals(events, start, end);
  const blocked = mergedBlockedMinutes(events, start, end);
  const lunchMinutes = d.lunchEnabled ? Math.max(0, Number(d.lunchDuration) || 0) : 0;
  const fikaMinutes = d.fikaEnabled ? Math.max(0, Number(d.fikaDuration) || 0) : 0;
  const base = Math.max(0, end - start - lunchMinutes - fikaMinutes);
  return { base, blocked, available: Math.max(0, base - blocked), intervals };
}
function remainingConfiguredWorkCapacity(now = new Date(), planDate = todayKey()) {
  const start = clockMinutes(workStartTime()), end = clockMinutes(workEndTime());
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const date = String(planDate || todayKey());
  const workday = new Date(`${date}T00:00:00`).getDay();
  const workdays = Array.isArray(d.workdays) ? d.workdays.map(Number) : [];
  if (!workdays.includes(workday)) return { available: 0, blocked: 0, remaining: 0, intervals: [] };
  const rangeStart = Math.max(start, nowMinutes);
  if (rangeStart >= end) return { available: 0, blocked: 0, remaining: 0, intervals: [] };
  const events = d.events.filter(event => !event.date || event.date === date);
  const remaining = end - rangeStart;
  const intervals = freeWorkIntervals(events, rangeStart, end);
  const blocked = mergedBlockedMinutes(events, rangeStart, end);
  const fullIntervals = freeWorkIntervals(events, start, end);
  const fullFreeMinutes = fullIntervals.reduce((sum, interval) => sum + interval[1] - interval[0], 0);
  const fullAvailable = configuredWorkCapacityForPlan(date).available;
  const workFactor = fullFreeMinutes ? fullAvailable / fullFreeMinutes : 0;
  const elapsedFreeMinutes = fullIntervals.reduce((sum, interval) => {
    const elapsedEnd = Math.min(interval[1], rangeStart);
    return sum + Math.max(0, elapsedEnd - interval[0]);
  }, 0);
  const available = Math.max(0, Math.floor(fullAvailable - elapsedFreeMinutes * workFactor));
  return { available, blocked, remaining, intervals };
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
  if (!isConfiguredWorkday(todayKey()) || !evening.minutes) return null;
  const urgent = d.projects.some(project => project.deadline && Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000) <= 7 && project.progress < 100);
  const remaining = d.projects.reduce((sum, project) => sum + project.stages.filter(stage => stage.progress < 100).reduce((stageSum, stage) => stageSum + (Number(stage.estimatedMinutes) || 0), 0), 0);
  const daysToDeadline = d.projects.filter(project => project.deadline && project.progress < 100).map(project => Math.max(1, Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000)));
  const overloaded = daysToDeadline.length && remaining > capacity.available * Math.min(...daysToDeadline);
  if (!(urgent || capacity.available < 120 || overloaded)) return null;
  return { minutes: Math.min(120, evening.minutes), start: evening.start };
}
function riskFor(project) { if (!project.deadline) return 'green'; const days = Math.ceil((new Date(`${project.deadline}T00:00:00`) - new Date()) / 86400000); if (days <= 7 && project.progress < 70) return 'red'; if (days <= 21 && project.progress < 50) return 'yellow'; return 'green'; }
function buildPlanProposal(availableMinutesForPlan, intervals, planDate = todayKey()) {
  const current = (pendingPlan || d.plan).filter(item => isPlanForDate(item, planDate));
  const excluded = current.filter(item => item.planExcluded).map(item => ({ ...item }));
  const preserved = current.filter(item => {
    if (item.planExcluded) return false;
    return d.planAccepted || item.done || item.isExtra || Number(item.actualMinutes) > 0 || taskDailyProgress(item) > 0
      || (item.recurringTaskId && (d.planAccepted || !d.recurringTasks.some(template => String(template.id) === String(item.recurringTaskId))));
  }).map(item => ({ ...item }));
  const fixedIds = new Set([...preserved, ...excluded].map(item => String(item.id)));
  const preservedStages = new Set([...preserved, ...excluded].filter(item => item.projectId != null && item.stageId != null).map(item => `${item.projectId}:${item.stageId}`));
  const candidateContext = [...preserved, ...excluded];
  const candidatePool = [];
  const existingOccurrence = (templateId, occurrenceDate) => current.find(item => String(item.recurringTaskId) === String(templateId)
    && String(item.recurringOccurrenceDate || item.date) === occurrenceDate);

  if (!d.dailyReviews[planDate]?.confirmed && Number(availableMinutesForPlan) > 0) {
    d.projects.filter(project => project.status === '진행 중').forEach(project => {
      const stage = project.stages.find(item => stageProgress(item) < 100);
      if (!stage || preservedStages.has(`${project.id}:${stage.id}`)) return;
      const estimatedMinutes = Number(stage.estimatedMinutes) || (project.deadline ? 90 : 60);
      const stageRemaining = stageRemainingMinutes(stage, candidateContext);
      const remainingMinutes = Math.max(0, Math.floor(Math.min(estimatedMinutes, Number.isFinite(stageRemaining) ? stageRemaining : estimatedMinutes)));
      if (!remainingMinutes) return;
      const history = latestUnfinishedHistory({ planDate, projectId: project.id, stageId: stage.id });
      candidatePool.push({
        id: `proposal-${planDate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${candidatePool.length}`,
        kind: 'project', projectId: project.id, stageId: stage.id,
        name: `${project.name} · ${stage.name}`, deadline: /^\d{4}-\d{2}-\d{2}$/.test(project.deadline || '') ? project.deadline : null,
        importance: project.importance, estimatedMinutes, remainingMinutes, stageRemainingMinutes: remainingMinutes,
        allocationGroup: `${project.id}:${stage.id}`, groupRemainingMinutes: remainingMinutes,
        hasUnfinishedHistory: Boolean(history), carryoverOf: history?.id ?? null,
        progress: stageProgress(stage), actualMinutes: 0, dailyProgress: 0, stageProgressApplied: 0,
        progressMode: 'manual', done: false, date: planDate
      });
    });

    const recurrenceEntries = recurringOccurrencesForPlanDate(planDate);
    current.filter(item => item.recurringTaskId && !fixedIds.has(String(item.id))).forEach(item => {
      const occurrenceDate = item.recurringOccurrenceDate || item.date;
      const template = d.recurringTasks.find(candidate => String(candidate.id) === String(item.recurringTaskId));
      if (!template || !recurrenceMatches(template, occurrenceDate)) return;
      if (!recurrenceEntries.some(entry => String(entry.template.id) === String(template.id) && entry.occurrenceDate === occurrenceDate)) {
        recurrenceEntries.push({ template, occurrenceDate, existing: item });
      }
    });

    recurrenceEntries.forEach(({ template, occurrenceDate, deferred, existing }) => {
      const prior = existing || existingOccurrence(template.id, occurrenceDate);
      if (prior && fixedIds.has(String(prior.id))) return;
      const project = d.projects.find(item => String(item.id) === String(template.projectId));
      const stage = project?.stages.find(item => String(item.id) === String(template.stageId));
      if (template.projectId && (!project || project.status !== '진행 중')) return;
      if (template.stageId && (!stage || stageProgress(stage) >= 100)) return;
      const stageRemaining = stage ? stageRemainingMinutes(stage, candidateContext) : Infinity;
      const templateMinutes = Math.max(1, Number(template.estimatedMinutes) || 30);
      const remainingMinutes = Math.max(0, Math.floor(Math.min(templateMinutes, Number.isFinite(stageRemaining) ? stageRemaining : templateMinutes)));
      if (!remainingMinutes) return;
      const history = latestUnfinishedHistory({ planDate, recurringTaskId: template.id });
      const decision = d.recurringDecisions[recurrenceOccurrenceKey(template.id, occurrenceDate)];
      candidatePool.push({
        id: prior?.id || `repeat-${template.id}-${occurrenceDate}`,
        kind: 'recurring', recurringTaskId: template.id, recurringOccurrenceDate: occurrenceDate,
        recurrenceDecisionKey: decision?.action === 'defer' ? recurrenceOccurrenceKey(template.id, occurrenceDate) : null,
        projectId: project?.id ?? null, stageId: stage?.id ?? null,
        name: prior?.name || template.name, deadline: /^\d{4}-\d{2}-\d{2}$/.test(project?.deadline || '') ? project.deadline : null,
        importance: project?.importance, estimatedMinutes: templateMinutes, remainingMinutes,
        stageRemainingMinutes: stage ? remainingMinutes : null,
        allocationGroup: stage ? `${project.id}:${stage.id}` : null, groupRemainingMinutes: stage ? remainingMinutes : null,
        hasUnfinishedHistory: Boolean(history), carryoverOf: history?.id ?? null,
        progress: stage ? stageProgress(stage) : 0, actualMinutes: 0, dailyProgress: 0,
        stageProgressApplied: 0, progressMode: 'manual', done: false, isCarryover: Boolean(history),
        deferredOccurrence: Boolean(deferred || decision?.action === 'defer'), date: planDate
      });
    });
  }

  const allocation = PLAN_ENGINE.allocateCandidates(candidatePool, availableMinutesForPlan, {
    reservedMinutes: totalPlanned(preserved), utilization: DEFAULT_PLAN_UTILIZATION,
    slots: usableWorkSlots(intervals, availableMinutesForPlan), planDate
  });
  const candidates = allocation.allocations.map(item => ({
    ...item,
    minutes: item.plannedMinutes,
    plannedMinutes: item.plannedMinutes,
    proposalCandidate: true,
    isCarryover: Boolean(item.carryoverOf)
  }));
  const proposal = [...preserved, ...excluded, ...candidates];
  Object.defineProperties(proposal, {
    unallocated: { value: allocation.unallocated, enumerable: false },
    allocationLimit: { value: allocation.allocationLimit, enumerable: false },
    reservedMinutes: { value: allocation.reserved, enumerable: false }
  });
  return proposal;
}
function openPlanProposal(available, mode, intervals, planDate = todayKey()) {
  proposalDraft = buildPlanProposal(available, intervals, planDate);
  proposalMeta = { available, mode, allocationLimit: proposalDraft.allocationLimit || 0, unallocated: proposalDraft.unallocated || [] };
  const rows = proposalDraft.filter(item => !item.planExcluded).map(item => {
    const candidate = Boolean(item.proposalCandidate);
    const label = item.recurringTaskId ? `반복 작업 · ${item.deferredOccurrence ? '이전 회차를 미룬 후보' : '이번 회차'}` : item.isCarryover ? '이전 미완료 작업에서 새로 제안' : '새 제안';
    return `<div class="proposal-row" data-proposal-row="${esc(item.id)}"><b>${esc(item.name)}</b><div class="detail">${candidate ? `${label} · ${esc(taskProjectLabel(item))} · 전체 예상 ${item.estimatedMinutes || item.minutes}분` : '기존 완료/기록/직접 추가 계획 · 유지'}</div>${candidate ? `<label class="label">오늘 배정 시간 (분)</label><input class="input proposal-minutes" type="number" min="0" max="${Math.min(Math.max(0, available), Number(item.remainingMinutes) || plannedMinutes(item))}" value="${plannedMinutes(item)}" data-proposal-minutes="${esc(item.id)}"><button class="secondary small-button" data-remove-proposal="${esc(item.id)}">이번 추천에서 제외</button>` : `<div class="detail">배정 ${plannedMinutes(item)}분 · 실제 ${item.actualMinutes || 0}분</div>`}</div>`;
  }).join('') || '<div class="event">남은 시간에 제안할 작업이 없어. 기존 계획은 유지돼.</div>';
  const unallocatedRows = proposalMeta.unallocated.map(item => `<div class="detail">미배정 · ${esc(item.name)} · ${item.unallocatedMinutes}분</div>`).join('');
  const offDayRows = offDayRecurringTasks(planDate).map(({ template, occurrenceDate, deferred }) => `<div class="proposal-row"><b>${esc(template.name)}</b><div class="detail">${esc(recurrenceDescription(template))} · 회차 ${esc(occurrenceDate)} · ${deferred ? '아직 미배정으로 남아 있어.' : '오늘은 작업 가능 요일이 아니야.'} 기존 반복 규칙과 기록은 유지돼.</div><button class="secondary small-button" data-offday-recurring="defer" data-id="${esc(template.id)}" data-date="${esc(occurrenceDate)}" data-plan-date="${esc(planDate)}">다음 작업일에 1회 미루기</button></div>`).join('');
  const currentRows = d.plan.filter(item => isPlanForDate(item, planDate) && !item.planExcluded).map(item => `<div class="detail">· ${esc(item.name)} · ${plannedMinutes(item)}분${item.done ? ' · 완료' : ''}${item.isExtra ? ' · 직접 추가' : ''}</div>`).join('') || '<div class="detail">· 기존 계획 없음</div>';
  const capacityMessage = available <= 0 ? '오늘은 설정된 작업 가능 시간이 없어. 기존 계획은 자동 변경되지 않아.' : `신규 배정 한도 ${minutesLabel(proposalMeta.allocationLimit)} · 나머지 작업은 다음 날로 자동 예약되지 않아.`;
  const stageButton = available > 0 ? '<button class="primary wide" id="stagePlanProposal">이 제안 미리보기</button>' : '';
  modal(mode === 'remaining' ? '현재 시간 기준 재계산' : '오늘 추천 다시 받기', `<div class="day-summary">오늘 작업 가능 시간 <b>${minutesLabel(available)}</b><br>${capacityMessage}<br>현재 계획은 아직 변경되지 않았어.</div>${offDayRows ? `<h4>비작업일 반복 회차</h4>${offDayRows}` : ''}<h4>현재 계획</h4>${currentRows}<h4>새 계획 미리보기</h4>${rows}${unallocatedRows}<div class="detail">제안 작업 합계 ${minutesLabel(totalPlanned(proposalDraft))}</div>${stageButton}<button class="secondary wide" id="cancelPlanProposal">기존 계획 유지</button>`);
}
function recommend() {
  const capacity = configuredWorkCapacityForPlan(todayKey());
  openPlanProposal(capacity.available, 'basic', capacity.intervals, todayKey());
}
function recalculateFromNow() {
  const capacity = remainingConfiguredWorkCapacity(new Date(), todayKey());
  openPlanProposal(capacity.available, 'remaining', capacity.intervals, todayKey());
}
function planTaskDisplayName(item) {
  const project = d.projects.find(candidate => String(candidate.id) === String(item.projectId));
  const stage = project?.stages.find(candidate => String(candidate.id) === String(item.stageId));
  const projectName = project?.name || item.projectNameAtReview || item.projectName || '';
  const stageName = stage?.name || item.stageNameAtReview || item.stageName || '';
  const estimate = Number(stage?.estimatedMinutes) || Number(item.estimatedMinutes) || 0;
  return PLAN_ENGINE.formatPlanTaskTitle(projectName, stageName, plannedMinutes(item), estimate, item.name);
}
function renderTodayPlan(tasks) {
  if (!tasks.length) return '<div class="emptyplan">오늘 추천할 일이 없어. 쉬어도 괜찮아 🌿</div>';
  const cards = tasks.map((item, index) => {
    const progress = taskDailyProgress(item);
    const stage = d.projects.find(project => project.id == item.projectId)?.stages.find(candidate => candidate.id == item.stageId);
    const recurringLabel = item.recurringTaskId ? item.deferredOccurrence
      ? `반복 회차 ${dateLabel(item.recurringOccurrenceDate)} · 미뤄서 배정`
      : '반복 작업 · 오늘 회차' : '';
    const displayName = planTaskDisplayName(item);
    return `<div class="item task ${item.done ? 'done' : ''}"><button class="check ${item.done ? 'checked' : ''}" data-task-check="${esc(item.id)}" aria-label="${esc(displayName)} 완료">${item.done ? '✓' : ''}</button><div class="taskmain"><div class="taskline"><b>${esc(displayName)}</b><span>배정 <input class="time-input plan-time-input" type="number" min="1" max="1440" step="1" value="${plannedMinutes(item)}" data-plan-minutes="${esc(item.id)}" aria-label="${esc(displayName)} 오늘 배정 시간 (분)" title="오늘 배정 시간 변경"></span>분</div><div class="progressrow"><input type="range" min="0" max="100" step="1" value="${progress}" data-task-progress="${esc(item.id)}" aria-label="${esc(displayName)} 오늘 진척도"><span class="progress-percent"><input class="percent" type="number" min="0" max="100" step="1" value="${progress}" data-task-percent="${esc(item.id)}">%</span></div>${stage ? `<div class="detail stage-progress-label">단계 전체 진척도 ${percentText(stageProgress(stage))}</div>` : ''}<div class="time-row">실제 작업 시간 <input class="time-input" type="number" min="0" value="${item.actualMinutes}" data-task-actual="${esc(item.id)}">분</div><div class="plan-task-actions"><button class="secondary small-button" data-plan-move="up" data-id="${esc(item.id)}" aria-label="${esc(displayName)} 위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button><button class="secondary small-button" data-plan-move="down" data-id="${esc(item.id)}" aria-label="${esc(displayName)} 아래로 이동" ${index === tasks.length - 1 ? 'disabled' : ''}>↓</button>${item.isExtra ? `<button class="secondary small-button" data-plan-edit="${esc(item.id)}">수정</button>` : ''}<button class="danger plan-remove" data-plan-remove="${esc(item.id)}" aria-label="오늘 계획에서 제외">×</button></div>${item.recurringTaskId ? `<div class="detail">${esc(recurringLabel)}</div>` : item.isExtra ? '<div class="detail">직접 추가한 작업</div>' : ''}</div></div>`;
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
  const lunchLabel = d.lunchEnabled ? `${Number(d.lunchDuration) || DEFAULT_LUNCH_MINUTES}분` : '없음';
  const fikaLabel = d.fikaEnabled ? `${Number(d.fikaDuration) || DEFAULT_SETTINGS_FIKA_MINUTES}분` : '없음';
  const overCapacity = plannedTotal > capacity.available;
  $('capacity').innerHTML = `<div class="capacity-card"><div class="capacity-metrics"><span>오늘 작업 가능한 시간 <b>${minutesLabel(available)}</b></span><span>작업 예상 시간 <b>${minutesLabel(plannedTotal)}</b></span></div><span class="muted">기본 ${workStartTime()}~${workEndTime()} · 점심 ${lunchLabel} · FIKA ${fikaLabel} · 일정/준비시간 반영</span>${overCapacity ? `<span class="muted" role="status">현재 계획이 설정한 작업 가능 시간보다 ${minutesLabel(plannedTotal - capacity.available)} 많아. 기존 계획은 자동으로 바꾸지 않았어.</span>` : ''}<button class="secondary wide recalculate-button" id="recalculatePlan">현재 시간으로 다시 계산하기</button></div>`;
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
  const projectOptions = allProjects().filter(project => project.status !== '완료').map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
  modal('계획에 작업 추가', `<label class="label" for="plannedMode">추가 방식</label><select class="input" id="plannedMode"><option value="existing">기존 프로젝트의 단계 작업</option><option value="independent">독립 작업</option><option value="newProject">새 프로젝트와 작업</option></select><div id="plannedExistingFields"><label class="label" for="plannedProject">프로젝트</label><select class="input" id="plannedProject">${projectOptions || '<option value="">등록된 프로젝트 없음</option>'}</select><label class="label" for="plannedStage">기존 단계</label><select class="input" id="plannedStage"></select></div><div id="plannedNewProjectFields" class="hidden"><label class="label" for="plannedProjectName">새 프로젝트 이름</label><input class="input" id="plannedProjectName" maxlength="120" placeholder="프로젝트 이름"></div><label class="label" for="plannedTaskName">작업명</label><input class="input" id="plannedTaskName" maxlength="120" placeholder="작업명" readonly><label class="label" for="plannedTaskMinutes">오늘 배정 시간 (분)</label><input class="input" id="plannedTaskMinutes" type="number" min="1" max="1440" step="1" value="30"><div class="muted">기존 단계 선택은 프로젝트·단계와 전체 예상 시간을 유지해. 오늘 배정 시간만 별도로 설정해.</div><button class="primary wide" id="savePlannedTask">계획에 추가</button>`);
  populatePlannedStages();
}
function populatePlannedStages() {
  const project = allProjects().find(item => String(item.id) === $('plannedProject')?.value);
  if ($('plannedStage')) $('plannedStage').innerHTML = (project?.stages || []).map(stage => `<option value="${esc(stage.id)}">${esc(stage.name)}</option>`).join('') || '<option value="">단계 없음</option>';
  updatePlannedTaskName();
}
function updatePlannedTaskName() {
  const nameInput = $('plannedTaskName');
  if (!nameInput || $('plannedMode')?.value !== 'existing') return;
  const project = allProjects().find(item => String(item.id) === $('plannedProject')?.value);
  const stage = project?.stages.find(item => String(item.id) === $('plannedStage')?.value);
  nameInput.value = project && stage ? `${project.name} - ${stage.name}` : '';
  nameInput.readOnly = true;
  nameInput.dataset.generatedName = 'true';
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
    if (item.planExcluded) return `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="muted">오늘은 쉬기로 했어. 배정 ${plannedMinutes(item)}분은 다른 작업을 다시 선택할 때 사용할 수 있어.</div><button class="choice small" data-restore-swap-i="${index}">다시 고르기</button></div>`;
    if (item.done || item.isExtra || item.recurringTaskId) return `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="muted">${item.recurringTaskId ? '반복 작업의 오늘 인스턴스는 유지돼.' : '완료/직접 추가한 작업은 유지돼.'}</div></div>`;
    const choices = d.projects.map(project => `<button class="choice small" data-swap-i="${index}" data-p="${project.id}">${esc(project.name)}</button>`).join('');
    return `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="arrow">이걸 → 뭘로 바꿀까?</div><div class="choices">${choices}<button class="choice small" data-swap-i="${index}" data-rest="1">오늘은 쉬기</button></div></div>`;
  }).join('');
  modal('오늘 할 일을 바꾸자', blocks + (planChangeDraft.length ? '<div class="change-preview"><b>변경 결과를 미리 확인해줘.</b><div class="muted">아직 저장되지 않았어. 확인 후 오늘 화면에서 확정할 수 있어.</div><button class="primary wide" id="applyPlanChange">변경 미리보기</button><button class="secondary wide" id="cancelPlanChange">취소</button></div>' : '<div class="muted">오늘은 쉬어도 괜찮아.</div><button class="secondary wide" id="cancelPlanChange">취소</button>'));
}
function replacePlanChangeSlot(index, projectId) {
  const current = planChangeDraft?.[index];
  const project = d.projects.find(item => String(item.id) === String(projectId));
  const stage = project?.stages.find(item => stageProgress(item) < 100);
  if (!current || !project || !stage) return false;
  const otherTasks = planChangeDraft.filter((_, itemIndex) => itemIndex !== index);
  const remaining = stageRemainingMinutes(stage, otherTasks);
  if (remaining <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); return false; }
  const available = pendingPlanMeta?.available ?? workCapacity().available;
  const replacement = PLAN_ENGINE.createPlanChangeReplacement(current, project, stage, {
    stageRemaining: remaining,
    availableMinutes: available,
    otherPlannedMinutes: totalPlanned(otherTasks),
    progress: stageProgress(stage)
  });
  if (!replacement) { toast('오늘 남은 작업 가능 시간에 배정할 수 없어.'); return false; }
  planChangeDraft[index] = { ...replacement, date: todayKey() };
  return true;
}
function openCapture() { show('capture'); $('captureText').focus(); }

$('close').onclick = closeModal;
$('capture').onclick = openCapture;
$('exportData').onclick = exportDataBackup;
$('recommendPlan').onclick = recommend;
$('importData').onclick = () => $('importFileInput').click();
$('importFileInput').onchange = event => importDataFile(event.target.files[0]);
$('downloadImportBackup').onclick = downloadImportBackup;
$('restoreImportBackup').onclick = restoreImportBackup;
$('eveningButton').onclick = () => show('evening');
$('backToToday').onclick = () => show('today');
$('accept').onclick = () => { if (pendingPlan !== null) { const referencedProjectIds = new Set(pendingPlan.map(item => String(item.projectId))); d.projects.push(...pendingProjects.filter(project => referencedProjectIds.has(String(project.id)))); const otherDates = d.plan.filter(item => !isPlanForDate(item)); d.plan = [...otherDates, ...pendingPlan.map(item => ({ ...item, date: todayKey() }))]; d.plan.filter(item => isPlanForDate(item)).forEach(syncPlanToProject); pendingPlan = null; pendingPlanMeta = null; pendingProjects = []; } d.planAccepted = true; save(); $('headline').textContent = '좋아. 오늘은 이걸로 가자 🌿'; bounce(); render(); };
$('accept').onclick = () => { if (pendingPlan !== null) { const referencedProjectIds = new Set(pendingPlan.map(item => String(item.projectId))); d.projects.push(...pendingProjects.filter(project => referencedProjectIds.has(String(project.id)))); const otherDates = d.plan.filter(item => !isPlanForDate(item)); d.plan = [...otherDates, ...pendingPlan.map(item => ({ ...item, date: todayKey() }))]; d.plan.filter(item => isPlanForDate(item)).forEach(syncPlanToProject); pendingPlan = null; pendingPlanMeta = null; pendingProjects = []; } d.planAccepted = true; save(); $('headline').textContent = '좋아. 오늘은 이걸로 가자 🌿'; bounce(); render(); };
$('swap').onclick = openPlanChangeModal;
$('saveWorkHours').onclick = () => {
  const start = $('workStartSetting').value;
  const end = $('workEndSetting').value;
  const workdays = Array.from(document.querySelectorAll('[data-workday].selected')).map(button => Number(button.dataset.workday));
  const lunchEnabled = $('lunchEnabled').checked;
  const fikaEnabled = $('fikaEnabled').checked;
  const lunchDuration = Number($('lunchDuration').value);
  const fikaDuration = Number($('fikaDuration').value);
  const feedback = $('settingsFeedback');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    feedback.textContent = '시작 시간과 종료 시간을 모두 입력해줘.';
    return;
  }
  if (clockMinutes(end) <= clockMinutes(start)) {
    feedback.textContent = '종료 시간은 시작 시간보다 늦어야 해.';
    return;
  }
  if (!workdays.length) {
    feedback.textContent = '작업 가능 요일을 하나 이상 선택해줘.';
    return;
  }
  if (lunchEnabled && (!Number.isInteger(lunchDuration) || lunchDuration < 5 || lunchDuration > 180 || lunchDuration % 5 !== 0)) {
    feedback.textContent = '점심 시간은 5분 단위로 5분~180분 안에 선택해줘.';
    return;
  }
  if (fikaEnabled && (!Number.isInteger(fikaDuration) || fikaDuration < 5 || fikaDuration > 180 || fikaDuration % 5 !== 0)) {
    feedback.textContent = 'FIKA 시간은 5분 단위로 5분~180분 안에 선택해줘.';
    return;
  }
  try {
    persistSettings({ start, end, workdays, lunchEnabled, lunchDuration, fikaEnabled, fikaDuration });
    feedback.textContent = '작업 일정 설정을 저장했어. 기존 계획과 기록은 유지돼.';
    renderSettings();
    render();
  } catch (error) {
    console.error('작업 일정 설정을 저장하지 못했어.', error);
    feedback.textContent = '설정을 저장하지 못했어. 기존 데이터는 변경하지 않았어.';
  }
};
$('addEvent').onclick = () => modal('일정 추가', `<label class="label">날짜</label><input class="input" id="eventDate" type="date" value="${todayKey()}"><label class="label">시작 시간</label><input class="input" id="eventTime" type="time" value="09:00"><label class="label">종료 시간</label><input class="input" id="eventEnd" type="time" value="10:00"><label class="label">일정 이름</label><input class="input" id="eventName" placeholder="예: 발레">${preparationField(DEFAULT_PREPARATION_MINUTES)}<button class="primary wide" id="saveEvent">추가</button>`);
$('addProject').onclick = () => modal('프로젝트 추가', `<label class="label">프로젝트 이름</label><input class="input" id="projectName" placeholder="예: 가구 공부"><label class="label">목적 또는 설명</label><textarea class="input small-textarea" id="projectDescription"></textarea><label class="label">중요도 (1~5)</label><input class="input" id="projectImportance" type="number" min="1" max="5" value="3"><label class="label">마감일</label><label class="deadline-choice"><input type="checkbox" id="newNoDeadline" checked> 마감일 없음</label><input class="input" id="projectDeadline" type="date" disabled><button class="primary wide" id="saveProject">추가</button>`); 
$('saveCapture').onclick = () => { const text = $('captureText').value.trim(); if (!text) return; d.captures.push({ id: `capture-${Date.now()}`, text, at: new Date().toISOString() }); save(); $('captureText').value = ''; renderCaptures(); toast('기억해둘게. 나중에 프로젝트에 붙일 수 있어.'); };
document.addEventListener('click', event => {
  const target = event.target;
  if (target.id === 'confirmDataImport') { confirmDataImport(); return; }
  if (target.id === 'cancelDataImport') { cancelDataImport(); return; }
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
    const mode = $('plannedMode').value;
    const minutes = Number($('plannedTaskMinutes').value);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) { toast('예상 시간은 1~1440분의 정수로 입력해줘.'); return; }
    let project = null, stage = null;
    let name = $('plannedTaskName').value.trim();
    if (mode === 'existing') {
      project = allProjects().find(item => String(item.id) === $('plannedProject').value);
      stage = project?.stages.find(item => String(item.id) === $('plannedStage').value);
      if (!project || !stage) { toast('프로젝트와 단계를 선택해줘.'); return; }
      name = `${project.name || '프로젝트'} - ${stage.name || '단계'}`;
      const duplicate = activePlan().some(item => !item.planExcluded
        && String(item.projectId) === String(project.id) && String(item.stageId) === String(stage.id));
      if (duplicate) { toast('선택한 프로젝트 단계가 오늘 계획에 이미 있어. 기존 계획을 수정해줘.'); return; }
    } else if (mode === 'newProject') {
      const projectName = $('plannedProjectName').value.trim();
      if (!projectName) { toast('새 프로젝트 이름을 입력해줘.'); return; }
      if (!name) { toast('작업명을 입력해줘.'); return; }
      project = createProjectRecord(projectName, '', 3, null, name, 0);
      stage = project.stages[0];
    } else if (!name) {
      toast('작업명을 입력해줘.'); return;
    }
    if (!project && activePlan().some(item => !item.planExcluded && item.projectId == null && item.stageId == null
      && String(item.name || '').trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase())) {
      toast('같은 이름의 독립 작업이 오늘 계획에 이미 있어.'); return;
    }
    const remaining = stage ? stageRemainingMinutes(stage, activePlan()) : Infinity;
    if (stage && remaining <= 0) { toast('이 단계에 남은 예상 작업량이 없어.'); return; }
    const assignedMinutes = Number.isFinite(remaining) ? Math.min(minutes, remaining) : minutes;
    const item = {
      id: `planned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name, projectId: project?.id ?? null, stageId: stage?.id ?? null,
      minutes: stage ? Number(stage.estimatedMinutes) || minutes : minutes, plannedMinutes: assignedMinutes,
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
  const offDayRecurring = target.closest('[data-offday-recurring]');
  if (offDayRecurring) {
    const template = d.recurringTasks.find(item => String(item.id) === offDayRecurring.dataset.id);
    const occurrenceDate = offDayRecurring.dataset.date;
    if (!template || !recurrenceMatches(template, occurrenceDate) || recurringOccurrenceRecorded(template.id, occurrenceDate)) return;
    const key = recurrenceOccurrenceKey(template.id, occurrenceDate);
    if (offDayRecurring.dataset.offdayRecurring === 'defer') {
      const planDate = nextConfiguredWorkday(offDayRecurring.dataset.planDate || occurrenceDate);
      if (!planDate) { toast('다음 작업 가능 요일을 찾지 못했어. 작업 요일 설정을 확인해줘.'); return; }
      d.recurringDecisions[key] = { templateId: template.id, occurrenceDate, action: 'defer', planDate, decidedAt: new Date().toISOString() };
      save(); closeModal(); render(); toast(`${planDate} 후보로 1회 미뤘어. 그날 제안에서 확인하고 확정해줘.`);
    }
    return;
  }
  if (target.id === 'stagePlanProposal') {
    if (!proposalDraft || !proposalMeta) return;
    const rows = new Map([...document.querySelectorAll('[data-proposal-row]')].map(row => [row.dataset.proposalRow, row]));
    const stagedPlan = proposalDraft.flatMap(item => {
      if (item.planExcluded) return [{ ...item }];
      const row = rows.get(String(item.id));
      if (!row) return [];
      const minutesInput = row.querySelector('[data-proposal-minutes]');
      if (minutesInput) {
        const candidateLimit = Math.max(0, Number(item.remainingMinutes) || plannedMinutes(item));
        const minutes = Math.min(candidateLimit, Math.max(0, Math.round(Number(minutesInput.value) || 0)));
        if (!minutes) return [];
        item.plannedMinutes = minutes;
      }
      return [{ ...item }];
    });
    const proposedMinutes = stagedPlan.filter(item => item.proposalCandidate).reduce((sum, item) => sum + plannedMinutes(item), 0);
    if (proposedMinutes > proposalMeta.allocationLimit) { toast('새 작업 시간이 남은 계획 시간보다 길어. 시간을 줄이거나 작업을 제외해줘.'); return; }
    const stageAllocations = new Map();
    const stageLimits = new Map();
    stagedPlan.filter(item => item.proposalCandidate && item.allocationGroup).forEach(item => {
      stageAllocations.set(item.allocationGroup, (stageAllocations.get(item.allocationGroup) || 0) + plannedMinutes(item));
      stageLimits.set(item.allocationGroup, Number(item.groupRemainingMinutes) || 0);
    });
    if ([...stageAllocations].some(([group, minutes]) => minutes > stageLimits.get(group))) {
      toast('같은 단계의 제안 작업 합계가 남은 예상 작업량보다 길어. 시간을 줄여줘.');
      return;
    }
    pendingPlan = stagedPlan.map(item => {
      const saved = { ...item };
      if (item.proposalCandidate) saved.plannedByEngine = true;
      ['proposalCandidate', 'remainingMinutes', 'stageRemainingMinutes', 'allocationGroup', 'groupRemainingMinutes', 'recurrenceDecisionKey'].forEach(field => delete saved[field]);
      return saved;
    });
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
  const restoreSwap = target.closest('[data-restore-swap-i]');
  if (restoreSwap && planChangeDraft) {
    const item = planChangeDraft[Number(restoreSwap.dataset.restoreSwapI)];
    if (item) delete item.planExcluded;
    openPlanChangeModal(); return;
  }
  const swap = target.closest('[data-swap-i]');
  if (swap && planChangeDraft) {
    const index = Number(swap.dataset.swapI);
    if (swap.dataset.rest) planChangeDraft[index].planExcluded = true;
    else if (!replacePlanChangeSlot(index, swap.dataset.p)) return;
    openPlanChangeModal(); return;
  }
  if (target.id === 'applyPlanChange' && planChangeDraft) { pendingPlan = planChangeDraft.filter(item => !item.planExcluded).map(item => ({ ...item })); pendingPlanMeta = pendingPlanMeta || { available: workCapacity().available, mode: 'basic' }; planChangeDraft = null; closeModal(); render(); return; }
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
    $('plannedTaskName').readOnly = target.value === 'existing';
    if (target.value === 'existing') updatePlannedTaskName();
    else if ($('plannedTaskName').dataset.generatedName === 'true') { $('plannedTaskName').value = ''; delete $('plannedTaskName').dataset.generatedName; }
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
      task.querySelector('.taskline b').textContent = planTaskDisplayName(item);
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
    $('plannedTaskName').readOnly = event.target.value === 'existing';
    if (event.target.value === 'existing') updatePlannedTaskName();
    else if ($('plannedTaskName').dataset.generatedName === 'true') { $('plannedTaskName').value = ''; delete $('plannedTaskName').dataset.generatedName; }
    return;
  }
  if (event.target.id === 'plannedProject') { populatePlannedStages(); return; }
  if (event.target.id === 'plannedStage') { updatePlannedTaskName(); return; }
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
document.querySelectorAll('[data-workday]').forEach(button => button.onclick = () => {
  button.classList.toggle('selected');
  const selected = document.querySelectorAll('[data-workday].selected').length;
  if (selected === 0) button.classList.add('selected');
});
$('lunchEnabled').onchange = updateSettingsDurationState;
$('fikaEnabled').onchange = updateSettingsDurationState;
registerAppServiceWorker();
migrate(); ensureRecurringInstances(); render(); renderSettings(); updateImportBackupActions();

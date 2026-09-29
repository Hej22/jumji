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
  return { projects: [], events: [], plan: [], captures: [], planAccepted: false, deferReasons: {}, dailyReviews: {} };
}
const loaded = JSON.parse(localStorage.getItem(KEY) || 'null');
let d = loaded || createEmptyData();
let pendingPlan = null;
let toastTimer = null;
let selectedReviewDate = todayKey();
let editingReview = false;
let reviewStep = 'summary';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[match]));
const dateLabel = value => value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '마감 없음';

function migrate() {
  d.projects = (d.projects || []).map(project => {
    const stages = Array.isArray(project.stages) ? project.stages : [{
      id: `${project.id}-legacy`, name: project.stage || '시작 전', progress: Number(project.progress) || 0,
      estimatedMinutes: 0, actualMinutes: 0
    }];
    const normalizedStages = stages.map(stage => ({ ...stage, progress: Math.max(0, Math.min(100, Math.round(Number(stage.progress) || 0))), estimatedMinutes: Math.max(0, Math.round(Number(stage.estimatedMinutes) || 0)), actualMinutes: Math.max(0, Math.round(Number(stage.actualMinutes) || 0)), progressMode: stage.progressMode || 'auto' }));
    const progress = Number(project.progress) || 0;
    return { ...project, description: project.description || '', importance: Number(project.importance) || 3, deadline: project.deadline || null, status: project.status || '진행 중', stages: normalizedStages, progress, stage: project.stage || normalizedStages[0]?.name || '시작 전' };
  });
  d.events = (d.events || []).map(event => ({ ...event, preparationMinutes: [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES }));
  d.plan = (d.plan || []).map(item => ({ ...item, estimatedMinutes: Number(item.estimatedMinutes ?? item.minutes) || 0, actualMinutes: Number(item.actualMinutes) || 0, minutes: Number(item.minutes ?? item.estimatedMinutes) || 0, progress: Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0))), progressMode: item.progressMode || 'auto', done: Boolean(item.done) }));
  d.plan.forEach(syncPlanToProject);
  d.captures = (d.captures || []).map((capture, index) => ({ ...capture, id: capture.id || `capture-${index}`, text: capture.text ?? capture.content ?? '', at: capture.at || capture.createdAt || new Date().toISOString() }));
  d.planAccepted = Boolean(d.planAccepted); d.deferReasons = d.deferReasons || {}; d.dailyReviews = d.dailyReviews || {};
  d.projects.forEach(syncProjectProgress);
  save();
}
function save() { localStorage.setItem(KEY, JSON.stringify(d)); }
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
  return date === todayKey() ? d.plan : [];
}
function taskProjectLabel(item) {
  const project = d.projects.find(candidate => candidate.id == item.projectId);
  return project ? `${project.name}${item.stageId ? ` · ${project.stages.find(stage => stage.id == item.stageId)?.name || ''}` : ''}` : '프로젝트 없음';
}
function totalActual(tasks) { return tasks.reduce((sum, item) => sum + (Number(item.actualMinutes) || 0), 0); }
function reviewSnapshot() {
  return {
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    tasks: d.plan.map(item => ({ ...item })),
    events: todayEvents().map(event => ({ ...event })),
    deferReasons: { ...d.deferReasons },
    note: d.dailyReviews[todayKey()]?.note || ''
  };
}
function isReviewConfirmed(date = todayKey()) { return Boolean(d.dailyReviews[date]?.confirmed); }
function calculatedProgress(estimatedMinutes, actualMinutes, fallbackProgress, mode = 'auto', done = false) {
  if (done) return 100;
  if (mode === 'auto' && estimatedMinutes > 0 && actualMinutes > 0) return Math.max(0, Math.min(100, Math.round(actualMinutes / estimatedMinutes * 100)));
  return Math.max(0, Math.min(100, Math.round(fallbackProgress || 0)));
}
function stageProgress(stage) {
  return calculatedProgress(Number(stage.estimatedMinutes) || 0, Number(stage.actualMinutes) || 0, stage.progress, stage.progressMode, false);
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
function syncPlanToProject(item) {
  const project = d.projects.find(candidate => candidate.id == item.projectId);
  if (!project) return;
  const stage = project.stages.find(candidate => candidate.id == item.stageId);
  if (!stage) return;
  if (item.isExtra && item.projectActualApplied) {
    stage.actualMinutes = Math.max(0, Number(stage.actualMinutes) || 0);
  } else {
    stage.actualMinutes = Math.max(Number(stage.actualMinutes) || 0, Number(item.actualMinutes) || 0);
  }
  if (item.done) {
    stage.progress = 100;
    stage.progressMode = 'manual';
  } else if (item.progressMode === 'manual') {
    stage.progress = item.progress;
    stage.progressMode = 'manual';
  }
  syncProjectProgress(project);
}
function progressLabel(progress) {
  const rounded = Math.round(progress);
  return ({ 25: '1/4', 50: '1/2', 75: '3/4' })[rounded] || `${rounded}%`;
}
function todayEvents() { return d.events.filter(event => !event.date || event.date === todayKey()).sort((a, b) => (a.time || '').localeCompare(b.time || '')); }
function clockMinutes(value) { const parts = String(value || '').split(':').map(Number); return parts.length === 2 && parts.every(Number.isFinite) ? parts[0] * 60 + parts[1] : 0; }
function mergedBlockedMinutes(events, rangeStart, rangeEnd) {
  const intervals = events.map(event => {
    if (!event.time || !event.end) return null;
    const preparation = [0, 30, 60].includes(Number(event.preparationMinutes)) ? Number(event.preparationMinutes) : DEFAULT_PREPARATION_MINUTES;
    return [Math.max(rangeStart, clockMinutes(event.time) - preparation), Math.min(rangeEnd, clockMinutes(event.end) + preparation)];
  }).filter(interval => interval && interval[1] > interval[0]).sort((a, b) => a[0] - b[0]);
  let total = 0, current = null;
  intervals.forEach(interval => {
    if (!current) current = interval;
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { total += current[1] - current[0]; current = interval; }
  });
  if (current) total += current[1] - current[0];
  return total;
}
function workCapacity() {
  const start = clockMinutes(DEFAULT_WORK_START), end = clockMinutes(DEFAULT_WORK_END);
  const blocked = mergedBlockedMinutes(todayEvents(), start, end);
  const base = end - start - DEFAULT_LUNCH_MINUTES - DEFAULT_FIKA_MINUTES;
  return { base, blocked, available: Math.max(0, base - blocked) };
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
function recommend() {
  const available = Math.floor(availableMinutes() * DEFAULT_PLAN_UTILIZATION), completed = d.plan.filter(item => item.done);
  const ranked = [...d.projects].sort((a, b) => {
    const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity, bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return ad - bd || (b.importance || 3) - (a.importance || 3) || (a.progress || 0) - (b.progress || 0);
  });
  const candidates = []; let used = 0;
  for (const project of ranked) {
    if (used >= available) break;
    const stage = project.stages.find(item => (item.progress || 0) < 100) || project.stages[0];
    if (!stage) continue;
    const estimatedMinutes = Number(stage.estimatedMinutes) || (project.deadline ? 90 : 60);
    const minutes = Math.min(estimatedMinutes, Math.max(0, available - used));
    if (!minutes) continue;
    candidates.push({ id: Date.now() + candidates.length, projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name}`, minutes, estimatedMinutes, plannedMinutes: minutes, actualMinutes: 0, progress: stageProgress(stage), progressMode: 'auto', done: false });
    used += minutes;
    if (candidates.length >= 3) break;
  }
  d.plan = [...completed, ...candidates]; d.planAccepted = false; save(); render(); $('headline').textContent = '일정 바뀌었으니 다시 짜봤어.'; bounce();
}
function render() {
  const events = todayEvents();
  d.projects.forEach(syncProjectProgress);
  $('todayDate').textContent = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(new Date());
  const review = d.dailyReviews[todayKey()];
  const isComplete = Boolean(review?.confirmed);
  $('todaySummary').innerHTML = isComplete ? `<div class="day-summary home-summary"><div class="summary-emoji">🌿</div><b>오늘은 ${minutesLabel(totalActual(review.tasks))} 작업했어.</b><button class="primary wide" id="openReviewSummary">오늘 하루 돌아보기</button></div>` : '';
  $('eventList').innerHTML = evForCalendar();
  $('projectList').innerHTML = d.projects.map(project => { const risk = riskFor(project); return `<button class="project projectbtn" data-project-id="${project.id}"><div class="projecttop"><div><b>${esc(project.name)}</b><div class="detail">${esc(project.stage)} · ${project.progress}% · 중요도 ${project.importance}/5</div></div><span class="risk ${risk === 'yellow' ? 'yellow' : risk === 'red' ? 'red' : ''}">${risk === 'red' ? '위험' : risk === 'yellow' ? '확인' : '여유'}</span></div><div class="bar"><i style="width:${project.progress}%"></i></div><div class="detail">${dateLabel(project.deadline)} · ${esc(project.status)}</div></button>`; }).join('');
  if (isComplete) {
    $('capacity').innerHTML = ''; $('events').innerHTML = ''; $('plan').innerHTML = ''; $('eveningSuggestion').innerHTML = '';
    $('addTodayTask').classList.add('hidden'); $('todayActions').classList.add('hidden'); $('eveningButton').classList.add('hidden');
    renderCaptures(); renderEvening(); renderReviewCalendar(); updateActions(); return;
  }
  $('addTodayTask').classList.remove('hidden'); $('todayActions').classList.remove('hidden'); $('eveningButton').classList.remove('hidden');
  const capacity = workCapacity();
  $('capacity').innerHTML = `<div class="capacity-card">오늘 작업 가능 시간 약 <b>${minutesLabel(capacity.available)}</b><span class="muted">기본 09:00~17:00 · 점심 ${DEFAULT_LUNCH_MINUTES}분 · fika ${DEFAULT_FIKA_MINUTES}분 · 일정/준비시간 ${capacity.blocked}분 반영 · 계획 배정 ${Math.round(DEFAULT_PLAN_UTILIZATION * 100)}%</span></div>`;
  $('events').innerHTML = events.map(event => `<button class="pill eventpill" data-event-id="${event.id}">🕐 ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''} ${esc(event.name)} <span class="source">${event.source === 'external' ? '외부 일정' : '점지 일정'}</span></button>`).join('') || '<span class="muted">오늘 등록된 일정이 없어.</span>';
  $('plan').innerHTML = d.plan.length ? d.plan.map(item => { item.progress = calculatedProgress(item.estimatedMinutes, item.actualMinutes, item.progress, item.progressMode, item.done); const planned = item.plannedMinutes || item.minutes; return `<div class="item task ${item.done ? 'done' : ''}"><button class="check ${item.done ? 'checked' : ''}" data-task-check="${item.id}">${item.done ? '✓' : ''}</button><div class="taskmain"><div class="taskline"><b>${esc(item.name)} · ${progressLabel(item.progress)}</b><span>배정 ${planned}분 · 실제 ${item.actualMinutes}분</span></div><div class="progressrow"><input type="range" min="0" max="100" step="1" value="${item.progress}" data-task-progress="${item.id}"><span class="progress-percent"><input class="percent" type="number" min="0" max="100" step="1" value="${item.progress}" data-task-percent="${item.id}">%</span></div><div class="time-row">예상 ${item.estimatedMinutes || item.minutes}분 · 실제 <input class="time-input" type="number" min="0" value="${item.actualMinutes}" data-task-actual="${item.id}">분</div>${item.isExtra ? '<div class="detail">오늘 추가로 한 일</div>' : ''}</div></div>`; }).join('') : '<div class="emptyplan">오늘 추천할 일이 없어. 쉬어도 괜찮아 🌿</div>';
  const suggestion = eveningSuggestion();
  $('eveningSuggestion').innerHTML = suggestion ? `<div class="evening-suggestion"><b>오늘 기본 작업시간이 부족해 보여.</b><div>저녁 ${suggestion.start}부터 최대 ${minutesLabel(suggestion.minutes)} 더 할 수 있어. 추가할까?</div><button class="primary small-button" id="addEveningWork">추가할래</button><button class="secondary small-button" id="skipEveningWork">오늘은 여기까지</button></div>` : '';
  renderCaptures(); renderEvening(); renderReviewCalendar(); updateActions();
}
function evForCalendar() { if (!d.events.length) return '<div class="event">등록된 일정이 없어.</div>'; return [...d.events].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '')).map(event => `<button class="event eventbtn" data-event-id="${event.id}"><div class="eventtop"><b>${esc(event.date || '날짜 없음')} · ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''}</b><span>${event.source === 'external' ? '외부' : '점지'}</span></div>${esc(event.name)}<div class="detail">${event.source === 'external' ? '외부 캘린더 연동 예정' : '눌러서 수정'}</div></button>`).join(''); }
function renderCaptures() { const list = [...d.captures].reverse(); $('captureList').innerHTML = list.length ? list.map(capture => `<article class="capture-card"><div class="detail">${esc(new Date(capture.at).toLocaleString('ko-KR'))}</div><div>${esc(capture.text)}</div><button class="danger small-button" data-delete-capture="${capture.id}">삭제</button></article>`).join('') : '<div class="event">아직 기록이 없어.</div>'; }
function openAddTodayTask() {
  const options = d.projects.flatMap(project => project.stages.map(stage => `<option value="${project.id}:${stage.id}">${esc(project.name)} · ${esc(stage.name)}</option>`)).join('');
  modal('오늘 한 일 추가', `<label>무엇을 했어?<input class="input" id="extraName" placeholder="작업명"></label><label>어디에 한 일이야?<select class="input" id="extraLink"><option value="">프로젝트 없음</option>${options}</select></label><label>실제 작업 시간 (분)<input class="input" id="extraActual" type="number" min="0" value="30"></label><label>진행률 (%)<input class="input" id="extraProgress" type="number" min="0" max="100" value="0"></label><button class="primary wide" id="saveExtraTask">저장하기</button>`);
}
function renderEvening() {
  const review = d.dailyReviews[todayKey()];
  if (review?.confirmed && reviewStep === 'summary') {
    const tasks = review.tasks || [];
    $('eveningList').innerHTML = `<div class="day-summary"><b>오늘의 기록</b><div>오늘은 ${minutesLabel(totalActual(tasks))} 작업했어.</div></div><h3>오늘 한 일</h3>${tasks.map(item => `<div class="evening-item ${item.done ? 'done' : ''}"><b>${esc(item.name)}</b><div class="detail">${esc(taskProjectLabel(item))} · 실제 ${item.actualMinutes || 0}분 · ${item.progress || 0}% · ${item.done ? '완료' : '미완료'}</div></div>`).join('')}<button class="secondary wide" id="addTodayTaskFromReview">＋ 오늘 한 일 추가</button><button class="secondary wide" id="editReview">기록 수정하기</button>`;
    return;
  }
  const allDone = d.plan.length > 0 && d.plan.every(item => item.done);
  const tasks = d.plan.length ? d.plan.map(item => `<div class="evening-item ${item.done ? 'done' : ''}"><b>${esc(item.name)}</b><div class="detail">${esc(taskProjectLabel(item))} · 예상 ${item.estimatedMinutes || item.minutes}분</div>${reviewStep === 'edit' ? `<label>완료 <input type="checkbox" data-review-done="${item.id}" ${item.done ? 'checked' : ''}></label><label>진행률 (%) <input class="input" type="number" min="0" max="100" data-review-progress="${item.id}" value="${item.progress}"></label><label>실제 시간 (분) <input class="input" type="number" min="0" data-review-actual="${item.id}" value="${item.actualMinutes}"></label>` : `<div class="detail">실제 ${item.actualMinutes}분 · 진행률 ${item.progress}% · ${item.done ? '완료' : '미완료'}</div>`}</div>`).join('') : '<div class="event">오늘 계획한 일이 없어.</div>';
  const events = todayEvents().map(event => `<div class="review-event"><b>${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''} ${esc(event.name)}</b><span>${event.source === 'external' ? '외부 일정' : '점지 일정'}</span></div>`).join('') || '<div class="muted">오늘 일정이 없어.</div>';
  if (reviewStep === 'defer') {
    const pending = d.plan.filter(item => !item.done);
    if (!pending.length) { finalizeReview(); return; }
    $('eveningList').innerHTML = `<h3>오늘 못 한 일은 왜 미뤘을까?</h3>${pending.map(item => `<div class="evening-item"><b>${esc(item.name)}</b><select class="input" data-defer-reason="${item.id}"><option value="">미룬 이유 선택</option>${['피곤함', '시간이 부족함', '시작하기 어려웠음', '다른 일정이 생김', '하기 싫었음', '예상보다 어려웠음', '기타'].map(option => `<option ${d.deferReasons[item.id] === option ? 'selected' : ''}>${option}</option>`).join('')}</select><input class="input" placeholder="메모 (선택)" data-defer-note="${item.id}" value="${esc(d.deferReasons[`${item.id}-note`] || '')}"></div>`).join('')}<button class="primary wide" id="finalizeReview">기록 저장하기</button>`;
    return;
  }
  $('eveningList').innerHTML = `${allDone ? '<div class="celebrate">🎉 오늘 계획한 일을 다 했어! 고생했어.</div>' : ''}<h3>오늘 기록이 맞아?</h3><div class="day-summary">현재 실제 작업시간 ${minutesLabel(totalActual(d.plan))}</div>${tasks}${reviewStep === 'summary' ? '<button class="secondary wide" id="addTodayTaskFromReview">＋ 오늘 한 일 추가</button>' : ''}<h3>오늘의 일정</h3><div class="review-events">${events}</div>${reviewStep === 'edit' ? '<button class="primary wide" id="saveReviewEdits">저장하고 다음으로</button>' : '<button class="primary wide" id="confirmReview">맞아, 이대로 기록할래</button><button class="secondary wide" id="editReview">수정할래</button>'}`;
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
  $('selectedDayReview').innerHTML = `<h3>${dateLabel(date)}</h3>${review ? `<div class="day-summary">오늘은 ${minutesLabel(totalActual(tasks))} 작업했어.</div><h4>그날 한 일</h4>${tasks.map(item => `<div class="history-item"><b>${esc(item.name)}</b><div>${esc(taskProjectLabel(item))} · 실제 ${item.actualMinutes || 0}분 · ${item.progress || 0}% · ${item.done ? '완료' : '미완료'}${item.isExtra ? ' · 오늘 추가한 일' : ''}</div></div>`).join('')}<h4>그날의 일정</h4>${events.map(event => `<div class="history-item">${esc(event.time)} ${esc(event.name)} · ${event.source === 'external' ? '외부 일정' : '점지 일정'}</div>`).join('') || '<div class="muted">일정 없음</div>'}<h4>미룬 일</h4>${tasks.filter(item => !item.done).map(item => `<div class="history-item">${esc(item.name)} · ${esc(review.deferReasons?.[item.id] || '이유 기록 없음')}</div>`).join('') || '<div class="muted">미룬 일 없음</div>'}` : '<div class="event">이 날짜에는 저장된 하루 기록이 없어.</div>'}`;
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
function updateActions() { $('accept').textContent = d.planAccepted ? '오늘 계획 확정됨 ✓' : '이대로 할래'; $('accept').disabled = d.planAccepted; $('accept').classList.toggle('confirmed', d.planAccepted); }
function modal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }
function bounce() { $('mascot').classList.add('jump'); setTimeout(() => $('mascot').classList.remove('jump'), 700); }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.remove('hidden'); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2400); }
function show(name) { document.querySelectorAll('.screen').forEach(screen => screen.classList.add('hidden')); const target = name === 'capture' ? 'captureScreen' : name; $(target).classList.remove('hidden'); document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.screen === name)); if (name === 'records') { renderCaptures(); renderReviewCalendar(); } if (name === 'evening') { reviewStep = d.dailyReviews[todayKey()]?.confirmed ? 'summary' : 'summary'; renderEvening(); } }
function preparationField(value) { return `<label class="label">준비/이동시간</label><select class="input" id="eventPreparation"><option value="0" ${Number(value) === 0 ? 'selected' : ''}>없음</option><option value="30" ${Number(value) === 30 || value == null ? 'selected' : ''}>30분</option><option value="60" ${Number(value) === 60 ? 'selected' : ''}>60분</option></select>`; }
function editEvent(id) { const event = d.events.find(item => item.id == id); if (!event) return; if (event.source === 'external') { modal('외부 일정', `<div class="externalhint"><b>${esc(event.name)}</b><div class="detail">${esc(event.date || '날짜 없음')} · ${esc(event.time)}${event.end ? `–${esc(event.end)}` : ''}</div><div class="muted">외부 캘린더 연동 예정이야. 현재는 점지에서 외부 일정을 수정하거나 삭제할 수 없어.</div></div>`); return; } modal('점지 일정 수정', `<label class="label">날짜</label><input class="input" id="eventDate" type="date" value="${esc(event.date || todayKey())}"><label class="label">시작 시간</label><input class="input" id="eventTime" type="time" value="${esc(event.time)}"><label class="label">종료 시간</label><input class="input" id="eventEnd" type="time" value="${esc(event.end || '')}"><label class="label">일정 이름</label><input class="input" id="eventName" value="${esc(event.name)}">${preparationField(event.preparationMinutes)}<button class="primary wide" id="updateEvent" data-id="${id}">수정하기</button><button class="danger wide" id="deleteEvent" data-id="${id}">일정 삭제</button><button class="secondary wide" id="recommendAgain">오늘 추천 다시 받기</button>`); }
function editProject(id) {
  const project = d.projects.find(item => item.id == id); if (!project) return;
  const stages = project.stages.map(stage => `<div class="stage-row"><label>단계 이름<input class="input stage-name" data-stage-name="${stage.id}" value="${esc(stage.name)}"></label><label>진행률 (%)<input class="input stage-number" type="number" min="0" max="100" step="1" data-stage-progress="${stage.id}" value="${stage.progress}"></label><label>예상 소요시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-estimate="${stage.id}" value="${stage.estimatedMinutes}"></label><label>실제 작업시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-actual="${stage.id}" value="${stage.actualMinutes}"></label><button class="danger small-button" data-delete-stage="${stage.id}">삭제</button></div>`).join('');
  modal('프로젝트 상세', `<label class="label">이름</label><input class="input" id="editProjectName" value="${esc(project.name)}"><label class="label">목적 또는 설명</label><textarea class="input small-textarea" id="editProjectDescription">${esc(project.description)}</textarea><label class="label">중요도 (1~5)</label><input class="input" id="editProjectImportance" type="number" min="1" max="5" value="${project.importance}"><label class="label">마감일</label><label class="deadline-choice"><input type="checkbox" id="noDeadline" ${project.deadline ? '' : 'checked'}> 마감일 없음</label><input class="input" id="editProjectDeadline" type="date" value="${esc(project.deadline || '')}" ${project.deadline ? '' : 'disabled'}><label class="label">상태</label><select class="input" id="editProjectStatus"><option ${project.status === '진행 중' ? 'selected' : ''}>진행 중</option><option ${project.status === '대기' ? 'selected' : ''}>대기</option><option ${project.status === '완료' ? 'selected' : ''}>완료</option></select><h4>단계</h4><div id="stageEditor">${stages || '<div class="muted">아직 단계가 없어.</div>'}</div><button class="secondary wide" id="addStage">＋ 단계 추가</button><button class="primary wide" id="updateProject" data-id="${id}">저장</button><button class="danger wide" id="deleteProject" data-id="${id}">프로젝트 삭제</button>`);
  $('noDeadline').onchange = event => { $('editProjectDeadline').disabled = event.target.checked; if (event.target.checked) $('editProjectDeadline').value = ''; };
}
function openPlanChangeModal() { const choices = d.projects; const blocks = pendingPlan.map((item, index) => `<div class="swapblock"><div class="swapfrom">🐾 ${esc(item.name)}</div><div class="arrow">이걸 → 뭘로 바꿀까?</div><div class="choices">${choices.map(project => `<button class="choice small" data-swap-i="${index}" data-p="${project.id}">${esc(project.name)}</button>`).join('')}<button class="choice small" data-swap-i="${index}" data-rest="1">오늘은 쉬기</button></div></div>`).join(''); modal('오늘 할 일을 바꾸자', blocks + (pendingPlan.length ? '<div class="change-preview"><b>변경 결과를 확인해줘.</b><div class="muted">아직 오늘 계획에는 반영되지 않았어.</div><button class="primary wide" id="applyPlanChange">이 변경으로 할래</button></div>' : '<div class="muted">오늘은 쉬어도 괜찮아.</div>')); }
function openCapture() { show('capture'); $('captureText').focus(); }

$('close').onclick = closeModal;
$('capture').onclick = openCapture;
$('exportData').onclick = exportDataBackup;
$('eveningButton').onclick = () => show('evening');
$('backToToday').onclick = () => show('today');
$('accept').onclick = () => { d.planAccepted = true; save(); $('headline').textContent = '좋아. 오늘은 이걸로 가자 🌿'; bounce(); render(); };
$('swap').onclick = () => { pendingPlan = d.plan.map(item => ({ ...item })); openPlanChangeModal(); };
$('addEvent').onclick = () => modal('일정 추가', `<label class="label">날짜</label><input class="input" id="eventDate" type="date" value="${todayKey()}"><label class="label">시작 시간</label><input class="input" id="eventTime" type="time" value="09:00"><label class="label">종료 시간</label><input class="input" id="eventEnd" type="time" value="10:00"><label class="label">일정 이름</label><input class="input" id="eventName" placeholder="예: 발레">${preparationField(DEFAULT_PREPARATION_MINUTES)}<button class="primary wide" id="saveEvent">추가</button>`);
$('addProject').onclick = () => modal('프로젝트 추가', `<label class="label">프로젝트 이름</label><input class="input" id="projectName" placeholder="예: 가구 공부"><label class="label">목적 또는 설명</label><textarea class="input small-textarea" id="projectDescription"></textarea><label class="label">중요도 (1~5)</label><input class="input" id="projectImportance" type="number" min="1" max="5" value="3"><label class="label">마감일</label><label class="deadline-choice"><input type="checkbox" id="newNoDeadline" checked> 마감일 없음</label><input class="input" id="projectDeadline" type="date" disabled><button class="primary wide" id="saveProject">추가</button>`); 
$('saveCapture').onclick = () => { const text = $('captureText').value.trim(); if (!text) return; d.captures.push({ id: `capture-${Date.now()}`, text, at: new Date().toISOString() }); save(); $('captureText').value = ''; renderCaptures(); toast('기억해둘게. 나중에 프로젝트에 붙일 수 있어.'); };
document.addEventListener('click', event => {
  const target = event.target;
  if (target.id === 'addTodayTask') { openAddTodayTask(); return; }
  if (target.id === 'addTodayTaskFromReview') { openAddTodayTask(); return; }
  if (target.id === 'openReviewSummary') { show('evening'); return; }
  const reviewDate = target.closest('[data-review-date]'); if (reviewDate) { selectedReviewDate = reviewDate.dataset.reviewDate; renderReviewCalendar(); return; }
  if (target.id === 'confirmReview') { reviewStep = d.plan.some(item => !item.done) ? 'defer' : 'summary'; if (reviewStep === 'summary') finalizeReview(); else renderEvening(); return; }
  if (target.id === 'editReview') { reviewStep = 'edit'; renderEvening(); return; }
  if (target.id === 'saveReviewEdits') { d.plan.forEach(item => { const done = document.querySelector(`[data-review-done="${item.id}"]`); const progress = document.querySelector(`[data-review-progress="${item.id}"]`); const actual = document.querySelector(`[data-review-actual="${item.id}"]`); if (done) item.done = done.checked; if (actual) item.actualMinutes = Math.max(0, Math.round(Number(actual.value) || 0)); if (progress) item.progress = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0))); if (item.done) item.progress = 100; item.progressMode = progress ? 'manual' : item.progressMode; syncPlanToProject(item); }); reviewStep = d.plan.some(item => !item.done) ? 'defer' : 'summary'; if (reviewStep === 'summary') finalizeReview(); else renderEvening(); return; }
  if (target.id === 'finalizeReview') { finalizeReview(); return; }
  if (target.id === 'saveExtraTask') {
    const name = $('extraName').value.trim(), actual = Math.max(0, Math.round(Number($('extraActual').value) || 0)), selected = $('extraLink').value;
    if (!name) return;
    let projectId = null, stageId = null, estimatedMinutes = actual, progress = Math.max(0, Math.min(100, Math.round(Number($('extraProgress').value) || 0)));
    if (selected) { [projectId, stageId] = selected.split(':'); const project = d.projects.find(item => item.id == projectId), stage = project?.stages.find(item => item.id == stageId); estimatedMinutes = stage?.estimatedMinutes || actual; progress = stage ? stageProgress(stage) : progress; }
    const item = { id: `extra-${Date.now()}`, name, projectId, stageId, minutes: actual, plannedMinutes: actual, estimatedMinutes, actualMinutes: actual, progress, progressMode: selected ? 'auto' : 'manual', done: false, isExtra: true, projectActualApplied: Boolean(selected), date: todayKey() };
    if (selected) { const project = d.projects.find(candidate => candidate.id == projectId); const stage = project?.stages.find(candidate => candidate.id == stageId); if (stage) { stage.actualMinutes = (Number(stage.actualMinutes) || 0) + actual; item.progress = stageProgress(stage); } }
    d.plan.push(item); syncPlanToProject(item);
    if (d.dailyReviews[todayKey()]?.confirmed) d.dailyReviews[todayKey()].tasks = d.plan.map(planItem => ({ ...planItem }));
    save(); closeModal(); render(); toast('오늘 한 일로 기록했어.'); return;
  }
  const eventButton = target.closest('[data-event-id]'); if (eventButton) { editEvent(eventButton.dataset.eventId); return; }
  const projectButton = target.closest('[data-project-id]'); if (projectButton) { editProject(projectButton.dataset.projectId); return; }
  const check = target.closest('[data-task-check]'); if (check) { const item = d.plan.find(planItem => planItem.id == check.dataset.taskCheck); if (item) { item.done = !item.done; item.progress = item.done ? 100 : item.progress; item.progressMode = item.done ? 'manual' : item.progressMode; syncPlanToProject(item); save(); render(); if (item.done) { const completedCheck = document.querySelector(`[data-task-check="${item.id}"]`); completedCheck.classList.add('pop'); if (!item.actualMinutes) document.querySelector(`[data-task-actual="${item.id}"]`).focus(); toast('팡! 하나 해냈어 🌿 실제 시간을 적어둘까?'); } } return; }
  const deleteCapture = target.closest('[data-delete-capture]'); if (deleteCapture) { d.captures = d.captures.filter(capture => capture.id !== deleteCapture.dataset.deleteCapture); save(); renderCaptures(); return; }
  const deleteStage = target.closest('[data-delete-stage]'); if (deleteStage) { target.closest('.stage-row').remove(); return; }
  const swap = target.closest('[data-swap-i]'); if (swap && pendingPlan) { const index = Number(swap.dataset.swapI); if (swap.dataset.rest) pendingPlan.splice(index, 1); else { const project = d.projects.find(item => item.id == swap.dataset.p); const stage = project.stages.find(item => item.progress < 100) || project.stages[0]; pendingPlan[index] = { ...pendingPlan[index], projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name}`, estimatedMinutes: stage.estimatedMinutes || 60, minutes: stage.estimatedMinutes || 60, actualMinutes: 0, progress: 0, done: false }; } openPlanChangeModal(); return; }
  if (target.id === 'applyPlanChange' && pendingPlan) { d.plan = pendingPlan; d.planAccepted = false; pendingPlan = null; save(); closeModal(); render(); return; }
  if (target.id === 'addStage') { const row = document.createElement('div'); row.className = 'stage-row'; const id = `new-${Date.now()}`; row.innerHTML = `<label>단계 이름<input class="input stage-name" data-stage-name="${id}" placeholder="단계 이름"></label><label>진행률 (%)<input class="input stage-number" type="number" min="0" max="100" step="1" data-stage-progress="${id}" value="0"></label><label>예상 소요시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-estimate="${id}" value="0"></label><label>실제 작업시간 (분)<input class="input stage-number" type="number" min="0" step="1" data-stage-actual="${id}" value="0"></label><button class="danger small-button" data-delete-stage="${id}">삭제</button>`; $('stageEditor').appendChild(row); return; }
  if (target.id === 'addEveningWork') { const suggestion = eveningSuggestion(); if (suggestion) { const project = d.projects.slice().sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity))[0]; const stage = project && (project.stages.find(item => item.progress < 100) || project.stages[0]); if (stage) { d.plan.push({ id: Date.now(), projectId: project.id, stageId: stage.id, name: `${project.name} · ${stage.name} (저녁)`, minutes: suggestion.minutes, plannedMinutes: suggestion.minutes, estimatedMinutes: stage.estimatedMinutes || suggestion.minutes, actualMinutes: 0, progress: stageProgress(stage), progressMode: 'auto', done: false, evening: true }); save(); render(); toast('저녁 작업을 오늘 계획에 추가했어.'); } } return; }
  if (target.id === 'skipEveningWork') { $('eveningSuggestion').innerHTML = '<div class="muted">오늘은 여기까지 하기로 했어.</div>'; return; }
  if (target.id === 'saveEvent') { const name = $('eventName').value.trim(); if (name && $('eventDate').value && $('eventTime').value) { d.events.push({ id: Date.now(), date: $('eventDate').value, time: $('eventTime').value, end: $('eventEnd').value, name, source: 'jumji', preparationMinutes: Number($('eventPreparation').value) }); save(); closeModal(); render(); toast('일정을 저장했어.'); } return; }
  if (target.id === 'updateEvent') { const item = d.events.find(eventItem => eventItem.id == target.dataset.id); if (item) { item.date = $('eventDate').value; item.time = $('eventTime').value; item.end = $('eventEnd').value; item.name = $('eventName').value.trim(); item.preparationMinutes = Number($('eventPreparation').value); save(); closeModal(); render(); toast('일정을 수정했어.'); } return; }
  if (target.id === 'deleteEvent') { d.events = d.events.filter(eventItem => eventItem.id != target.dataset.id); save(); closeModal(); render(); return; }
  if (target.id === 'recommendAgain') { closeModal(); recommend(); return; }
  if (target.id === 'saveProject') { const name = $('projectName').value.trim(); if (name) { const deadline = $('newNoDeadline')?.checked ? null : $('projectDeadline').value || null; d.projects.push({ id: Date.now(), name, description: $('projectDescription').value.trim(), importance: Math.max(1, Math.min(5, Number($('projectImportance').value) || 3)), deadline, status: '진행 중', stages: [{ id: `stage-${Date.now()}`, name: '시작 전', progress: 0, progressMode: 'auto', estimatedMinutes: 0, actualMinutes: 0 }], stage: '시작 전', progress: 0 }); save(); closeModal(); render(); } return; }
  if (target.id === 'deleteProject') { d.projects = d.projects.filter(project => project.id != target.dataset.id); d.plan = d.plan.filter(item => item.projectId != target.dataset.id); save(); closeModal(); render(); return; }
  if (target.id === 'updateProject') { const project = d.projects.find(item => item.id == target.dataset.id); if (project) { const rows = [...document.querySelectorAll('.stage-row')]; project.name = $('editProjectName').value.trim(); project.description = $('editProjectDescription').value.trim(); project.importance = Math.max(1, Math.min(5, Number($('editProjectImportance').value) || 3)); project.deadline = $('noDeadline').checked ? null : $('editProjectDeadline').value || null; project.status = $('editProjectStatus').value; project.stages = rows.map(row => { const id = row.querySelector('[data-stage-name]').dataset.stageName; const oldStage = project.stages.find(stage => String(stage.id) === id); const progressInput = row.querySelector('[data-stage-progress]'); return { id, name: row.querySelector('.stage-name').value.trim() || '새 단계', progress: Math.max(0, Math.min(100, Math.round(Number(progressInput.value) || 0))), progressMode: oldStage && Number(progressInput.value) === Number(oldStage.progress) ? oldStage.progressMode : 'manual', estimatedMinutes: Math.max(0, Math.round(Number(row.querySelector('[data-stage-estimate]').value) || 0)), actualMinutes: Math.max(0, Math.round(Number(row.querySelector('[data-stage-actual]').value) || 0)) }; }); syncProjectProgress(project); save(); closeModal(); render(); } return; }
  const defer = target.closest('[data-defer-reason]'); if (defer) { d.deferReasons[defer.dataset.deferReason] = defer.value; save(); return; }
  const note = target.closest('[data-defer-note]'); if (note) { note.addEventListener('change', () => { if (note.value.trim()) { d.deferReasons[note.dataset.deferNote] = note.value.trim(); save(); } }); return; }
});
document.addEventListener('input', event => {
  const target = event.target;
  const progress = target.closest('[data-task-progress], [data-task-percent]');
  if (progress) {
    const item = d.plan.find(planItem => planItem.id == (progress.dataset.taskProgress || progress.dataset.taskPercent));
    if (item) {
      item.progress = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0)));
      item.done = item.progress >= 100;
      item.progressMode = 'manual';
      syncPlanToProject(item);
      const task = progress.closest('.task');
      task.querySelector('[data-task-progress]').value = item.progress;
      task.querySelector('[data-task-percent]').value = item.progress;
      task.classList.toggle('done', item.done);
      save();
    }
    return;
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'newNoDeadline') {
    $('projectDeadline').disabled = event.target.checked;
    if (event.target.checked) $('projectDeadline').value = '';
  }
  const actual = event.target.closest('[data-task-actual]');
  if (actual) {
    const item = d.plan.find(planItem => planItem.id == actual.dataset.taskActual);
    if (item) {
      item.actualMinutes = Math.max(0, Math.round(Number(actual.value) || 0));
      item.progress = calculatedProgress(item.estimatedMinutes, item.actualMinutes, item.progress, item.progressMode, item.done);
      syncPlanToProject(item);
      save();
      render();
    }
  }
  const reviewNote = event.target.closest('[data-defer-note]');
  if (reviewNote) {
    d.deferReasons[`${reviewNote.dataset.deferNote}-note`] = reviewNote.value.trim();
    save();
  }
});
document.querySelectorAll('nav button').forEach(button => button.onclick = () => show(button.dataset.screen));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
migrate(); render();

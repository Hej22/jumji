(function () {
  const requiredArrayFields = ['projects', 'events', 'plan', 'captures'];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasArray = (value, field) => Array.isArray(value[field]);
  const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
  const isValidTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const isObjectArray = value => Array.isArray(value) && value.every(isObject);

  function validateImportedData(value) {
    const errors = [];
    if (!isObject(value)) {
      return { valid: false, errors: ['최상위 데이터는 객체여야 합니다.'] };
    }
    requiredArrayFields.forEach(field => {
      if (!hasArray(value, field)) errors.push(`${field} 필드는 배열이어야 합니다.`);
    });
    if (Object.prototype.hasOwnProperty.call(value, 'recurringTasks') && !Array.isArray(value.recurringTasks)) {
      errors.push('recurringTasks 필드는 배열이어야 합니다.');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dailyReviews') && !isObject(value.dailyReviews)) {
      errors.push('dailyReviews 필드는 날짜별 기록 객체여야 합니다.');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'deferReasons') && !isObject(value.deferReasons)) {
      errors.push('deferReasons 필드는 객체여야 합니다.');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'planAccepted') && typeof value.planAccepted !== 'boolean') {
      errors.push('planAccepted 필드는 불리언이어야 합니다.');
    }
    if (value.projects && value.projects.some(project => !isObject(project))) {
      errors.push('projects의 각 항목은 객체여야 합니다.');
    }
    if (value.projects && value.projects.some(project => isObject(project) && (project.id == null || typeof project.name !== 'string'))) {
      errors.push('projects의 각 항목에는 식별자와 이름이 필요합니다.');
    }
    if (value.projects && value.projects.some(project => {
      if (!isObject(project) || !Object.prototype.hasOwnProperty.call(project, 'stages')) return false;
      return !Array.isArray(project.stages) || project.stages.some(stage => !isObject(stage));
    })) {
      errors.push('projects.stages는 배열이어야 하며 각 요소는 객체여야 합니다.');
    }
    if (value.projects && value.projects.some(project => isObject(project) && Array.isArray(project.stages) && project.stages.some(stage => stage.name != null && typeof stage.name !== 'string'))) {
      errors.push('projects.stages의 이름은 문자열이어야 합니다.');
    }
    if (value.events && value.events.some(event => !isObject(event))) {
      errors.push('events의 각 항목은 객체여야 합니다.');
    }
    if (value.plan && value.plan.some(item => !isObject(item))) {
      errors.push('plan의 각 항목은 객체여야 합니다.');
    }
    if (value.captures && value.captures.some(capture => !isObject(capture))) {
      errors.push('captures의 각 항목은 객체여야 합니다.');
    }
    if (value.recurringTasks && value.recurringTasks.some(task => !isObject(task))) {
      errors.push('recurringTasks의 각 항목은 객체여야 합니다.');
    }
    if (value.dailyReviews && Object.values(value.dailyReviews).some(review => !isObject(review)
      || (review.tasks != null && !isObjectArray(review.tasks))
      || (review.events != null && !isObjectArray(review.events)))) {
      errors.push('dailyReviews의 각 날짜 기록과 tasks/events는 올바른 객체/배열이어야 합니다.');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'workStart') && !isValidTime(value.workStart)) errors.push('workStart는 HH:MM 형식이어야 합니다.');
    if (Object.prototype.hasOwnProperty.call(value, 'workEnd') && !isValidTime(value.workEnd)) errors.push('workEnd는 HH:MM 형식이어야 합니다.');
    if (isValidTime(value.workStart) && isValidTime(value.workEnd) && value.workEnd <= value.workStart) errors.push('workEnd는 workStart보다 늦어야 합니다.');
    if (Object.prototype.hasOwnProperty.call(value, 'workdays') && (!Array.isArray(value.workdays)
      || value.workdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) errors.push('workdays는 0~6 정수 배열이어야 합니다.');
    ['lunchEnabled', 'fikaEnabled'].forEach(field => {
      if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] !== 'boolean') errors.push(`${field} 필드는 불리언이어야 합니다.`);
    });
    ['lunchDuration', 'fikaDuration'].forEach(field => {
      if (Object.prototype.hasOwnProperty.call(value, field)
        && (!Number.isInteger(value[field]) || value[field] < 5 || value[field] > 180 || value[field] % 5 !== 0)) errors.push(`${field} 필드는 5~180 사이의 5분 단위 정수여야 합니다.`);
    });
    return { valid: errors.length === 0, errors };
  }

  function prepareImportedData(value, migrate) {
    const validation = validateImportedData(value);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    if (typeof migrate !== 'function') throw new Error('가져온 데이터를 변환할 수 없습니다.');
    const candidate = JSON.parse(JSON.stringify(value));
    candidate.recurringTasks ??= [];
    candidate.dailyReviews ??= {};
    candidate.deferReasons ??= {};
    candidate.planAccepted ??= false;
    migrate(candidate);
    const normalizedValidation = validateImportedData(candidate);
    if (!normalizedValidation.valid) throw new Error(normalizedValidation.errors.join(' '));
    return candidate;
  }

  function commitImportedData({ storage, key, backupKey, previousValue, backupData, importedData, savedAt }) {
    let previousBackup;
    try {
      previousBackup = storage.getItem(backupKey);
    } catch (cause) {
      const error = new Error('기존 복구 백업을 확인하지 못했습니다.', { cause });
      error.name = 'ImportBackupError';
      throw error;
    }
    const backupValue = JSON.stringify({ version: 1, savedAt, data: backupData });
    try {
      storage.setItem(backupKey, backupValue);
      if (storage.getItem(backupKey) !== backupValue) throw new Error('백업 확인에 실패했습니다.');
    } catch (cause) {
      try {
        if (storage.getItem(backupKey) !== previousBackup) {
          if (previousBackup === null) storage.removeItem(backupKey);
          else storage.setItem(backupKey, previousBackup);
        }
      } catch (restoreError) {
        cause.backupRestoreFailed = true;
      }
      const error = new Error('가져오기 전 백업을 저장하지 못했습니다.', { cause });
      error.name = 'ImportBackupError';
      throw error;
    }

    const serialized = JSON.stringify(importedData);
    try {
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new Error('가져온 데이터 저장 확인에 실패했습니다.');
    } catch (cause) {
      try {
        if (storage.getItem(key) !== previousValue) {
          if (previousValue === null) storage.removeItem(key);
          else storage.setItem(key, previousValue);
        }
        if (storage.getItem(key) !== previousValue) throw new Error('기존 저장 데이터 복구를 확인하지 못했습니다.');
      } catch (restoreError) {
        cause.rollbackFailed = true;
      }
      const error = new Error('가져온 데이터를 저장하지 못했습니다.', { cause });
      error.name = 'ImportCommitError';
      error.rollbackFailed = Boolean(cause.rollbackFailed);
      throw error;
    }
    return backupValue;
  }

  function summarizeImportedData(value) {
    return {
      projects: Array.isArray(value.projects) ? value.projects.length : 0,
      events: Array.isArray(value.events) ? value.events.length : 0,
      plan: Array.isArray(value.plan) ? value.plan.length : 0,
      captures: Array.isArray(value.captures) ? value.captures.length : 0,
      recurringTasks: Array.isArray(value.recurringTasks) ? value.recurringTasks.length : 0,
      dailyReviews: Object.keys(value.dailyReviews || {}).length
    };
  }

  globalThis.JumjiImportData = { validateImportedData, prepareImportedData, commitImportedData, summarizeImportedData };
})();

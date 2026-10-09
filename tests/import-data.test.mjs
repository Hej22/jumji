import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../import-data.js', import.meta.url), 'utf8');
const context = { console };
vm.createContext(context);
vm.runInContext(source, context);
const { validateImportedData, prepareImportedData, commitImportedData, summarizeImportedData } = context.JumjiImportData;

function createStorage(seed = {}, options = {}) {
  const values = new Map(Object.entries(seed));
  let failedAfterWrite = false;
  return {
    getItem(key) {
      if (key === options.failGetKey) throw new Error('synthetic storage read failure');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (key === options.failSetKey) throw new Error('synthetic storage failure');
      values.set(key, String(value));
      if (key === options.failAfterWriteKey && !failedAfterWrite) {
        failedAfterWrite = true;
        throw new Error('synthetic post-write failure');
      }
    },
    removeItem(key) { values.delete(key); }
  };
}

const validExport = {
  projects: [{ id: 1, name: '테스트', progress: 50, stages: [{ id: 's1', progress: 50 }] }],
  events: [{ id: 'e1', date: '2026-10-07', time: '09:00', end: '10:00' }],
  plan: [{ id: 'p1', projectId: 1, minutes: 60, dailyProgress: 20 }],
  captures: [{ id: 'c1', text: '기록' }],
  planAccepted: true,
  deferReasons: {},
  dailyReviews: {},
  recurringTasks: [{ id: 'r1', name: '반복', active: true }]
};

const result = validateImportedData(validExport);
assert.equal(result.valid, true, result.errors.join('; '));
assert.deepEqual(JSON.parse(JSON.stringify(summarizeImportedData(validExport))), {
  projects: 1,
  events: 1,
  plan: 1,
  captures: 1,
  recurringTasks: 1,
  dailyReviews: 0
});

const malformed = JSON.parse(JSON.stringify(validExport));
malformed.projects = 'not-an-array';
const invalid = validateImportedData(malformed);
assert.equal(invalid.valid, false);
assert.match(invalid.errors.join('; '), /projects/);

const noData = { projects: [], events: [], plan: [], captures: [] };
assert.equal(validateImportedData(noData).valid, true);
const legacyCandidate = prepareImportedData(noData, candidate => candidate);
assert.deepEqual(JSON.parse(JSON.stringify(legacyCandidate.recurringTasks)), []);
assert.deepEqual(JSON.parse(JSON.stringify(legacyCandidate.recurringDecisions)), {});
assert.deepEqual(JSON.parse(JSON.stringify(legacyCandidate.dailyReviews)), {});
assert.deepEqual(JSON.parse(JSON.stringify(legacyCandidate.deferReasons)), {});
assert.equal(legacyCandidate.planAccepted, false);

const wrongReviewType = { ...validExport, dailyReviews: [] };
assert.equal(validateImportedData(wrongReviewType).valid, false);
assert.equal(validateImportedData({ ...validExport, recurringDecisions: { old: { templateId: 'r1', occurrenceDate: '2026-10-09', action: 'defer', planDate: '2026-10-12' } } }).valid, true);
assert.equal(validateImportedData({ ...validExport, recurringDecisions: { old: { templateId: 'r1', occurrenceDate: '2026-10-09', action: 'defer', planDate: '2026-10-08' } } }).valid, false);

const rootArray = [validExport];
assert.equal(validateImportedData(rootArray).valid, false);

const invalidStage = JSON.parse(JSON.stringify(validExport));
invalidStage.projects[0].stages = [null];
assert.equal(validateImportedData(invalidStage).valid, false);

const invalidStageObject = JSON.parse(JSON.stringify(validExport));
invalidStageObject.projects[0].stages = ['not-an-object'];
assert.equal(validateImportedData(invalidStageObject).valid, false);

const original = JSON.parse(JSON.stringify(validExport));
validateImportedData(validExport);
assert.deepEqual(validExport, original);

assert.throws(() => JSON.parse('{invalid json'));
assert.throws(() => prepareImportedData(validExport, () => { throw new Error('synthetic migration failure'); }), /synthetic migration failure/);
assert.deepEqual(validExport, original);

const appKey = 'jumji_v03';
const backupKey = `${appKey}_preimport_backup`;
const originalRaw = JSON.stringify(validExport);
const roundTripStorage = createStorage({ [appKey]: originalRaw });
const imported = prepareImportedData(validExport, candidate => candidate);
commitImportedData({ storage: roundTripStorage, key: appKey, backupKey, previousValue: originalRaw, backupData: originalRaw, importedData: imported, savedAt: '2026-10-09T00:00:00.000Z' });
assert.equal(validateImportedData(JSON.parse(roundTripStorage.getItem(appKey))).valid, true);
const savedBackup = JSON.parse(roundTripStorage.getItem(backupKey));
assert.equal(savedBackup.version, 1);
assert.equal(savedBackup.data, originalRaw);

const backupFailureStorage = createStorage({ [appKey]: originalRaw, [backupKey]: 'older-backup' }, { failSetKey: backupKey });
assert.throws(() => commitImportedData({ storage: backupFailureStorage, key: appKey, backupKey, previousValue: originalRaw, backupData: originalRaw, importedData: imported, savedAt: '2026-10-09T00:00:00.000Z' }), error => error.name === 'ImportBackupError');
assert.equal(backupFailureStorage.getItem(appKey), originalRaw);
assert.equal(backupFailureStorage.getItem(backupKey), 'older-backup');

const backupReadFailureStorage = createStorage({ [appKey]: originalRaw }, { failGetKey: backupKey });
assert.throws(() => commitImportedData({ storage: backupReadFailureStorage, key: appKey, backupKey, previousValue: originalRaw, backupData: originalRaw, importedData: imported, savedAt: '2026-10-09T00:00:00.000Z' }), error => error.name === 'ImportBackupError');
assert.equal(backupReadFailureStorage.getItem(appKey), originalRaw);

const commitFailureStorage = createStorage({ [appKey]: originalRaw }, { failSetKey: appKey });
assert.throws(() => commitImportedData({ storage: commitFailureStorage, key: appKey, backupKey, previousValue: originalRaw, backupData: originalRaw, importedData: imported, savedAt: '2026-10-09T00:00:00.000Z' }), error => error.name === 'ImportCommitError');
assert.equal(commitFailureStorage.getItem(appKey), originalRaw);
assert.equal(JSON.parse(commitFailureStorage.getItem(backupKey)).data, originalRaw);

const postWriteFailureStorage = createStorage({ [appKey]: originalRaw }, { failAfterWriteKey: appKey });
assert.throws(() => commitImportedData({ storage: postWriteFailureStorage, key: appKey, backupKey, previousValue: originalRaw, backupData: originalRaw, importedData: imported, savedAt: '2026-10-09T00:00:00.000Z' }), error => error.name === 'ImportCommitError');
assert.equal(postWriteFailureStorage.getItem(appKey), originalRaw);

const cancelledStorage = createStorage({ [appKey]: originalRaw });
assert.equal(cancelledStorage.getItem(appKey), originalRaw);

console.log('Import safety tests passed: validation, legacy defaults, migration isolation, backup, rollback, and cancellation checks');

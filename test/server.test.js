/**
 * Server-side tests for Code.gs
 * Runs the real Code.gs inside Node with mocked Google Apps Script services
 * (SpreadsheetApp, DriveApp, LockService, PropertiesService, Utilities).
 *
 * Run: node test/server.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------- GAS mocks
function makeEnv() {
  const props = {};
  const files = {};              // id -> { trashed }
  let fileCounter = 0;
  let uuidCounter = 0;
  const sheetData = [];          // array of row arrays; index 0 = sheet row 1
  let lockCount = 0, unlockCount = 0;

  function ensureCell(r, c) {
    while (sheetData.length < r) sheetData.push([]);
    const row = sheetData[r - 1];
    while (row.length < c) row.push('');
  }

  const sheet = {
    setName() {}, setFrozenRows() {},
    appendRow(row) { sheetData.push(row.slice()); },
    getLastRow() { return sheetData.length; },
    deleteRow(r) { sheetData.splice(r - 1, 1); },
    getRange(r, c, nr, nc) {
      if (nr === undefined) { nr = 1; nc = 1; }
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = sheetData[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] !== undefined ? row[c - 1 + j] : '');
            out.push(line);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValue(v) { ensureCell(r, c); sheetData[r - 1][c - 1] = v; },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++)
            for (let j = 0; j < vals[i].length; j++) {
              ensureCell(r + i, c + j);
              sheetData[r - 1 + i][c - 1 + j] = vals[i][j];
            }
        }
      };
    }
  };

  const ss = { getSheets: () => [sheet], getSheetByName: () => sheet, getId: () => 'ss1' };

  const ctx = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { lockCount++; },
        releaseLock() { unlockCount++; }
      })
    },
    SpreadsheetApp: { create: () => ss, openById: () => ss },
    DriveApp: {
      createFolder: () => ({ getId: () => 'folder1' }),
      getFolderById: () => ({
        createFile() {
          const id = 'file' + (++fileCounter);
          files[id] = { trashed: false };
          return { getId: () => id, setSharing() {} };
        }
      }),
      getFileById(id) {
        if (!files[id]) throw new Error('no such file: ' + id);
        return { setTrashed(v) { files[id].trashed = v; } };
      },
      Access: { ANYONE_WITH_LINK: 1 },
      Permission: { VIEW: 1 }
    },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuidCounter),
      base64Decode: s => Buffer.from(s, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name })
    },
    HtmlService: {
      createHtmlOutputFromFile() {
        const o = { setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o };
        return o;
      },
      XFrameOptionsMode: { ALLOWALL: 1 }
    }
  };

  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx);
  return { ctx, files, sheetData, locks: () => ({ lockCount, unlockCount }) };
}

// ---------------------------------------------------------------- tiny test runner
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function throws(fn, msg) {
  try { fn(); check(false, msg + ' (did NOT throw)'); }
  catch (e) { check(true, msg + ' → "' + e.message + '"'); }
}
const B64 = Buffer.from('fake-jpeg-bytes').toString('base64');

// ================================================================ tests
console.log('\n== doGet / setup ==');
{
  const { ctx } = makeEnv();
  const out = ctx.doGet();
  check(!!out, 'doGet returns HTML output and auto-creates sheet + folder');
}

console.log('\n== addJob / getJobs ==');
{
  const { ctx, sheetData } = makeEnv();
  const j1 = ctx.addJob({ tab: 'want', category: '', note: 'Job A', photos: [B64] });
  check(j1.id && j1.status === 'pending' && j1.photoIds.length === 1, 'addJob(want) returns pending job with 1 photo');
  check(typeof j1.createdAt === 'number', 'createdAt is a timestamp');

  const j2 = ctx.addJob({ tab: 'delivery', category: 'lalamove', note: 'Send by 5pm', photos: [B64] });
  check(j2.category === 'lalamove', 'addJob(delivery) keeps category');

  const j3 = ctx.addJob({ tab: 'postage', category: '', note: '', photos: [B64, B64] });
  check(j3.photoIds.length === 2, 'addJob(postage) stores 2 photos');

  check(sheetData.length === 4, 'sheet has header + 3 rows');

  const want = ctx.getJobs('want');
  check(want.length === 1 && want[0].note === 'Job A', 'getJobs(want) returns only want jobs');

  ctx.addJob({ tab: 'want', category: '', note: 'Job B', photos: [B64] });
  const want2 = ctx.getJobs('want');
  check(want2[0].note === 'Job B' && want2[1].note === 'Job A', 'getJobs is newest-first');

  throws(() => ctx.addJob({ tab: 'want', category: '', note: 'x', photos: [] }), 'addJob with no photo throws');

  const counts = ctx.getCounts();
  check(counts.want === 2 && counts.delivery === 1 && counts.postage === 1, 'getCounts counts pending per tab');
}

console.log('\n== updateStatus ==');
{
  const { ctx, files } = makeEnv();
  const w = ctx.addJob({ tab: 'want', note: '', category: '', photos: [B64] });
  const d = ctx.addJob({ tab: 'delivery', note: '', category: 'bus', photos: [B64] });

  const r1 = ctx.updateStatus(w.id, 'got', null);
  check(r1.status === 'got' && typeof r1.doneAt === 'number', "updateStatus 'got' works without photo");
  check(ctx.getJobs('want')[0].status === 'got', 'status persisted in sheet');

  ctx.updateStatus(w.id, 'notseen', null);
  check(ctx.getJobs('want')[0].status === 'notseen', "can flip to 'notseen'");

  throws(() => ctx.updateStatus(d.id, 'done', null), "'done' without proof photo throws");

  const r2 = ctx.updateStatus(d.id, 'done', B64);
  check(r2.proofPhotoId && files[r2.proofPhotoId] && !files[r2.proofPhotoId].trashed, "'done' with photo saves proof to Drive");
  check(ctx.getJobs('delivery')[0].proofPhotoId === r2.proofPhotoId, 'proof id persisted in sheet');

  ctx.updateStatus(d.id, 'archived', null);
  check(ctx.getJobs('delivery').length === 0, 'archived jobs are hidden from getJobs');
  check(ctx.getCounts().delivery === 0, 'archived jobs are not counted');

  throws(() => ctx.updateStatus('no-such-id', 'got', null), 'unknown id throws');
  throws(() => ctx.updateStatus(w.id, 'hacked', null), 'invalid status value throws');

  // proof photo uploaded for a job that vanished must be cleaned up
  const before = Object.keys(files).length;
  throws(() => ctx.updateStatus('ghost', 'done', B64), "'done' on missing job throws");
  const orphan = Object.keys(files)[before];
  check(files[orphan].trashed === true, 'orphaned proof photo is trashed');
}

console.log('\n== editJob ==');
{
  const { ctx, files } = makeEnv();
  const j = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'old note', photos: [B64] });
  const oldPhoto = j.photoIds[0];

  const e1 = ctx.editJob(j.id, { note: 'new note', category: 'pickup', photo1: null, photo2: null });
  check(e1.note === 'new note' && e1.category === 'pickup', 'edit note + category without touching photos');
  check(e1.photoIds[0] === oldPhoto && !files[oldPhoto].trashed, 'existing photo untouched when photo1 is null');

  const e2 = ctx.editJob(j.id, { note: 'new note', category: 'pickup', photo1: B64, photo2: null });
  check(e2.photoIds[0] !== oldPhoto, 'photo replaced when new photo1 given');
  check(files[oldPhoto].trashed === true, 'old photo moved to trash');
  check(ctx.getJobs('delivery')[0].note === 'new note', 'edit persisted in sheet');

  // postage second photo
  const p = ctx.addJob({ tab: 'postage', category: '', note: '', photos: [B64, B64] });
  const oldAwb = p.photoIds[1];
  const e3 = ctx.editJob(p.id, { note: '', category: '', photo1: null, photo2: B64 });
  check(e3.photoIds[1] !== oldAwb && files[oldAwb].trashed, 'postage airway-bill photo replaceable');
  check(e3.photoIds[0] === p.photoIds[0], 'first photo kept');

  // editing a missing job must clean up freshly uploaded photos
  const before = Object.keys(files).length;
  throws(() => ctx.editJob('ghost', { note: '', category: '', photo1: B64, photo2: B64 }), 'edit on missing job throws');
  const ids = Object.keys(files);
  check(files[ids[before]].trashed && files[ids[before + 1]].trashed, 'uploaded photos for failed edit are trashed');
}

console.log('\n== deleteJob ==');
{
  const { ctx, files, sheetData } = makeEnv();
  const a = ctx.addJob({ tab: 'want', category: '', note: 'A', photos: [B64] });
  const b = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'B', photos: [B64] });
  ctx.updateStatus(b.id, 'done', B64);
  const bProof = ctx.getJobs('delivery')[0].proofPhotoId;

  const res = ctx.deleteJob(b.id);
  check(res.ok === true, 'deleteJob returns ok');
  check(ctx.getJobs('delivery').length === 0, 'deleted job gone from getJobs');
  check(sheetData.length === 2, 'row physically removed (header + 1 left)');
  check(files[b.photoIds[0]].trashed === true, 'job photo trashed');
  check(files[bProof].trashed === true, 'proof photo trashed too');
  check(ctx.getJobs('want').length === 1 && ctx.getJobs('want')[0].id === a.id, 'other jobs untouched');

  throws(() => ctx.deleteJob('no-such-id'), 'deleting unknown id throws');

  // delete the first data row specifically (regression: off-by-one row math)
  ctx.deleteJob(a.id);
  check(sheetData.length === 1, 'can delete first data row; only header remains');
  check(ctx.getJobs('want').length === 0 && ctx.getCounts().want === 0, 'empty sheet handled');
}

console.log('\n== lock hygiene ==');
{
  const env = makeEnv();
  const j = env.ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64] });
  env.ctx.updateStatus(j.id, 'got', null);
  env.ctx.editJob(j.id, { note: 'x', category: '', photo1: B64, photo2: null });
  env.ctx.deleteJob(j.id);
  try { env.ctx.deleteJob('ghost'); } catch (e) {}
  const l = env.locks();
  check(l.lockCount === l.unlockCount, 'every lock acquired is released (' + l.lockCount + '/' + l.unlockCount + ')');
}

console.log('\n================================');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

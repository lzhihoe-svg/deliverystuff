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
        createFile(blob) {
          const id = 'file' + (++fileCounter);
          files[id] = { trashed: false, blob };
          return { getId: () => id, setSharing() {} };
        }
      }),
      getFileById(id) {
        if (!files[id]) throw new Error('no such file: ' + id);
        return {
          setTrashed(v) { files[id].trashed = v; },
          getBlob() {
            const b = files[id].blob;
            return { getContentType: () => b.type, getBytes: () => b.bytes };
          }
        };
      },
      Access: { ANYONE_WITH_LINK: 1 },
      Permission: { VIEW: 1 }
    },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuidCounter),
      base64Decode: s => Buffer.from(s, 'base64'),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
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
const PIN = '1234';

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

  const r1 = ctx.updateStatus(w.id, 'got', null, null, null);
  check(r1.status === 'got' && typeof r1.doneAt === 'number', "updateStatus 'got' works without photo");
  check(ctx.getJobs('want')[0].status === 'got', 'status persisted in sheet');

  ctx.updateStatus(w.id, 'notseen', null, null, null);
  check(ctx.getJobs('want')[0].status === 'notseen', "can flip to 'notseen'");

  throws(() => ctx.updateStatus(d.id, 'done', null, null, null), "'done' without proof photo throws");

  const r2 = ctx.updateStatus(d.id, 'done', B64, B64, null);
  check(r2.proofPhotoId && files[r2.proofPhotoId] && !files[r2.proofPhotoId].trashed, "'done' with photo saves proof to Drive");
  check(ctx.getJobs('delivery')[0].proofPhotoId === r2.proofPhotoId, 'proof id persisted in sheet');

  ctx.updateStatus(d.id, 'archived', null, null, PIN);
  check(ctx.getJobs('delivery').length === 0, 'archived jobs are hidden from getJobs');
  check(ctx.getCounts().delivery === 0, 'archived jobs are not counted');

  throws(() => ctx.updateStatus('no-such-id', 'got', null, null, null), 'unknown id throws');
  throws(() => ctx.updateStatus(w.id, 'hacked', null, null, null), 'invalid status value throws');

  // proof photo uploaded for a job that vanished must be cleaned up
  const before = Object.keys(files).length;
  throws(() => ctx.updateStatus('ghost', 'done', B64, null, null), "'done' on missing job throws");
  const orphan = Object.keys(files)[before];
  check(files[orphan].trashed === true, 'orphaned proof photo is trashed');
}

console.log('\n== editJob (multi-photo spec) ==');
{
  const { ctx, files } = makeEnv();
  const j = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'old note', photos: [B64, B64] });
  const [pA, pB] = j.photoIds;

  // keep both photos, change text only
  const e1 = ctx.editJob(j.id, { note: 'new note', category: 'pickup', photos: [{ id: pA }, { id: pB }] }, PIN);
  check(e1.note === 'new note' && e1.category === 'pickup', 'edit note + category');
  check(e1.photoIds[0] === pA && e1.photoIds[1] === pB && !files[pA].trashed, 'kept photos untouched');

  // reorder photos
  const e2 = ctx.editJob(j.id, { note: 'new note', category: 'pickup', photos: [{ id: pB }, { id: pA }] }, PIN);
  check(e2.photoIds[0] === pB && e2.photoIds[1] === pA, 'photos can be reordered');
  check(!files[pA].trashed && !files[pB].trashed, 'reordering trashes nothing');

  // remove one, add two new
  const e3 = ctx.editJob(j.id, { note: 'n', category: 'bus', photos: [{ id: pA }, { b64: B64 }, { b64: B64 }] }, PIN);
  check(e3.photoIds.length === 3 && e3.photoIds[0] === pA, 'removed + added photos applied');
  check(files[pB].trashed === true, 'removed photo moved to trash');
  check(!files[e3.photoIds[1]].trashed && !files[e3.photoIds[2]].trashed, 'new photos alive');
  check(ctx.getJobs('delivery')[0].photoIds.length === 3, 'persisted in sheet');

  throws(() => ctx.editJob(j.id, { note: '', category: '', photos: [] }, PIN), 'edit with zero photos throws');
  throws(() => ctx.editJob(j.id, { note: '', category: '',
    photos: [{b64:B64},{b64:B64},{b64:B64},{b64:B64},{b64:B64},{b64:B64},{b64:B64}] }, PIN), 'edit with 7 photos throws');

  // editing a missing job must clean up freshly uploaded photos
  const before = Object.keys(files).length;
  throws(() => ctx.editJob('ghost', { note: '', category: '', photos: [{ b64: B64 }] }, PIN), 'edit on missing job throws');
  const ids = Object.keys(files);
  check(files[ids[before]].trashed === true, 'uploaded photo for failed edit is trashed');
}

console.log('\n== multi-photo addJob ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64, B64, B64, B64] });
  check(j.photoIds.length === 4, 'addJob stores 4 photos');
  check(ctx.getJobs('want')[0].photoIds.length === 4, 'all 4 persisted');
  throws(() => ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64,B64,B64,B64,B64,B64,B64] }), '7 photos rejected (max 6)');
}

console.log('\n== resetAll (new day) ==');
{
  const { ctx } = makeEnv();
  ctx.addJob({ tab: 'want', category: '', note: 'a', photos: [B64] });
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'b', photos: [B64] });
  ctx.addJob({ tab: 'postage', category: '', note: 'c', photos: [B64, B64] });
  ctx.updateStatus(d.id, 'done', B64, B64, null);

  throws(() => ctx.resetAll(''), 'staff cannot reset');
  throws(() => ctx.resetAll('9999'), 'wrong PIN cannot reset');
  check(ctx.getJobs('want').length === 1, 'nothing cleared by failed attempts');

  const res = ctx.resetAll(PIN);
  check(res.ok === true && res.archived === 3, 'admin reset archives all 3 jobs');
  check(ctx.getJobs('want').length === 0 && ctx.getJobs('delivery').length === 0 && ctx.getJobs('postage').length === 0,
    'all tabs empty after reset');
  const c = ctx.getCounts();
  check(c.want === 0 && c.delivery === 0 && c.postage === 0, 'badges all zero');
  check(ctx.resetAll(PIN).archived === 0, 'second reset archives nothing (idempotent)');
}

console.log('\n== resetDone (clear finished work only) ==');
{
  const { ctx } = makeEnv();
  const w1 = ctx.addJob({ tab: 'want', category: '', note: 'seen', photos: [B64] });
  const w2 = ctx.addJob({ tab: 'want', category: '', note: 'notseen', photos: [B64] });
  ctx.addJob({ tab: 'want', category: '', note: 'todo', photos: [B64] });
  const d1 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'done', photos: [B64] });
  ctx.addJob({ tab: 'delivery', category: 'bus', note: 'todo', photos: [B64] });
  const p1 = ctx.addJob({ tab: 'postage', category: '', note: 'done', photos: [B64, B64] });
  ctx.updateStatus(w1.id, 'got', null, null, null);
  ctx.updateStatus(w2.id, 'notseen', null, null, null);
  ctx.updateStatus(d1.id, 'done', B64, B64, null);
  ctx.updateStatus(p1.id, 'done', B64, B64, null);

  throws(() => ctx.resetDone(''), 'staff cannot clear done');
  throws(() => ctx.resetDone('9999'), 'wrong PIN cannot clear done');
  check(ctx.getJobs('want').length === 3, 'nothing cleared by failed attempts');

  const res = ctx.resetDone(PIN);
  check(res.ok === true && res.archived === 3, 'archives the Got It + 2 done jobs (3 total)');
  check(res.carried === 3, 'reports 3 unfinished jobs carried forward');
  const want = ctx.getJobs('want');
  check(want.length === 2, 'Got It jobsheet archived, the rest stay');
  check(want.some(j => j.status === 'notseen') && want.some(j => j.status === 'pending'),
    'Not Seen and To Do jobsheets carried forward');
  check(ctx.getJobs('delivery').length === 1 && ctx.getJobs('delivery')[0].status === 'pending',
    'unfinished delivery carried forward');
  check(ctx.getJobs('postage').length === 0, 'done postage archived');
  check(ctx.resetDone(PIN).archived === 0, 'second clear archives nothing (idempotent)');
}

console.log('\n== updateProof / deleteProof (staff can fix proof photos) ==');
{
  const { ctx, files } = makeEnv();
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64], thumbs: [B64] });
  const r = ctx.updateStatus(d.id, 'done', B64, B64, null);

  // retake — NO PIN needed, staff are allowed
  const r2 = ctx.updateProof(d.id, B64, B64);
  check(r2.proofPhotoId && r2.proofPhotoId !== r.proofPhotoId, 'updateProof stores a NEW proof photo');
  check(files[r.proofPhotoId].trashed && files[r.proofThumbId].trashed, 'old proof + its thumb trashed');
  const jj = ctx.getJobs('delivery')[0];
  check(jj.proofPhotoId === r2.proofPhotoId && jj.proofThumbId === r2.proofThumbId, 'new proof persisted in sheet');
  check(jj.status === 'done', 'job stays done after a retake');
  throws(() => ctx.updateProof(d.id, null, null), 'updateProof without a photo throws');
  throws(() => ctx.updateProof('ghost', B64, B64), 'updateProof on a missing job throws');

  // remove — job must go BACK to To Do
  const r3 = ctx.deleteProof(d.id);
  check(r3.status === 'pending', 'deleteProof returns pending');
  check(files[r2.proofPhotoId].trashed && files[r2.proofThumbId].trashed, 'removed proof files trashed');
  const back = ctx.getJobs('delivery')[0];
  check(back.status === 'pending' && !back.proofPhotoId && !back.proofThumbId, 'job is back in To Do with no proof');
  check(back.doneAt === '' || back.doneAt === 0, 'doneAt cleared');
  check(ctx.getCounts().delivery === 1, 'badge counts it as pending again');
  throws(() => ctx.deleteProof('ghost'), 'deleteProof on a missing job throws');
}

console.log('\n== deleteJob ==');
{
  const { ctx, files, sheetData } = makeEnv();
  const a = ctx.addJob({ tab: 'want', category: '', note: 'A', photos: [B64] });
  const b = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'B', photos: [B64] });
  ctx.updateStatus(b.id, 'done', B64, B64, null);
  const bProof = ctx.getJobs('delivery')[0].proofPhotoId;

  const res = ctx.deleteJob(b.id, PIN);
  check(res.ok === true, 'deleteJob returns ok');
  check(ctx.getJobs('delivery').length === 0, 'deleted job gone from getJobs');
  check(sheetData.length === 2, 'row physically removed (header + 1 left)');
  check(files[b.photoIds[0]].trashed === true, 'job photo trashed');
  check(files[bProof].trashed === true, 'proof photo trashed too');
  check(ctx.getJobs('want').length === 1 && ctx.getJobs('want')[0].id === a.id, 'other jobs untouched');

  throws(() => ctx.deleteJob('no-such-id', PIN), 'deleting unknown id throws');

  // delete the first data row specifically (regression: off-by-one row math)
  ctx.deleteJob(a.id, PIN);
  check(sheetData.length === 1, 'can delete first data row; only header remains');
  check(ctx.getJobs('want').length === 0 && ctx.getCounts().want === 0, 'empty sheet handled');
}

console.log('\n== thumbnails + getInitData (speed) ==');
{
  const { ctx, files } = makeEnv();
  const j = ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64, B64], thumbs: [B64, B64] });
  check(j.thumbIds.length === 2 && j.thumbIds[0] && files[j.thumbIds[0]], 'addJob stores a thumbnail per photo');
  check(ctx.getJobs('want')[0].thumbIds.length === 2, 'thumbIds persisted in sheet');

  const noThumbs = ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64] });
  check(noThumbs.thumbIds[0] === '', 'jobs without thumbs still work (old clients)');

  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64], thumbs: [B64] });
  const r = ctx.updateStatus(d.id, 'done', B64, B64, null);
  check(r.proofThumbId && files[r.proofThumbId], 'proof photo gets a thumbnail too');
  check(ctx.getJobs('delivery')[0].proofThumbId === r.proofThumbId, 'proofThumbId persisted');

  // edit: replaced photo trashes its thumb as well
  const e = ctx.editJob(j.id, { note: '', category: '', photos: [{ b64: B64, thumb: B64 }] }, PIN);
  check(files[j.photoIds[0]].trashed && files[j.thumbIds[0]].trashed, 'removed photo AND its thumb trashed');
  check(e.thumbIds[0] && files[e.thumbIds[0]] && !files[e.thumbIds[0]].trashed, 'new thumb saved on edit');

  // delete trashes thumbs + proof thumb
  ctx.deleteJob(d.id, PIN);
  check(files[d.thumbIds[0]].trashed && files[r.proofThumbId].trashed, 'delete trashes thumbs and proof thumb');

  const init = ctx.getInitData('want');
  check(Array.isArray(init.jobs) && init.jobs.length === 2, 'getInitData returns jobs');
  check(init.counts.want === 2, 'getInitData returns counts in the same round trip');
}

console.log('\n== addPhotoToJob (parallel uploads) ==');
{
  const { ctx, files } = makeEnv();
  const j = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64], thumbs: [B64] });
  const r1 = ctx.addPhotoToJob(j.id, 1, B64, B64);
  const r2 = ctx.addPhotoToJob(j.id, 2, B64, B64);
  check(r1.photoId && r2.photoId, 'photos 2 and 3 attach to the job');
  const got = ctx.getJobs('delivery')[0];
  check(got.photoIds.length === 3 && got.photoIds[1] === r1.photoId && got.photoIds[2] === r2.photoId,
    'photos land at their positions (order preserved)');
  check(got.thumbIds[1] === r1.thumbId && got.thumbIds[2] === r2.thumbId, 'thumbs land alongside');

  // out-of-order arrival still lands correctly
  const k = ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64], thumbs: [B64] });
  const r3 = ctx.addPhotoToJob(k.id, 3, B64, B64); // photo 4 arrives before photo 2
  const r4 = ctx.addPhotoToJob(k.id, 1, B64, B64);
  const got2 = ctx.getJobs('want')[0];
  check(got2.photoIds[3] === r3.photoId && got2.photoIds[1] === r4.photoId, 'out-of-order arrivals slot correctly');

  throws(() => ctx.addPhotoToJob('ghost', 1, B64, B64), 'unknown job throws');
  const before = Object.keys(files).length;
  try { ctx.addPhotoToJob('ghost', 1, B64, B64); } catch (e) {}
  const ids = Object.keys(files);
  check(files[ids[before]].trashed && files[ids[before + 1]].trashed, 'orphaned photo+thumb trashed on failure');
  throws(() => ctx.addPhotoToJob(j.id, 9, B64, B64), 'index over the 6-photo cap throws');
  throws(() => ctx.addPhotoToJob(j.id, 1, null, null), 'missing photo throws');
}

console.log('\n== dueAt (ready-by deadline) ==');
{
  const { ctx } = makeEnv();
  const due = Date.now() + 3600000;
  const j = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64], thumbs: [B64], dueAt: due });
  check(j.dueAt === due, 'addJob stores dueAt');
  check(ctx.getJobs('delivery')[0].dueAt === due, 'dueAt persisted in sheet');
  const noDue = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64] });
  check(noDue.dueAt === '', 'jobs without deadline store empty');
  const due2 = Date.now() + 7200000;
  const e = ctx.editJob(j.id, { note: '', category: 'bus', dueAt: due2, photos: [{ id: j.photoIds[0], thumbId: j.thumbIds[0] }] }, PIN);
  check(e.dueAt === due2, 'editJob can change the deadline');
  check(ctx.getJobs('delivery').find(x => x.id === j.id).dueAt === due2, 'changed deadline persisted');
  const e2 = ctx.editJob(j.id, { note: '', category: 'bus', dueAt: '', photos: [{ id: j.photoIds[0], thumbId: j.thumbIds[0] }] }, PIN);
  check(e2.dueAt === '', 'deadline can be cleared');
  const init = ctx.getInitData('delivery');
  check(init.jobs.length === 2, 'getInitData still fine with dueAt column');
}

console.log('\n== askAgain (re-check with staff) ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'want', category: '', note: 'Jobsheet A', photos: [B64], thumbs: [B64] });
  ctx.updateStatus(j.id, 'got', null, null, null);
  check(ctx.getJobs('want')[0].status === 'got', 'job swiped as got');
  throws(() => ctx.askAgain(j.id, ''), 'staff cannot ask again');
  throws(() => ctx.askAgain(j.id, '9999'), 'wrong PIN cannot ask again');
  const r = ctx.askAgain(j.id, PIN);
  check(r.status === 'pending' && typeof r.pinnedAt === 'number', 'askAgain returns pending + pinned');
  const back = ctx.getJobs('want')[0];
  check(back.status === 'pending', 'job is back in the swipe deck');
  check(back.doneAt === '', 'old answer time cleared');
  check(back.pinnedAt === r.pinnedAt, 'pinned to the front of the deck');
  check(ctx.getCounts().want === 1, 'badge counts it as pending again');
  const j2 = ctx.addJob({ tab: 'want', category: '', note: 'B', photos: [B64] });
  ctx.updateStatus(j2.id, 'notseen', null, null, null);
  const r2 = ctx.askAgain(j2.id, PIN);
  check(r2.status === 'pending', 'works from notseen too');
  throws(() => ctx.askAgain('ghost', PIN), 'unknown id throws');
}

console.log('\n== jsCount (postage jobsheet/waybill split) ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'postage', category: '', note: '', photos: [B64, B64, B64], thumbs: [B64, B64, B64], jsCount: 2 });
  check(j.jsCount === 2, 'addJob stores the jobsheet count');
  check(ctx.getJobs('postage')[0].jsCount === 2, 'jsCount persisted in sheet');
  check(ctx.getAllData().jobs.postage[0].jsCount === 2, 'getAllData includes jsCount');
  const e = ctx.editJob(j.id, { note: '', category: '', dueAt: '', jsCount: 1,
    photos: j.photoIds.map((id, i) => ({ id: id, thumbId: j.thumbIds[i] })) }, PIN);
  check(e.jsCount === 1, 'edit can change the split');
  const legacy = ctx.addJob({ tab: 'postage', category: '', note: '', photos: [B64, B64] });
  check(legacy.jsCount === 0, 'legacy jobs without split store 0 (page treats 1st photo as jobsheet)');
}

console.log('\n== admin PIN enforcement ==');
{
  const { ctx } = makeEnv();
  check(ctx.checkPin('1234') === true, 'checkPin accepts the right PIN');
  check(ctx.checkPin('0000') === false, 'checkPin rejects a wrong PIN');
  check(ctx.checkPin('') === false, 'checkPin rejects empty PIN');

  const j = ctx.addJob({ tab: 'want', category: '', note: 'x', photos: [B64] });
  throws(() => ctx.editJob(j.id, { note: 'hack', category: '', photos: [{ id: j.photoIds[0] }] }, ''), 'staff (no PIN) cannot edit');
  throws(() => ctx.editJob(j.id, { note: 'hack', category: '', photos: [{ id: j.photoIds[0] }] }, '9999'), 'wrong PIN cannot edit');
  throws(() => ctx.deleteJob(j.id, ''), 'staff (no PIN) cannot delete');
  throws(() => ctx.deleteJob(j.id, '9999'), 'wrong PIN cannot delete');
  throws(() => ctx.updateStatus(j.id, 'archived', null, null, ''), 'staff (no PIN) cannot archive');
  check(ctx.getJobs('want').length === 1 && ctx.getJobs('want')[0].note === 'x', 'job untouched after failed attempts');

  ctx.updateStatus(j.id, 'got', null, null, null);
  check(ctx.getJobs('want')[0].status === 'got', 'staff CAN swipe (got) without PIN');
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64] });
  ctx.updateStatus(d.id, 'done', B64, B64, null);
  check(ctx.getJobs('delivery')[0].status === 'done', 'staff CAN complete with proof photo without PIN');

  const e = ctx.editJob(j.id, { note: 'fixed', category: '', photos: [{ id: j.photoIds[0] }] }, PIN);
  check(e.note === 'fixed', 'admin with PIN can edit');
  check(ctx.deleteJob(j.id, PIN).ok === true, 'admin with PIN can delete');
}

console.log('\n== getImagesData (photos on every device) ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64] });
  const map = ctx.getImagesData([j.photoIds[0], 'bogus-id']);
  check(typeof map[j.photoIds[0]] === 'string' && map[j.photoIds[0]].indexOf('data:image/jpeg;base64,') === 0,
    'returns image as data URI (no Drive sharing needed)');
  const decoded = Buffer.from(map[j.photoIds[0]].split(',')[1], 'base64').toString();
  check(decoded === 'fake-jpeg-bytes', 'image bytes round-trip correctly');
  check(map['bogus-id'] === null, 'missing file returns null instead of crashing');
  const many = ctx.getImagesData(['a','b','c','d','e','f','g','h']);
  check(Object.keys(many).length === 6, 'caps at 6 images per call');
}

console.log('\n== lock hygiene ==');
{
  const env = makeEnv();
  const j = env.ctx.addJob({ tab: 'want', category: '', note: '', photos: [B64] });
  env.ctx.updateStatus(j.id, 'got', null, null, null);
  env.ctx.editJob(j.id, { note: 'x', category: '', photos: [{ b64: B64 }] }, PIN);
  env.ctx.deleteJob(j.id, PIN);
  try { env.ctx.deleteJob('ghost', PIN); } catch (e) {}
  const l = env.locks();
  check(l.lockCount === l.unlockCount, 'every lock acquired is released (' + l.lockCount + '/' + l.unlockCount + ')');
}

console.log('\n================================');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

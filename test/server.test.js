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
  let lockCount = 0, unlockCount = 0;

  // sheet factory — the spreadsheet holds NAMED sheets (Jobs + Inventory)
  function makeSheet() {
    const data = []; // array of row arrays; index 0 = sheet row 1
    function ensureCell(r, c) {
      while (data.length < r) data.push([]);
      const row = data[r - 1];
      while (row.length < c) row.push('');
    }
    return {
      _data: data,
      setName() {}, setFrozenRows() {},
      appendRow(row) { data.push(row.slice()); },
      getLastRow() { return data.length; },
      deleteRow(r) { data.splice(r - 1, 1); },
      getRange(r, c, nr, nc) {
        if (nr === undefined) { nr = 1; nc = 1; }
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = data[r - 1 + i] || [];
              const line = [];
              for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] !== undefined ? row[c - 1 + j] : '');
              out.push(line);
            }
            return out;
          },
          getValue() { return this.getValues()[0][0]; },
          setValue(v) { ensureCell(r, c); data[r - 1][c - 1] = v; },
          setValues(vals) {
            for (let i = 0; i < vals.length; i++)
              for (let j = 0; j < vals[i].length; j++) {
                ensureCell(r + i, c + j);
                data[r - 1 + i][c - 1 + j] = vals[i][j];
              }
          }
        };
      }
    };
  }

  const sheet = makeSheet();
  const sheetData = sheet._data;
  const namedSheets = { Jobs: sheet };
  const ss = {
    getSheets: () => [sheet],
    getSheetByName: n => namedSheets[n] || null,
    insertSheet: n => { namedSheets[n] = makeSheet(); return namedSheets[n]; },
    getId: () => 'ss1'
  };

  // Drive folders: root + month subfolders (savePhoto_ files by month)
  const folderReg = {};
  function makeFolder(name) {
    if (folderReg[name]) return folderReg[name];
    const sub = {};
    const f = {
      getId: () => name,
      createFile(blob) {
        const id = 'file' + (++fileCounter);
        files[id] = { trashed: false, blob, folder: name };
        return { getId: () => id, setSharing() {} };
      },
      getFoldersByName(n) {
        let left = sub[n] ? 1 : 0;
        return { hasNext: () => left > 0, next: () => { left = 0; return sub[n]; } };
      },
      createFolder(n) { sub[n] = makeFolder(name + '/' + n); return sub[n]; },
      moveTo(dest) { f.movedTo = dest.getId(); }
    };
    folderReg[name] = f;
    return f;
  }

  const ctx = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: k => { delete props[k]; }
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
      createFolder: name => makeFolder(name || 'folder1'),
      getFolderById: id => folderReg[id] || makeFolder(id),
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
  return { ctx, files, sheetData, folders: folderReg, locks: () => ({ lockCount, unlockCount }) };
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

console.log('\n== resetDone (clear finished work only — the big ✔ decides) ==');
{
  const { ctx } = makeEnv();
  const w1 = ctx.addJob({ tab: 'want', category: '', note: 'seen', photos: [B64] });
  const w2 = ctx.addJob({ tab: 'want', category: '', note: 'notseen', photos: [B64] });
  ctx.addJob({ tab: 'want', category: '', note: 'todo', photos: [B64] });
  const d1 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'done delivered', photos: [B64] });
  const d2 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'done NOT confirmed', photos: [B64] });
  ctx.addJob({ tab: 'delivery', category: 'bus', note: 'todo', photos: [B64] });
  const p1 = ctx.addJob({ tab: 'postage', category: '', note: 'done sent', photos: [B64, B64] });
  const p2 = ctx.addJob({ tab: 'postage', category: '', note: 'done READY not sent', photos: [B64, B64] });
  const f1 = ctx.addJob({ tab: 'defect', category: '', note: 'fixed defect', photos: [B64, B64] });
  ctx.updateStatus(w1.id, 'got', null, null, null);
  ctx.updateStatus(w2.id, 'notseen', null, null, null);
  ctx.updateStatus(d1.id, 'done', B64, B64, null);
  ctx.updateStatus(d2.id, 'done', B64, B64, null);
  ctx.updateStatus(p1.id, 'done', B64, B64, null);
  ctx.updateStatus(p2.id, 'done', B64, B64, null);
  ctx.updateStatus(f1.id, 'done', B64, B64, null);
  ctx.markDelivered(d1.id, 'bus', 'ZH');
  ctx.markSentJnt(p1.id);

  throws(() => ctx.resetDone(''), 'staff cannot clear done');
  throws(() => ctx.resetDone('9999'), 'wrong PIN cannot clear done');
  check(ctx.getJobs('want').length === 3, 'nothing cleared by failed attempts');

  const res = ctx.resetDone(PIN);
  check(res.ok === true && res.archived === 4, 'archives Got It + ✔ delivered + ✔ sent + fixed defect (4 total)');
  check(res.carried === 5, '5 jobs carried forward (incl. ready-not-sent + done-not-confirmed)');
  const want = ctx.getJobs('want');
  check(want.length === 2, 'Got It jobsheet archived, the rest stay');
  check(want.some(j => j.status === 'notseen') && want.some(j => j.status === 'pending'),
    'Not Seen and To Do jobsheets carried forward');
  const dLeft = ctx.getJobs('delivery');
  check(dLeft.length === 2, '✔ Delivered job archived; to-do AND done-not-confirmed stay');
  check(dLeft.some(j => j.id === d2.id && j.status === 'done'),
    'a done delivery NOT yet confirmed Delivered survives Clear Done');
  const pLeft = ctx.getJobs('postage');
  check(pLeft.length === 1 && pLeft[0].id === p2.id && pLeft[0].status === 'done',
    'a READY parcel not yet given to J&T survives Clear Done');
  check(!pLeft[0].sentAt, '…and is still counted as ready for the truck');
  check(ctx.getJobs('defect').length === 0, 'fixed defects are archived (no second stage)');
  check(ctx.resetDone(PIN).archived === 0, 'second clear archives nothing (idempotent)');

  // once the survivors get their big ✔, the NEXT clear takes them
  ctx.markDelivered(d2.id, 'pickup', 'Bob');
  ctx.markSentJnt(p2.id);
  const res2 = ctx.resetDone(PIN);
  check(res2.archived === 2, 'after their ✔, the next Clear Done archives them');
  check(ctx.getJobs('postage').length === 0, 'sent parcel gone from the board');
}

console.log('\n== undoReset (bring back what a reset archived) ==');
{
  const { ctx } = makeEnv();
  const w1 = ctx.addJob({ tab: 'want', category: '', note: 'got', photos: [B64] });
  const w2 = ctx.addJob({ tab: 'want', category: '', note: 'todo', photos: [B64] });
  const d1 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'done', photos: [B64] });
  ctx.updateStatus(w1.id, 'got', null, null, null);
  ctx.updateStatus(d1.id, 'done', B64, B64, null);

  throws(() => ctx.undoReset(PIN), 'nothing to undo before any reset');

  // undo a FULL reset: every job returns with its old status
  ctx.resetAll(PIN);
  check(ctx.getJobs('want').length === 0, 'reset all cleared the tabs');
  throws(() => ctx.undoReset(''), 'staff cannot undo');
  const u1 = ctx.undoReset(PIN);
  check(u1.ok === true && u1.restored === 3, 'undo restores all 3 archived jobs');
  const wantBack = ctx.getJobs('want');
  check(wantBack.find(j => j.id === w1.id).status === 'got', "❤️ Got It came back as 'got', not pending");
  check(wantBack.find(j => j.id === w2.id).status === 'pending', 'To Do came back as pending');
  check(ctx.getJobs('delivery')[0].status === 'done', 'done job came back as done, proof intact');
  check(ctx.getJobs('delivery')[0].proofPhotoId, 'proof photo still attached after undo');
  throws(() => ctx.undoReset(PIN), 'second undo throws (one level of undo)');

  // undo a CLEAR DONE: only what IT archived comes back
  ctx.markDelivered(d1.id, 'bus', 'ZH'); // give it the big ✔ so Clear Done takes it
  ctx.resetDone(PIN);
  check(ctx.getJobs('want').length === 1 && ctx.getJobs('delivery').length === 0, 'clear done archived got + ✔ delivered');
  const u2 = ctx.undoReset(PIN);
  check(u2.restored === 2, 'undo restores the 2 jobs clear-done archived');
  check(ctx.getJobs('want').length === 2 && ctx.getJobs('delivery').length === 1, 'both back on the board');

  // a job archived by an OLDER reset must NOT come back with a newer undo
  ctx.resetAll(PIN);              // archives all 3 (snapshot A)
  const w3 = ctx.addJob({ tab: 'want', category: '', note: 'new day', photos: [B64] });
  ctx.resetAll(PIN);              // archives only the new job (snapshot B overwrites A)
  const u3 = ctx.undoReset(PIN);
  check(u3.restored === 1 && ctx.getJobs('want').length === 1 && ctx.getJobs('want')[0].id === w3.id,
    'undo only brings back the LAST reset, older archives stay archived');
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

console.log('\n== evidence filing: month / customer / one folder per job ==');
{
  const { ctx, files } = makeEnv();
  const now = new Date();
  const ym = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
  const day = ym + '-' + ('0' + now.getDate()).slice(-2);

  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: '2 jersey', customer: 'Nurul Syifa', photos: [B64], thumbs: [B64] });
  check(d.customer === 'Nurul Syifa', 'addJob stores the customer');
  const jf = files[d.photoIds[0]];
  check(jf.folder.indexOf('Kilang App Photos/Delivery/' + ym + '/Nurul Syifa/DELIVERY bus') === 0,
    'photo filed under Kilang App Photos / Delivery / month / CUSTOMER / job folder');
  check(jf.folder.indexOf(day) > 0, 'job folder name contains the date');
  check(jf.folder.indexOf('2 jersey') > 0, 'job folder name contains the note');
  check(jf.blob.name.indexOf('Photo 1 — Nurul Syifa') === 0, 'file named by its role + customer');

  // proof lands in the SAME job folder — jobsheet + proof together
  const r = ctx.updateStatus(d.id, 'done', B64, B64, null);
  const pf = files[r.proofPhotoId];
  check(pf.folder === jf.folder, 'PROOF stored in the SAME job folder as the photos');
  check(pf.blob.name.indexOf('PROOF — Nurul Syifa') === 0, "proof file named 'PROOF — customer'");

  // retake keeps the filing
  const r2 = ctx.updateProof(d.id, B64, B64);
  check(files[r2.proofPhotoId].folder === jf.folder && files[r2.proofPhotoId].blob.name.indexOf('PROOF') === 0,
    'retaken proof lands in the same job folder');

  // blank customer → Unassigned folder
  const u = ctx.addJob({ tab: 'delivery', category: 'pickup', note: 'no name', photos: [B64] });
  check(u.customer === 'Unassigned', 'blank customer becomes Unassigned');
  check(files[u.photoIds[0]].folder.indexOf('/Unassigned/') > 0, 'filed under the Unassigned folder');

  // postage: files named Jobsheet / Waybill by their group
  const p = ctx.addJob({ tab: 'postage', category: '', note: '', customer: 'Humaira', photos: [B64, B64, B64], thumbs: [B64, B64, B64], jsCount: 2 });
  check(files[p.photoIds[0]].blob.name.indexOf('Jobsheet 1') === 0 &&
        files[p.photoIds[1]].blob.name.indexOf('Jobsheet 2') === 0 &&
        files[p.photoIds[2]].blob.name.indexOf('Waybill 1') === 0,
    'postage files named Jobsheet 1/2 and Waybill 1');
  check(files[p.photoIds[0]].folder.indexOf('Kilang App Photos/Postage/' + ym + '/Humaira/') === 0,
    'postage filed under its own Postage subfolder');

  // background-uploaded photos (photo 2+) land in the same job folder
  const bg = ctx.addJob({ tab: 'postage', category: '', note: '', customer: 'Humaira', photos: [B64], thumbs: [B64], jsCount: 1 });
  const add = ctx.addPhotoToJob(bg.id, 1, B64, B64);
  check(files[add.photoId].folder === files[bg.photoIds[0]].folder, 'parallel-uploaded photo joins the same folder');
  check(files[add.photoId].blob.name.indexOf('Waybill 1') === 0, 'and is named by its group');

  // unsafe characters cleaned from folder/file names
  const w = ctx.addJob({ tab: 'want', category: '', note: 'x', customer: 'A/B:C*D?"E<F>G|H\nI', photos: [B64] });
  check(files[w.photoIds[0]].folder.indexOf('A/B') < 0, 'unsafe characters cleaned from the customer folder');

  // edit can change the customer; search finds by customer
  ctx.editJob(d.id, { note: '2 jersey', category: 'bus', customer: 'Nurul Syifa Binti Ali', photos: [{ id: d.photoIds[0], thumbId: d.thumbIds[0] }] }, PIN);
  check(ctx.getJobs('delivery').find(j => j.id === d.id).customer === 'Nurul Syifa Binti Ali', 'edit updates the customer');
  const s = ctx.searchHistory('binti ali', PIN);
  check(s.total === 1 && s.results[0].id === d.id, 'history finds the job by CUSTOMER name');
}

console.log('\n== searchHistory (evidence = jobs WITH a proof photo) ==');
{
  const { ctx } = makeEnv();
  const a = ctx.addJob({ tab: 'delivery', category: 'lalamove', note: 'Nurul Syifa 2 jersey', photos: [B64], thumbs: [B64] });
  const b = ctx.addJob({ tab: 'postage', category: '', note: 'Humaira SMK Bandar', photos: [B64, B64], thumbs: [B64, B64], jsCount: 1 });
  ctx.addJob({ tab: 'want', category: '', note: 'Baju batik 50pcs', photos: [B64] });
  ctx.updateStatus(a.id, 'done', B64, B64, null);

  const rs = ctx.searchHistory('nurul', '');
  check(rs.total === 1 && rs.results[0].id === a.id, 'STAFF (no PIN) can view the evidence history too');

  const r1 = ctx.searchHistory('nurul', PIN);
  check(r1.total === 1 && r1.results[0].id === a.id, 'finds the job by customer name (case-insensitive)');
  check(r1.results[0].proofPhotoId, 'result includes the proof photo');

  // EVIDENCE RULE: no proof photo = not evidence = not listed
  check(ctx.searchHistory('humaira', PIN).total === 0, 'a job WITHOUT a proof photo is NOT evidence');
  ctx.updateStatus(b.id, 'done', B64, B64, null);
  const r2 = ctx.searchHistory('POSTAGE', PIN);
  check(r2.total === 1 && r2.results[0].id === b.id, 'it becomes evidence once the proof is taken (found by tab)');

  const today = new Date();
  const dayStr = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
  const r3 = ctx.searchHistory(dayStr, PIN);
  check(r3.total === 2, "date search lists today's evidence only (the proofless want job excluded)");

  const r4 = ctx.searchHistory('', PIN);
  check(r4.total === 2 && r4.results[0].id === b.id, 'empty query lists recent evidence, newest first');

  // page + sub-type filters, and Drive folder links
  const r7 = ctx.searchHistory('', PIN, 'delivery');
  check(r7.total === 1 && r7.results[0].id === a.id, 'tab filter: Delivery only');
  check(ctx.searchHistory('', PIN, 'delivery', 'lalamove').total === 1, 'sub-type filter: Lalamove finds it');
  check(ctx.searchHistory('', PIN, 'delivery', 'bus').total === 0, 'sub-type filter: Bus excludes it');
  check(ctx.searchHistory('humaira', PIN, 'postage').total === 1, 'text search combines with the tab filter');
  check(!!r7.results[0].folderId, "each result carries its job's Drive folder id");
  check(typeof r7.driveFolderId === 'string' && r7.driveFolderId.length > 0,
    "response includes the master 'Kilang App Photos' folder id");

  // THE KEY: evidence survives a full reset
  ctx.resetAll(PIN);
  const r5 = ctx.searchHistory('nurul', PIN);
  check(r5.total === 1 && r5.results[0].status === 'archived' && r5.results[0].proofPhotoId,
    'after RESET the job is still findable WITH its proof (archived, not deleted)');
  check(ctx.searchHistory('no-such-customer', PIN).total === 0, 'no match returns empty');

  // cap at 100
  for (let i = 0; i < 105; i++) {
    const x = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'bulk' + i, photos: [B64] });
    ctx.updateStatus(x.id, 'done', B64, B64, null);
  }
  const r6 = ctx.searchHistory('bulk', PIN);
  check(r6.total === 105 && r6.results.length === 100, 'results capped at 100 (total still reported)');
}

console.log('\n== defect tab (jobsheet + defect photos + PROOF to finish) ==');
{
  const { ctx, files } = makeEnv();
  const d = ctx.addJob({ tab: 'defect', category: '', note: 'Torn sleeve', customer: 'Nurul', photos: [B64, B64, B64], thumbs: [B64, B64, B64], jsCount: 1 });
  check(d.status === 'pending', 'defect entry starts as To Do — needs a PROOF photo to finish');
  check(files[d.photoIds[0]].blob.name.indexOf('Jobsheet 1') === 0, 'first group still named Jobsheet');
  check(files[d.photoIds[1]].blob.name.indexOf('Defect 1') === 0 &&
        files[d.photoIds[2]].blob.name.indexOf('Defect 2') === 0, "second-group photos named 'Defect N' (not Waybill)");
  check(files[d.photoIds[0]].folder.indexOf('Kilang App Photos/Defect/') === 0 &&
        files[d.photoIds[0]].folder.indexOf('/Nurul/DEFECT') > 0,
    'filed under Kilang App Photos / Defect / month / customer');
  const all = ctx.getAllData();
  check(all.jobs.defect.length === 1 && all.counts.defect === 1, 'getAllData returns the defect tab (1 pending, badge counts it)');
  check(ctx.searchHistory('defect', PIN).total === 0, 'an open defect (no proof yet) is not evidence yet');
  throws(() => ctx.updateStatus(d.id, 'done', null, null, null), 'defect cannot be done WITHOUT a proof photo');
  const r = ctx.updateStatus(d.id, 'done', B64, B64, null);
  check(ctx.searchHistory('defect', PIN).total === 1, 'fixed defect (with proof) shows in evidence by tab name');
  check(files[r.proofPhotoId].folder === files[d.photoIds[0]].folder, 'PROOF lands in the same defect job folder');
  check(ctx.getJobs('defect')[0].status === 'done' && ctx.getAllData().counts.defect === 0, 'proof photo completes the defect');
  ctx.resetDone(PIN);
  check(ctx.getJobs('defect').length === 0, 'CLEAR DONE archives finished defects');
  check(ctx.searchHistory('torn', PIN).total === 1 && ctx.searchHistory('torn', PIN).results[0].proofPhotoId,
    'still findable in history after clearing, WITH its proof');
}

console.log('\n== addJob idempotency (safe retry via clientId) ==');
{
  const { ctx, files } = makeEnv();
  const a1 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'idem', clientId: 'ckey1', photos: [B64], thumbs: [B64] });
  check(a1.id === 'ckey1', 'client-supplied id becomes the job id');
  const a2 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'idem', clientId: 'ckey1', photos: [B64], thumbs: [B64] });
  check(a2.id === 'ckey1', 'retry returns the SAME job');
  check(ctx.getJobs('delivery').length === 1, 'retrying addJob does NOT create a duplicate job');
  check(JSON.stringify(a2.photoIds) === JSON.stringify(a1.photoIds), 'retry returns the original photos');
  const dupTrashed = Object.keys(files).filter(k => files[k].trashed).length;
  check(dupTrashed >= 2, "the retry's duplicate photo files are trashed (" + dupTrashed + ")");
  const b = ctx.addJob({ tab: 'want', category: '', note: 'no key', photos: [B64] });
  check(b.id !== 'ckey1' && ctx.getJobs('want').length === 1, 'jobs without clientId still work');
}

console.log('\n== undoSwipe (staff fix a wrong swipe, no PIN) ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'want', category: '', note: 'Oops', photos: [B64], thumbs: [B64] });
  throws(() => ctx.undoSwipe(j.id), 'cannot undo a jobsheet that was never swiped');
  ctx.updateStatus(j.id, 'got', null, null, null);
  const r = ctx.undoSwipe(j.id); // NO pin — staff allowed
  check(r.status === 'pending' && typeof r.pinnedAt === 'number', 'undo returns pending + pinned');
  const back = ctx.getJobs('want')[0];
  check(back.status === 'pending' && back.doneAt === '', 'jobsheet back in the deck, answer time cleared');
  check(back.pinnedAt === r.pinnedAt, 'pinned to the FRONT of the deck');
  check(ctx.getCounts().want === 1, 'badge counts it as pending again');
  ctx.updateStatus(j.id, 'notseen', null, null, null);
  check(ctx.undoSwipe(j.id).status === 'pending', 'undo works from notseen too');
  throws(() => ctx.undoSwipe(j.id), 'second undo throws (already pending)');
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: '', photos: [B64] });
  ctx.updateStatus(d.id, 'done', B64, B64, null);
  throws(() => ctx.undoSwipe(d.id), 'cannot undo a DONE delivery job (use Remove Proof)');
  throws(() => ctx.undoSwipe('ghost'), 'unknown id throws');
}

console.log('\n== check-first pipeline (prepare → ❤️ → auto-push) ==');
{
  const { ctx, files } = makeEnv();
  const c = ctx.addJob({ tab: 'want', category: '', note: 'SN 30 jersey', customer: 'SN',
    photos: [B64, B64], thumbs: [B64, B64], nextTab: 'delivery', nextCategory: 'bus', nextDueAt: 123456789 });
  check(c.nextTab === 'delivery' && c.nextCategory === 'bus', 'prepared check stores the next step');
  check(ctx.getAllData().counts.delivery === 0, 'prepared job does NOT count in Delivery before the check');

  ctx.updateStatus(c.id, 'notseen', null, null, null);
  check(ctx.getJobs('delivery').length === 0, '❌ Not Seen pushes nothing');

  const r = ctx.updateStatus(c.id, 'got', null, null, null);
  check(!!(r.pushed && r.pushed.tab === 'delivery' && r.pushed.category === 'bus'), '❤️ auto-creates the Delivery job');
  const d = ctx.getJobs('delivery')[0];
  check(!!d && d.id === r.pushed.id && d.status === 'pending', 'pushed job is on the Delivery board as To Do');
  check(d.note === 'SN 30 jersey' && d.customer === 'SN' && Number(d.dueAt) === 123456789, 'prepared details carried over');
  check(JSON.stringify(d.photoIds) === JSON.stringify(c.photoIds), 'photos are SHARED with the check (no re-upload)');
  check(d.fromCheck === true, "pushed job marked 'passed check'");
  check(ctx.getJobs('want')[0].nextJobId === d.id, 'check remembers its pushed job');
  check(ctx.getAllData().counts.delivery === 1, 'now it counts in the Delivery balance');

  ctx.updateStatus(c.id, 'got', null, null, null);
  check(ctx.getJobs('delivery').length === 1, 'second ❤️ does NOT duplicate the push');

  const u = ctx.undoSwipe(c.id);
  check(u.pulledBack === d.id, 'UNDO reports the pulled-back job');
  check(ctx.getJobs('delivery').length === 0, 'pushed job removed from Delivery on undo');
  check(!files[c.photoIds[0]].trashed, 'shared photos untouched by the pull-back');

  const r2 = ctx.updateStatus(c.id, 'got', null, null, null);
  check(!!r2.pushed && r2.pushed.id !== d.id && ctx.getJobs('delivery').length === 1, 're-❤️ pushes a fresh job');

  const done = ctx.updateStatus(r2.pushed.id, 'done', B64, B64, null);
  check(files[done.proofPhotoId].folder === files[c.photoIds[0]].folder,
    'PROOF lands in the same shared pipeline folder');

  ctx.undoSwipe(c.id);
  check(ctx.getJobs('delivery').length === 1, 'undo does NOT remove a pushed job that is already done');

  ctx.deleteJob(ctx.getJobs('delivery')[0].id, PIN);
  check(!files[c.photoIds[0]].trashed, 'deleting the pushed job never trashes the shared photos');
  check(files[done.proofPhotoId].trashed, 'but its own proof is trashed');

  const p = ctx.addJob({ tab: 'want', category: '', note: 'to post', photos: [B64], nextTab: 'postage' });
  check(ctx.updateStatus(p.id, 'got', null, null, null).pushed.tab === 'postage', 'pipeline to Postage works too');
  const plain = ctx.addJob({ tab: 'want', category: '', note: 'plain', photos: [B64] });
  check(ctx.updateStatus(plain.id, 'got', null, null, null).pushed === null, 'a plain check pushes nothing');
  const dj = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'x', photos: [B64], nextTab: 'postage' });
  check(dj.nextTab === '', 'nextTab is Checking-only (ignored on other tabs)');
}

console.log('\n== 🚌 Sent bus (postage → delivery/bus, proof still required) ==');
{
  const { ctx, files, folders } = makeEnv();
  const j = ctx.addJob({ tab: 'postage', category: '', note: 'parcel for CG', customer: 'CG',
    photos: [B64, B64], thumbs: [B64, B64], jsCount: 1 });
  throws(() => ctx.sentBus(j.id, null, null), 'no proof photo → refused');
  check(ctx.getJobs('postage')[0].status === 'pending', 'job untouched after the refusal');

  const r = ctx.sentBus(j.id, B64, B64);
  check(r.tab === 'delivery' && r.category === 'bus' && r.status === 'done', 'becomes a done Delivery → Bus job');
  check(ctx.getJobs('postage').length === 0, 'gone from the Postage board');
  const d = ctx.getJobs('delivery')[0];
  check(!!d && d.id === j.id && d.status === 'done' && d.category === 'bus', 'same job, now on the Delivery board');
  check(d.note === 'parcel for CG' && d.customer === 'CG' && d.jsCount === 1, 'note, customer and photo split kept');
  check(JSON.stringify(d.photoIds) === JSON.stringify(j.photoIds), 'photos kept — no re-upload');
  check(!!files[r.proofPhotoId] && !files[r.proofPhotoId].trashed, 'proof photo saved');
  check(files[r.proofPhotoId].folder === files[j.photoIds[0]].folder, "proof lands in the job's own folder");
  const jf = folders[d.folderId];
  check(!!jf.movedTo && jf.movedTo.indexOf('/Delivery/') > 0 && /\/CG$/.test(jf.movedTo),
    'Drive folder re-filed under Delivery/<month>/CG');
  const ev = ctx.searchHistory('', PIN, 'delivery', 'bus');
  check(ev.results.some(x => x.id === j.id), 'listed in Evidence under Delivery → Bus');
  check(ctx.searchHistory('', PIN, 'postage', '').results.length === 0, 'no longer listed under Postage');
  check(ctx.getAllData().counts.postage === 0, 'postage balance drops');

  const dj = ctx.addJob({ tab: 'delivery', category: 'lalamove', note: 'x', photos: [B64] });
  throws(() => ctx.sentBus(dj.id, B64, B64), 'only a postage job can be marked Sent bus');

  // a pipeline-pushed postage job shares its folder with the check — folder stays put
  const c = ctx.addJob({ tab: 'want', category: '', note: 'pp', customer: 'SN', photos: [B64], nextTab: 'postage' });
  const pushed = ctx.updateStatus(c.id, 'got', null, null, null).pushed;
  const r2 = ctx.sentBus(pushed.id, B64, B64);
  check(r2.status === 'done' && r2.category === 'bus', 'a pipeline postage job can be Sent bus too');
  check(!folders[pushed.folderId].movedTo, 'shared pipeline folder is NOT moved (check evidence stays together)');
  check(!files[c.photoIds[0]].trashed, 'shared photos untouched');
}

console.log("\n== 🚨 problem flow (haven't received → office prints) ==");
{
  const { ctx, files } = makeEnv();
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'no stock', customer: 'SN', photos: [B64], thumbs: [B64] });
  const r = ctx.reportProblem(d.id);
  check(r.problem === 'reported' && r.problemAt > 0, "report flags the job as haven't-received");
  check(ctx.getJobs('delivery')[0].problem === 'reported', 'flag persisted in the sheet');
  const r2 = ctx.reportProblem(d.id);
  check(r2.problemAt === r.problemAt, 'double report is idempotent (same timestamp)');
  throws(() => ctx.solveProblem(d.id, null, null), 'solve WITHOUT the printing photo → refused');
  const s = ctx.solveProblem(d.id, B64, B64);
  check(s.problem === 'printed' && s.printedAt > 0 && !!s.printPhotoId, 'solved: printed stamp + photo stored');
  const dj = ctx.getJobs('delivery')[0];
  check(dj.problem === 'printed' && !!dj.printedAt && dj.printPhotoId === s.printPhotoId, "job now shows 'printed at'");
  check(files[s.printPhotoId].folder === files[dj.photoIds[0]].folder, "printing photo files into the job's own Drive folder");

  const w = ctx.addJob({ tab: 'want', category: '', note: 'ns', photos: [B64] });
  throws(() => ctx.solveProblem(w.id, B64, B64), 'a normal checking job is NOT on the problem page');
  throws(() => ctx.reportProblem(w.id), 'checking jobs cannot use the report button (❌ swipe IS the report)');
  ctx.updateStatus(w.id, 'notseen', null, null, null);
  check(ctx.solveProblem(w.id, B64, B64).problem === 'printed', '❌ Not Seen checking job can be solved too');

  const p = ctx.addJob({ tab: 'postage', category: '', note: 'pp', photos: [B64] });
  ctx.reportProblem(p.id);
  ctx.solveProblem(p.id, B64, B64);
  ctx.reportProblem(p.id);
  check(ctx.getJobs('postage')[0].problem === 'reported' && ctx.getJobs('postage')[0].printedAt === '',
    're-report clears the old printed stamp');

  ctx.deleteJob(d.id, PIN);
  check(files[s.printPhotoId].trashed, 'deleting the job trashes its printing photo too');

  // 📝 shared problem info — staff write, both sides read
  const ni = ctx.addJob({ tab: 'postage', category: '', note: 'note test', customer: 'SN', photos: [B64] });
  throws(() => ctx.setProblemNote(ni.id, 'hello'), 'cannot write info on a job that has no problem');
  ctx.reportProblem(ni.id);
  const nr2 = ctx.setProblemNote(ni.id, 'Jobsheet is with Kak Ros, please reprint page 2');
  check(nr2.problemNote.indexOf('Kak Ros') >= 0, 'staff write info without a PIN');
  check(ctx.getJobs('postage').filter(j => j.id === ni.id)[0].problemNote === nr2.problemNote,
    'info persisted — both sides see it on the job');
  ctx.setProblemNote(ni.id, '');
  check(ctx.getJobs('postage').filter(j => j.id === ni.id)[0].problemNote === '', 'info can be cleared');
  const nw = ctx.addJob({ tab: 'want', category: '', note: 'ns note', photos: [B64] });
  ctx.updateStatus(nw.id, 'notseen', null, null, null);
  check(ctx.setProblemNote(nw.id, 'reprint A4').problemNote === 'reprint A4',
    '❌ Not Seen checking jobs accept info too');
  check(ctx.setProblemNote(ni.id, 'x'.repeat(500)).problemNote.length === 300, 'info capped at 300 chars');

  // "🏷️ No sticker" — the second postage problem type
  const ns = ctx.addJob({ tab: 'postage', category: '', note: 'sticker missing', photos: [B64] });
  const nr = ctx.reportProblem(ns.id, 'sticker');
  check(nr.problem === 'nosticker' && nr.problemAt > 0, 'no-sticker report flags the job');
  check(ctx.getJobs('postage')[0].problem === 'nosticker', 'flag persisted');
  const dd = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'x', photos: [B64] });
  throws(() => ctx.reportProblem(dd.id, 'sticker'), 'no-sticker is Postage-only');
  check(ctx.solveProblem(ns.id, B64, B64).problem === 'printed', 'office solves a no-sticker report the same way');

  // DEFECT jobs can be reported as haven't-received too
  const df = ctx.addJob({ tab: 'defect', category: '', note: 'torn collar', customer: 'CG', photos: [B64], jsCount: 1 });
  const dr = ctx.reportProblem(df.id);
  check(dr.problem === 'reported' && dr.problemAt > 0, "defect job can be reported as haven't-received");
  throws(() => ctx.reportProblem(df.id, 'sticker'), 'but no-sticker stays Postage-only for defects too');
  check(ctx.solveProblem(df.id, B64, B64).problem === 'printed', 'office solves a defect report the same way');

  // "📄 Got sticker, No Job" — the third postage problem type
  const nj = ctx.addJob({ tab: 'postage', category: '', note: 'sticker only', photos: [B64] });
  const njr = ctx.reportProblem(nj.id, 'nojob');
  check(njr.problem === 'nojob' && njr.problemAt > 0, 'got-sticker-no-job report flags the job');
  check(ctx.getJobs('postage').filter(j => j.id === nj.id)[0].problem === 'nojob', 'flag persisted');
  const njr2 = ctx.reportProblem(nj.id, 'nojob');
  check(njr2.problemAt === njr.problemAt, 'reporting twice is idempotent');
  throws(() => ctx.reportProblem(dd.id, 'nojob'), 'got-sticker-no-job is Postage-only');
  check(ctx.setProblemNote(nj.id, 'jobsheet hilang').problemNote === 'jobsheet hilang',
    'a no-job report accepts info too');
  check(ctx.solveProblem(nj.id, B64, B64).problem === 'printed',
    'office solves it the same way — print the jobsheet, snap the photo');

  // the TOP button: sticker arrives with NO job on the board at all
  throws(() => ctx.reportStickerNoJob({}), 'sticker photo required');
  const before = ctx.getJobs('postage').length;
  const sj = ctx.reportStickerNoJob({ photo: B64, thumb: B64, clientId: 'stick1' });
  check(sj.tab === 'postage' && sj.problem === 'nojob' && sj.problemAt > 0,
    'one tap creates a postage job ALREADY flagged no-job');
  check(ctx.getJobs('postage').length === before + 1 &&
        ctx.getJobs('postage').filter(x => x.id === sj.id)[0].problem === 'nojob',
    'the sticker job lands on the Postage board, flagged');
  check(sj.photoIds.length === 1 && !!sj.photoIds[0], 'the sticker photo is saved');
  const sj2 = ctx.reportStickerNoJob({ photo: B64, thumb: B64, clientId: 'stick1' });
  check(sj2.id === sj.id && ctx.getJobs('postage').length === before + 1,
    'retrying with the same clientId does not double-post');
  check(ctx.solveProblem(sj.id, B64, B64).problem === 'printed',
    'office prints the jobsheet and solves the sticker job');
}

console.log('\n== 🚨 typed problems (raise / edit / delete by staff) ==');
{
  const { ctx } = makeEnv();
  const w = ctx.addJob({ tab: 'want', category: '', note: 'check js', photos: [B64] });
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'jersey', photos: [B64] });
  throws(() => ctx.reportProblem(d.id, 'custom', '   '), 'typed problem requires text');
  const r = ctx.reportProblem(d.id, 'custom', 'Wrong size printed');
  check(r.problem === 'custom' && r.probLog[0].text === 'Wrong size printed', 'staff can raise a typed problem');
  const rw = ctx.reportProblem(w.id, 'custom', 'Jobsheet blur, cannot read');
  check(rw.problem === 'custom', 'CHECKING jobsheets can be reported too');
  const e1 = ctx.editProblemReport(d.id, 'Wrong size — need XL');
  check(e1.probLog[0].text === 'Wrong size — need XL', 'staff can edit the typed text');
  throws(() => ctx.editProblemReport(w.id, ''), 'edit requires text');
  const s = ctx.solveProblem(d.id, B64, B64);
  check(s.problem === 'printed' && s.probLog.length === 2, 'office solves a typed problem the same way');
  throws(() => ctx.editProblemReport(d.id, 'x'), 'solved problems can no longer be edited');
  ctx.reportProblem(d.id, 'custom', 'second issue');
  const del = ctx.deleteProblemReport(d.id);
  check(del.problem === 'printed' && del.probLog.length === 2,
    'deleting the raise removes it — the earlier solved cycle stays');
  const delw = ctx.deleteProblemReport(w.id);
  check(delw.problem === '' && delw.probLog.length === 0, 'deleting the only raise leaves no problem at all');
  throws(() => ctx.deleteProblemReport(d.id), 'nothing raised left to delete');

  // the ONE-TAP reports are deletable by staff too — wrong taps happen
  const p3 = ctx.addJob({ tab: 'postage', category: '', note: 'ns del', photos: [B64, B64] });
  ctx.reportProblem(p3.id, 'sticker');
  const dl3 = ctx.deleteProblemReport(p3.id);
  check(dl3.problem === '' && dl3.probLog.length === 0, "a 'No sticker' report can be deleted");
  ctx.reportProblem(p3.id);
  check(ctx.deleteProblemReport(p3.id).problem === '', "a 'Haven't received' report can be deleted");
  ctx.reportProblem(p3.id, 'nojob');
  check(ctx.deleteProblemReport(p3.id).problem === '', "a 'Got sticker, no job' report can be deleted");
  throws(() => ctx.editProblemReport(p3.id, 'x'), 'but one-tap reports are never text-editable');
}

console.log('\n== 🚨 problem HISTORY — report → solve → report → solve (A A B B) ==');
{
  const { ctx } = makeEnv();
  const p = ctx.addJob({ tab: 'postage', category: '', note: 'cycle test', photos: [B64, B64], jsCount: 1 });
  ctx.reportProblem(p.id);
  ctx.setProblemNote(p.id, 'first info');
  const s1 = ctx.solveProblem(p.id, B64, B64);
  check(s1.probLog.length === 2 && s1.probLog[0].k === 'report' && s1.probLog[1].k === 'solve',
    'log holds report A then solve A');
  check(s1.probLog[1].note === 'first info', 'solve A archives the info note (shown ABOVE its photo)');
  check(ctx.getJobs('postage')[0].problemNote === '', 'live note cleared after solve — archived in the log');
  const r2 = ctx.reportProblem(p.id);
  check(r2.probLog.length === 3, 'reporting AGAIN after printed appends — cycles can repeat');
  ctx.setProblemNote(p.id, 'second info');
  const s2 = ctx.solveProblem(p.id, B64, B64);
  check(s2.probLog.map(e => e.k).join(',') === 'report,solve,report,solve',
    'A A B B — full history until both sides are satisfied');
  check(s2.probLog[1].photoId !== s2.probLog[3].photoId, 'each solve keeps its OWN photo');
  check(ctx.getJobs('postage')[0].probLog.length === 4, 'the whole history rides along with the job');
}

console.log('\n== 📄 solving a no-job report ATTACHES the printed jobsheet ==');
{
  const { ctx } = makeEnv();
  const j = ctx.reportStickerNoJob({ photos: [B64], thumbs: [B64], note: 'orphan sticker', clientId: 'orp1' });
  check(j.jsCount === 0 && j.probLog.length === 1 && j.probLog[0].kind === 'nojob',
    'sticker job starts with NO jobsheet and a no-job report in its log');
  const s = ctx.solveProblem(j.id, B64, B64);
  check(s.attachedJobsheet === true, 'solving reports back: jobsheet attached');
  const jj = ctx.getJobs('postage')[0];
  check(jj.jsCount === 1 && jj.photoIds.length === 2 && jj.photoIds[0] === s.printPhotoId,
    'printed photo becomes photo #1 (the Jobsheet side); the sticker stays as Waybill');
  // an ordinary reported job does NOT get a jobsheet attached
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'ordinary', photos: [B64] });
  ctx.reportProblem(d.id);
  const sd = ctx.solveProblem(d.id, B64, B64);
  check(!sd.attachedJobsheet && ctx.getJobs('delivery')[0].photoIds.length === 1,
    'normal reports keep their photos untouched');
}

console.log('\n== 📦 Delivered? (how + by whom, no photo) ==');
{
  const { ctx } = makeEnv();
  const d = ctx.addJob({ tab: 'delivery', category: 'lalamove', note: 'jersey 20pcs', customer: 'SN', photos: [B64], thumbs: [B64] });
  throws(() => ctx.markDelivered(d.id, 'lalamove', 'ZH'), 'cannot confirm delivered BEFORE the job is done');
  ctx.updateStatus(d.id, 'done', B64, B64, null);
  throws(() => ctx.markDelivered(d.id, '', 'ZH'), 'must choose HOW it was delivered');
  throws(() => ctx.markDelivered(d.id, 'teleport', 'ZH'), 'only the four real methods are accepted');
  throws(() => ctx.markDelivered(d.id, 'lalamove', ''), 'must choose WHO delivered');
  throws(() => ctx.markDelivered(d.id, 'lalamove', 'Ali'), 'only Bos (ZH) or Bob');

  const r = ctx.markDelivered(d.id, 'lalamove', 'ZH');
  check(r.deliveredAt > 0 && r.deliveredVia === 'lalamove' && r.deliveredBy === 'ZH',
    'confirmed: how + who + timestamp, NO photo needed');
  const dj = ctx.getJobs('delivery')[0];
  check(dj.deliveredAt === r.deliveredAt && dj.deliveredVia === 'lalamove' && dj.deliveredBy === 'ZH',
    'job carries the full delivered record');

  const r2 = ctx.markDelivered(d.id, 'personal', 'Bob');
  check(r2.deliveredVia === 'personal' && ctx.getJobs('delivery')[0].deliveredBy === 'Bob',
    're-confirming corrects the record');

  ctx.removeDelivered(d.id);
  const back = ctx.getJobs('delivery')[0];
  check(back.deliveredAt === '' && back.deliveredVia === '' && back.deliveredBy === '',
    'Undo Delivered clears everything');

  const p = ctx.addJob({ tab: 'postage', category: '', note: 'p', photos: [B64] });
  ctx.updateStatus(p.id, 'done', B64, B64, null);
  throws(() => ctx.markDelivered(p.id, 'bus', 'Bob'), 'postage jobs cannot use Delivered');

  // sent-bus jobs become Delivery done → they CAN be confirmed delivered
  const sb = ctx.addJob({ tab: 'postage', category: '', note: 'bus one', photos: [B64] });
  ctx.sentBus(sb.id, B64, B64);
  check(ctx.markDelivered(sb.id, 'bus', 'ZH').deliveredAt > 0, 'a Sent-bus job can be confirmed delivered too');

  // ...and evidence/history carries the record
  const ev = ctx.searchHistory('', PIN, 'delivery', '');
  const evJob = ev.results.filter(j => j.id === sb.id)[0];
  check(!!evJob && evJob.deliveredVia === 'bus' && evJob.deliveredBy === 'ZH', 'Evidence keeps how + who');

  // un-doing the job's Done clears the delivered confirmation with it
  const d2 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'x', photos: [B64] });
  ctx.updateStatus(d2.id, 'done', B64, B64, null);
  ctx.markDelivered(d2.id, 'pickup', 'Bob');
  ctx.deleteProof(d2.id);
  const b2 = ctx.getJobs('delivery').filter(j => j.id === d2.id)[0];
  check(b2.status === 'pending' && b2.deliveredAt === '' && b2.deliveredBy === '',
    'removing the Done proof also clears the delivered confirmation');
}

console.log('\n== 📮 Sent to J&T (ready count → sent → big ✔) ==');
{
  const { ctx } = makeEnv();
  const a = ctx.addJob({ tab: 'postage', category: '', note: 'parcel A', photos: [B64, B64], jsCount: 1 });
  const b = ctx.addJob({ tab: 'postage', category: '', note: 'parcel B', photos: [B64, B64], jsCount: 1 });
  throws(() => ctx.markSentJnt(a.id), 'cannot mark Sent before the parcel is Done');
  ctx.updateStatus(a.id, 'done', B64, B64, null);
  ctx.updateStatus(b.id, 'done', B64, B64, null);
  const ready0 = ctx.getJobs('postage').filter(j => j.status === 'done' && !j.sentAt).length;
  check(ready0 === 2, 'two parcels ready for the 11am truck');
  const r = ctx.markSentJnt(a.id);
  check(r.sentAt > 0 && ctx.getJobs('postage').filter(j => j.id === a.id)[0].sentAt === r.sentAt,
    'Sent stamps the timestamp on the parcel');
  check(ctx.getJobs('postage').filter(j => j.status === 'done' && !j.sentAt).length === 1,
    'the ready count drops — next count is a fresh batch');
  const d = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'x', photos: [B64] });
  ctx.updateStatus(d.id, 'done', B64, B64, null);
  throws(() => ctx.markSentJnt(d.id), 'delivery jobs cannot use Sent-to-J&T');
  ctx.undoSentJnt(a.id);
  check(ctx.getJobs('postage').filter(j => j.status === 'done' && !j.sentAt).length === 2,
    'Undo Sent puts the parcel back in the ready count');
  ctx.markSentJnt(a.id);
  ctx.deleteProof(a.id);
  check(ctx.getJobs('postage').filter(j => j.id === a.id)[0].sentAt === '',
    'removing the Done proof clears Sent too');
}

console.log('\n== 📦 stock count (staff key in, admin views) ==');
{
  const { ctx } = makeEnv();
  const cat = ctx.getStockTake();
  check(cat.sections.length === 3 &&
    cat.sections[0].name === 'Fabric' && cat.sections[1].name === 'Ink' && cat.sections[2].name === 'Paper',
    'catalog has Fabric + Ink + Paper sections');
  check(cat.sections[0].items.length === 9 && cat.sections[0].items[0].target === 10,
    'fabric items carry their targets (Eyelet = 10)');
  check(cat.sections[1].items.every(i => i.orderIf === 2), 'ink orders when below 2');
  check(cat.sections[0].items.every(i => i.qty === ''), 'no counts yet — empty values');

  throws(() => ctx.submitStockTake([], 'staff'), 'empty submission refused');
  throws(() => ctx.submitStockTake([{ item: 'Eyelet', qty: 'abc' }], 'staff'), 'garbage-only submission refused');
  const r = ctx.submitStockTake([
    { item: 'Eyelet', qty: 4 }, { item: 'Ink - Red', qty: 0 }, { item: 'Paper - Sublimation', qty: 7 }
  ], 'staff');
  check(r.ok === true && r.saved === 3, 'staff submits a count — 3 items saved, no PIN needed');

  const t1 = ctx.getStockTake();
  check(t1.sections[0].items[0].qty === 4, 'Eyelet latest count = 4');
  check(t1.sections[1].items[0].qty === 0, 'ZERO is a valid count (Ink - Red = 0)');
  check(t1.sections[2].items[0].qty === 7 && t1.lastAt === r.at, 'paper counted + lastAt stamped');

  const r2 = ctx.submitStockTake([{ item: 'Eyelet', qty: 12 }], 'admin');
  check(ctx.getStockTake().sections[0].items[0].qty === 12, 'a NEW count replaces the old value');
  check(ctx.getStockTake().sections[0].items[0].by === 'admin', 'and remembers who counted');
  check(r2.at >= r.at, 'counting history stays in the sheet (auditable)');

  // stock lives in its OWN sheet — the job boards are untouched
  check(ctx.getAllData().counts.want === 0 && ctx.getJobs('postage').length === 0,
    'stock counts never leak into the job boards');
}

console.log('\n== lost photo slot: Save heals the job ==');
{
  const { ctx } = makeEnv();
  const j = ctx.addJob({ tab: 'postage', category: '', note: 'lost slot', customer: 'DO',
    photos: [B64, B64, B64], thumbs: [B64, B64, B64], jsCount: 2 });
  // an edit whose list still contains a ghost entry (empty id — the photo's
  // background upload never finished) simply drops it
  const e = ctx.editJob(j.id, { note: 'lost slot', category: '', jsCount: 1, photos: [
    { id: j.photoIds[0], thumbId: j.thumbIds[0] },
    { id: '' },
    { id: j.photoIds[2], thumbId: j.thumbIds[2] }
  ] }, PIN);
  check(e.photoIds.length === 2 && e.photoIds.every(Boolean), 'ghost photo entries dropped on save');
  check(e.photoIds[0] === j.photoIds[0] && e.photoIds[1] === j.photoIds[2], 'real photos kept in order');
  throws(() => ctx.editJob(j.id, { note: '', category: '', photos: [{ id: '' }] }, PIN),
    'an edit with ONLY ghost entries is refused (photo required)');
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
  const many = ctx.getImagesData(['a','b','c','d','e','f','g','h','i','j']);
  check(Object.keys(many).length === 8, 'caps at 8 images per call');
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

console.log('\n== history sorting: ✔ out-the-door jobs first, cap 100 ==');
{
  const { ctx } = makeEnv();
  const a = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'plain done', photos: [B64] });
  ctx.updateStatus(a.id, 'done', B64, B64, null);
  const b = ctx.addJob({ tab: 'postage', category: '', note: 'sent one', photos: [B64, B64] });
  ctx.updateStatus(b.id, 'done', B64, B64, null);
  ctx.markSentJnt(b.id);
  const c = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'delivered one', photos: [B64] });
  ctx.updateStatus(c.id, 'done', B64, B64, null);
  ctx.markDelivered(c.id, 'pickup', 'Bob');
  const res = ctx.searchHistory('', PIN);
  const notes = res.results.map(j => j.note);
  check(notes.length === 3, 'all three finished jobs listed');
  check(notes.indexOf('plain done') === 2, '✔ delivered / sent jobs rank ABOVE a plain done job');
  check(notes[0] === 'delivered one' || notes[0] === 'sent one', 'newest ✔ job first within the top group');
}

console.log('\n== getPerformance (daily production KPI, 14 days) ==');
{
  const { ctx, sheetData } = makeEnv();
  throws(() => ctx.getPerformance(''), 'staff cannot open performance');
  throws(() => ctx.getPerformance('9999'), 'wrong PIN rejected');
  const d1 = ctx.addJob({ tab: 'delivery', category: 'bus', note: 'perf done', photos: [B64] });
  ctx.updateStatus(d1.id, 'done', B64, B64, null);
  ctx.markDelivered(d1.id, 'bus', 'ZH');
  const p1 = ctx.addJob({ tab: 'postage', category: '', note: 'perf open', photos: [B64, B64] });
  const w1 = ctx.addJob({ tab: 'want', category: '', note: 'perf check', photos: [B64] });
  ctx.updateStatus(w1.id, 'got', null, null, null);

  const perf = ctx.getPerformance(PIN);
  check(perf.days.length === 14, 'always exactly 14 days');
  check(perf.days[0].at > perf.days[13].at, 'newest day (today) first');
  const t = perf.days[0];
  check(t.posted === 2 && t.load === 2 && t.done === 1 && t.left === 1 && t.out === 1,
    'today: 2 posted · load 2 · 1 done · 1 left · 1 out ✔ (want swipes excluded)');

  // move the finished job's dates back one day, straight in the sheet
  const DAY = 86400000;
  const row = sheetData.find(r => r[0] === d1.id);
  row[7] -= DAY; row[9] -= DAY; row[27] -= DAY;
  const perf2 = ctx.getPerformance(PIN);
  check(perf2.days[1].posted === 1 && perf2.days[1].done === 1 && perf2.days[1].out === 1 &&
        perf2.days[1].load === 1 && perf2.days[1].left === 0,
    'yesterday: counts follow the dates (true day-by-day split)');
  check(perf2.days[0].posted === 1 && perf2.days[0].done === 0 && perf2.days[0].load === 1,
    'today keeps only its own jobs');

  // THE FIX: a leftover job finished today counts against today's LOAD,
  // so the KPI stays honest (≤ 100%) even when done > posted that day
  const p2 = ctx.addJob({ tab: 'postage', category: '', note: 'leftover', photos: [B64, B64] });
  const row2 = sheetData.find(r => r[0] === p2.id);
  row2[7] -= 3 * DAY; // posted 3 days ago…
  ctx.updateStatus(p2.id, 'done', B64, B64, null); // …finished today
  const perf4 = ctx.getPerformance(PIN);
  check(perf4.days[0].posted === 1 && perf4.days[0].done === 1 && perf4.days[0].load === 2,
    'leftover finished today: done 1 vs load 2 — KPI 50%, never 350%');
  check(perf4.days[3].posted === 1 && perf4.days[3].load === 1 && perf4.days[3].left === 1,
    'the 3 days it sat waiting show it in Load and Left');

  // CLEAR DONE / RESET must never erase performance history
  ctx.resetAll(PIN);
  const perf3 = ctx.getPerformance(PIN);
  check(perf3.days[1].done === 1 && perf3.days[0].posted === 1, 'RESET does not erase performance history');
  check(perf3.days[0].left === 0 && perf3.days[0].load === 1,
    'a job archived without finishing stops counting as workload (no eternal backlog)');
}

console.log('\n================================');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

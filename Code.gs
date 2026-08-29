/**
 * KILANG APP — replaces 3 WhatsApp groups (Kilang Want / Kilang Packing / Kilang Postage)
 *
 * Data  : Google Sheet  "Kilang App Data"   (created automatically on first run)
 * Photos: Drive folder  "Kilang App Photos" (created automatically on first run)
 *
 * Deploy: Deploy > New deployment > Web app
 *         Execute as: Me    |    Who has access: Anyone with the link
 *
 * Performance notes:
 *  - Every photo is stored twice: full size (for zoom) and a small thumbnail
 *    (for cards) — cards load ~10x faster.
 *  - Mutations return small objects; slow Drive work happens outside the lock.
 *  - getInitData() returns jobs + badge counts in ONE round trip.
 */

var APP_TITLE = 'ARAMEGA — Kilang App';

/**
 * ADMIN PIN — CHANGE THIS before you deploy!
 * Admins (with the PIN) can edit, delete, hide and reset jobs. Staff cannot.
 */
var ADMIN_PIN = '1234';

function checkPin(pin) {
  return String(pin) === ADMIN_PIN;
}

function requireAdmin_(pin) {
  if (String(pin) !== ADMIN_PIN) throw new Error('Admin only — wrong PIN');
}

// ---------------------------------------------------------------- web entry

function doGet() {
  ensureSetup_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------- setup

function ensureSetup_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_ID') && props.getProperty('FOLDER_ID')) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!props.getProperty('SHEET_ID')) {
      var ss = SpreadsheetApp.create('Kilang App Data');
      var sh = ss.getSheets()[0];
      sh.setName('Jobs');
      sh.appendRow(['id', 'tab', 'category', 'note', 'photoIds', 'status',
                    'createdBy', 'createdAt', 'doneBy', 'doneAt', 'proofPhotoId',
                    'thumbIds', 'proofThumbId', 'dueAt', 'pinnedAt', 'jsCount',
                    'customer', 'folderId',
                    'nextTab', 'nextCategory', 'nextDueAt', 'nextJobId',
                    'problem', 'problemAt', 'printedAt', 'printPhotoId', 'printThumbId',
                    'deliveredAt', 'deliveredPhotoId', 'deliveredThumbId', 'problemNote', 'deliveredVia', 'deliveredBy', 'sentAt',
                    'probLog']);
      sh.setFrozenRows(1);
      props.setProperty('SHEET_ID', ss.getId());
    }
    if (!props.getProperty('FOLDER_ID')) {
      var folder = DriveApp.createFolder('Kilang App Photos');
      props.setProperty('FOLDER_ID', folder.getId());
    }
  } finally {
    lock.releaseLock();
  }
}

function getSheet_() {
  ensureSetup_();
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return SpreadsheetApp.openById(id).getSheetByName('Jobs');
}

function getFolder_() {
  ensureSetup_();
  var id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  return DriveApp.getFolderById(id);
}

// ---------------------------------------------------------------- photos

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** "2026-08-05 14.32" — date+time stamp used in photo file names. */
function stamp_() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()) +
    ' ' + pad2_(d.getHours()) + '.' + pad2_(d.getMinutes());
}

/** "2026-08-05" for a ms timestamp (used by the history search). */
function dayStr_(ts) {
  if (!ts) return '';
  var d = new Date(Number(ts));
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** Make a note safe + short for a Drive file name. */
function cleanName_(s) {
  return String(s || '').replace(/[\r\n\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

var TAB_TAG = { want: 'CHECKING', delivery: 'DELIVERY', postage: 'POSTAGE', defect: 'DEFECT' };

/**
 * Human-readable Drive file name, so evidence is findable in Drive alone:
 * "PROOF · DELIVERY bus · 2026-08-05 14.32 — Nurul Syifa jersey"
 * (fallback naming for old jobs that have no folder of their own)
 */
function photoName_(tab, category, note, kind) {
  var s = (kind ? kind + ' · ' : '') +
    (TAB_TAG[tab] || 'JOB') + (category ? ' ' + category : '') +
    ' · ' + stamp_();
  var n = cleanName_(note);
  if (n) s += ' — ' + n;
  return s;
}

/** Quick unlocked read of the job fields needed for filing photos. */
function jobLabel_(id) {
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row > 0) {
      var v = sh.getRange(row, 1, 1, 18).getValues()[0];
      return { tab: v[1], category: v[2], note: v[3], jsCount: Number(v[15]) || 0,
               customer: v[16] || '', folderId: v[17] || '' };
    }
  } catch (e) {}
  return { tab: '', category: '', note: '', jsCount: 0, customer: '', folderId: '' };
}

/** Get-or-create a child folder by name. */
function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Master evidence folder — the app's own "Kilang App Photos" folder. */
function masterFolder_() { return getFolder_(); }

var TAB_FOLDER = { want: 'Checking', delivery: 'Delivery', postage: 'Postage', defect: 'Defect' };

/**
 * Evidence filing:
 *   Kilang App Photos / Delivery (or Postage, Checking, Defect) /
 *   2026-08 / <Customer> / <one folder per job>
 * Everything belonging to a job — jobsheet, waybill/defect photos and
 * the proof — lives together in that job's folder.
 */
function makeJobFolder_(customer, tab, category, note, createdAt) {
  var d = new Date(Number(createdAt));
  var month = d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
  var tf = childFolder_(masterFolder_(), TAB_FOLDER[tab] || 'Other');
  var mf = childFolder_(tf, month);
  var cf = childFolder_(mf, cleanName_(customer) || 'Unassigned');
  var jname = (TAB_TAG[tab] || 'JOB') + (category ? ' ' + category : '') +
    ' · ' + dayStr_(createdAt) + ' ' + pad2_(d.getHours()) + '.' + pad2_(d.getMinutes());
  var n = cleanName_(note);
  if (n) jname += ' — ' + n;
  return childFolder_(cf, jname);
}

/** The folder a job's photos belong in (falls back for old jobs). */
function jobFolderOf_(lbl) {
  if (lbl && lbl.folderId) {
    try { return DriveApp.getFolderById(lbl.folderId); } catch (e) {}
  }
  return monthFolder_();
}

/** "Jobsheet 1" / "Waybill 2" / "Defect 1" / "Photo 3" — what a photo IS in its job. */
function photoKind_(tab, jsCount, index) {
  if ((tab === 'postage' || tab === 'defect') && jsCount > 0) {
    if (index < jsCount) return 'Jobsheet ' + (index + 1);
    return (tab === 'defect' ? 'Defect ' : 'Waybill ') + (index - jsCount + 1);
  }
  return 'Photo ' + (index + 1);
}

/** File name inside a job folder: "Jobsheet 1 — Nurul Syifa · 2026-08-05 14.32" */
function fileLabel_(kind, customer) {
  var c = cleanName_(customer);
  return kind + (c && c !== 'Unassigned' ? ' — ' + c : '') + ' · ' + stamp_();
}

/**
 * Month subfolder ("2026-08") inside the app folder — photos are filed by
 * month instead of piling up in one endless folder.
 */
function monthFolder_() {
  var d = new Date();
  var name = d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
  var props = PropertiesService.getScriptProperties();
  var key = 'MF_' + name;
  var fid = props.getProperty(key);
  if (fid) {
    try { return DriveApp.getFolderById(fid); } catch (e) {}
  }
  var root = getFolder_();
  var it = root.getFoldersByName(name);
  var f = it.hasNext() ? it.next() : root.createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}

/** Saves a base64 JPEG into a given Drive folder, returns the file id. */
function savePhotoTo_(folder, base64Data, name) {
  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, 'image/jpeg', name + '.jpg');
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // Workspace domains may block link sharing; images are served through
    // getImagesData anyway, so this is not required.
  }
  return file.getId();
}

/** Saves into this month's folder (fallback for jobs without their own folder). */
function savePhoto_(base64Data, name) {
  return savePhotoTo_(monthFolder_(), base64Data, name);
}

function trashFile_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
}

/**
 * Serves image bytes through the app as data URIs — photos show on every
 * device with no dependency on Drive link-sharing (often blocked on
 * Google Workspace domains). Max 8 images per call; the page batches.
 */
function getImagesData(ids) {
  var out = {};
  var n = Math.min(ids.length, 8);
  for (var i = 0; i < n; i++) {
    var id = ids[i];
    try {
      var blob = DriveApp.getFileById(id).getBlob();
      out[id] = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
    } catch (e) {
      out[id] = null; // deleted or inaccessible — the page shows a placeholder
    }
  }
  return out;
}

/** Finds the sheet row (>=2) for a job id, or -1. */
function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

function rowToJob_(r) {
  return {
    id: r[0], tab: r[1], category: r[2], note: r[3],
    photoIds: JSON.parse(r[4] || '[]'), status: r[5],
    createdAt: r[7], doneAt: r[9], proofPhotoId: r[10],
    thumbIds: JSON.parse(r[11] || '[]'), proofThumbId: r[12] || '',
    dueAt: r[13] || '', pinnedAt: r[14] || '',
    jsCount: Number(r[15]) || 0,  // postage: first N photos are Jobsheet, rest Waybill
    customer: r[16] || '',
    folderId: r[17] || '',        // the job's own Drive folder (History links to it)
    // check-first pipeline: where this checking job goes after ❤️ Got It
    nextTab: r[18] || '', nextCategory: r[19] || '',
    nextDueAt: r[20] || '', nextJobId: r[21] || '',
    fromCheck: r[6] === 'check',  // this job was auto-created by a passed check
    // "haven't received this job" problem flow
    problem: r[22] || '',         // '' | 'reported' | 'printed'
    problemAt: r[23] || '', printedAt: r[24] || '',
    printPhotoId: r[25] || '', printThumbId: r[26] || '',
    // second-stage delivery confirmation: it actually ARRIVED
    deliveredAt: r[27] || '', deliveredPhotoId: r[28] || '', deliveredThumbId: r[29] || '',
    problemNote: r[30] || '',  // shared info both sides can read on the Problem page
    deliveredVia: r[31] || '', // how it reached the customer (lalamove/bus/pickup/personal)
    deliveredBy: r[32] || '',  // who delivered — 'ZH' (Bos) or 'Bob'
    sentAt: r[33] || '',       // postage: when the J&T truck collected it
    // FULL problem history — every report + every solve, in order, so
    // report→solve can repeat until both sides are satisfied
    probLog: (function (raw) { try { return JSON.parse(raw || '[]'); } catch (e) { return []; } })(r[34])
  };
}

/** Append one event to a job's problem history (column 35). */
function pushProbLog_(sh, row, ev) {
  var cur = [];
  try { cur = JSON.parse(sh.getRange(row, 35).getValue() || '[]'); } catch (e) {}
  cur.push(ev);
  sh.getRange(row, 35).setValue(JSON.stringify(cur));
  return cur;
}

// ---------------------------------------------------------------- API called from the page

/**
 * Add a job. Returns the created job object.
 * payload = { tab: 'want'|'delivery'|'postage',
 *             category: ''|'lalamove'|'bus'|'pickup',
 *             note: string,
 *             photos: [base64jpeg, ...],      // full size, for zoom
 *             thumbs: [base64jpeg, ...],      // small, for cards (same order)
 *             dueAt: ms-timestamp or '' }     // optional "ready by" deadline
 */
function addJob(payload) {
  if (!payload || !payload.photos || !payload.photos.length) {
    throw new Error('Photo required');
  }
  if (payload.photos.length > 6) throw new Error('Max 6 photos per job');
  // The page sends its own clientId so a network RETRY is safe: if the
  // first attempt actually reached the server, the retry finds the job
  // instead of creating a duplicate.
  var id = payload.clientId ? String(payload.clientId).slice(0, 40) : Utilities.getUuid();
  var createdAt = new Date().getTime();
  var dueAt = payload.dueAt ? Number(payload.dueAt) : '';
  var jsCount = payload.jsCount ? Number(payload.jsCount) : 0;
  var customer = cleanName_(payload.customer) || 'Unassigned';

  // Every job gets its OWN Drive folder: month / customer / job.
  // Jobsheet, waybill and (later) the proof all land together in it.
  var folder = makeJobFolder_(customer, payload.tab, payload.category, payload.note, createdAt);
  var folderId = folder.getId();

  var photoIds = [], thumbIds = [];
  for (var i = 0; i < payload.photos.length; i++) {
    var kind = photoKind_(payload.tab, jsCount, i);
    photoIds.push(savePhotoTo_(folder, payload.photos[i], fileLabel_(kind, customer)));
    var t = payload.thumbs && payload.thumbs[i];
    thumbIds.push(t ? savePhotoTo_(folder, t, fileLabel_(kind + ' (thumb)', customer)) : '');
  }

  // check-first pipeline (Checking tab only): after ❤️ Got It the job is
  // auto-sent to nextTab with these prepared details
  var nextTab = (payload.tab === 'want' && (payload.nextTab === 'delivery' || payload.nextTab === 'postage'))
    ? payload.nextTab : '';
  var nextCategory = nextTab === 'delivery' ? (payload.nextCategory || '') : '';
  var nextDueAt = nextTab && payload.nextDueAt ? Number(payload.nextDueAt) : '';

  var existing = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    if (payload.clientId) {
      var row = findRow_(sh, id);
      if (row > 0) existing = sh.getRange(row, 1, 1, 35).getValues()[0];
    }
    if (!existing) {
      sh.appendRow([
        id, payload.tab, payload.category || '', payload.note || '',
        JSON.stringify(photoIds), 'pending',
        '', createdAt, '', '', '',
        JSON.stringify(thumbIds), '', dueAt, '', jsCount,
        customer, folderId,
        nextTab, nextCategory, nextDueAt, '',
        '', '', '', '', '',
        '', '', '', '', '', '', '', ''
      ]);
    }
  } finally {
    lock.releaseLock();
  }
  if (existing) {
    // duplicate retry: this run's photo copies are not needed
    for (var k = 0; k < photoIds.length; k++) { trashFile_(photoIds[k]); trashFile_(thumbIds[k]); }
    return rowToJob_(existing);
  }
  return {
    id: id, tab: payload.tab, category: payload.category || '',
    note: payload.note || '', photoIds: photoIds, status: 'pending',
    createdAt: createdAt, doneAt: '', proofPhotoId: '',
    thumbIds: thumbIds, proofThumbId: '', dueAt: dueAt, pinnedAt: '',
    jsCount: jsCount, customer: customer,
    nextTab: nextTab, nextCategory: nextCategory, nextDueAt: nextDueAt, nextJobId: ''
  };
}

/**
 * ADMIN ONLY. Ask the factory AGAIN about a jobsheet they already swiped:
 * puts it back to 'pending' and pins it to the FRONT of the swipe deck,
 * so staff must answer ❤️ seen / ❌ not seen one more time.
 */
function askAgain(id, pin) {
  requireAdmin_(pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var ts = new Date().getTime();
    sh.getRange(row, 6).setValue('pending');
    sh.getRange(row, 10).setValue('');
    sh.getRange(row, 15).setValue(ts);
    return { id: id, status: 'pending', pinnedAt: ts };
  } finally {
    lock.releaseLock();
  }
}

/**
 * UNDO a wrong swipe on the Checking tab — staff OR admin, no PIN (staff
 * fix their own swipes). Only works on a swiped jobsheet (got / notseen);
 * it returns to the FRONT of the swipe deck.
 */
function undoSwipe(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var st = sh.getRange(row, 6).getValue();
    if (st !== 'got' && st !== 'notseen') throw new Error('Nothing to undo');
    var ts = new Date().getTime();
    sh.getRange(row, 6).setValue('pending');
    sh.getRange(row, 10).setValue('');
    sh.getRange(row, 15).setValue(ts);
    // pipeline pull-back: a wrong ❤️ already pushed the job to the next
    // board — take it back (only while it is still untouched/pending)
    var pulledBack = '';
    var nextJobId = sh.getRange(row, 22).getValue();
    if (nextJobId) {
      var prow = findRow_(sh, nextJobId);
      if (prow > 0 && sh.getRange(prow, 6).getValue() === 'pending') {
        sh.deleteRow(prow); // photos are shared with the check — nothing trashed
        pulledBack = nextJobId;
      }
      sh.getRange(row, 22).setValue('');
    }
    return { id: id, status: 'pending', pinnedAt: ts, pulledBack: pulledBack };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Attach one more photo to an existing job at a given position.
 * The page posts a job with its FIRST photo only (fast), then uploads the
 * remaining photos through parallel calls to this function — total upload
 * time becomes the slowest single photo instead of the sum of all of them.
 */
function addPhotoToJob(id, index, fullB64, thumbB64) {
  if (!fullB64) throw new Error('Photo required');
  index = Number(index);
  if (!(index >= 0 && index < 6)) throw new Error('Bad photo index');

  // Save to Drive BEFORE taking the lock (Drive is the slow part).
  // Photos file into the SAME job folder photo 1 created.
  var lbl = jobLabel_(id);
  var folder = jobFolderOf_(lbl);
  var kind = photoKind_(lbl.tab, lbl.jsCount, index);
  var pId = savePhotoTo_(folder, fullB64, fileLabel_(kind, lbl.customer));
  var tId = thumbB64 ? savePhotoTo_(folder, thumbB64, fileLabel_(kind + ' (thumb)', lbl.customer)) : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(pId); trashFile_(tId);
      throw new Error('Job not found');
    }
    var photoIds = JSON.parse(sh.getRange(row, 5).getValue() || '[]');
    var thumbIds = JSON.parse(sh.getRange(row, 12).getValue() || '[]');
    while (photoIds.length <= index) photoIds.push('');
    while (thumbIds.length <= index) thumbIds.push('');
    photoIds[index] = pId;
    thumbIds[index] = tId;
    sh.getRange(row, 5).setValue(JSON.stringify(photoIds));
    sh.getRange(row, 12).setValue(JSON.stringify(thumbIds));
  } finally {
    lock.releaseLock();
  }
  return { id: id, index: index, photoId: pId, thumbId: tId };
}

/**
 * Edit a job's note / category / photos. ADMIN ONLY (needs the PIN).
 * changes = { note, category, dueAt,
 *             photos: [ {id, thumbId} | {b64, thumb} , ... ] }   // FULL new list, in order
 * Any existing photo missing from the list is moved to the Drive trash.
 */
function editJob(id, changes, pin) {
  requireAdmin_(pin);
  // drop ghost entries (a photo slot whose background upload never
  // finished has an empty id) — saving an edit HEALS such a job
  var spec = (changes.photos || []).filter(function (p) { return p && (p.b64 || p.id); });
  if (!spec.length) throw new Error('Photo required');
  if (spec.length > 6) throw new Error('Max 6 photos per job');

  // Save new photos BEFORE taking the lock (Drive is the slow part).
  var lbl = jobLabel_(id);
  var folder = jobFolderOf_(lbl);
  var editCustomer = changes.customer !== undefined ? (cleanName_(changes.customer) || 'Unassigned') : lbl.customer;
  var editJs = changes.jsCount ? Number(changes.jsCount) : 0;
  var newIds = [], newThumbIds = [];
  for (var i = 0; i < spec.length; i++) {
    var kind = photoKind_(lbl.tab, editJs, i);
    newIds.push(spec[i].b64 ? savePhotoTo_(folder, spec[i].b64, fileLabel_(kind, editCustomer)) : null);
    newThumbIds.push(spec[i].b64 && spec[i].thumb ? savePhotoTo_(folder, spec[i].thumb, fileLabel_(kind + ' (thumb)', editCustomer)) : null);
  }

  var toTrash = [];
  var job;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      for (var k = 0; k < newIds.length; k++) { trashFile_(newIds[k]); trashFile_(newThumbIds[k]); }
      throw new Error('Job not found');
    }
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    var oldIds = JSON.parse(vals[4] || '[]');
    var oldThumbs = JSON.parse(vals[11] || '[]');

    var finalIds = [], finalThumbs = [];
    for (var p = 0; p < spec.length; p++) {
      finalIds.push(spec[p].b64 ? newIds[p] : spec[p].id);
      finalThumbs.push(spec[p].b64 ? (newThumbIds[p] || '') : (spec[p].thumbId || ''));
    }
    for (var o = 0; o < oldIds.length; o++) {
      if (finalIds.indexOf(oldIds[o]) < 0) toTrash.push(oldIds[o]);
    }
    for (var t = 0; t < oldThumbs.length; t++) {
      if (oldThumbs[t] && finalThumbs.indexOf(oldThumbs[t]) < 0) toTrash.push(oldThumbs[t]);
    }
    var dueAt = changes.dueAt ? Number(changes.dueAt) : '';
    var jsCount = changes.jsCount ? Number(changes.jsCount) : 0;

    sh.getRange(row, 3, 1, 3).setValues([[changes.category || '', changes.note || '', JSON.stringify(finalIds)]]);
    sh.getRange(row, 12).setValue(JSON.stringify(finalThumbs));
    sh.getRange(row, 14).setValue(dueAt);
    sh.getRange(row, 16).setValue(jsCount);
    sh.getRange(row, 17).setValue(editCustomer);

    vals[2] = changes.category || '';
    vals[3] = changes.note || '';
    vals[4] = JSON.stringify(finalIds);
    vals[11] = JSON.stringify(finalThumbs);
    vals[13] = dueAt;
    vals[15] = jsCount;
    vals[16] = editCustomer;
    job = rowToJob_(vals);
  } finally {
    lock.releaseLock();
  }
  for (var x = 0; x < toTrash.length; x++) trashFile_(toTrash[x]);
  return job;
}

/** Delete a job's row, then move its photos to the Drive trash. ADMIN ONLY. */
function deleteJob(id, pin) {
  // SOFT delete: the row stays in the sheet and every photo stays in Drive.
  // The job just disappears from the boards, and lives on in the 🗑️ Deleted
  // tab of Evidence History where the admin can look at it or Restore it.
  requireAdmin_(pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var prev = String(sh.getRange(row, 6).getValue() || 'pending');
    if (prev !== 'deleted') {
      sh.getRange(row, 6).setValue('deleted');
      pushProbLog_(sh, row, { k: 'delete', at: new Date().getTime(), prev: prev });
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id };
}

/** ADMIN ONLY. Undo an accidental delete: the job returns to the exact
    status it had (board, done, delivered — everything intact). */
function restoreJob(id, pin) {
  requireAdmin_(pin);
  var prev = 'pending';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    if (String(sh.getRange(row, 6).getValue()) !== 'deleted') throw new Error('Job is not deleted');
    var log = [];
    try { log = JSON.parse(sh.getRange(row, 35).getValue() || '[]'); } catch (e) {}
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i] && log[i].k === 'delete') { prev = log[i].prev || 'pending'; break; }
    }
    sh.getRange(row, 6).setValue(prev);
    pushProbLog_(sh, row, { k: 'restore', at: new Date().getTime() });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id, status: prev };
}

/** ADMIN ONLY. Every deleted job, newest deletion first (max 100) —
    the "just in case" record for accidental deletes. */
function getDeletedJobs(pin) {
  requireAdmin_(pin);
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { results: [] };
  var rows = sh.getRange(2, 1, last - 1, 35).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[5] !== 'deleted') continue;
    var j = rowToJob_(r);
    j.deletedAt = 0;
    for (var k = j.probLog.length - 1; k >= 0; k--) {
      if (j.probLog[k] && j.probLog[k].k === 'delete') { j.deletedAt = j.probLog[k].at || 0; break; }
    }
    out.push(j);
  }
  out.sort(function (a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });
  return { results: out.slice(0, 100) };
}

/**
 * ADMIN ONLY. Start a new day: archive EVERY job in every tab.
 * Nothing is deleted — all records and photos stay in the Google Sheet
 * and Drive folder; the app simply starts empty again.
 */
function resetAll(pin) {
  requireAdmin_(pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, archived: 0 };
    var vals = sh.getRange(2, 1, last - 1, 6).getValues(); // id .. status
    var out = [], snap = {}, n = 0;
    for (var i = 0; i < vals.length; i++) {
      var st = vals[i][5];
      if (st !== 'archived' && st !== 'deleted') { snap[vals[i][0]] = st; st = 'archived'; n++; }
      out.push([st]);
    }
    sh.getRange(2, 6, last - 1, 1).setValues(out);
    if (n > 0) saveResetSnapshot_(snap);
    return { ok: true, archived: n };
  } finally {
    lock.releaseLock();
  }
}

/** Remember what a reset archived, so the admin can UNDO a mistake. */
function saveResetSnapshot_(snap) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty('LAST_RESET', JSON.stringify({ at: new Date().getTime(), rows: snap }));
  } catch (e) {} // snapshot too big to store — reset still works, undo unavailable
}

/**
 * ADMIN ONLY. Undo the LAST reset (RESET ALL or CLEAR DONE): every job that
 * reset archived gets its previous status back — got stays got, done stays
 * done, pending comes back to the deck. One level of undo.
 */
function undoReset(pin) {
  requireAdmin_(pin);
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_RESET');
  if (!raw) throw new Error('Nothing to undo');
  var snap = JSON.parse(raw);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    var restored = 0;
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, 6).getValues();
      var out = [];
      for (var i = 0; i < vals.length; i++) {
        var st = vals[i][5];
        var prev = snap.rows[vals[i][0]];
        if (prev && st === 'archived') { st = prev; restored++; }
        out.push([st]);
      }
      sh.getRange(2, 6, last - 1, 1).setValues(out);
    }
    PropertiesService.getScriptProperties().deleteProperty('LAST_RESET');
    return { ok: true, restored: restored };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ADMIN ONLY. Clear FINISHED work only. "Finished" means TRULY out the door:
 *  - Checking jobsheets swiped ❤️ Got It
 *  - Delivery jobs done AND confirmed ✔ Delivered
 *  - Postage parcels done AND ✔ given to J&T
 *  - fixed Defects (done — they have no second stage)
 * A parcel still waiting for the J&T truck, or a delivery not yet confirmed
 * Delivered, is NOT finished — it stays on the board so it can't be
 * forgotten. Everything unfinished carries forward to the next day.
 */
function resetDone(pin) {
  requireAdmin_(pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, archived: 0, carried: 0 };
    // 34 columns: we need deliveredAt (28) and sentAt (34), not just status
    var vals = sh.getRange(2, 1, last - 1, 35).getValues();
    var out = [], snap = {}, archived = 0, carried = 0;
    for (var i = 0; i < vals.length; i++) {
      var tab = vals[i][1], status = vals[i][5];
      if (status !== 'archived' && status !== 'deleted') {
        var finished =
          (tab === 'want' && status === 'got') ||
          (status === 'done' && (
            tab === 'defect' ||
            (tab === 'delivery' && vals[i][27]) ||   // deliveredAt set
            (tab === 'postage' && vals[i][33])));    // sentAt set
        if (finished) {
          snap[vals[i][0]] = status; status = 'archived'; archived++;
        } else {
          carried++;
        }
      }
      out.push([status]);
    }
    sh.getRange(2, 6, last - 1, 1).setValues(out);
    if (archived > 0) saveResetSnapshot_(snap);
    return { ok: true, archived: archived, carried: carried };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Replace the proof photo on a finished job. Staff OR admin — whoever took
 * a wrong photo can fix it. The old proof files are trashed.
 */
function updateProof(id, proofBase64, proofThumbBase64) {
  if (!proofBase64) throw new Error('Proof photo required');
  // Save the new proof BEFORE taking the lock (Drive is the slow part).
  var lbl = jobLabel_(id);
  var pFolder = jobFolderOf_(lbl);
  var proofId = savePhotoTo_(pFolder, proofBase64, fileLabel_('PROOF', lbl.customer));
  var proofThumbId = proofThumbBase64 ? savePhotoTo_(pFolder, proofThumbBase64, fileLabel_('PROOF (thumb)', lbl.customer)) : '';
  var toTrash = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(proofId); trashFile_(proofThumbId);
      throw new Error('Job not found');
    }
    var vals = sh.getRange(row, 11, 1, 3).getValues()[0];
    if (vals[0]) toTrash.push(vals[0]); // old proof
    if (vals[2]) toTrash.push(vals[2]); // old proof thumb
    sh.getRange(row, 11).setValue(proofId);
    sh.getRange(row, 13).setValue(proofThumbId);
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { id: id, proofPhotoId: proofId, proofThumbId: proofThumbId };
}

/**
 * Remove the proof photo from a finished job. Staff OR admin. A done job
 * must have a proof, so the job goes BACK to To Do (status 'pending').
 */
function deleteProof(id) {
  var toTrash = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 11, 1, 3).getValues()[0];
    if (vals[0]) toTrash.push(vals[0]);
    if (vals[2]) toTrash.push(vals[2]);
    sh.getRange(row, 6).setValue('pending'); // back to To Do
    sh.getRange(row, 10).setValue('');       // doneAt
    sh.getRange(row, 11).setValue('');       // proofPhotoId
    sh.getRange(row, 13).setValue('');       // proofThumbId
    // a job that is no longer Done cannot stay "delivered" either
    var dv = sh.getRange(row, 28, 1, 3).getValues()[0];
    if (dv[1]) toTrash.push(dv[1]);
    if (dv[2]) toTrash.push(dv[2]);
    sh.getRange(row, 28, 1, 3).setValues([['', '', '']]);
    sh.getRange(row, 32, 1, 2).setValues([['', '']]);
    sh.getRange(row, 34).setValue(''); // no longer Done → no longer Sent either
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { id: id, status: 'pending' };
}

/** All non-archived jobs for one tab, newest first. */
function getJobs(tab) {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 35).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[1] !== tab || r[5] === 'archived' || r[5] === 'deleted') continue;
    out.push(rowToJob_(r));
  }
  out.reverse();
  return out;
}

/** Jobs for one tab + badge counts, in a single round trip (faster startup). */
function getInitData(tab) {
  return { jobs: getJobs(tab), counts: getCounts() };
}

/**
 * ALL three tabs + badge counts in ONE round trip — a single sheet read.
 * Used by the Refresh button so Checking, Delivery and Postage update together.
 */
function getAllData() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  var jobs = { want: [], delivery: [], postage: [], defect: [] };
  var counts = { want: 0, delivery: 0, postage: 0, defect: 0 };
  if (last < 2) return { jobs: jobs, counts: counts };
  var rows = sh.getRange(2, 1, last - 1, 35).getValues();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!jobs.hasOwnProperty(r[1]) || r[5] === 'archived' || r[5] === 'deleted') continue;
    var j = rowToJob_(r);
    jobs[r[1]].push(j);
    if (j.status === 'pending') counts[r[1]]++;
  }
  jobs.want.reverse(); jobs.delivery.reverse(); jobs.postage.reverse(); jobs.defect.reverse();
  return { jobs: jobs, counts: counts };
}

/**
 * Update a job's status. Returns { id, status, doneAt, proofPhotoId, proofThumbId }.
 * Tab 1 (want)            : status 'got' (❤️) or 'notseen' (❌) — no photo needed.
 * Tab 2/3 (delivery/post) : status 'done' — proofBase64 photo REQUIRED (+ small thumb).
 * Any tab                 : status 'archived' — ADMIN ONLY (hides the job, keeps the record).
 */
function updateStatus(id, status, proofBase64, proofThumbBase64, pin) {
  var allowed = { got: 1, notseen: 1, done: 1, archived: 1 };
  if (!allowed[status]) throw new Error('Bad status');
  if (status === 'archived') requireAdmin_(pin);
  if (status === 'done' && !proofBase64) {
    throw new Error('Proof photo required');
  }
  // Save the proof photo BEFORE taking the lock (Drive is the slow part).
  // The PROOF lands in the SAME job folder as the jobsheet/waybill photos.
  var lbl = proofBase64 ? jobLabel_(id) : null;
  var pFolder = lbl ? jobFolderOf_(lbl) : null;
  var proofId = proofBase64 ? savePhotoTo_(pFolder, proofBase64, fileLabel_('PROOF', lbl.customer)) : '';
  var proofThumbId = proofThumbBase64 ? savePhotoTo_(pFolder, proofThumbBase64, fileLabel_('PROOF (thumb)', lbl.customer)) : '';
  var doneAt = new Date().getTime();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(proofId); trashFile_(proofThumbId);
      throw new Error('Job not found');
    }
    sh.getRange(row, 6).setValue(status);
    if (status !== 'archived') {
      sh.getRange(row, 10).setValue(doneAt);
      if (proofId) sh.getRange(row, 11).setValue(proofId);
      if (proofThumbId) sh.getRange(row, 13).setValue(proofThumbId);
    }
    // CHECK-FIRST PIPELINE: ❤️ Got It on a prepared jobsheet auto-creates
    // the Delivery/Postage job with the prepared details. The photos and
    // Drive folder are SHARED, so the proof later lands in the same folder.
    // nextJobId guards against double-push (re-swipes after Push Up).
    var pushed = null;
    if (status === 'got') {
      var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
      if (vals[18] && !vals[21]) {
        var pid = Utilities.getUuid();
        var prow = [
          pid, vals[18], vals[19] || '', vals[3],
          vals[4], 'pending',
          'check', new Date().getTime(), '', '', '',
          vals[11], '', vals[20] || '', '', 0,
          vals[16] || 'Unassigned', vals[17] || '',
          '', '', '', '',
          '', '', '', '', '',
          '', '', '', '', '', '', '', ''
        ];
        sh.appendRow(prow);
        sh.getRange(row, 22).setValue(pid);
        pushed = rowToJob_(prow);
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { id: id, status: status, doneAt: doneAt, proofPhotoId: proofId, proofThumbId: proofThumbId, pushed: pushed };
}

/**
 * "🚌 SENT BUS" — a postage parcel that went by bus instead. The job moves
 * to the DELIVERY board as a completed Bus delivery; the proof photo is
 * still REQUIRED, same rule as any Done. Its Drive folder is re-filed under
 * Delivery too — unless the folder is shared with a Checking job (pipeline
 * push), in which case it stays where the check evidence lives.
 */
function sentBus(id, proofBase64, proofThumbBase64) {
  if (!proofBase64) throw new Error('Proof photo required');
  // Save the proof BEFORE taking the lock (Drive is the slow part); it lands
  // in the job's own folder, which moves along with it afterwards.
  var lbl = jobLabel_(id);
  var pFolder = jobFolderOf_(lbl);
  var proofId = savePhotoTo_(pFolder, proofBase64, fileLabel_('PROOF', lbl.customer));
  var proofThumbId = proofThumbBase64 ? savePhotoTo_(pFolder, proofThumbBase64, fileLabel_('PROOF (thumb)', lbl.customer)) : '';
  var doneAt = new Date().getTime();
  var toTrash = [], moveInfo = null;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(proofId); trashFile_(proofThumbId);
      throw new Error('Job not found');
    }
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    if (vals[1] !== 'postage') {
      trashFile_(proofId); trashFile_(proofThumbId);
      throw new Error('Only a postage job can be marked Sent bus');
    }
    if (vals[10]) toTrash.push(vals[10]); // replace an existing proof, if any
    if (vals[12]) toTrash.push(vals[12]);
    sh.getRange(row, 2).setValue('delivery');
    sh.getRange(row, 3).setValue('bus');
    sh.getRange(row, 6).setValue('done');
    sh.getRange(row, 10).setValue(doneAt);
    sh.getRange(row, 11).setValue(proofId);
    sh.getRange(row, 13).setValue(proofThumbId);
    if (vals[6] !== 'check' && vals[17]) {
      moveInfo = { folderId: vals[17], customer: vals[16] || 'Unassigned', createdAt: vals[7] };
    }
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  if (moveInfo) {
    try { // folder filing is best-effort — the record itself is already correct
      var d = new Date(Number(moveInfo.createdAt));
      var month = d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
      var dest = childFolder_(childFolder_(childFolder_(masterFolder_(), 'Delivery'), month),
        cleanName_(moveInfo.customer) || 'Unassigned');
      DriveApp.getFolderById(moveInfo.folderId).moveTo(dest);
    } catch (e) {}
  }
  return { id: id, tab: 'delivery', category: 'bus', status: 'done', doneAt: doneAt,
           proofPhotoId: proofId, proofThumbId: proofThumbId };
}

/**
 * "❓ HAVEN'T RECEIVED" — staff sees a Delivery/Postage job on the board but
 * the physical job never reached the factory. One tap flags it as a PROBLEM
 * so the office team knows to print it. No PIN needed — any staff can report.
 * (Checking's ❌ Not Seen jobs join the Problem page automatically.)
 */
function reportProblem(id, kind, text) {
  // kind '' → "haven't received" ('reported'); 'sticker' → "no sticker"
  // ('nosticker'); 'nojob' → "got sticker, no jobsheet" ('nojob');
  // 'custom' → staff TYPED the problem themselves (any tab, incl. Checking)
  var mark = kind === 'sticker' ? 'nosticker'
    : kind === 'nojob' ? 'nojob'
    : kind === 'custom' ? 'custom' : 'reported';
  text = String(text || '').trim().slice(0, 300);
  if (mark === 'custom' && !text) throw new Error('Type the problem first');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    if (mark !== 'custom' &&
        vals[1] !== 'delivery' && vals[1] !== 'postage' && vals[1] !== 'defect') {
      throw new Error('Only Delivery/Postage/Defect jobs can be reported');
    }
    if (mark === 'nosticker' && vals[1] !== 'postage') {
      throw new Error('No-sticker reports are for Postage jobs');
    }
    if (mark === 'nojob' && vals[1] !== 'postage') {
      throw new Error('Got-sticker-no-job reports are for Postage jobs');
    }
    if (vals[22] === mark) { // already reported the same thing — idempotent
      return { id: id, problem: mark, problemAt: vals[23] };
    }
    var ts = new Date().getTime();
    sh.getRange(row, 23).setValue(mark);
    sh.getRange(row, 24).setValue(ts);
    sh.getRange(row, 25).setValue(''); // a fresh report clears an old "printed"
    // history: reports can repeat (report → solve → report again …)
    var log = pushProbLog_(sh, row, { k: 'report', kind: mark, at: ts, text: text });
    return { id: id, problem: mark, problemAt: ts, probLog: log };
  } finally {
    lock.releaseLock();
  }
}

/** STAFF can EDIT the text of a raised (typed) problem. */
function editProblemReport(id, text) {
  text = String(text || '').trim().slice(0, 300);
  if (!text) throw new Error('Type the problem first');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    if (vals[22] !== 'custom') throw new Error('Only a typed problem can be edited');
    var log = [];
    try { log = JSON.parse(vals[34] || '[]'); } catch (e) {}
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i].k === 'report' && log[i].kind === 'custom') { log[i].text = text; break; }
    }
    sh.getRange(row, 35).setValue(JSON.stringify(log));
    return { id: id, text: text, probLog: log };
  } finally {
    lock.releaseLock();
  }
}

/** STAFF can DELETE any raised report — typed problems AND the one-tap
    reports (haven't received / no sticker / got-sticker-no-job). A wrong
    tap leaves the Problem page with one delete. */
function deleteProblemReport(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    var mark = vals[22];
    if (mark !== 'custom' && mark !== 'reported' && mark !== 'nosticker' && mark !== 'nojob') {
      throw new Error('No active report to delete');
    }
    var log = [];
    try { log = JSON.parse(vals[34] || '[]'); } catch (e) {}
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i].k === 'report' && log[i].kind === mark) { log.splice(i, 1); break; }
    }
    sh.getRange(row, 35).setValue(JSON.stringify(log));
    // earlier solved cycles keep their 'printed' state; otherwise no problem
    var hasSolve = log.some(function (e) { return e.k === 'solve'; });
    sh.getRange(row, 23).setValue(hasSolve ? 'printed' : '');
    sh.getRange(row, 24).setValue('');
    return { id: id, problem: hasSolve ? 'printed' : '', probLog: log };
  } finally {
    lock.releaseLock();
  }
}

/**
 * "📄 GOT STICKER, NO JOB" — the special button at the TOP of the Postage
 * page. A waybill sticker arrived at the factory but there is NO job on the
 * board. Staff snap the sticker; this creates the postage job (sticker photo
 * only) already flagged 'nojob' on the Problem page, so the office prints
 * the jobsheet and solves it as usual. clientId makes retries safe.
 */
function reportStickerNoJob(payload) {
  var photos = (payload && payload.photos) || (payload && payload.photo ? [payload.photo] : []);
  var thumbs = (payload && payload.thumbs) || (payload && payload.thumb ? [payload.thumb] : []);
  if (!photos.length) throw new Error('Sticker photo required');
  var job = addJob({
    tab: 'postage', category: '',
    note: String((payload && payload.note) || ''),
    customer: String((payload && payload.customer) || ''),
    clientId: payload && payload.clientId,
    photos: photos,
    thumbs: thumbs,
    dueAt: (payload && payload.dueAt) || '',
    jsCount: 0             // NO jobsheet — the card shows a big red ? until solved
  });
  var r = reportProblem(job.id, 'nojob');
  job.problem = r.problem;
  job.problemAt = r.problemAt;
  job.probLog = r.probLog;
  return job;
}

/**
 * "✅ SOLVED" on the Problem page — the office printed the job. The photo of
 * the printing status is REQUIRED as evidence; it files into the job's own
 * Drive folder. Works on reported Delivery/Postage jobs AND on Checking jobs
 * that were swiped ❌ Not Seen. The job then shows "🖨️ Printed at <time>".
 */
function solveProblem(id, photoB64, thumbB64) {
  if (!photoB64) throw new Error('Printing photo required');
  // Save the photo BEFORE taking the lock (Drive is the slow part).
  var lbl = jobLabel_(id);
  var pFolder = jobFolderOf_(lbl);
  var photoId = savePhotoTo_(pFolder, photoB64, fileLabel_('PRINTED', lbl.customer));
  var thumbId = thumbB64 ? savePhotoTo_(pFolder, thumbB64, fileLabel_('PRINTED (thumb)', lbl.customer)) : '';
  var ts = new Date().getTime();
  var toTrash = [];

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(photoId); trashFile_(thumbId);
      throw new Error('Job not found');
    }
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    var isProblem = vals[22] === 'reported' || vals[22] === 'nosticker' || vals[22] === 'nojob' ||
      vals[22] === 'custom' || (vals[1] === 'want' && vals[5] === 'notseen');
    if (!isProblem) {
      trashFile_(photoId); trashFile_(thumbId);
      throw new Error('This job is not on the Problem page');
    }
    sh.getRange(row, 23).setValue('printed');
    sh.getRange(row, 25).setValue(ts);
    sh.getRange(row, 26).setValue(photoId);
    sh.getRange(row, 27).setValue(thumbId);
    // history: keep EVERY solve (with the info note at that moment ABOVE its
    // photo) — cycles can repeat until both sides are satisfied
    var log = pushProbLog_(sh, row,
      { k: 'solve', at: ts, photoId: photoId, thumbId: thumbId, note: String(vals[30] || '') });
    // a solved "Got sticker, No Job": the printed jobsheet BECOMES the job's
    // jobsheet photo — the red ? on the card turns into the real thing
    var attached = false, photoIds = null, thumbIds = null, jsCount = Number(vals[15]) || 0;
    if (vals[22] === 'nojob' && vals[1] === 'postage') {
      photoIds = JSON.parse(vals[4] || '[]');
      thumbIds = JSON.parse(vals[11] || '[]');
      photoIds.unshift(photoId);
      thumbIds.unshift(thumbId);
      jsCount = jsCount + 1;
      sh.getRange(row, 5).setValue(JSON.stringify(photoIds));
      sh.getRange(row, 12).setValue(JSON.stringify(thumbIds));
      sh.getRange(row, 16).setValue(jsCount);
      attached = true;
    }
    // clear the current shared note — it is archived inside the solve event
    if (vals[30]) sh.getRange(row, 31).setValue('');
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { id: id, problem: 'printed', printedAt: ts, printPhotoId: photoId, printThumbId: thumbId,
           probLog: log, attachedJobsheet: attached, photoIds: photoIds, thumbIds: thumbIds, jsCount: jsCount };
}

/**
 * 🗑️ on the SOLVED picture — delete the LATEST solve. The problem it
 * answered automatically REOPENS on the Problem page as unsolved, and the
 * archived info note comes back as the live note. Only the newest solve can
 * be deleted (older ones are history), and only while no newer report is
 * open. A jobsheet the solve attached (Got sticker, No Job) is detached.
 */
function deleteSolve(id) {
  var toTrash = [];
  var out;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    var log = [];
    try { log = JSON.parse(vals[34] || '[]'); } catch (e) {}
    if (vals[22] !== 'printed' || !log.length || log[log.length - 1].k !== 'solve') {
      throw new Error('No solved photo to delete');
    }
    var ev = log.pop();
    if (ev.photoId) toTrash.push(ev.photoId);
    if (ev.thumbId) toTrash.push(ev.thumbId);
    // detach a jobsheet this solve attached (Got sticker, No Job flow)
    var photoIds = JSON.parse(vals[4] || '[]');
    var thumbIds = JSON.parse(vals[11] || '[]');
    var jsCount = Number(vals[15]) || 0;
    var pi = ev.photoId ? photoIds.indexOf(ev.photoId) : -1;
    if (pi >= 0 && pi < jsCount) {
      photoIds.splice(pi, 1);
      if (thumbIds.length > pi) thumbIds.splice(pi, 1);
      jsCount--;
      sh.getRange(row, 5).setValue(JSON.stringify(photoIds));
      sh.getRange(row, 12).setValue(JSON.stringify(thumbIds));
      sh.getRange(row, 16).setValue(jsCount);
    }
    // REOPEN the report this solve answered
    var lastReport = null, prevSolve = null;
    for (var i = log.length - 1; i >= 0; i--) {
      if (!lastReport && log[i].k === 'report') lastReport = log[i];
      if (!prevSolve && log[i].k === 'solve') prevSolve = log[i];
      if (lastReport && prevSolve) break;
    }
    sh.getRange(row, 23).setValue(lastReport ? lastReport.kind : '');
    sh.getRange(row, 24).setValue(lastReport ? lastReport.at : '');
    sh.getRange(row, 25).setValue(prevSolve ? prevSolve.at : '');
    sh.getRange(row, 26).setValue(prevSolve ? (prevSolve.photoId || '') : '');
    sh.getRange(row, 27).setValue(prevSolve ? (prevSolve.thumbId || '') : '');
    if (ev.note) sh.getRange(row, 31).setValue(ev.note); // the note lives on
    sh.getRange(row, 35).setValue(JSON.stringify(log));
    out = { id: id, problem: lastReport ? lastReport.kind : '',
      problemAt: lastReport ? lastReport.at : '',
      printedAt: prevSolve ? prevSolve.at : '',
      printPhotoId: prevSolve ? (prevSolve.photoId || '') : '',
      printThumbId: prevSolve ? (prevSolve.thumbId || '') : '',
      probLog: log, photoIds: photoIds, thumbIds: thumbIds, jsCount: jsCount };
  } finally {
    lock.releaseLock();
  }
  for (var t = 0; t < toTrash.length; t++) trashFile_(toTrash[t]);
  return out;
}

/**
 * Shared info on a Problem-page job — STAFF or ADMIN can write it, both
 * sides read it (on the Problem page and on the job's own card).
 */
function setProblemNote(id, text) {
  text = String(text || '').slice(0, 300);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    var isProblem = vals[22] === 'reported' || vals[22] === 'nosticker' || vals[22] === 'nojob' ||
      vals[22] === 'custom' || (vals[1] === 'want' && vals[5] === 'notseen');
    if (!isProblem) throw new Error('This job is not on the Problem page');
    sh.getRange(row, 31).setValue(text);
    return { id: id, problemNote: text };
  } finally {
    lock.releaseLock();
  }
}

/**
 * "📦 DELIVERED?" — second-stage confirmation on a DELIVERY job that is
 * already Done (ready/sent). No photo: the answer to "how did it reach the
 * customer, and who delivered it?" IS the record. Staff or admin confirm;
 * the job then shows a big ✔ so nobody thinks about it again.
 */
var DELIVERED_VIAS = { lalamove: 1, bus: 1, pickup: 1, personal: 1 };
function markDelivered(id, via, by) {
  if (!DELIVERED_VIAS[via]) throw new Error('Choose HOW it was delivered');
  if (by !== 'ZH' && by !== 'Bob') throw new Error('Choose who delivered — Bos (ZH) or Bob');
  var ts = new Date().getTime();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    if (vals[1] !== 'delivery') throw new Error('Delivered confirmation is for Delivery jobs');
    if (vals[5] !== 'done') throw new Error('Finish the job first (Done + proof), then confirm delivered');
    sh.getRange(row, 28).setValue(ts);
    sh.getRange(row, 32).setValue(via);
    sh.getRange(row, 33).setValue(by);
  } finally {
    lock.releaseLock();
  }
  return { id: id, deliveredAt: ts, deliveredVia: via, deliveredBy: by };
}

/** Undo a wrong Delivered confirmation — back to "ready, not yet delivered". */
function removeDelivered(id) {
  var toTrash = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 28, 1, 3).getValues()[0];
    if (vals[1]) toTrash.push(vals[1]);
    if (vals[2]) toTrash.push(vals[2]);
    sh.getRange(row, 28, 1, 3).setValues([['', '', '']]);
    sh.getRange(row, 32, 1, 2).setValues([['', '']]);
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { id: id, deliveredAt: '' };
}

/**
 * "📮 SENT TO J&T" — a Done postage parcel was handed to the daily 11am
 * truck. One tap (no photo); the parcel leaves the ready count and shows
 * the big ✔. The ready count = Done postage jobs without sentAt.
 */
function markSentJnt(id) {
  var ts = new Date().getTime();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 35).getValues()[0];
    if (vals[1] !== 'postage') throw new Error('Sent-to-J&T is for Postage jobs');
    if (vals[5] !== 'done') throw new Error('Finish the parcel first (Done + proof), then mark Sent');
    sh.getRange(row, 34).setValue(ts);
  } finally {
    lock.releaseLock();
  }
  return { id: id, sentAt: ts };
}

/** Undo a wrong Sent tap — the parcel returns to the ready count. */
function undoSentJnt(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    sh.getRange(row, 34).setValue('');
  } finally {
    lock.releaseLock();
  }
  return { id: id, sentAt: '' };
}

// ---------------------------------------------------------------- 📦 inventory
// Replaces the old Google Form: staff key stock in/out here, the admin
// views totals. Lives in its own "Inventory" tab of the same spreadsheet.
function invSheet_() {
  ensureSetup_();
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  var sh = ss.getSheetByName('Inventory');
  if (!sh) {
    sh = ss.insertSheet('Inventory');
    sh.appendRow(['id', 'at', 'item', 'qty', 'note', 'by']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * ⭐ EDIT THIS LIST: the stock items your staff count, with the TARGET each
 * one should be kept at. `orderIf` on a section = order when stock falls
 * BELOW that number (defaults to the item's target).
 */
var STOCK_SECTIONS = [
  { name: 'Fabric', hint: '10 combined rolls = FREE SHIPPING', items: [
    { name: 'Eyelet', target: 10 }, { name: 'Mini Eyelet', target: 10 },
    { name: 'Interlock', target: 5 }, { name: 'RJPK', target: 5 },
    { name: 'Hexagon', target: 5 }, { name: 'Ultron', target: 3 },
    { name: 'Mesh', target: 3 }, { name: 'Lycra 280', target: 3 },
    { name: 'Polysoft', target: 3 }, { name: 'Black Loban', target: 3 },
    { name: 'White Loban', target: 3 }, { name: 'Mini Square', target: 3 }
  ] },
  { name: 'Ink', hint: 'Ink supplier: FREE DELIVERY · order if below 2', orderIf: 2, items: [
    { name: 'Ink - Red', target: 3 }, { name: 'Ink - Blue', target: 3 },
    { name: 'Ink - Yellow', target: 3 }, { name: 'Ink - Black', target: 3 }
  ] },
  { name: 'Paper', hint: '', items: [
    { name: 'Paper - Sublimation', target: 5 }
  ] }
];

/**
 * Staff OR admin submit a stock count: values = [{item, qty}] for the rows
 * they filled. Every count is appended to the "Inventory" sheet tab with
 * time + who, so the full counting history stays auditable.
 */
function submitStockTake(values, by) {
  if (!values || !values.length) throw new Error('Key in at least one stock value');
  var ts = new Date().getTime();
  by = by === 'admin' ? 'admin' : 'staff';
  var saved = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = invSheet_();
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var q = v ? Number(v.qty) : NaN;
      if (!v || !v.item || isNaN(q) || q < 0) continue; // 0 is a VALID count
      sh.appendRow([Utilities.getUuid(), ts, cleanName_(v.item), q, 'stock count', by]);
      saved++;
    }
  } finally {
    lock.releaseLock();
  }
  if (!saved) throw new Error('Key in at least one stock value');
  return { ok: true, at: ts, saved: saved };
}

/** The catalog with each item's LATEST counted value (+ when and by whom),
    plus fullAt/fullBy: the last time ONE submission covered EVERY item —
    the boss prefers whole-list counts over one-by-one updates. */
function getStockTake() {
  var latest = {}, lastAt = 0, subs = {};
  var sh = invSheet_();
  var last = sh.getLastRow();
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 6).getValues();
    for (var i = 0; i < rows.length; i++) { // chronological — later rows win
      var r = rows[i];
      latest[String(r[2])] = { qty: Number(r[3]) || 0, at: r[1], by: r[5] || '' };
      if (Number(r[1]) > lastAt) lastAt = Number(r[1]);
      var key = String(r[1]); // one submission = one shared timestamp
      if (!subs[key]) subs[key] = { by: r[5] || '', items: {} };
      subs[key].items[String(r[2])] = 1;
    }
  }
  var names = [];
  for (var s2 = 0; s2 < STOCK_SECTIONS.length; s2++) {
    for (var k2 = 0; k2 < STOCK_SECTIONS[s2].items.length; k2++) names.push(STOCK_SECTIONS[s2].items[k2].name);
  }
  var fullAt = 0, fullBy = '';
  for (var key2 in subs) {
    var covered = true;
    for (var n = 0; n < names.length; n++) {
      if (!subs[key2].items[names[n]]) { covered = false; break; }
    }
    if (covered && Number(key2) > fullAt) { fullAt = Number(key2); fullBy = subs[key2].by; }
  }
  var sections = [];
  for (var s = 0; s < STOCK_SECTIONS.length; s++) {
    var sec = STOCK_SECTIONS[s];
    var items = [];
    for (var k = 0; k < sec.items.length; k++) {
      var it = sec.items[k];
      var l = latest[it.name];
      items.push({ name: it.name, target: it.target,
        orderIf: sec.orderIf || it.target,
        qty: l ? l.qty : '', at: l ? l.at : '', by: l ? l.by : '' });
    }
    sections.push({ name: sec.name, hint: sec.hint || '', items: items });
  }
  return { sections: sections, lastAt: lastAt, fullAt: fullAt, fullBy: fullBy };
}

/**
 * STAFF AND ADMIN (read-only). Evidence history: search EVERY job ever
 * posted — including archived ones (RESET never deletes records). Matches
 * the query against the note, category, tab and the posted/finished dates
 * ("2026-08-05"). Empty query = the most recent jobs. Jobs fully OUT THE
 * DOOR (✔ Delivered / ✔ Sent to J&T) sort to the very top, then everything
 * newest first. Capped at 100 results.
 * (The pin argument is kept for compatibility, unused.)
 */
function searchHistory(q, pin, tab, category) {
  q = String(q || '').toLowerCase().trim();
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { results: [], total: 0, driveFolderId: masterFolder_().getId() };
  var rows = sh.getRange(2, 1, last - 1, 35).getValues();
  var out = [];
  for (var i = rows.length - 1; i >= 0; i--) { // newest first
    var r = rows[i];
    if (!r[10]) continue;                        // EVIDENCE = has a PROOF photo; no proof, not listed
    if (r[5] === 'deleted') continue;            // deleted jobs live in the Deleted tab only
    if (tab && r[1] !== tab) continue;           // page filter (delivery / postage / …)
    if (category && r[2] !== category) continue; // delivery sub-type (bus / lalamove / pickup)
    if (q) {
      var hay = (String(r[3]) + ' ' + String(r[16]) + ' ' + r[2] + ' ' + r[1] + ' ' +
        dayStr_(r[7]) + ' ' + dayStr_(r[9])).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    out.push(rowToJob_(r));
  }
  // ✔ out-the-door jobs (Delivered / Sent to J&T) float to the very top,
  // then everything else — newest first within each group
  out.sort(function (a, b) {
    var oa = (a.deliveredAt || a.sentAt) ? 1 : 0;
    var ob = (b.deliveredAt || b.sentAt) ? 1 : 0;
    if (oa !== ob) return ob - oa;
    var ka = Math.max(Number(a.sentAt || 0), Number(a.deliveredAt || 0), Number(a.doneAt || 0), Number(a.createdAt || 0));
    var kb = Math.max(Number(b.sentAt || 0), Number(b.deliveredAt || 0), Number(b.doneAt || 0), Number(b.createdAt || 0));
    return kb - ka;
  });
  // driveFolderId: the "Kilang App Photos" master folder, so the page can
  // offer an "open in Google Drive" link next to the results.
  return { results: out.slice(0, 100), total: out.length, driveFolderId: masterFolder_().getId() };
}

/**
 * ADMIN ONLY. 📈 Daily production KPI — the last 14 days, every day.
 * Counts WORK jobs (Delivery / Postage / Defect; Checking swipes excluded).
 *
 * The KPI is done ÷ WORKLOAD, not done ÷ posted — a job finished today may
 * have been posted days ago, so measuring against that day's real board
 * (leftover + new) keeps the number honest and never above 100%.
 * Per day:
 *   posted — new jobs posted that day
 *   load   — WORKLOAD: every job open on the board at any point that day
 *            (carried over from before + newly posted)
 *   done   — jobs COMPLETED that day (proof photo taken)
 *   left   — still unfinished at the END of that day (tomorrow's carryover)
 *   out    — out the door that day (✔ Delivered + ✔ Sent to J&T)
 * A job archived WITHOUT ever being finished (cancelled / reset away) stops
 * counting as workload — otherwise it would inflate "left" forever.
 * Archived finished jobs count on their real dates — CLEAR DONE / RESET
 * never hides performance. Newest day first.
 */
function getPerformance(pin) {
  requireAdmin_(pin);
  var now = new Date();
  var days = [], idx = {};
  for (var d = 13; d >= 0; d--) {
    var ds = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d).getTime();
    var de = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d + 1).getTime() - 1;
    idx[dayStr_(ds)] = days.length;
    days.push({ ymd: dayStr_(ds), at: ds, end: de, posted: 0, load: 0, done: 0, left: 0, out: 0 });
  }
  var winStart = days[0].at;
  var startBacklog = 0; // jobs already waiting when the 14-day window opens
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 35).getValues();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r[1] === 'want') continue;
      var createdAt = Number(r[7] || 0);
      var doneAt = r[10] ? Number(r[9] || 0) : 0; // finished = has a proof photo
      var deliveredAt = Number(r[27] || 0), sentAt = Number(r[33] || 0);
      if (!createdAt) continue;
      if (r[5] === 'deleted') continue;   // deleted jobs count nowhere
      if (idx[dayStr_(createdAt)] != null) days[idx[dayStr_(createdAt)]].posted++;
      if (doneAt && idx[dayStr_(doneAt)] != null) days[idx[dayStr_(doneAt)]].done++;
      if (deliveredAt && idx[dayStr_(deliveredAt)] != null) days[idx[dayStr_(deliveredAt)]].out++;
      if (sentAt && idx[dayStr_(sentAt)] != null) days[idx[dayStr_(sentAt)]].out++;
      // workload: which days did this job sit on the board?
      var ghost = (r[5] === 'archived' && !doneAt); // cleared without being finished
      if (ghost) continue;
      if (createdAt < winStart && (!doneAt || doneAt >= winStart)) startBacklog++;
      for (var k = 0; k < days.length; k++) {
        if (createdAt > days[k].end) continue;       // not posted yet that day
        if (doneAt && doneAt < days[k].at) continue; // finished before that day
        days[k].load++;
        if (!doneAt || doneAt > days[k].end) days[k].left++;
      }
    }
  }
  for (var j2 = 0; j2 < days.length; j2++) delete days[j2].end;
  days.reverse(); // today first
  return { days: days, startBacklog: startBacklog };
}

/** Badge counts for the bottom navigation (pending items per tab). */
function getCounts() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  var counts = { want: 0, delivery: 0, postage: 0, defect: 0 };
  if (last < 2) return counts;
  var rows = sh.getRange(2, 2, last - 1, 5).getValues(); // tab .. status
  for (var i = 0; i < rows.length; i++) {
    var tab = rows[i][0], status = rows[i][4];
    if (status === 'pending' && counts.hasOwnProperty(tab)) counts[tab]++;
  }
  return counts;
}

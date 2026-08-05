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
                    'customer', 'folderId']);
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

/** Master evidence folder in Drive: "Delivery Check". */
function masterFolder_() {
  var props = PropertiesService.getScriptProperties();
  var fid = props.getProperty('MASTER_FOLDER_ID');
  if (fid) {
    try { return DriveApp.getFolderById(fid); } catch (e) {}
  }
  var f = DriveApp.createFolder('Delivery Check');
  props.setProperty('MASTER_FOLDER_ID', f.getId());
  return f;
}

var TAB_FOLDER = { want: 'Checking', delivery: 'Delivery', postage: 'Postage', defect: 'Defect' };

/**
 * Evidence filing:
 *   Delivery Check / Delivery (or Postage, Checking, Defect) /
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
 * Google Workspace domains). Max 6 images per call; the page batches.
 */
function getImagesData(ids) {
  var out = {};
  var n = Math.min(ids.length, 6);
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
    customer: r[16] || ''
  };
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

  var existing = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    if (payload.clientId) {
      var row = findRow_(sh, id);
      if (row > 0) existing = sh.getRange(row, 1, 1, 18).getValues()[0];
    }
    if (!existing) {
      sh.appendRow([
        id, payload.tab, payload.category || '', payload.note || '',
        JSON.stringify(photoIds), 'pending',
        '', createdAt, '', '', '',
        JSON.stringify(thumbIds), '', dueAt, '', jsCount,
        customer, folderId
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
    jsCount: jsCount, customer: customer
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
    return { id: id, status: 'pending', pinnedAt: ts };
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
  var spec = changes.photos || [];
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
    var vals = sh.getRange(row, 1, 1, 18).getValues()[0];
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
  requireAdmin_(pin);
  var toTrash = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) throw new Error('Job not found');
    var vals = sh.getRange(row, 1, 1, 13).getValues()[0];
    toTrash = JSON.parse(vals[4] || '[]').concat(JSON.parse(vals[11] || '[]'));
    if (vals[10]) toTrash.push(vals[10]);
    if (vals[12]) toTrash.push(vals[12]);
    sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { ok: true, id: id };
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
      if (st !== 'archived') { snap[vals[i][0]] = st; st = 'archived'; n++; }
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
 * ADMIN ONLY. Clear FINISHED work only: archive Delivery/Postage jobs that
 * are done and Checking jobsheets swiped Got It. Everything unfinished
 * (To Do, Not Seen) is carried forward to the next day.
 */
function resetDone(pin) {
  requireAdmin_(pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, archived: 0, carried: 0 };
    var vals = sh.getRange(2, 1, last - 1, 6).getValues(); // id .. status
    var out = [], snap = {}, archived = 0, carried = 0;
    for (var i = 0; i < vals.length; i++) {
      var tab = vals[i][1], status = vals[i][5];
      if (status !== 'archived') {
        if (status === 'done' || (tab === 'want' && status === 'got')) {
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
  var rows = sh.getRange(2, 1, last - 1, 17).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[1] !== tab || r[5] === 'archived') continue;
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
  var rows = sh.getRange(2, 1, last - 1, 17).getValues();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!jobs.hasOwnProperty(r[1]) || r[5] === 'archived') continue;
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
  } finally {
    lock.releaseLock();
  }
  return { id: id, status: status, doneAt: doneAt, proofPhotoId: proofId, proofThumbId: proofThumbId };
}

/**
 * ADMIN ONLY. Evidence history: search EVERY job ever posted — including
 * archived ones (RESET never deletes records). Matches the query against
 * the note, category, tab and the posted/finished dates ("2026-08-05").
 * Empty query = the 50 most recent jobs. Newest first, capped at 50.
 */
function searchHistory(q, pin) {
  requireAdmin_(pin);
  q = String(q || '').toLowerCase().trim();
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { results: [], total: 0 };
  var rows = sh.getRange(2, 1, last - 1, 18).getValues();
  var out = [];
  for (var i = rows.length - 1; i >= 0; i--) { // newest first
    var r = rows[i];
    if (q) {
      var hay = (String(r[3]) + ' ' + String(r[16]) + ' ' + r[2] + ' ' + r[1] + ' ' +
        dayStr_(r[7]) + ' ' + dayStr_(r[9])).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    out.push(rowToJob_(r));
  }
  return { results: out.slice(0, 50), total: out.length };
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

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

var APP_TITLE = 'ARA MEGA — Kilang App';

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
                    'thumbIds', 'proofThumbId', 'dueAt', 'pinnedAt', 'jsCount']);
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

/** Saves a base64 JPEG to Drive, returns the file id. */
function savePhoto_(base64Data, name) {
  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, 'image/jpeg', name + '.jpg');
  var file = getFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // Workspace domains may block link sharing; images are served through
    // getImagesData anyway, so this is not required.
  }
  return file.getId();
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
    jsCount: Number(r[15]) || 0   // postage: first N photos are Jobsheet, rest Waybill
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
  var id = Utilities.getUuid();
  var photoIds = [], thumbIds = [];
  for (var i = 0; i < payload.photos.length; i++) {
    photoIds.push(savePhoto_(payload.photos[i], payload.tab + '-' + id + '-' + i));
    var t = payload.thumbs && payload.thumbs[i];
    thumbIds.push(t ? savePhoto_(t, payload.tab + '-' + id + '-' + i + '-t') : '');
  }
  var createdAt = new Date().getTime();
  var dueAt = payload.dueAt ? Number(payload.dueAt) : '';
  var jsCount = payload.jsCount ? Number(payload.jsCount) : 0;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    getSheet_().appendRow([
      id, payload.tab, payload.category || '', payload.note || '',
      JSON.stringify(photoIds), 'pending',
      '', createdAt, '', '', '',
      JSON.stringify(thumbIds), '', dueAt, '', jsCount
    ]);
  } finally {
    lock.releaseLock();
  }
  return {
    id: id, tab: payload.tab, category: payload.category || '',
    note: payload.note || '', photoIds: photoIds, status: 'pending',
    createdAt: createdAt, doneAt: '', proofPhotoId: '',
    thumbIds: thumbIds, proofThumbId: '', dueAt: dueAt, pinnedAt: '',
    jsCount: jsCount
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
  var pId = savePhoto_(fullB64, 'job-' + id + '-' + index);
  var tId = thumbB64 ? savePhoto_(thumbB64, 'job-' + id + '-' + index + '-t') : '';

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
  var newIds = [], newThumbIds = [];
  for (var i = 0; i < spec.length; i++) {
    newIds.push(spec[i].b64 ? savePhoto_(spec[i].b64, 'edit-' + id + '-' + i) : null);
    newThumbIds.push(spec[i].b64 && spec[i].thumb ? savePhoto_(spec[i].thumb, 'edit-' + id + '-' + i + '-t') : null);
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
    var vals = sh.getRange(row, 1, 1, 16).getValues()[0];
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

    vals[2] = changes.category || '';
    vals[3] = changes.note || '';
    vals[4] = JSON.stringify(finalIds);
    vals[11] = JSON.stringify(finalThumbs);
    vals[13] = dueAt;
    vals[15] = jsCount;
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
    var range = sh.getRange(2, 6, last - 1, 1); // status column
    var vals = range.getValues();
    var n = 0;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] !== 'archived') { vals[i][0] = 'archived'; n++; }
    }
    range.setValues(vals);
    return { ok: true, archived: n };
  } finally {
    lock.releaseLock();
  }
}

/** All non-archived jobs for one tab, newest first. */
function getJobs(tab) {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 16).getValues();
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
  var jobs = { want: [], delivery: [], postage: [] };
  var counts = { want: 0, delivery: 0, postage: 0 };
  if (last < 2) return { jobs: jobs, counts: counts };
  var rows = sh.getRange(2, 1, last - 1, 16).getValues();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!jobs.hasOwnProperty(r[1]) || r[5] === 'archived') continue;
    var j = rowToJob_(r);
    jobs[r[1]].push(j);
    if (j.status === 'pending') counts[r[1]]++;
  }
  jobs.want.reverse(); jobs.delivery.reverse(); jobs.postage.reverse();
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
  var proofId = proofBase64 ? savePhoto_(proofBase64, 'proof-' + id) : '';
  var proofThumbId = proofThumbBase64 ? savePhoto_(proofThumbBase64, 'proof-' + id + '-t') : '';
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

/** Badge counts for the bottom navigation (pending items per tab). */
function getCounts() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  var counts = { want: 0, delivery: 0, postage: 0 };
  if (last < 2) return counts;
  var rows = sh.getRange(2, 2, last - 1, 5).getValues(); // tab .. status
  for (var i = 0; i < rows.length; i++) {
    var tab = rows[i][0], status = rows[i][4];
    if (status === 'pending' && counts.hasOwnProperty(tab)) counts[tab]++;
  }
  return counts;
}

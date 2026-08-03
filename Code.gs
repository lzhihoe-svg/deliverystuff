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
 *  - Mutations return small objects (not the whole job list) so the phone
 *    never waits for a full re-read of the sheet.
 *  - Slow Drive work (saving/trashing photos) happens OUTSIDE the script lock
 *    so parallel users never queue behind each other.
 */

var APP_TITLE = 'Kilang App';

/**
 * ADMIN PIN — CHANGE THIS before you deploy!
 * Admins (with the PIN) can edit, delete and hide jobs. Staff cannot.
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
                    'createdBy', 'createdAt', 'doneBy', 'doneAt', 'proofPhotoId']);
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

/** Saves a base64 JPEG to Drive, makes it viewable by link, returns the file id. */
function savePhoto_(base64Data, name) {
  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, 'image/jpeg', name + '.jpg');
  var file = getFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // Some Google Workspace domains block link sharing; photos will still work
    // for anyone signed in to an account that can see the folder.
  }
  return file.getId();
}

function trashFile_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
}

/**
 * Serves image bytes through the app as data URIs.
 * This is how every device sees the photos: it does NOT depend on Drive
 * link-sharing, which Google Workspace domains often block (that's why
 * photos used to appear only on the uploader's own device).
 * Max 6 images per call; the page requests them in batches.
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
    createdAt: r[7], doneAt: r[9], proofPhotoId: r[10]
  };
}

// ---------------------------------------------------------------- API called from the page

/**
 * Add a job. Returns the created job object.
 * payload = { tab: 'want'|'delivery'|'postage',
 *             category: ''|'lalamove'|'bus'|'pickup',
 *             note: string,
 *             photos: [base64jpeg, ...] }   // 1 photo for want/delivery, 2 for postage
 */
function addJob(payload) {
  if (!payload || !payload.photos || !payload.photos.length) {
    throw new Error('Photo required / Gambar diperlukan');
  }
  var id = Utilities.getUuid();
  var photoIds = [];
  for (var i = 0; i < payload.photos.length; i++) {
    photoIds.push(savePhoto_(payload.photos[i], payload.tab + '-' + id + '-' + i));
  }
  var createdAt = new Date().getTime();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    getSheet_().appendRow([
      id, payload.tab, payload.category || '', payload.note || '',
      JSON.stringify(photoIds), 'pending',
      '', createdAt, '', '', ''
    ]);
  } finally {
    lock.releaseLock();
  }
  return {
    id: id, tab: payload.tab, category: payload.category || '',
    note: payload.note || '', photoIds: photoIds, status: 'pending',
    createdAt: createdAt, doneAt: '', proofPhotoId: ''
  };
}

/**
 * Edit a job's note / category / photos. ADMIN ONLY (needs the PIN).
 * Returns the updated job object.
 * changes = { note, category, photo1: base64|null, photo2: base64|null }
 * A null photo means "keep the existing one".
 */
function editJob(id, changes, pin) {
  requireAdmin_(pin);
  // Save new photos BEFORE taking the lock (Drive is the slow part).
  var newP1 = changes.photo1 ? savePhoto_(changes.photo1, 'edit-' + id + '-0') : null;
  var newP2 = changes.photo2 ? savePhoto_(changes.photo2, 'edit-' + id + '-1') : null;

  var toTrash = [];
  var job;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(newP1); trashFile_(newP2);
      throw new Error('Job not found');
    }
    var vals = sh.getRange(row, 1, 1, 11).getValues()[0];
    var photoIds = JSON.parse(vals[4] || '[]');
    if (newP1) { if (photoIds[0]) toTrash.push(photoIds[0]); photoIds[0] = newP1; }
    if (newP2) { if (photoIds[1]) toTrash.push(photoIds[1]); photoIds[1] = newP2; }

    sh.getRange(row, 3, 1, 3).setValues([[changes.category || '', changes.note || '', JSON.stringify(photoIds)]]);

    vals[2] = changes.category || '';
    vals[3] = changes.note || '';
    vals[4] = JSON.stringify(photoIds);
    job = rowToJob_(vals);
  } finally {
    lock.releaseLock();
  }
  // Trash replaced photos AFTER releasing the lock.
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
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
    var vals = sh.getRange(row, 1, 1, 11).getValues()[0];
    toTrash = JSON.parse(vals[4] || '[]');
    if (vals[10]) toTrash.push(vals[10]);
    sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  // Slow Drive trashing happens after the row is already gone.
  for (var i = 0; i < toTrash.length; i++) trashFile_(toTrash[i]);
  return { ok: true, id: id };
}

/** All non-archived jobs for one tab, newest first. */
function getJobs(tab) {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 11).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[1] !== tab || r[5] === 'archived') continue;
    out.push(rowToJob_(r));
  }
  out.reverse();
  return out;
}

/**
 * Update a job's status. Returns { id, status, doneAt, proofPhotoId }.
 * Tab 1 (want)            : status 'got' (❤️) or 'notseen' (❌) — no photo needed.
 * Tab 2/3 (delivery/post) : status 'done' — proofBase64 photo REQUIRED.
 * Any tab                 : status 'archived' — ADMIN ONLY (hides the job, keeps the record).
 */
function updateStatus(id, status, proofBase64, pin) {
  var allowed = { got: 1, notseen: 1, done: 1, archived: 1 };
  if (!allowed[status]) throw new Error('Bad status');
  if (status === 'archived') requireAdmin_(pin);
  if (status === 'done' && !proofBase64) {
    throw new Error('Proof photo required / Gambar bukti diperlukan');
  }
  // Save the proof photo BEFORE taking the lock (Drive is the slow part).
  var proofId = proofBase64 ? savePhoto_(proofBase64, 'proof-' + id) : '';
  var doneAt = new Date().getTime();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var row = findRow_(sh, id);
    if (row < 0) {
      trashFile_(proofId);
      throw new Error('Job not found');
    }
    sh.getRange(row, 6).setValue(status);
    if (status !== 'archived') {
      sh.getRange(row, 10).setValue(doneAt);
      if (proofId) sh.getRange(row, 11).setValue(proofId);
    }
  } finally {
    lock.releaseLock();
  }
  return { id: id, status: status, doneAt: doneAt, proofPhotoId: proofId };
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

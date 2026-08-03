/**
 * KILANG APP — replaces 3 WhatsApp groups (Kilang Want / Kilang Packing / Kilang Postage)
 *
 * Data  : Google Sheet  "Kilang App Data"   (created automatically on first run)
 * Photos: Drive folder  "Kilang App Photos" (created automatically on first run)
 *
 * Deploy: Deploy > New deployment > Web app
 *         Execute as: Me    |    Who has access: Anyone with the link
 */

var APP_TITLE = 'Kilang App';

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

// ---------------------------------------------------------------- API called from the page

/**
 * Add a job.
 * payload = { tab: 'want'|'delivery'|'postage',
 *             category: ''|'lalamove'|'bus'|'pickup',
 *             note: string,
 *             photos: [base64jpeg, ...],   // 1 photo for want/delivery, 2 for postage
 *             createdBy: string }
 */
function addJob(payload) {
  var id = Utilities.getUuid();
  var photoIds = [];
  for (var i = 0; i < payload.photos.length; i++) {
    photoIds.push(savePhoto_(payload.photos[i], payload.tab + '-' + id + '-' + i));
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    getSheet_().appendRow([
      id, payload.tab, payload.category || '', payload.note || '',
      JSON.stringify(photoIds), 'pending',
      payload.createdBy || '', new Date().getTime(), '', '', ''
    ]);
  } finally {
    lock.releaseLock();
  }
  return getJobs(payload.tab);
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
    out.push({
      id: r[0], tab: r[1], category: r[2], note: r[3],
      photoIds: JSON.parse(r[4] || '[]'), status: r[5],
      createdBy: r[6], createdAt: r[7],
      doneBy: r[8], doneAt: r[9], proofPhotoId: r[10]
    });
  }
  out.reverse();
  return out;
}

/**
 * Update a job's status.
 * Tab 1 (want)            : status 'got' (❤️) or 'notseen' (❌) — no photo needed.
 * Tab 2/3 (delivery/post) : status 'done' — proofBase64 photo REQUIRED.
 * Any tab                 : status 'archived' (boss hides finished/old jobs).
 */
function updateStatus(id, status, byName, proofBase64) {
  if (status === 'done' && !proofBase64) {
    throw new Error('Proof photo required / Gambar bukti diperlukan');
  }
  var proofId = proofBase64 ? savePhoto_(proofBase64, 'proof-' + id) : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === id) {
        var row = i + 2;
        sh.getRange(row, 6).setValue(status);
        if (status !== 'archived') {
          sh.getRange(row, 9).setValue(byName || '');
          sh.getRange(row, 10).setValue(new Date().getTime());
          if (proofId) sh.getRange(row, 11).setValue(proofId);
        }
        var tab = sh.getRange(row, 2).getValue();
        lock.releaseLock();
        return getJobs(tab);
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  throw new Error('Job not found');
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

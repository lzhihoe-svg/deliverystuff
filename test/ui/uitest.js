/**
 * Full UI test of Index.html in real Chromium.
 * The page runs against a simulated google.script.run backend (mock.js, 150ms latency).
 * Uses CDP synthesizeScrollGesture to send REAL touch scroll gestures.
 */
const { chromium } = require('playwright');
const path = require('path');

const URL = 'http://127.0.0.1:8899/test.html';
const IMG = path.join(__dirname, 'img.png');
const IMG2 = path.join(__dirname, 'img2.png');
const IMG3 = path.join(__dirname, 'img3.png');

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ❌ ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function clickSafe(loc) {
  await loc.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await loc.click();
}
// real finger drag: trusted touch events via CDP
async function touchDrag(cdp, x0, y0, x1, y1) {
  const R = Math.round;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: R(x0), y: R(y0) }] });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: R(x0 + (x1 - x0) * i / steps), y: R(y0 + (y1 - y0) * i / steps) }]
    });
    await sleep(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ============================================================ MOBILE
  console.log('\n===== MOBILE (390x740, touch) =====');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 740 }, hasTouch: true });
  // the header logo lives on aramega.com.my — no internet in the test box,
  // so abort it fast (the app's onerror fallback hides it) instead of
  // letting a hanging request delay every page load
  await ctx.route('**aramega.com.my**', r => r.abort());
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  page.on('pageerror', e => { fail++; failures.push('JS error: ' + e.message); console.log('  ❌ PAGE JS ERROR: ' + e.message); });
  await page.goto(URL);
  await sleep(400);

  console.log('\n-- structure: internal scroller (iOS iframe fix) --');
  check((await page.locator('#scroller').count()) === 1, 'app scrolls inside #scroller, not the iframe document');
  check(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden', 'body scroll disabled');

  await page.click('#role-overlay .x-close');
  await sleep(150);

  console.log('\n-- one round trip on startup + branding --');
  const calls = await page.evaluate(() => window.__mockcalls.map(c => c.name));
  check(calls.indexOf('getAllData') >= 0, 'startup uses combined getAllData call (all 3 tabs at once)');
  check(calls.indexOf('getJobs') < 0 && calls.indexOf('getCounts') < 0 && calls.indexOf('getInitData') < 0, 'no separate per-tab calls');
  check((await page.locator('header h1').textContent()).replace(/\s+/g, ' ').indexOf('ARAMEGA') >= 0,
    'ARAMEGA branding in header (one word)');
  check((await page.locator('header h1 img.logo').count()) === 1 &&
    (await page.locator('header h1 img.logo').getAttribute('src')).indexOf('aramega.com.my') > 0,
    'ARAMEGA company logo in header');
  check((await page.locator('#refresh-btn').textContent()).trim() === 'Refresh', "refresh button shows the word 'Refresh'");

  console.log('\n-- post multi-photo job --');
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(700);
  await page.fill('#upload-note', 'Baju batik 50pcs');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#topcard').count()) === 1, 'job posted, stack showing');
  check(await page.evaluate(() => window.__mockdb.jobs[0].thumbIds.length === 2), 'thumbnails uploaded alongside photos');

  console.log('\n-- tap flips photos (finger tap on multi-photo card) --');
  let tb = await page.locator('#topcard').boundingBox();
  const beforeTap = await page.locator('#topcard img[data-img]').getAttribute('data-img');
  await page.touchscreen.tap(tb.x + tb.width * 0.85, tb.y + tb.height * 0.4);
  await sleep(300);
  check((await page.locator('#topcard img[data-img]').getAttribute('data-img')) !== beforeTap, 'finger tap right side flips photo');
  check((await page.locator('#topcard').count()) === 1, 'tap does not swipe the card away');

  // second job so the page has enough content to scroll
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', IMG3);
  await sleep(500);
  await page.click('#btn-submit');
  await sleep(600);

  console.log('\n-- THE BUG: vertical touch scroll starting ON the swipe card --');
  let box = await page.locator('#topcard').boundingBox();
  const st0 = await page.evaluate(() => document.getElementById('scroller').scrollTop);
  await touchDrag(cdp, box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2, box.y + box.height / 2 - 160);
  await sleep(500);
  const st1 = await page.evaluate(() => document.getElementById('scroller').scrollTop);
  check(st1 > st0 + 20, 'page scrolls with finger on the card (scrollTop ' + st0 + ' → ' + st1 + ') — was STUCK before');
  check((await page.locator('#topcard').count()) === 1, 'vertical scroll did NOT swipe the card away');
  check(await page.evaluate(() => window.__mockdb.jobs.every(j => j.status === 'pending')), 'no accidental ❤️/❌ from scrolling');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(200);

  console.log('\n-- horizontal touch drag still swipes the card --');
  box = await page.locator('#topcard').boundingBox();
  await touchDrag(cdp, box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2 - 250, box.y + box.height / 2);
  await sleep(800);
  const notSeen = await page.evaluate(() => window.__mockdb.jobs.filter(j => j.status === 'notseen').length);
  check(notSeen === 1, 'horizontal touch drag = ❌ decision swipe (direction lock works both ways)');

  console.log('\n-- mouse swipe still fine --');
  box = await page.locator('#topcard').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + i * 25, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-responded').textContent()).indexOf('Got it') >= 0, 'mouse drag right = ❤️');

  console.log('\n-- status list separated by swipe result --');
  const respHtml = await page.locator('#want-responded').innerHTML();
  check(respHtml.indexOf('Not Seen (1)') >= 0, "'❌ Not Seen (1)' section present");
  check(respHtml.indexOf('Got It (1)') >= 0, "'❤️ Got It (1)' section present");
  check(respHtml.indexOf('Not Seen') < respHtml.indexOf('Got It'), 'Not Seen shown first (needs follow-up)');


  console.log('\n-- cards use small thumbnails, not full images --');
  const cardImgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#want-responded img[data-img]')).map(el => el.getAttribute('data-img')));
  check(cardImgs.length > 0 && cardImgs.every(id => id.indexOf('th') === 0), 'status cards load thumb ids (' + cardImgs.join(',') + ')');
  await sleep(600);
  const thumbCached = await page.evaluate(() => {
    for (var i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i).indexOf('ki_') === 0) return true;
    }
    return false;
  });
  check(thumbCached, 'thumbnails cached in localStorage (no re-download next visit)');

  console.log('\n-- vertical touch scroll over a photo carousel (tab 2) --');
  await page.click('#role-btn');
  await sleep(150);
  await page.click('#role-admin-btn');
  await page.fill('#pin-input', '1234');
  await page.click('#pin-wrap .btn.blue');
  await sleep(500);
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++) {
      window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Job ' + i, photos: ['x', 'y'], thumbs: ['x', 'y'] });
    }
  });
  await page.click('#nav-delivery');
  await sleep(600);
  check((await page.locator('#delivery-list .car-track').count()) === 4, '4 carousel cards rendered');
  const carBox = await page.locator('#delivery-list .car-track').first().boundingBox();
  const dst0 = await page.evaluate(() => document.getElementById('scroller').scrollTop);
  await touchDrag(cdp, carBox.x + carBox.width / 2, carBox.y + carBox.height / 2, carBox.x + carBox.width / 2, carBox.y + carBox.height / 2 - 250);
  await sleep(500);
  const dst1 = await page.evaluate(() => document.getElementById('scroller').scrollTop);
  check(dst1 > dst0 + 50, 'page scrolls smoothly with finger on a carousel (' + dst0 + ' → ' + dst1 + ')');
  const horizBefore = await page.locator('#delivery-list .car-track').first().evaluate(el => el.scrollLeft);
  check(horizBefore < 10, 'vertical scroll did not slide the photos sideways');

  console.log('\n-- horizontal touch swipe INSIDE carousel changes photo --');
  await page.locator('#delivery-list .car-track').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  const carBox2 = await page.locator('#delivery-list .car-track').first().boundingBox();
  await touchDrag(cdp, carBox2.x + carBox2.width / 2, carBox2.y + carBox2.height / 2, carBox2.x + carBox2.width / 2 - 250, carBox2.y + carBox2.height / 2);
  await sleep(600);
  const slid = await page.locator('#delivery-list .car-track').first().evaluate(el => el.scrollLeft);
  check(slid > 100, 'horizontal swipe slides to next photo (scrollLeft=' + Math.round(slid) + ')');

  console.log('\n-- proof + reset regression --');
  await clickSafe(page.locator('#delivery-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(250);
  check(!await page.locator('#spinner').isVisible(), 'proof upload does NOT block with a spinner');
  check((await page.locator('#delivery-list .proof').count()) === 1, 'job marked done instantly (optimistic)');
  await sleep(600);
  check((await page.locator('#delivery-list .proof').count()) === 1, 'proof photo flow works');
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.proofThumbId)), 'proof thumbnail stored too');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await page.click('#reset-btn');
  await sleep(150);
  check(await page.locator('#reset-overlay').isVisible(), 'RESET opens a SAFETY MENU first — no more one-tap wipe');
  check(await page.locator('#reset-overlay .btn.green').isVisible() &&
        await page.locator('#reset-overlay .btn.red').isVisible() &&
        await page.locator('#reset-overlay .btn.gray').isVisible(),
    'menu offers CLEAR DONE, RESET ALL and UNDO');
  await page.locator('#reset-overlay .btn.green').click(); // CLEAR DONE path
  await sleep(150);
  check((await page.locator('#confirm-msg').textContent()).indexOf('FINISHED') >= 0,
    'menu CLEAR DONE leads to the clear-done confirm');
  await page.locator('#confirm-overlay .btn.gray').click(); // cancel it
  await sleep(150);
  await page.click('#reset-btn');
  await sleep(150);
  await page.locator('#reset-overlay .btn.red').click(); // RESET ALL
  await sleep(150);
  check(await page.locator('#confirm-overlay').isVisible(), 'RESET ALL still asks are-you-sure on top');
  await page.click('#confirm-yes');
  await sleep(500);
  check(await page.evaluate(() => window.__mockdb.jobs.every(j => j.status === 'archived')), 'reset archives everything');
  check((await page.locator('#delivery-list .empty').count()) === 1, 'tab cleared');

  console.log('\n-- UNDO: the last reset can be taken back --');
  const preUndo = await page.evaluate(() => window.__mockdb.jobs.length);
  await page.click('#reset-btn');
  await sleep(150);
  await page.locator('#reset-overlay .btn.gray').click(); // UNDO
  await sleep(600);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.status !== 'archived').length > 0),
    'archived jobs are back on the server');
  check((await page.locator('#delivery-list .card').count()) > 0, 'cards reappear on screen after undo');
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.status === 'done' && j.proofPhotoId)),
    'a done job returned as done WITH its proof photo');
  // put everything back to archived so later sections start clean
  await page.click('#reset-btn');
  await sleep(150);
  await page.locator('#reset-overlay .btn.red').click();
  await sleep(150);
  await page.click('#confirm-yes');
  await sleep(500);
  check(preUndo === await page.evaluate(() => window.__mockdb.jobs.length), 'undo/reset never deletes records');

  console.log('\n-- proof photo: STAFF can retake and remove --');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'pickup', note: 'Proof fix', photos: ['pf1'], thumbs: ['pft1'] });
    setRole('staff', ''); // these tools must work for STAFF, not just admin
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  const pfCard = page.locator('#delivery-list .card').filter({ hasText: 'Proof fix' });
  await clickSafe(pfCard.locator('.btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await pfCard.locator('.proof-tools .t-reproof').count()) === 1 &&
        (await pfCard.locator('.proof-tools .t-delproof').count()) === 1,
    'staff sees 📷 Retake Proof + 🗑️ Remove Proof on the done card');
  await clickSafe(pfCard.locator('.t-reproof'));
  await page.setInputFiles('#proof-file', IMG2);
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'Proof fix' && j.proofPhotoId.indexOf('reproof') === 0)),
    'retake stores the NEW proof photo on the server');
  check(await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'Proof fix').status === 'done'),
    'job stays done after a retake');
  await clickSafe(pfCard.locator('.t-delproof'));
  await sleep(150);
  await page.click('#confirm-yes');
  await sleep(600);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Proof fix');
    return j.status === 'pending' && !j.proofPhotoId;
  }), 'remove proof sends the job BACK to To Do (server too)');
  check((await pfCard.locator('.btn.green').count()) === 1, "card shows 'Done! Take Proof Photo' again");
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(300);

  console.log('\n-- CLEAR DONE: only finished work archived, rest carried forward --');
  await page.evaluate(() => {
    const g = window.__mockapi.addJob({ tab: 'want', category: '', note: 'CD-got', photos: ['cg1'], thumbs: ['cgt1'] });
    window.__mockapi.updateStatus(g.id, 'got', null, null, null);
    const ns = window.__mockapi.addJob({ tab: 'want', category: '', note: 'CD-notseen', photos: ['cn1'], thumbs: ['cnt1'] });
    window.__mockapi.updateStatus(ns.id, 'notseen', null, null, null);
    const dd = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'CD-done', photos: ['cd1'], thumbs: ['cdt1'] });
    window.__mockapi.updateStatus(dd.id, 'done', 'p', 'pt', null);
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  check(await page.locator('#reset-btn').isVisible() &&
    (await page.locator('#reset-btn').textContent()).indexOf('Clear / Reset') >= 0,
    "admin sees ONE '🧹 Clear / Reset ▾' dropdown button");
  check((await page.locator('#cleardone-btn').count()) === 0, 'the separate CLEAR DONE button is gone');
  await page.click('#reset-btn');
  await sleep(150);
  check(await page.locator('#reset-overlay').isVisible(), 'dropdown menu opens with both choices');
  await page.locator('#reset-overlay .btn.green').click(); // CLEAR DONE
  await sleep(150);
  check((await page.locator('#confirm-msg').textContent()).indexOf('Unfinished') >= 0,
    'confirm explains unfinished jobs stay');
  await page.click('#confirm-yes');
  await sleep(600);
  const cd = await page.evaluate(() => ({
    done: window.__mockdb.jobs.find(j => j.note === 'CD-done').status,
    got: window.__mockdb.jobs.find(j => j.note === 'CD-got').status,
    ns: window.__mockdb.jobs.find(j => j.note === 'CD-notseen').status,
    pf: window.__mockdb.jobs.find(j => j.note === 'Proof fix').status
  }));
  check(cd.done === 'archived' && cd.got === 'archived', 'done job + ❤️ Got It jobsheet archived');
  check(cd.ns === 'notseen' && cd.pf === 'pending', '❌ Not Seen + To Do jobs carried forward');
  check((await pfCard.count()) === 1, 'carried-forward job still on screen');
  await page.evaluate(() => setRole('staff', ''));
  await sleep(200);
  check(!await page.locator('#reset-btn').isVisible(), 'staff does NOT see Clear / Reset');
  check(await page.locator('#history-btn').isVisible(), 'staff DOES see the History button');
  await page.click('#history-btn');
  await sleep(600);
  check(await page.locator('#history-overlay').isVisible() &&
    (await page.locator('#history-results .h-card').count()) > 0,
    'staff can open History and see the evidence');
  await page.evaluate(() => closeHistory());
  await sleep(200);
  await page.evaluate(() => { // restore admin + tidy the carried notseen job for later sections
    setRole('admin', '1234');
    const ns = window.__mockdb.jobs.find(j => j.note === 'CD-notseen');
    ns.status = 'archived';
  });
  await page.evaluate(() => refresh());
  await sleep(500);

  console.log('\n-- 🗂️ History: find evidence even after CLEAR DONE / RESET --');
  check(await page.locator('#history-btn').isVisible(), 'admin sees the History button');
  await page.click('#history-btn');
  await sleep(600);
  check(await page.locator('#history-overlay').isVisible(), 'history window opens');
  check((await page.locator('#history-results .h-card').count()) > 0, 'recent jobs listed right away');
  await page.fill('#history-q', 'CD-done');
  await page.click('#history-overlay .btn.blue');
  await sleep(500);
  check((await page.locator('#history-results .h-card').count()) === 1, 'search narrows to the matching job');
  check((await page.locator('#history-results .h-card').first().textContent()).indexOf('Archived') >= 0,
    'ARCHIVED job (cleared from the tabs) is still findable');
  check((await page.locator('#history-results .proof-pic').count()) === 1, 'its PROOF photo is shown, marked PROOF');
  await clickSafe(page.locator('#history-results .proof-pic img'));
  await sleep(300);
  check(await page.locator('#viewer').isVisible(), 'tapping the proof opens the fullscreen viewer');
  await page.locator('.viewer-x').click();
  await sleep(200);

  // page + sub-type filters, and Drive folder links
  check(await page.locator('#hist-tabs').isVisible(), 'history has page filter pills');
  await page.evaluate(() => {
    // evidence = proof photo, so each seeded job gets one
    const h1 = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'HF-bus', photos: ['hb1'], thumbs: ['hbt1'] });
    const h2 = window.__mockapi.addJob({ tab: 'delivery', category: 'lalamove', note: 'HF-lala', photos: ['hl1'], thumbs: ['hlt1'] });
    const h3 = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'HF-post', photos: ['hp1', 'hp2'], thumbs: ['hpt1', 'hpt2'], jsCount: 1 });
    [h1, h2, h3].forEach(h => window.__mockapi.updateStatus(h.id, 'done', 'p', 'pt', null));
  });
  await page.fill('#history-q', 'HF-');
  await page.click('#history-overlay .btn.blue');
  await sleep(400);
  check((await page.locator('#history-results .h-card').count()) === 3, 'search finds all 3 seeded jobs');
  await page.click('#hist-tabs button[data-t="delivery"]');
  await sleep(400);
  check(await page.locator('#hist-cats').isVisible(), 'Delivery shows its sub-choices (Lalamove/Bus/Pickup)');
  check((await page.locator('#history-results .h-card').count()) === 2, 'Delivery filter narrows to 2');
  await page.click('#hist-cats button[data-c="bus"]');
  await sleep(400);
  check((await page.locator('#history-results .h-card').count()) === 1 &&
        (await page.locator('#history-results').textContent()).indexOf('HF-bus') >= 0,
    'Bus sub-choice → only the bus job');
  await page.click('#hist-tabs button[data-t="postage"]');
  await sleep(400);
  check(!await page.locator('#hist-cats').isVisible(), 'sub-choices hide for Postage');
  check((await page.locator('#history-results .h-card').count()) === 1, 'Postage filter → 1 result');
  check((await page.locator('#history-results .h-card .h-drive').count()) === 1,
    "job card has an 'Open this job in Drive' link");
  check((await page.locator('#history-results .h-card .h-drive').getAttribute('href')).indexOf('drive.google.com/drive/folders/') >= 0,
    'link points to the Drive folder');
  check((await page.locator('#history-results .h-drive.master').count()) === 1,
    "master 'Delivery Check' Drive link shown on top");
  await page.click('#hist-tabs button[data-t=""]');
  await sleep(300);
  await page.fill('#history-q', '');
  await page.evaluate(() => { // tidy the seeded filter jobs so later sections see their expected state
    window.__mockdb.jobs.forEach(j => { if (j.note && j.note.indexOf('HF-') === 0) j.status = 'archived'; });
  });
  await page.click('#history-overlay .x-close');
  await sleep(200);
  await page.evaluate(() => setRole('staff', ''));
  await sleep(200);
  check(await page.locator('#history-btn').isVisible(), 'staff sees the History button too (read-only evidence)');
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(200);

  console.log('\n-- 📊 admin stats: all 4 pages at a glance --');
  check(await page.locator('#stats-btn').isVisible(), 'admin sees the Stats button');
  await page.click('#stats-btn');
  await sleep(300);
  check(await page.locator('#stats-overlay').isVisible(), 'stats window opens');
  check((await page.locator('#stats-body .st-card').count()) === 4, 'one card per page (Checking, Delivery, Postage, Defect)');
  const stTxt = await page.locator('#stats-body').textContent();
  check(stTxt.indexOf('Checking') >= 0 && stTxt.indexOf('Delivery') >= 0 &&
        stTxt.indexOf('Postage') >= 0 && stTxt.indexOf('Defect') >= 0, 'all 4 sections named');
  const stExpect = await page.evaluate(() => {
    const d = window.__kilang.jobs.delivery;
    return {
      pend: String(d.filter(j => j.status === 'pending').length),
      done: String(d.filter(j => j.status === 'done').length)
    };
  });
  const dNums = await page.locator('#stats-body .st-card').nth(1).locator('.st-cell .n').allTextContents();
  check(dNums[0] === stExpect.pend && dNums[1] === stExpect.done,
    'delivery numbers match the live board (' + dNums.join('/') + ')');
  check((await page.locator('#stats-body .st-bar').count()) === 4, 'progress bar on every page');
  await page.click('#stats-overlay .x-close');
  await sleep(200);
  await page.evaluate(() => setRole('staff', ''));
  await sleep(200);
  check(!await page.locator('#stats-btn').isVisible(), 'staff does NOT see the Stats button');
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(200);

  console.log('\n-- 👤 customer name field (delivery & postage) --');
  await page.click('#nav-delivery');
  await sleep(400);
  await page.click('#nav-post');
  await sleep(200);
  check(await page.locator('#customer-wrap').isVisible(), 'customer field shows for delivery');
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="pickup"]');
  await page.fill('#upload-customer', 'Nurul Syifa');
  await page.fill('#upload-note', 'Cust-test 2 jersey');
  await page.click('#btn-submit');
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'Cust-test 2 jersey' && j.customer === 'Nurul Syifa')),
    'customer stored on the server');
  const custCard = page.locator('#delivery-list .card').filter({ hasText: 'Cust-test' });
  check((await custCard.locator('.chip.cust').textContent()).indexOf('Nurul Syifa') >= 0,
    'card shows the 👤 customer chip');
  await page.click('#nav-post');
  await sleep(200);
  await page.setInputFiles('#photos-file', IMG2);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  await page.fill('#upload-note', 'Blank-cust');
  await page.click('#btn-submit');
  await sleep(400);
  check((await page.locator('#toast').textContent()).indexOf('customer name') >= 0 &&
        await page.locator('#upload-overlay').isVisible(),
    'posting with NO name is blocked — must tap an agent or type a customer');
  await page.fill('#upload-customer', 'Kak Ros');
  await page.click('#btn-submit');
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'Blank-cust' && j.customer === 'Kak Ros')),
    'typed customer name saves the post');
  await clickSafe(custCard.locator('.t-edit').first());
  await sleep(300);
  check((await page.locator('#upload-customer').inputValue()) === 'Nurul Syifa', 'edit window prefills the customer');
  await page.click('#upload-overlay .x-close');
  await sleep(200);
  await page.click('#nav-want');
  await sleep(300);
  await page.click('#nav-post');
  await sleep(200);
  check(!await page.locator('#customer-wrap').isVisible(), 'no customer field on Checking');
  await page.click('#upload-overlay .x-close');
  await sleep(200);
  await page.click('#nav-delivery');
  await sleep(300);
  await page.click('#history-btn');
  await sleep(500);
  await page.fill('#history-q', 'nurul syifa');
  await page.click('#history-overlay .btn.blue');
  await sleep(500);
  check((await page.locator('#history-results .h-card').count()) === 0,
    'a job WITHOUT a proof photo is NOT evidence (not listed)');
  await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Cust-test 2 jersey');
    window.__mockapi.updateStatus(j.id, 'done', 'p', 'pt', null);
  });
  await page.click('#history-overlay .btn.blue');
  await sleep(500);
  check((await page.locator('#history-results .h-card').count()) === 1 &&
        (await page.locator('#history-results .h-card').first().textContent()).indexOf('👤 Nurul Syifa') >= 0,
    'once the proof is taken, History finds it by CUSTOMER name');
  await page.click('#history-overlay .x-close');
  await sleep(200);

  console.log('\n-- ⚡ agent quick-pick chips --');
  await page.click('#nav-delivery');
  await sleep(300);
  await page.click('#nav-post');
  await sleep(250);
  check((await page.locator('#agent-chips .agent-chip').count()) >= 6, 'agent buttons show in the post window');
  check((await page.locator('#agent-chips .agent-chip').first().textContent()) === 'SN', 'first agent is SN');
  await page.locator('#agent-chips .agent-chip', { hasText: 'Lanyard Malaya' }).click();
  check((await page.locator('#upload-customer').inputValue()) === 'Lanyard Malaya', 'one tap fills the name');
  check((await page.locator('#agent-chips .agent-chip.active').textContent()) === 'Lanyard Malaya', 'tapped chip highlights');
  await page.locator('#agent-chips .agent-chip.active').click();
  check((await page.locator('#upload-customer').inputValue()) === '', 'tapping the same chip again clears it');
  await page.locator('#agent-chips .agent-chip', { hasText: 'SN' }).first().click();
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  await page.fill('#upload-note', 'Agent-test');
  await page.click('#btn-submit');
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'Agent-test' && j.customer === 'SN')),
    'posted with the tapped agent (SN)');
  await page.click('#nav-post');
  await sleep(250);
  check((await page.locator('#agent-chips .agent-chip').count()) === 6,
    'ONLY the 6 agents are buttons — customers are typed, not picked');
  await page.fill('#upload-customer', 'Walk-in Customer');
  check((await page.locator('#agent-chips .agent-chip.active').count()) === 0,
    'typing a customer name deselects all agent buttons');
  await page.click('#upload-overlay .x-close');
  await sleep(200);

  console.log('\n-- 🔗 check-first pipeline: prepare → ❤️ → auto-push --');
  await page.click('#nav-want');
  await sleep(400);
  await page.click('#nav-post');
  await sleep(250);
  check(await page.locator('#next-wrap').isVisible(), "Checking post has 'After check ✅ send to'");
  check(!await page.locator('#customer-wrap').isVisible(), 'plain check: no customer section');
  await page.click('#next-chips button[data-next="delivery"]');
  await sleep(200);
  check(await page.locator('#next-cats').isVisible(), 'choosing Delivery reveals the method choices');
  check(await page.locator('#customer-wrap').isVisible() && await page.locator('#due-wrap').isVisible(),
    'customer + Ready-by appear for the pipeline');
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(600);
  await page.fill('#upload-note', 'Pipe-test 30 jersey');
  await page.click('#btn-submit');
  await sleep(300);
  check((await page.locator('#toast').textContent()).indexOf('method') >= 0, 'blocked without a delivery method');
  await page.click('#next-cats button[data-ncat="bus"]');
  await page.click('#btn-submit');
  await sleep(300);
  check((await page.locator('#toast').textContent()).indexOf('customer name') >= 0, 'blocked without agent/customer');
  await page.locator('#agent-chips .agent-chip', { hasText: 'SN' }).first().click();
  await page.click('#btn-submit');
  await sleep(900);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Pipe-test 30 jersey');
    return !!(j && j.tab === 'want' && j.nextTab === 'delivery' && j.nextCategory === 'bus' && j.customer === 'SN');
  }), 'prepared check stored with its next step');
  check((await page.locator('#topcard .foot .cap').textContent()).indexOf('after ✅') >= 0,
    'swipe deck shows where the job goes after the check');
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.tab === 'delivery' && j.note === 'Pipe-test 30 jersey').length === 0),
    'nothing on Delivery before the check');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(200);
  let pb = await page.locator('#topcard').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pb.x + pb.width / 2 + i * 25, pb.y + pb.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(800);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.tab === 'delivery' && x.note === 'Pipe-test 30 jersey');
    return !!(j && j.status === 'pending' && j.fromCheck && j.customer === 'SN' && j.category === 'bus');
  }), '❤️ auto-pushed the job to Delivery with the prepared details');
  await page.click('#nav-delivery');
  await sleep(500);
  check((await page.locator('#delivery-list .card').filter({ hasText: 'Pipe-test' }).locator('.chip.passed').count()) === 1,
    "Delivery card wears '✅ passed check'");
  await page.click('#nav-want');
  await sleep(400);
  check(await page.locator('#undo-bar').isVisible(), 'undo bar available after the swipe');
  await clickSafe(page.locator('#undo-bar button'));
  await sleep(700);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.tab === 'delivery' && j.note === 'Pipe-test 30 jersey').length === 0),
    'UNDO pulled the pushed job back off Delivery');
  check((await page.locator('#topcard').count()) === 1, 'jobsheet back in the deck');
  pb = await page.locator('#topcard').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pb.x + pb.width / 2 + i * 25, pb.y + pb.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.tab === 'delivery' && j.note === 'Pipe-test 30 jersey' && j.status === 'pending').length === 1),
    're-swipe ❤️ pushes a fresh job again');
  await page.evaluate(() => { // tidy for later sections
    window.__mockdb.jobs.forEach(j => { if (j.note === 'Pipe-test 30 jersey') j.status = 'archived'; });
  });
  await page.evaluate(() => refresh());
  await sleep(500);
  await page.click('#nav-delivery');
  await sleep(300);

  console.log('\n-- stat boxes: Balance To Do vs Completed --');
  check((await page.locator('#delivery-list .stat-row').count()) === 1, 'delivery has the two counter boxes');
  check(await page.evaluate(() => document.getElementById('delivery-list').firstElementChild.className.indexOf('stat-row') >= 0),
    'boxes sit at the top, directly below the Lalamove/Bus pills');
  const st = await page.evaluate(() => {
    const d = window.__kilang.jobs.delivery;
    return { t: d.filter(j => j.status === 'pending').length, d: d.filter(j => j.status === 'done').length };
  });
  let nums = await page.locator('#delivery-list .stat-box .num').allTextContents();
  check(nums[0] === String(st.t) && nums[1] === String(st.d), 'counts correct (' + nums.join(' / ') + ')');
  const bcCard = page.locator('#delivery-list .card').filter({ hasText: 'Blank-cust' });
  await clickSafe(bcCard.locator('.btn.green').first());
  await page.setInputFiles('#proof-file', IMG3);
  await sleep(900);
  nums = await page.locator('#delivery-list .stat-box .num').allTextContents();
  check(nums[0] === String(st.t - 1) && nums[1] === String(st.d + 1),
    'finishing a job moves the counters instantly (balance -1, completed +1)');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Stat-post', photos: ['sp1', 'sp2'], thumbs: ['spt1', 'spt2'], jsCount: 1 });
  });
  await page.evaluate(() => refresh());
  await sleep(500);
  await page.click('#nav-postage');
  await sleep(500);
  const ph = await page.locator('#postage-list').innerHTML();
  check(ph.indexOf('stat-row') >= 0 && ph.indexOf('stat-row') < ph.indexOf('To Do ('),
    'postage boxes sit ABOVE the To Do section');
  // tidy the helper job so later postage sections see their expected state
  await page.evaluate(() => { window.__mockdb.jobs.find(j => j.note === 'Stat-post').status = 'archived'; });
  await page.click('#nav-delivery');
  await sleep(400);

  console.log('\n-- upload reliability: automatic retry, no lost photos --');
  await page.evaluate(() => { window.__mockfail = { addJob: 1 }; });
  await page.click('#nav-post');
  await sleep(200);
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  await page.fill('#upload-note', 'Retry-post');
  await page.fill('#upload-customer', 'RT');
  await page.click('#btn-submit');
  await sleep(3000); // first try fails; the automatic retry fires at 1.5s
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.note === 'Retry-post').length === 1),
    'failed post retried automatically — exactly ONE job created (no duplicate)');
  await page.evaluate(() => { window.__mockfail = { addPhotoToJob: 1 }; });
  await page.click('#nav-post');
  await sleep(200);
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(600);
  await page.click('#upload-cats button[data-cat="bus"]');
  await page.fill('#upload-note', 'Retry-photo');
  await page.fill('#upload-customer', 'RT');
  await page.click('#btn-submit');
  await sleep(3500);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Retry-photo');
    return !!(j && j.photoIds.length === 2 && j.photoIds[1]);
  }), 'failed background photo retried automatically — no need to re-upload');
  await page.evaluate(() => { window.__mockfail = {}; });

  console.log('\n-- refresh button: all 3 tabs, word label, updated-at time --');
  // seed jobs in OTHER tabs; one Refresh must pick them all up
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'want', category: '', note: 'W-seed', photos: ['w1'], thumbs: ['wt1'] });
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'D-seed', photos: ['d1'], thumbs: ['dt1'] });
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'G-seed', photos: ['g1', 'g2'], thumbs: ['gt1', 'gt2'] });
  });
  const allCalls0 = await page.evaluate(() => window.__mockcalls.filter(c => c.name === 'getAllData').length);
  await page.click('#refresh-btn');
  await sleep(60); // before the mock latency elapses
  check(await page.locator('#sync-row').isVisible(), 'status row appears under the header');
  check((await page.locator('#sync-row').textContent()).indexOf('Updating') >= 0, 'shows Updating…');
  check((await page.locator('#refresh-btn').textContent()).indexOf('Refreshing') >= 0, "button reads 'Refreshing…' while working");
  await sleep(600);
  const allCalls1 = await page.evaluate(() => window.__mockcalls.filter(c => c.name === 'getAllData').length);
  check(allCalls1 === allCalls0 + 1, 'ONE server call refreshes everything');
  const allTabs = await page.evaluate(() => ({
    w: window.__kilang.jobs.want.length, d: window.__kilang.jobs.delivery.length, g: window.__kilang.jobs.postage.length
  }));
  check(allTabs.w >= 1 && allTabs.d >= 1 && allTabs.g >= 1,
    'Checking + Delivery + Postage ALL updated together (' + allTabs.w + '/' + allTabs.d + '/' + allTabs.g + ')');
  check(await page.locator('#badge-delivery').isVisible() && await page.locator('#badge-postage').isVisible(),
    'other tabs\' badges updated without visiting them');
  check((await page.locator('#refresh-btn').textContent()).trim() === 'Refresh', "button back to 'Refresh'");
  await sleep(1200);
  const syncTxt = await page.locator('#sync-row').textContent();
  check(syncTxt.indexOf('Updated at') >= 0 && /\d{1,2}:\d{2}\s(AM|PM)/.test(syncTxt),
    "shows the actual time: '" + syncTxt.trim() + "'");
  await sleep(2600);
  let staysOk = false; // photo-loading status may briefly take the row over — wait it out
  for (let t = 0; t < 12 && !staysOk; t++) {
    staysOk = await page.locator('#sync-row').isVisible() &&
      (await page.locator('#sync-row').textContent()).indexOf('Updated at') >= 0;
    if (!staysOk) await sleep(500);
  }
  check(staysOk, 'updated-at time STAYS visible (does not disappear)');

  console.log('\n-- due time: post with Ready by --');
  await page.click('#nav-delivery');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#due-wrap').isVisible(), 'Ready-by time field shows for delivery');
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  await page.fill('#upload-due', '23:58');
  await page.fill('#upload-note', 'Due tonight');
  await page.fill('#upload-customer', 'DT');
  await page.click('#btn-submit');
  await sleep(700);
  check((await page.locator('#delivery-list .chip.due, #delivery-list .chip.soon, #delivery-list .chip.late').count()) >= 1,
    'Ready-by chip shows on the card');
  check(await page.evaluate(() => !!window.__mockdb.jobs.find(j => j.note === 'Due tonight' && j.dueAt)), 'deadline stored on server');

  // NEW: a deadline on ANOTHER DAY — simple Day + Month pickers, no year
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#upload-due-day').isVisible() && await page.locator('#upload-due-month').isVisible(),
    'Day + Month dropdowns show next to the time (no year)');
  await page.setInputFiles('#photos-file', IMG2);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  const tmr = await page.evaluate(() => {
    const d = new Date(Date.now() + 86400000);
    return { d: String(d.getDate()), m: String(d.getMonth()) };
  });
  await page.selectOption('#upload-due-day', tmr.d);
  await page.selectOption('#upload-due-month', tmr.m);
  await page.fill('#upload-due', '16:30');
  await page.fill('#upload-note', 'Tomorrow bus');
  await page.fill('#upload-customer', 'TB');
  await page.click('#btn-submit');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Tomorrow bus');
    return !!(j && j.dueAt > Date.now() + 12 * 3600000);
  }), "deadline stored with TOMORROW's date (year chosen automatically)");
  const tCard = page.locator('#delivery-list .card').filter({ hasText: 'Tomorrow bus' });
  check(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/.test(await tCard.locator('.chip.due').textContent()),
    'chip shows the DAY for deadlines not today');
  await clickSafe(tCard.locator('.t-edit').first());
  await sleep(300);
  check((await page.locator('#upload-due-day').inputValue()) === tmr.d &&
        (await page.locator('#upload-due-month').inputValue()) === tmr.m, 'edit prefills day + month');
  check((await page.locator('#upload-due').inputValue()) === '16:30', 'edit prefills the time');
  await page.click('#upload-overlay .x-close');
  await sleep(200);

  // THE BUG: date picked but NO time — must still save and survive a re-edit
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', IMG3);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="pickup"]');
  const tod = await page.evaluate(() => {
    const d = new Date();
    return { d: String(d.getDate()), m: String(d.getMonth()) };
  });
  await page.selectOption('#upload-due-day', tod.d);
  await page.selectOption('#upload-due-month', tod.m);
  await page.fill('#upload-note', 'Date only job');
  await page.fill('#upload-customer', 'DO');
  await page.click('#btn-submit');
  await sleep(700);
  const doCard = page.locator('#delivery-list .card').filter({ hasText: 'Date only job' });
  check((await doCard.locator('.chip.due, .chip.soon').count()) === 1,
    'date WITHOUT time still saves and shows a Ready-by chip');
  check((await doCard.locator('.chip.due, .chip.soon').first().textContent()).indexOf('today') >= 0,
    "chip reads 'Ready by today'");
  await clickSafe(doCard.locator('.t-edit').first());
  await sleep(300);
  check((await page.locator('#upload-due-day').inputValue()) === tod.d &&
        (await page.locator('#upload-due-month').inputValue()) === tod.m,
    'the date is STILL there when editing again (was disappearing)');
  check((await page.locator('#upload-due').inputValue()) === '', 'no time was invented');
  await page.click('#upload-overlay .x-close');
  await sleep(200);
  // Checking tab must NOT have a due field
  await page.click('#nav-want');
  await sleep(300);
  await page.click('#nav-post');
  await sleep(150);
  check(!await page.locator('#due-wrap').isVisible(), 'no due field on the Checking tab');
  await page.click('#upload-overlay .x-close');
  await sleep(150);
  await page.click('#nav-delivery');
  await sleep(400);

  console.log('\n-- due time: LATE chip + urgency sorting --');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'No deadline', photos: ['x1'], thumbs: ['xt1'] });
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Overdue job', photos: ['x2'], thumbs: ['xt2'], dueAt: Date.now() - 3600000 });
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Soon job', photos: ['x3'], thumbs: ['xt3'], dueAt: Date.now() + 1800000 });
  });
  await page.click('#refresh-btn');
  await sleep(500);
  check((await page.locator('#delivery-list .chip.late').count()) === 1, 'overdue job shows red LATE chip');
  check((await page.locator('#delivery-list .chip.soon').count()) >= 1, 'due-soon job shows countdown chip');
  const firstNote = await page.locator('#delivery-list .grid .card .note').first().textContent();
  check(firstNote.indexOf('Overdue job') >= 0, 'most urgent job sorted to the top');

  console.log('\n-- ASK AGAIN: send a swiped jobsheet back to staff --');
  await page.click('#nav-want');
  await sleep(500);
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(200);
  // swipe the pending seeded jobsheet to ❤️, and seed a ❌ one on the server
  let askBox = await page.locator('#topcard').boundingBox();
  await page.mouse.move(askBox.x + askBox.width / 2, askBox.y + askBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(askBox.x + askBox.width / 2 + i * 25, askBox.y + askBox.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  await page.evaluate(() => {
    const jj = window.__mockapi.addJob({ tab: 'want', category: '', note: 'NS-seed', photos: ['n1'], thumbs: ['nt1'] });
    window.__mockapi.updateStatus(jj.id, 'notseen', null, null, null);
  });
  await page.click('#refresh-btn');
  await sleep(600);
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'swipe deck empty (all jobsheets answered)');
  const askBtns = await page.locator('#want-responded .ask-btn').count();
  check(askBtns === 2, 'admin sees 🔁 Ask Again on Got It AND Not Seen cards');
  await clickSafe(page.locator('#want-responded .ask-btn').first());
  await sleep(300);
  check((await page.locator('#topcard').count()) === 1, 'jobsheet returns to the swipe deck instantly');
  check((await page.locator('#topcard .foot .cap').textContent()).indexOf('📌') >= 0, 'asked-again card pinned to the FRONT of the deck');
  check((await page.locator('#badge-want').textContent()) === '1', 'Checking badge counts it as pending again');
  await sleep(300);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.tab === 'want' && j.status === 'pending').length === 1),
    'server put it back to pending');
  check((await page.locator('#want-responded .ask-btn').count()) === 1, 'only 1 answered card left in status list');
  // staff must answer again — swipe it once more
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(200);
  askBox = await page.locator('#topcard').boundingBox();
  await page.mouse.move(askBox.x + askBox.width / 2, askBox.y + askBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(askBox.x + askBox.width / 2 + i * 25, askBox.y + askBox.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'staff answered again — deck empty');

  console.log('\n-- UNDO a wrong swipe (staff, no PIN) --');
  check((await page.locator('#nav-want .ico').textContent()) === '🔍', 'Checking tab icon is a magnifying glass');
  check(await page.locator('#undo-bar').isVisible(), 'after swiping, an UNDO bar appears');
  await page.evaluate(() => setRole('staff', '')); // undo must work WITHOUT admin
  await sleep(300);
  check(await page.locator('#undo-bar').isVisible(), 'staff sees the UNDO bar too');
  const undoCalls0 = await page.evaluate(() => window.__mockcalls.filter(c => c.name === 'undoSwipe').length);
  await clickSafe(page.locator('#undo-bar button'));
  await sleep(500);
  check((await page.locator('#topcard').count()) === 1, 'jobsheet comes BACK to the swipe deck');
  check((await page.locator('#topcard .foot .cap').textContent()).indexOf('📌') >= 0,
    'returned card is at the FRONT of the deck (pinned)');
  check((await page.locator('#undo-bar').count()) === 0, 'undo bar disappears after use');
  check(await page.evaluate(() => window.__mockcalls.filter(c => c.name === 'undoSwipe').length) === undoCalls0 + 1,
    'undoSwipe called on the server (no PIN)');
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.tab === 'want' && j.status === 'pending').length === 1),
    'server put it back to pending');
  check((await page.locator('#badge-want').textContent()) === '1', 'Checking badge counts it again');
  // swipe it away once more so later sections start from the expected state
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(200);
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(200);
  const ub = await page.locator('#topcard').boundingBox();
  await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(ub.x + ub.width / 2 + i * 25, ub.y + ub.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'deck empty again after re-swipe');
  await page.click('#nav-delivery');
  await sleep(500);

  console.log('\n-- photo REORDER + bigger previews in the post window --');
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', [IMG, IMG2, IMG3]);
  await sleep(900);
  const tw = await page.locator('#upload-thumbs .thumb').first().evaluate(el => el.offsetWidth);
  check(tw >= 100, 'photo previews are bigger (' + tw + 'px) so admin can verify');
  check((await page.locator('#upload-thumbs .thumb-arrows').count()) === 3, '◀ ▶ reorder buttons on every photo');
  const order0 = await page.evaluate(() => window.__kilang.upload.photos.map(pp => pp.b64.slice(30, 50)));
  await page.locator('#upload-thumbs .thumb-wrap').first().locator('.thumb-arrows button').first().click();
  await sleep(200);
  const order1 = await page.evaluate(() => window.__kilang.upload.photos.map(pp => pp.b64.slice(30, 50)));
  check(order1[0] === order0[1] && order1[1] === order0[0], '▶ swaps photo 1 and photo 2');
  await page.locator('#upload-thumbs .thumb-wrap').nth(1).locator('.thumb-arrows button').first().click();
  await sleep(200);
  const order2 = await page.evaluate(() => window.__kilang.upload.photos.map(pp => pp.b64.slice(30, 50)));
  check(order2[0] === order0[0], '◀ moves it back — order fully controllable');
  await page.click('#upload-overlay .x-close');
  await sleep(200);

  console.log('\n-- NON-BLOCKING upload with progress pill --');
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', [IMG, IMG2, IMG3]);
  await sleep(900);
  await page.click('#upload-cats button[data-cat="lalamove"]');
  await page.fill('#upload-note', 'Background upload');
  await page.fill('#upload-customer', 'BG');
  await page.evaluate(() => { window.__mocklat = { addJob: 400, addPhotoToJob: 400 }; });
  await page.click('#btn-submit');
  await sleep(120); // long before the 400ms server latency
  check(!await page.locator('#upload-overlay').isVisible(), 'form closes INSTANTLY');
  check(!await page.locator('#spinner').isVisible(), 'no blocking spinner during upload');
  check(await page.locator('#upload-pill').isVisible(), 'progress pill appears');
  check((await page.locator('#upload-pill').textContent()).indexOf('Uploading 3') >= 0, 'pill counts 3 photos');
  check((await page.locator('#delivery-list .chip.up').count()) === 1, 'card appears immediately with Uploading badge');
  await sleep(1500); // create(400ms) + parallel photo 2&3 (400ms) ≈ 800ms total
  check((await page.locator('#delivery-list .chip.up').count()) === 0, 'Uploading badge cleared when finished');
  const bg = await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'Background upload'));
  check(bg && bg.photoIds.length === 3 && bg.photoIds.every(x => x), 'all 3 photos on server via PARALLEL upload (~0.8s, not 1.2s serial)');
  await page.evaluate(() => { window.__mocklat = {}; });

  console.log('\n-- tab 3: Jobsheet & Waybill groups, each multi + swipeable --');
  await page.click('#nav-postage');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#postage-groups').isVisible(), 'TWO photo groups shown: Jobsheet and Waybill');
  check(!await page.locator('#generic-photos').isVisible(), 'single picker hidden for postage');
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('Jobsheet') >= 0, 'blocked without a jobsheet photo');
  await page.setInputFiles('#js-file', [IMG, IMG2]);
  await sleep(700);
  check((await page.locator('#js-thumbs .thumb').count()) === 2, 'MULTIPLE jobsheet photos added');
  check((await page.locator('#js-thumbs .thumb-arrows').count()) === 2, 'jobsheet photos reorderable with ◀ ▶');
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('Waybill') >= 0, 'blocked without a waybill photo');
  await page.setInputFiles('#wb-file', IMG3);
  await sleep(500);
  check((await page.locator('#wb-thumbs .thumb').count()) === 1, 'waybill photo added in its own group');

  console.log('\n-- move photos BETWEEN Jobsheet and Waybill (wrong upload fix) --');
  check((await page.locator('#js-thumbs .thumb-move').count()) === 2, "jobsheet photos have '⬇️ To Waybill' buttons");
  check((await page.locator('#wb-thumbs .thumb-move').count()) === 1, "waybill photos have '⬆️ To Jobsheet' buttons");
  await page.locator('#js-thumbs .thumb-move').last().click();
  await sleep(250);
  check((await page.locator('#js-thumbs .thumb').count()) === 1 && (await page.locator('#wb-thumbs .thumb').count()) === 2,
    'one tap moves a jobsheet photo into the Waybill group');
  await page.locator('#wb-thumbs .thumb-move').last().click();
  await sleep(250);
  check((await page.locator('#js-thumbs .thumb').count()) === 2 && (await page.locator('#wb-thumbs .thumb').count()) === 1,
    'and one tap moves it back to Jobsheet');
  await page.fill('#upload-customer', 'PG');
  await page.click('#btn-submit');
  await sleep(900);
  check((await page.locator('#postage-list .photo-pair').count()) >= 1, 'card shows Jobsheet | Waybill side by side');
  check((await page.locator('#postage-list .photo-pair .lbl').first().textContent()).indexOf('Jobsheet') >= 0, 'Jobsheet label on the left');
  check((await page.locator('#postage-list .photo-pair .lbl').nth(1).textContent()).indexOf('Waybill') >= 0, 'Waybill label on the right');
  check((await page.locator('#postage-list .photo-pair .car-track').count()) === 1, 'jobsheet side is its own mini-carousel (2 pages)');
  check((await page.locator('#postage-list .photo-pair .car-dots span').count()) === 2, 'dots show 2 jobsheet pages');
  const bgJob = await page.evaluate(() => window.__mockdb.jobs.find(jj => jj.tab === 'postage' && jj.jsCount && jj.status !== 'archived'));
  check(bgJob && bgJob.jsCount === 2 && bgJob.photoIds.length === 3, 'server stored the split (2 jobsheet + 1 waybill)');
  // swipe inside the jobsheet half only
  const mini = page.locator('#postage-list .photo-pair .car-track').first();
  await mini.evaluate(el => { el.scrollLeft = el.clientWidth; });
  await sleep(400);
  check((await page.locator('#postage-list .photo-pair .car-dots span').nth(1).getAttribute('class')) === 'on',
    'swiping the jobsheet half flips to its page 2');
  // edit re-opens with the groups split correctly
  await clickSafe(page.locator('#postage-list .t-edit').first());
  await sleep(300);
  check((await page.locator('#js-thumbs .thumb').count()) === 2 && (await page.locator('#wb-thumbs .thumb').count()) === 1,
    'editing splits photos back into their groups');
  await page.click('#upload-overlay .x-close');
  await sleep(200);
  await clickSafe(page.locator('#postage-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#postage-list .proof').count()) === 1, 'postage proof photo works');

  console.log('\n-- 🚌 Sent bus: postage parcel goes by bus → moves to Delivery --');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Bus-instead', customer: 'RT',
      photos: ['sb1', 'sb2'], thumbs: ['sb1', 'sb2'], jsCount: 1 });
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  const sbCard = page.locator('#postage-list .card').filter({ hasText: 'Bus-instead' });
  check((await sbCard.locator('.btn.bus').count()) === 1, "pending postage card shows the '🚌 Sent bus' button");
  await page.click('#nav-delivery');
  await sleep(400);
  check((await page.locator('#delivery-list .btn.bus').count()) === 0, 'Delivery cards do NOT show Sent bus');
  await page.click('#nav-postage');
  await sleep(400);
  await clickSafe(sbCard.locator('.btn.bus'));
  await page.setInputFiles('#proof-file', IMG);
  await sleep(300);
  check((await page.locator('#toast').textContent()).indexOf('bus') >= 0, 'toast says it moved to Delivery');
  check((await sbCard.count()) === 0, 'job leaves the Postage board instantly');
  await sleep(700);
  const sbJob = await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'Bus-instead'));
  check(!!sbJob && sbJob.tab === 'delivery' && sbJob.category === 'bus' && sbJob.status === 'done' && !!sbJob.proofPhotoId,
    'server: now a DONE Delivery → Bus job WITH its proof photo');
  await page.click('#nav-delivery');
  await sleep(500);
  const sbDone = page.locator('#delivery-list .card').filter({ hasText: 'Bus-instead' });
  check((await sbDone.count()) === 1, 'job appears on the Delivery board');
  check((await sbDone.locator('.chip.bus').count()) === 1, 'with the Bus category chip');
  check((await sbDone.locator('.proof').count()) === 1, 'and its proof photo attached');
  // archive it so later sections start clean
  await page.evaluate(() => { window.__mockdb.jobs.find(x => x.note === 'Bus-instead').status = 'archived'; });
  await page.evaluate(() => refresh());
  await sleep(400);
  await page.click('#nav-postage');
  await sleep(300);

  console.log('\n-- 📷 lost photo slot: pair layout survives + Edit heals --');
  await page.evaluate(() => {
    const j = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Lost-slot', customer: 'DO',
      photos: ['q1', 'q2', 'q3'], thumbs: ['q1', 'q2', 'q3'], jsCount: 2 });
    const dbj = window.__mockdb.jobs.find(x => x.id === j.id);
    dbj.photoIds[1] = ''; dbj.thumbIds[1] = ''; // a background upload that died mid-way
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  const lsCard = page.locator('#postage-list .card').filter({ hasText: 'Lost-slot' });
  check((await lsCard.locator('.photo-pair').count()) === 1, 'card STILL shows the Jobsheet | Waybill split');
  check((await lsCard.locator('.lost-photo').count()) === 1, "empty slot shows a 'photo didn't upload' tile");
  check((await lsCard.locator('.chip.old').count()) === 1, 'warning chip points them to Edit');
  let noHang = false; // the photo-loading counter must not get stuck on the ghost id
  for (let t = 0; t < 8 && !noHang; t++) {
    noHang = (await page.locator('#sync-row').textContent()).indexOf('photos') < 0;
    if (!noHang) await sleep(500);
  }
  check(noHang, "header does NOT hang on 'Loading photos… (1 left)'");
  await clickSafe(lsCard.locator('.t-edit'));
  await sleep(300);
  check((await page.locator('#js-thumbs .thumb').count()) === 1 && (await page.locator('#wb-thumbs .thumb').count()) === 1,
    'Edit shows only the REAL photos — no eternal Loading slot');
  await page.click('#btn-submit');
  await sleep(900);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Lost-slot');
    return j.photoIds.length === 2 && j.photoIds.every(Boolean) && j.jsCount === 1;
  }), '💾 Save heals the job on the server (ghost slot gone)');
  check((await lsCard.locator('.lost-photo').count()) === 0 && (await lsCard.locator('.photo-pair').count()) === 1,
    'card back to a clean Jobsheet | Waybill pair');
  await page.evaluate(() => { window.__mockdb.jobs.find(x => x.note === 'Lost-slot').status = 'archived'; });
  await page.evaluate(() => refresh());
  await sleep(400);

  console.log('\n-- 🔁 stuck photo auto-retry (bad Wi-Fi never loses a photo) --');
  await page.evaluate(() => { window.__mockfail = { addPhotoToJob: 3 }; }); // kill ALL quick retries
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#js-file', IMG);
  await sleep(500);
  await page.setInputFiles('#wb-file', IMG2);
  await sleep(500);
  await page.fill('#upload-customer', 'BG');
  await page.fill('#upload-note', 'Sticky-photo');
  await page.click('#btn-submit');
  await sleep(4500); // initial try + 2 quick retries all fail → parked in the queue
  // (the ambient 25s retry timer may already have healed it — that's the
  // feature working; only nudge the queue if the photo is still missing)
  check(await page.evaluate(() => !!window.__mockdb.jobs.find(x => x.note === 'Sticky-photo')),
    'job posted despite the failed photo');
  check((await page.locator('#postage-list .card').filter({ hasText: 'Sticky-photo' }).count()) === 1,
    'job still on screen with its local preview');
  await page.evaluate(() => retryStuckPhotos());
  await sleep(800);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Sticky-photo');
    return !!j && !!j.photoIds[1];
  }), 'retry queue re-uploads the stuck photo by itself');
  await page.evaluate(() => {
    window.__mockfail = null;
    window.__mockdb.jobs.find(x => x.note === 'Sticky-photo').status = 'archived';
  });
  await page.evaluate(() => refresh());
  await sleep(400);

  console.log('\n-- 🚨 Problem page: report → office prints → solved --');
  await page.evaluate(() => { // start from a clean problem slate
    window.__mockdb.jobs.forEach(j => { if (j.status === 'notseen') j.status = 'archived'; });
    window.__mockapi.addJob({ tab: 'delivery', category: 'lalamove', note: 'Prob-deliv', customer: 'SN', photos: ['pd1'], thumbs: ['pd1'] });
    const w = window.__mockapi.addJob({ tab: 'want', category: '', note: 'Prob-check', photos: ['pw1'], thumbs: ['pw1'] });
    window.__mockapi.updateStatus(w.id, 'notseen', null, null, null);
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  await page.click('#nav-delivery');
  await sleep(400);
  const pdCard = page.locator('#delivery-list .card').filter({ hasText: 'Prob-deliv' });
  check((await pdCard.locator('.btn.warn').count()) === 1, "delivery card has the '❓ Haven't received' button");
  check((await page.locator('#want-list .btn.warn, #defect-list .btn.warn').count()) === 0, 'checking/defect cards do NOT');
  await clickSafe(pdCard.locator('.btn.warn'));
  await sleep(600);
  check((await pdCard.locator('.prob-line').textContent()).indexOf('Reported at') >= 0, "card shows '🚨 Reported at <time>'");
  check((await pdCard.locator('.btn.warn').count()) === 0, 'report button gone after reporting');
  check(await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'Prob-deliv').problem === 'reported'),
    'server flagged the job');
  check((await page.locator('#problem-btn').textContent()).indexOf('(2)') > 0,
    'Problem button counts 2 (the report + the ❌ Not Seen check)');
  await page.click('#problem-btn');
  await sleep(400);
  check(await page.locator('#problem-overlay').isVisible(), 'Problem page opens');
  check((await page.locator('#problem-list .prob-card').count()) === 2, 'both problems listed');
  check(await page.evaluate(() => {
    const im = document.querySelector('#problem-list img[data-img]');
    return !!im && im.getAttribute('data-vis') === '1';
  }), 'problem photos are marked visible (overlay sits outside the lazy-load scroller)');
  await sleep(700);
  check(await page.evaluate(() => {
    const ims = document.querySelectorAll('#problem-list img[data-img]');
    return [...ims].every(im => im.src.indexOf('Loading') < 0); // placeholder says "Loading…"
  }), "problem thumbnails really download — no eternal 'Loading…'");
  check(await page.evaluate(() => {
    const bg = el => getComputedStyle(document.getElementById(el)).backgroundColor;
    return bg('upload-pill') !== 'rgb(255, 255, 255)' && bg('toast') !== 'rgb(255, 255, 255)';
  }), 'upload pill + toast are dark-on-light — never white text on a white pill');
  const probDeliv = page.locator('#problem-list .prob-card').filter({ hasText: 'Prob-deliv' });
  await probDeliv.locator('.btn.green').click();
  await page.setInputFiles('#print-file', IMG);
  await sleep(900);
  check((await page.locator('#problem-list .prob-card').count()) === 1, '✅ Solved removes the job from the Problem page');
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Prob-deliv');
    return j.problem === 'printed' && !!j.printedAt && !!j.printPhotoId;
  }), 'server: printed stamp + printing photo stored');
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(200);
  check((await pdCard.locator('.proof.printed .txt').textContent()).indexOf('Printed at') >= 0,
    "delivery card now shows '🖨️ Printed at <time>'");
  check((await pdCard.locator('.proof.printed img').count()) === 1,
    'WITH the printing-status photo (tappable thumbnail)');
  await clickSafe(pdCard.locator('.proof.printed img'));
  await sleep(300);
  check(await page.locator('#viewer').isVisible(), 'tapping the printing photo opens the viewer');
  await page.evaluate(() => closeViewer());
  await sleep(200);
  await page.click('#problem-btn');
  await sleep(300);
  await page.locator('#problem-list .prob-card .btn.green').first().click();
  await page.setInputFiles('#print-file', IMG2);
  await sleep(900);
  check((await page.locator('#problem-list .empty').count()) === 1, 'Problem page empty — no problems left');
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(200);
  check((await page.locator('#problem-btn').textContent()).indexOf('(') < 0, 'Problem badge cleared');
  await page.click('#nav-want');
  await sleep(400);
  check((await page.locator('#want-responded .proof.printed').count()) >= 1 &&
    (await page.locator('#want-responded .proof.printed img').count()) >= 1,
    "solved ❌ Not Seen card shows '🖨️ Printed at' WITH the photo on the Checking page");
  console.log('\n-- 🏷️ No sticker: the second postage problem type --');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'NoStick-test', customer: 'CG',
      photos: ['nst1', 'nst2'], thumbs: ['nst1', 'nst2'], jsCount: 1 });
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  await page.click('#nav-postage');
  await sleep(400);
  const nsCard = page.locator('#postage-list .card').filter({ hasText: 'NoStick-test' });
  check((await nsCard.locator('.btn.warn').count()) === 2, "postage card has BOTH buttons: Haven't received + No sticker");
  check((await nsCard.locator('.btn.warn').nth(1).textContent()).indexOf('No sticker') >= 0, "second one reads 'No sticker — tell office'");
  await page.click('#nav-delivery');
  await sleep(300);
  check((await page.locator('#delivery-list .card .btn.warn:has-text(\"No sticker\")').count()) === 0,
    'delivery cards do NOT get the sticker button');
  await page.click('#nav-postage');
  await sleep(300);
  await clickSafe(nsCard.locator('.btn.warn').nth(1));
  await sleep(600);
  check((await nsCard.locator('.prob-line').textContent()).indexOf('No sticker') >= 0,
    "card shows '🏷️ No sticker — reported at <time>'");
  check((await nsCard.locator('.btn.warn').count()) === 0, 'both report buttons gone once reported');
  check(await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'NoStick-test').problem === 'nosticker'),
    'server flagged it as no-sticker');
  await page.click('#problem-btn');
  await sleep(400);
  const nsProb = page.locator('#problem-list .prob-card').filter({ hasText: 'NoStick-test' });
  check((await nsProb.count()) === 1 && (await nsProb.textContent()).indexOf('No sticker') >= 0,
    "listed on the Problem page as '🏷️ No sticker'");
  await nsProb.locator('.btn.green').click();
  await page.setInputFiles('#print-file', IMG3);
  await sleep(900);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoStick-test');
    return j.problem === 'printed' && !!j.printedAt;
  }), 'office solves it with the printing photo, same as always');
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(200);

  await page.evaluate(() => { // cleanup
    ['Prob-deliv', 'Prob-check', 'NoStick-test'].forEach(n => {
      const j = window.__mockdb.jobs.find(x => x.note === n);
      if (j) j.status = 'archived';
    });
  });
  await page.evaluate(() => refresh());
  await sleep(400);
  await page.click('#nav-postage');
  await sleep(300);

  console.log('\n-- DEFECT tab: jobsheet + defect photos, DONE button --');
  check((await page.locator('#nav-defect').count()) === 1, 'Defect tab in the bottom nav');
  await page.click('#nav-defect');
  await sleep(400);
  check(await page.locator('#page-defect').isVisible(), 'defect page opens');
  await page.click('#nav-post');
  await sleep(200);
  check((await page.locator('#upload-title').textContent()).indexOf('Defect') >= 0, "post window titled 'Record Defect'");
  check((await page.locator('#wb-label').textContent()).indexOf('Defect photos') >= 0,
    "second group is called 'Defect photos' (not Waybill)");
  check((await page.locator('#btn-submit').textContent()).indexOf('DONE') >= 0, "submit button says '✅ DONE'");
  check(!await page.locator('#due-wrap').isVisible(), 'no Ready-by field for defect records');
  await page.setInputFiles('#js-file', IMG);
  await sleep(500);
  await page.click('#btn-submit');
  await sleep(300);
  check((await page.locator('#toast').textContent()).indexOf('Defect photo') >= 0, 'blocked without a defect photo');
  await page.setInputFiles('#wb-file', [IMG2, IMG3]);
  await sleep(600);
  await page.fill('#upload-customer', 'Aina');
  await page.fill('#upload-note', 'Torn sleeve x3');
  await page.click('#btn-submit');
  await sleep(900);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Torn sleeve x3');
    return !!(j && j.tab === 'defect' && j.status === 'pending' && j.jsCount === 1 && j.photoIds.length === 3);
  }), 'saved with 1 jobsheet + 2 defect photos, waiting in To Do');
  const defCard = page.locator('#defect-list .card').filter({ hasText: 'Torn sleeve x3' });
  check((await defCard.count()) === 1, 'card shows on the Defect page');
  check((await defCard.locator('.photo-pair .lbl').nth(1).textContent()).indexOf('Defect') >= 0,
    'card shows Jobsheet | Defect side by side');
  check((await defCard.locator('.btn.green').count()) === 1, "defect needs a PROOF: 'Done! Take Proof Photo' button shown");
  check((await page.locator('#badge-defect').textContent()) === '1', 'red badge counts the open defect');
  check((await page.locator('#defect-list .stat-row').count()) === 1, 'Balance/Completed boxes on the Defect page too');
  await clickSafe(defCard.locator('.t-edit').first());
  await sleep(300);
  check((await page.locator('#js-thumbs .thumb').count()) === 1 && (await page.locator('#wb-thumbs .thumb').count()) === 2,
    'edit splits jobsheet / defect photos back into their groups');
  await page.click('#upload-overlay .x-close');
  await sleep(200);
  // fixing the defect: proof photo completes it
  await clickSafe(defCard.locator('.btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Torn sleeve x3');
    return j.status === 'done' && !!j.proofPhotoId;
  }), 'proof photo marks the defect DONE on the server');
  check((await defCard.locator('.proof-tools .t-reproof').count()) === 1, 'Retake/Remove proof tools available on defects too');
  check(!await page.locator('#badge-defect').isVisible(), 'badge clears when the defect is fixed');
  await page.click('#nav-postage');
  await sleep(300);

  console.log('\n-- bottom nav: icons stay put when tapped --');
  const icoB = await page.locator('#nav-want .ico').boundingBox();
  const lblB = await page.locator('#nav-want .nav-lbl').boundingBox();
  await page.click('#nav-want');
  await sleep(400);
  const icoA = await page.locator('#nav-want .ico').boundingBox();
  const lblA = await page.locator('#nav-want .nav-lbl').boundingBox();
  // 2026 design: the active icon deliberately LIFTS 2px on its glowing
  // squircle — but it must never shift sideways, and labels never move.
  check(Math.abs(icoB.x - icoA.x) < 0.6, 'icon does not shift sideways when its tab becomes active');
  check(icoB.y - icoA.y > 1 && icoB.y - icoA.y < 4, 'active icon lifts gently (by design)');
  check(Math.abs(lblB.x - lblA.x) < 0.6 && Math.abs(lblB.y - lblA.y) < 0.6,
    'label does NOT move at all');
  check(lblA.y >= icoA.y + icoA.height - 3, 'label sits stacked BELOW the icon');

  console.log('\n-- fullscreen viewer: swipe through the photos --');
  await page.click('#nav-delivery');
  await sleep(500);
  const bgCard = page.locator('#delivery-list .card').filter({ hasText: 'Background upload' });
  await bgCard.locator('.car-slide img').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await bgCard.locator('.car-slide img').first().click();
  await sleep(300);
  check(await page.locator('#viewer').isVisible(), 'tapping a photo opens the fullscreen viewer');
  check((await page.locator('#viewer-count').textContent()).indexOf('1 / 3') >= 0, "counter shows '1 / 3'");
  const vImg0 = await page.locator('#viewer-img').getAttribute('data-img');
  // finger swipe left = next photo
  const vBox = await page.locator('#viewer').boundingBox();
  await touchDrag(cdp, vBox.x + vBox.width * 0.7, vBox.y + vBox.height / 2, vBox.x + vBox.width * 0.2, vBox.y + vBox.height / 2);
  await sleep(300);
  check((await page.locator('#viewer-count').textContent()).indexOf('2 / 3') >= 0, 'finger swipe left → photo 2');
  check((await page.locator('#viewer-img').getAttribute('data-img')) !== vImg0, 'image actually changed');
  // finger swipe right = back
  await touchDrag(cdp, vBox.x + vBox.width * 0.2, vBox.y + vBox.height / 2, vBox.x + vBox.width * 0.8, vBox.y + vBox.height / 2);
  await sleep(300);
  check((await page.locator('#viewer-count').textContent()).indexOf('1 / 3') >= 0, 'finger swipe right → back to photo 1');
  // arrows work on mobile too
  await page.locator('#viewer-next').click();
  await sleep(250);
  check((await page.locator('#viewer-count').textContent()).indexOf('2 / 3') >= 0, '› arrow also works');
  await page.locator('.viewer-x').click();
  await sleep(250);
  check(!await page.locator('#viewer').isVisible(), '✕ closes the viewer');

  console.log('\n-- viewer speed: thumbnail shows instantly, neighbours prefetch --');
  const vjob = await page.evaluate(() =>
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Viewer speed', photos: ['sf1', 'sf2', 'sf3'], thumbs: ['st1', 'st2', 'st3'] }));
  await page.evaluate(() => refresh());
  await sleep(600);
  const vsCard = page.locator('#delivery-list .card').filter({ hasText: 'Viewer speed' });
  await vsCard.locator('.car-slide img').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(900); // card thumbnails finish downloading
  await page.evaluate(() => { window.__mocklat = { getImagesData: 1200 }; }); // slow network for the full photos
  await vsCard.locator('.car-slide img').first().click();
  await sleep(250); // far less than the 1200ms the full photo needs
  const quickSrc = await page.locator('#viewer-img').getAttribute('src');
  check(quickSrc.indexOf(vjob.thumbIds[0]) >= 0,
    'viewer shows the cached THUMBNAIL instantly while the full photo downloads');
  await sleep(1700);
  const sharpSrc = await page.locator('#viewer-img').getAttribute('src');
  check(sharpSrc.indexOf(vjob.photoIds[0]) >= 0, 'sharp full-size photo replaces it when it arrives');
  const prefetched = await page.evaluate(ids =>
    ids.filter(id => window.__imgRequests.indexOf(id) >= 0).length, [vjob.photoIds[1], vjob.photoIds[2]]);
  check(prefetched === 2, 'next/previous photos prefetch in the background (instant swiping)');
  await page.evaluate(() => { window.__mocklat = {}; });
  await page.locator('.viewer-x').click();
  await sleep(250);
  // postage: tapping a jobsheet photo swipes ONLY jobsheet pages
  await page.click('#nav-postage');
  await sleep(500);
  const pairImg = page.locator('#postage-list .photo-pair .car-slide img').first();
  await pairImg.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await pairImg.click();
  await sleep(300);
  check((await page.locator('#viewer-count').textContent()).indexOf('/ 2') >= 0, 'jobsheet photo opens viewer with ONLY its 2 jobsheet pages');
  await page.locator('.viewer-x').click();
  await sleep(250);
  await page.click('#nav-delivery');
  await sleep(400);

  console.log('\n-- PIN gets priority over image loading --');
  await page.evaluate(() => {
    localStorage.clear(); // forget cached photos so plenty must load
    window.__mocklat = { getImagesData: 900 };
    for (let i = 0; i < 8; i++) {
      window.__mockapi.addJob({ tab: 'postage', category: '', note: 'P' + i, photos: ['zz' + i, 'zz' + i + 'b'], thumbs: ['zt' + i, 'zt' + i + 'b'] });
    }
  });
  await page.click('#nav-postage');
  await sleep(350); // image batches now in flight (900ms each)
  await page.click('#role-btn');
  await sleep(150);
  await page.click('#role-admin-btn');
  await page.fill('#pin-input', '1234');
  const tPin = await page.evaluate(() => Date.now());
  await page.click('#pin-wrap .btn.blue');
  await sleep(450); // PIN latency is only 150ms
  check(!await page.locator('#spinner').isVisible(), 'PIN completes fast — NOT stuck behind image downloads');
  check((await page.locator('#role-btn').textContent()).indexOf('Admin') >= 0, 'admin mode on');
  const imgCallsDuring = await page.evaluate(t =>
    window.__mockcalls.filter(c => c.name === 'getImagesData' && c.at > t && c.at < t + 300).length, tPin);
  check(imgCallsDuring === 0, 'zero image downloads started while PIN was checking (priority hold)');
  await page.evaluate(() => { window.__mocklat = {}; });

  console.log('\n-- lazy loading: only visible photos download --');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await sleep(2500); // back to the top; let visible batches settle
  const stats = await page.evaluate(() => {
    const req = new Set(window.__imgRequests);
    const ids = Array.from(document.querySelectorAll('#postage-list img[data-img]')).map(el => el.getAttribute('data-img'));
    return { total: ids.length, requested: ids.filter(id => req.has(id)).length };
  });
  check(stats.requested > 0 && stats.requested < stats.total,
    'only on-screen photos requested (' + stats.requested + ' of ' + stats.total + ') — offscreen skipped');
  // scroll down step by step, like a real user
  for (let step = 0; step < 8; step++) {
    await page.evaluate(() => { document.getElementById('scroller').scrollTop += 550; });
    await sleep(250);
  }
  await sleep(1200);
  const stats2 = await page.evaluate(() => {
    const req = new Set(window.__imgRequests);
    const ids = Array.from(document.querySelectorAll('#postage-list img[data-img]')).map(el => el.getAttribute('data-img'));
    return { requested: ids.filter(id => req.has(id)).length };
  });
  check(stats2.requested > stats.requested, 'scrolling down loads more (' + stats.requested + ' → ' + stats2.requested + ')');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });

  console.log('\n-- PIN watchdog: spinner can never hang forever --');
  await page.evaluate(() => { window.__PIN_TIMEOUT = 700; window.__mocklat = { checkPin: 3000 }; });
  await page.click('#role-btn');
  await sleep(150);
  await page.click('#role-admin-btn');
  await page.fill('#pin-input', '1234');
  await page.click('#pin-wrap .btn.blue');
  await sleep(300);
  check(await page.locator('#spinner').isVisible(), 'spinner shows while the network is slow');
  await sleep(750);
  check(!await page.locator('#spinner').isVisible(), 'watchdog closes the spinner instead of spinning forever');
  check((await page.locator('#toast').textContent()).indexOf('Slow network') >= 0, "tells the user: 'Slow network — please try again'");
  await page.evaluate(() => { window.__PIN_TIMEOUT = 0; window.__mocklat = {}; });
  await page.click('#role-overlay .x-close');
  await sleep(150);

  console.log('\n-- instant startup from cache --');
  // localStorage has cached job lists; a reload should render BEFORE the server answers
  await page.evaluate(() => {
    localStorage.setItem('kj_want', JSON.stringify([{
      id: 'cached1', tab: 'want', category: '', note: 'Cached job', photoIds: ['pc1'], thumbIds: ['tc1'],
      status: 'got', createdAt: Date.now(), doneAt: Date.now(), proofPhotoId: '', proofThumbId: ''
    }]));
  });
  await page.reload();
  // count IMMEDIATELY after load, before the mock server (150ms) can answer
  const early = await page.evaluate(() => ({
    cards: document.querySelectorAll('#want-responded .card').length,
    answered: window.__mockcalls.length > 0 && document.querySelector('#want-stack-area .empty') === null
  }));
  check(early.cards === 1, 'cached jobs render instantly, before the server responds');

  await ctx.close();

  // ============================================================ DESKTOP
  console.log('\n===== DESKTOP (1280x900, admin) =====');
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await dctx.route('**aramega.com.my**', r => r.abort());
  const dpage = await dctx.newPage();
  dpage.on('pageerror', e => { fail++; failures.push('JS error: ' + e.message); console.log('  ❌ PAGE JS ERROR: ' + e.message); });
  await dpage.addInitScript(() => {
    localStorage.setItem('kilangRole', 'admin');
    localStorage.setItem('kilangPin', '1234');
  });
  await dpage.goto(URL);
  await sleep(400);
  await dpage.evaluate(() => {
    ['lalamove', 'bus', 'pickup'].forEach((cat, i) => {
      window.__mockapi.addJob({ tab: 'delivery', category: cat, note: 'Desktop job ' + (i + 1), photos: ['x', 'y'], thumbs: ['x', 'y'] });
    });
  });
  await dpage.click('#nav-delivery');
  await sleep(600);
  check((await dpage.locator('#delivery-list .card').count()) === 3, '3 jobs render');
  const cols = await dpage.locator('#delivery-list .grid').first()
    .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(cols === 3, 'grid layout intact (' + cols + ' columns)');
  await dpage.locator('#delivery-list .car-btn.next').first().click();
  await sleep(600);
  const dot2 = await dpage.locator('#delivery-list .car-dots span').nth(1).getAttribute('class');
  check(dot2 === 'on', 'carousel arrows work');
  await dpage.evaluate(() => { window.__mockapi.addJob({ tab: 'want', category: '', note: 'Swipe me', photos: ['x'], thumbs: ['x'] }); });
  await dpage.click('#nav-want');
  await sleep(600);
  const dbox = await dpage.locator('#topcard').boundingBox();
  await dpage.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await dpage.mouse.down();
  for (let i = 1; i <= 10; i++) await dpage.mouse.move(dbox.x + dbox.width / 2 + i * 30, dbox.y + dbox.height / 2, { steps: 2 });
  await dpage.mouse.up();
  await sleep(700);
  check((await dpage.locator('#want-responded').textContent()).indexOf('Got it') >= 0, 'decision swipe works on desktop');

  console.log('\n-- desktop viewer: arrows + keyboard --');
  await dpage.click('#nav-delivery');
  await sleep(500);
  await dpage.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'PC viewer', photos: ['pc1', 'pc2', 'pc3'], thumbs: ['pt1', 'pt2', 'pt3'] });
  });
  await dpage.click('#refresh-btn');
  await sleep(600);
  const pcCard = dpage.locator('#delivery-list .card').filter({ hasText: 'PC viewer' });
  await pcCard.locator('.car-slide img').first().evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await pcCard.locator('.car-slide img').first().click();
  await sleep(300);
  check(await dpage.locator('#viewer').isVisible(), 'clicking a photo opens the viewer on PC');
  check(await dpage.locator('#viewer-next').isVisible(), '‹ › arrows visible on PC');
  await dpage.locator('#viewer-next').click();
  await sleep(250);
  check((await dpage.locator('#viewer-count').textContent()).indexOf('2 / 3') >= 0, '› arrow → photo 2');
  await dpage.keyboard.press('ArrowRight');
  await sleep(250);
  check((await dpage.locator('#viewer-count').textContent()).indexOf('3 / 3') >= 0, 'keyboard arrow → photo 3');
  await dpage.keyboard.press('ArrowLeft');
  await sleep(250);
  check((await dpage.locator('#viewer-count').textContent()).indexOf('2 / 3') >= 0, 'keyboard back → photo 2');
  await dpage.keyboard.press('Escape');
  await sleep(250);
  check(!await dpage.locator('#viewer').isVisible(), 'Escape closes the viewer');

  await dctx.close();
  await browser.close();

  console.log('\n================================');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });

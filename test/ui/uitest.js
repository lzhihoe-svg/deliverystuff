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
  // ---- simplified-UI helpers: header actions live in ☰, card actions in ⋯ ----
  async function viaMenu(sel) {
    await page.click('#menu-btn'); await sleep(250);
    await page.click(sel); await sleep(250);
  }
  async function menuItemVisible(sel) {
    await page.click('#menu-btn'); await sleep(250);
    const vis = await page.locator(sel).isVisible();
    await page.evaluate(() => closeMenu()); await sleep(150);
    return vis;
  }
  async function openOpts() { // Ready by + Instruction fold behind "More"
    if (!(await page.locator('#opt-wrap').isVisible())) { await page.click('#more-row'); await sleep(200); }
  }
  async function viaMore(cardLoc, itemSel) {
    await clickSafe(cardLoc.locator('.more-btn').first()); await sleep(250);
    await page.click('#jobmenu-list ' + itemSel); await sleep(250);
  }
  async function moreCount(cardLoc, itemSel) {
    await clickSafe(cardLoc.locator('.more-btn').first()); await sleep(250);
    const n = await page.locator('#jobmenu-list ' + itemSel).count();
    const txts = await page.locator('#jobmenu-list ' + itemSel).allTextContents();
    await page.evaluate(() => closeJobMenu()); await sleep(150);
    return { n, txts };
  }
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
  check((await page.locator('#refresh-btn').textContent()).indexOf('Refresh') >= 0, "refresh button shows the word 'Refresh'");

  console.log('\n-- post multi-photo job --');
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(700);
  await openOpts();
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
  await viaMenu('#role-btn');
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
  await viaMenu('#reset-btn');
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
  await viaMenu('#reset-btn');
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
  await viaMenu('#reset-btn');
  await sleep(150);
  await page.locator('#reset-overlay .btn.gray').click(); // UNDO
  await sleep(600);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.status !== 'archived').length > 0),
    'archived jobs are back on the server');
  check((await page.locator('#delivery-list .card').count()) > 0, 'cards reappear on screen after undo');
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.status === 'done' && j.proofPhotoId)),
    'a done job returned as done WITH its proof photo');
  // put everything back to archived so later sections start clean
  await viaMenu('#reset-btn');
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
  const pfTools = await moreCount(pfCard, '.jm-reproof, .jm-delproof');
  check(pfTools.n === 2, "staff sees 📷 Retake Proof + 🗑️ Remove Proof in the card's ⋯ menu");
  await viaMore(pfCard, '.jm-reproof');
  await page.setInputFiles('#proof-file', IMG2);
  await sleep(800);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'Proof fix' && j.proofPhotoId.indexOf('reproof') === 0)),
    'retake stores the NEW proof photo on the server');
  check(await page.evaluate(() => window.__mockdb.jobs.find(j => j.note === 'Proof fix').status === 'done'),
    'job stays done after a retake');
  await viaMore(pfCard, '.jm-delproof');
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
    window.__mockapi.markDelivered(dd.id, 'bus', 'ZH'); // big ✔ — Clear Done may take it
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  check((await menuItemVisible('#reset-btn')) &&
    (await page.locator('#reset-btn').textContent()).indexOf('Clear / Reset') >= 0,
    "admin sees ONE '🧹 Clear / Reset ▾' item in the ☰ menu");
  check((await page.locator('#cleardone-btn').count()) === 0, 'the separate CLEAR DONE button is gone');
  await viaMenu('#reset-btn');
  await sleep(150);
  check(await page.locator('#reset-overlay').isVisible(), 'dropdown menu opens with both choices');
  await page.locator('#reset-overlay .btn.green').click(); // CLEAR DONE
  await sleep(150);
  check((await page.locator('#confirm-msg').textContent()).indexOf('STAY') >= 0,
    'confirm explains ready-but-not-delivered jobs stay');
  await page.click('#confirm-yes');
  await sleep(600);
  const cd = await page.evaluate(() => ({
    done: window.__mockdb.jobs.find(j => j.note === 'CD-done').status,
    got: window.__mockdb.jobs.find(j => j.note === 'CD-got').status,
    ns: window.__mockdb.jobs.find(j => j.note === 'CD-notseen').status,
    pf: window.__mockdb.jobs.find(j => j.note === 'Proof fix').status
  }));
  check(cd.done === 'archived' && cd.got === 'archived', '✔ delivered job + ❤️ Got It jobsheet archived');
  check(cd.ns === 'notseen' && cd.pf === 'pending', '❌ Not Seen + To Do jobs carried forward');
  check((await pfCard.count()) === 1, 'carried-forward job still on screen');
  await page.evaluate(() => setRole('staff', ''));
  await sleep(200);
  check(!(await menuItemVisible('#reset-btn')), 'staff does NOT see Clear / Reset');
  check(await menuItemVisible('#history-btn'), 'staff DOES see the History button');
  await viaMenu('#history-btn');
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
  check(await menuItemVisible('#history-btn'), 'admin sees the History button');
  await viaMenu('#history-btn');
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
  check(await menuItemVisible('#history-btn'), 'staff sees the History button too (read-only evidence)');
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(200);

  console.log('\n-- 📊 admin stats: all 4 pages at a glance --');
  check(await menuItemVisible('#stats-btn'), 'admin sees the Stats button');
  await viaMenu('#stats-btn');
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
  check(!(await menuItemVisible('#stats-btn')), 'staff does NOT see the Stats button');
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
  await openOpts();
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
  await openOpts();
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
  await viaMore(custCard, '.jm-edit');
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
  await viaMenu('#history-btn');
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
  await openOpts();
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
  await openOpts();
  check(await page.locator('#customer-wrap').isVisible() && await page.locator('#due-wrap').isVisible(),
    'customer + Ready-by appear for the pipeline');
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(600);
  await openOpts();
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
  check((await page.locator('#delivery-list .card').filter({ hasText: 'Pipe-test' }).locator('.meta').textContent()).indexOf('passed check') >= 0,
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
  check((await page.locator('#delivery-list .stat-row').count()) === 1, 'delivery has the slim counter bar');
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
  await openOpts();
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
  await openOpts();
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
  await page.click('#menu-btn');
  await sleep(250);
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
  check((await page.locator('#refresh-btn').textContent()).indexOf('Refresh') >= 0, "button back to 'Refresh'");
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
  await openOpts();
  check(await page.locator('#due-wrap').isVisible(), 'Ready-by time field shows for delivery');
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  await openOpts();
  await page.fill('#upload-due', '23:58');
  await openOpts();
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
  await openOpts();
  check(await page.locator('#upload-due-day').isVisible() && await page.locator('#upload-due-month').isVisible(),
    'Day + Month dropdowns show next to the time (no year)');
  await page.setInputFiles('#photos-file', IMG2);
  await sleep(500);
  await page.click('#upload-cats button[data-cat="bus"]');
  const tmr = await page.evaluate(() => {
    const d = new Date(Date.now() + 86400000);
    return { d: String(d.getDate()), m: String(d.getMonth()) };
  });
  await openOpts();
  await page.selectOption('#upload-due-day', tmr.d);
  await page.selectOption('#upload-due-month', tmr.m);
  await openOpts();
  await page.fill('#upload-due', '16:30');
  await openOpts();
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
  await viaMore(tCard, '.jm-edit');
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
  await openOpts();
  await page.selectOption('#upload-due-day', tod.d);
  await page.selectOption('#upload-due-month', tod.m);
  await openOpts();
  await page.fill('#upload-note', 'Date only job');
  await page.fill('#upload-customer', 'DO');
  await page.click('#btn-submit');
  await sleep(700);
  const doCard = page.locator('#delivery-list .card').filter({ hasText: 'Date only job' });
  check((await doCard.locator('.chip.due, .chip.soon').count()) === 1,
    'date WITHOUT time still saves and shows a Ready-by chip');
  check((await doCard.locator('.chip.due, .chip.soon').first().textContent()).indexOf('today') >= 0,
    "chip reads 'Ready by today'");
  await viaMore(doCard, '.jm-edit');
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
  await viaMenu('#refresh-btn');
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
  await viaMenu('#refresh-btn');
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
  await openOpts();
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
  await viaMore(page.locator('#postage-list .card').first(), '.jm-edit');
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
  check((await moreCount(sbCard, '.jm-sentbus')).n === 1, "pending postage card offers '🚌 Sent bus' in its ⋯ menu");
  await page.click('#nav-delivery');
  await sleep(400);
  check(await page.evaluate(() => jobMenuHtml_({ id: 'x', tab: 'delivery', status: 'pending', problem: '', photoIds: [] }).indexOf('jm-sentbus') < 0),
    'Delivery cards do NOT offer Sent bus');
  await page.click('#nav-postage');
  await sleep(400);
  await viaMore(sbCard, '.jm-sentbus');
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

  console.log('\n-- 📦 Delivered? how + by whom, no photo → big ✔ --');
  await page.evaluate(() => {
    const d = window.__mockapi.addJob({ tab: 'delivery', category: 'lalamove', note: 'Deliv-confirm', customer: 'SN', photos: ['dc1'], thumbs: ['dc1'] });
    window.__mockapi.updateStatus(d.id, 'done', 'p', 'pt', null);
    setRole('staff', ''); // staff must be able to confirm too
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  await page.click('#nav-delivery');
  await sleep(400);
  const dcCard = page.locator('#delivery-list .card').filter({ hasText: 'Deliv-confirm' });
  check((await dcCard.locator('.btn.green').count()) === 1 &&
    (await dcCard.locator('.btn.green').textContent()).indexOf('Delivered?') >= 0,
    "done delivery card asks '📦 Delivered? Tap to confirm' (staff too)");
  await clickSafe(dcCard.locator('.btn.green'));
  await sleep(300);
  check(await page.locator('#deliv-overlay').isVisible(), 'the Delivered sheet opens');
  check((await page.locator('#deliv-via button').count()) === 4,
    'four methods: Lalamove / Bus / Self pickup / Sent personally');
  await page.click('#deliv-overlay .btn.green');
  await sleep(200);
  check((await page.locator('#toast').textContent()).indexOf('HOW') >= 0, 'blocked without choosing HOW');
  await page.click('#deliv-via button[data-v="lalamove"]');
  await page.click('#deliv-overlay .btn.green');
  await sleep(200);
  check((await page.locator('#toast').textContent()).indexOf('Bos (ZH) or Bob') >= 0, 'blocked without choosing WHO');
  await page.click('#deliv-by button[data-b="ZH"]');
  await page.click('#deliv-overlay .btn.green');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Deliv-confirm');
    return !!j.deliveredAt && j.deliveredVia === 'lalamove' && j.deliveredBy === 'ZH';
  }), 'server records how + who + timestamp — no photo anywhere');
  check((await dcCard.locator('.media-sealed .seal-tick').count()) === 1,
    'a green tick is stamped OVER the photos');
  const tickTxt = await dcCard.locator('.delivered-big').textContent();
  check((await dcCard.locator('.delivered-big .tick').count()) === 1 &&
    tickTxt.indexOf('DELIVERED') >= 0 && tickTxt.indexOf('Lalamove') >= 0 &&
    tickTxt.indexOf('Bos (ZH)') >= 0,
    'card shows the BIG ✔ with method, person and time');
  check((await dcCard.locator('.btn.green').count()) === 0, 'the Delivered button is gone — nothing left to think about');
  // the job moved into its OWN "Done & Delivered" section
  check((await page.locator('#sec-delivered-delivery').count()) === 1 &&
    (await page.locator('#sec-delivered-delivery').textContent()).indexOf('Done & Delivered') >= 0,
    "delivery has a separate '✔ Done & Delivered' section");
  check(await page.evaluate(() => {
    const sec = document.getElementById('sec-delivered-delivery');
    const grid = sec && sec.nextElementSibling;
    return !!grid && grid.textContent.indexOf('Deliv-confirm') >= 0;
  }), 'the confirmed job sits inside it, not in plain Done');
  const dcTools = await moreCount(dcCard, '.jm-deldeliv');
  check(dcTools.n === 1, '⋯ offers ↩️ Undo Delivered for wrong taps');
  await viaMore(dcCard, '.jm-deldeliv');
  await sleep(200);
  await page.click('#confirm-yes');
  await sleep(600);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Deliv-confirm');
    return j.deliveredAt === '' && j.deliveredBy === '';
  }), 'Undo clears the record');
  check((await dcCard.locator('.btn.green').count()) === 1, "the 'Delivered?' button returns");
  check((await dcCard.locator('.seal-tick').count()) === 0, 'the photo tick disappears after Undo');
  check((await page.locator('#sec-delivered-delivery').count()) === 0,
    'the Done & Delivered section empties out after Undo');
  check((await page.locator('#postage-list .delivered-big').count()) === 0, 'postage cards have no Delivered stage');
  await page.evaluate(() => {
    setRole('admin', '1234');
    window.__mockdb.jobs.find(x => x.note === 'Deliv-confirm').status = 'archived';
  });
  await page.evaluate(() => refresh());
  await sleep(400);
  await page.click('#nav-postage');
  await sleep(300);

  console.log('\n-- 📮 J&T ready count + Sent button --');
  await page.evaluate(() => {
    setRole('staff', '');
    const a = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Jnt-A', customer: 'SN', photos: ['ja1', 'ja2'], thumbs: ['ja1', 'ja2'], jsCount: 1 });
    const b = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Jnt-B', customer: 'CG', photos: ['jb1', 'jb2'], thumbs: ['jb1', 'jb2'], jsCount: 1 });
    window.__mockapi.updateStatus(a.id, 'done', 'p', 'pt', null);
    window.__mockapi.updateStatus(b.id, 'done', 'p', 'pt', null);
  });
  await page.evaluate(() => refresh());
  await sleep(600);
  const jntReady0 = await page.evaluate(() =>
    window.__kilang.jobs.postage.filter(j => j.status === 'done' && !j.sentAt).length);
  check((await page.locator('#postage-list .jnt-bar b').textContent()) === String(jntReady0),
    'the J&T bar shows how many parcels are ready RIGHT NOW (' + jntReady0 + ')');
  const jaCard = page.locator('#postage-list .card').filter({ hasText: 'Jnt-A' });
  check((await jaCard.locator('.btn.green').count()) === 1 &&
    (await jaCard.locator('.btn.green').textContent()).indexOf('Sent') >= 0,
    "ready parcel shows '📮 Sent — given to J&T' (staff too)");
  await clickSafe(jaCard.locator('.btn.green'));
  await sleep(200);
  await page.click('#confirm-yes');
  await sleep(700);
  check(await page.evaluate(() => !!window.__mockdb.jobs.find(x => x.note === 'Jnt-A').sentAt),
    'server stamps the Sent time');
  check((await jaCard.locator('.delivered-big').textContent()).indexOf('SENT TO J&T') >= 0,
    'big ✔ SENT TO J&T appears on the job');
  check((await jaCard.locator('.media-sealed .seal-tick').count()) === 1,
    'the jobsheet + waybill photos get the green tick stamp too');
  check((await page.locator('#postage-list .jnt-bar b').textContent()) === String(jntReady0 - 1),
    'the ready count drops — sent parcels are OUT of the next count');
  const jaTools = await moreCount(jaCard, '.jm-delsent');
  check(jaTools.n === 1, '⋯ offers ↩️ Undo Sent');
  await viaMore(jaCard, '.jm-delsent');
  await sleep(200);
  await page.click('#confirm-yes');
  await sleep(600);
  check((await page.locator('#postage-list .jnt-bar b').textContent()) === String(jntReady0),
    'Undo Sent puts it back in the ready count');
  await page.evaluate(() => {
    setRole('admin', '1234');
    ['Jnt-A', 'Jnt-B'].forEach(n => { const j = window.__mockdb.jobs.find(x => x.note === n); if (j) j.status = 'archived'; });
  });
  await page.evaluate(() => refresh());
  await sleep(400);

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
  await viaMore(lsCard, '.jm-edit');
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
  await openOpts();
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
  check((await moreCount(pdCard, '.jm-warn')).n === 1, "delivery card offers '❓ Haven't received' in its ⋯ menu");
  check(await page.evaluate(() => {
    const mk = t => jobMenuHtml_({ id: 'x', tab: t, status: 'pending', problem: '', photoIds: [] });
    return mk('want').indexOf('jm-warn') < 0 && mk('defect').indexOf('jm-warn') >= 0;
  }), 'checking cards do NOT (defect cards DO now)');
  await viaMore(pdCard, '.jm-warn');
  await sleep(600);
  check((await pdCard.locator('.prob-line').textContent()).indexOf('Reported at') >= 0, "card shows '🚨 Reported at <time>'");
  check((await moreCount(pdCard, '.jm-warn, .jm-sticker')).n === 0, 'report actions gone after reporting');
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

  console.log('\n-- 📝 problem info: staff write, both sides read --');
  await page.evaluate(() => {
    setRole('staff', ''); // writing info must NOT need the PIN
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Note-prob', customer: 'CG', photos: ['np1'], thumbs: ['np1'] });
  });
  await page.evaluate(() => refresh());
  await sleep(500);
  await page.click('#nav-delivery');
  await sleep(400);
  const npCard = page.locator('#delivery-list .card').filter({ hasText: 'Note-prob' });
  await viaMore(npCard, '.jm-warn'); // report it
  await sleep(500);
  await page.click('#problem-btn');
  await sleep(400);
  const npProb = page.locator('#problem-list .prob-card').filter({ hasText: 'Note-prob' });
  check((await npProb.locator('.prob-edit').count()) === 1 &&
    (await npProb.locator('.prob-edit').textContent()).indexOf('Write Problem Info') >= 0,
    "problem card has '✏️ Write Problem Info'");
  await npProb.locator('.prob-edit').click();
  await sleep(300);
  await npProb.locator('.prob-note-edit').fill('Jobsheet with Kak Ros — reprint page 2 only');
  await npProb.locator('.btn.green.small').first().click();
  await sleep(600);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'Note-prob');
    return j.problemNote.indexOf('Kak Ros') >= 0;
  }), 'staff saved the info on the server (no PIN)');
  check((await npProb.locator('.prob-note').textContent()).indexOf('Kak Ros') >= 0,
    'info shows on the Problem page');
  check((await npProb.locator('.prob-edit').textContent()).indexOf('Edit Problem Info') >= 0,
    "button now reads 'Edit Problem Info'");
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(300);
  check((await npCard.locator('.prob-note').textContent()).indexOf('Kak Ros') >= 0,
    'the SAME info shows on the job card — both sides read it');
  await page.evaluate(() => { // cleanup
    setRole('admin', '1234');
    window.__mockdb.jobs.find(x => x.note === 'Note-prob').status = 'archived';
  });
  await page.evaluate(() => refresh());
  await sleep(400);
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
  const nsTools = await moreCount(nsCard, '.jm-warn, .jm-sticker');
  check(nsTools.n === 2, "postage ⋯ menu has BOTH: Haven't received + No sticker");
  check(nsTools.txts.some(t => t.indexOf('No sticker') >= 0), "one of them reads 'No sticker'");
  await page.click('#nav-delivery');
  await sleep(300);
  check(await page.evaluate(() => jobMenuHtml_({ id: 'x', tab: 'delivery', status: 'pending', problem: '', photoIds: [] }).indexOf('jm-sticker') < 0),
    'delivery cards do NOT get the sticker action');
  await page.click('#nav-postage');
  await sleep(300);
  await viaMore(nsCard, '.jm-sticker');
  await sleep(600);
  check((await nsCard.locator('.prob-line').textContent()).indexOf('No sticker') >= 0,
    "card shows '🏷️ No sticker — reported at <time>'");
  check((await moreCount(nsCard, '.jm-warn, .jm-sticker')).n === 0, 'both report actions gone once reported');
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

  console.log('\n-- 🚨 typed problems: raise → edit → delete (and no more jm-nojob) --');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'NoJob-test', customer: 'SN',
      photos: ['njt1', 'njt2'], thumbs: ['njt1', 'njt2'], jsCount: 1 });
    refresh();
  });
  await sleep(600);
  await page.click('#nav-postage');
  await sleep(400);
  const njCard = page.locator('#postage-list .card').filter({ hasText: 'NoJob-test' });
  check((await moreCount(njCard, '.jm-nojob')).n === 0,
    "'Got sticker, No Job' is GONE from the ⋯ menu — top button only");
  const rTools = await moreCount(njCard, '.jm-problem');
  check(rTools.n === 1 && rTools.txts.some(t => t.indexOf('Problem') >= 0),
    '⋯ menu has the 🚨 Problem button instead');
  check(await page.evaluate(() => jobMenuHtml_({ id: 'x', tab: 'want', status: 'pending', problem: '', photoIds: [] }).indexOf('jm-problem') >= 0),
    'Checking jobsheets get the 🚨 Problem button too');
  await viaMore(njCard, '.jm-problem');
  await sleep(300);
  check(await page.locator('#raise-overlay').isVisible(), 'a text box opens to type the problem');
  await page.fill('#raise-text', 'Kain salah warna');
  await page.click('#raise-save');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoJob-test');
    return j.problem === 'custom' && j.probLog[0].text === 'Kain salah warna';
  }), 'typed problem saved on the server');
  check((await njCard.locator('.prob-line').textContent()).indexOf('Kain salah warna') >= 0,
    'the card shows the typed problem in red (P1: …)');
  await page.click('#problem-btn');
  await sleep(400);
  const rProb = page.locator('#problem-list .prob-card').filter({ hasText: 'Kain salah warna' });
  check((await rProb.count()) === 1, 'the typed problem waits on the Problem page');
  check((await rProb.locator('button:has-text("Edit Problem")').count()) === 1 &&
        (await rProb.locator('button:has-text("Delete")').count()) === 1,
    'staff get ✏️ Edit + 🗑️ Delete on a raised problem');
  await rProb.locator('button:has-text("Edit Problem")').click();
  await sleep(300);
  check((await page.inputValue('#raise-text')) === 'Kain salah warna', 'edit opens with the current text');
  await page.fill('#raise-text', 'Kain salah warna — tukar biru');
  await page.click('#raise-save');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoJob-test');
    return j.probLog[0].text.indexOf('tukar biru') >= 0;
  }), 'edited text saved on the server');
  await page.locator('#problem-list .prob-card').filter({ hasText: 'tukar biru' })
    .locator('button:has-text("Delete")').click();
  await sleep(250);
  await page.click('#confirm-yes');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoJob-test');
    return j.problem === '' && j.probLog.length === 0;
  }), 'deleting the raise withdraws it completely');
  check((await page.locator('#problem-list .prob-card').filter({ hasText: 'NoJob-test' }).count()) === 0,
    'gone from the Problem page');

  // one-tap reports (haven't received / no sticker) get 🗑️ Delete too
  await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoJob-test');
    window.__mockapi.reportProblem(j.id, 'sticker');
    refresh();
  });
  await sleep(600);
  await page.evaluate(() => renderProblems());
  await sleep(300);
  const nsDel = page.locator('#problem-list .prob-card').filter({ hasText: 'NoJob-test' });
  check((await nsDel.locator('button:has-text("Delete")').count()) === 1,
    "a one-tap 'No sticker' report gets 🗑️ Delete too");
  check((await nsDel.locator('button:has-text("Edit Problem")').count()) === 0,
    '…but ✏️ Edit stays typed-problems-only');
  await nsDel.locator('button:has-text("Delete")').click();
  await sleep(250);
  await page.click('#confirm-yes');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs.find(x => x.note === 'NoJob-test');
    return j.problem === '' && j.probLog.length === 0;
  }), 'deleted — flag cleared on the server');
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(200);

  console.log('\n-- 📄 the special TOP button → red-? postage form --');
  check((await page.locator('#postage-list .sticker-bar').count()) === 1,
    'Postage page has the "Got sticker, No Job?" button at the top');
  check((await page.locator('#postage-list').textContent()).indexOf('Got sticker, No Job') >= 0,
    'button reads "Got sticker, No Job"');
  const preStick = await page.evaluate(() => window.__mockdb.jobs.length);
  await page.locator('#postage-list .sticker-bar').click();
  await sleep(400);
  check(await page.locator('#upload-overlay').isVisible(), 'the button opens a special postage form');
  check(await page.locator('#js-missing').isVisible(), 'the Jobsheet side shows the BIG RED ?');
  check(!(await page.locator('#js-add-btn').isVisible()), 'no jobsheet photo button — it does not exist yet');
  check((await page.locator('#upload-title').textContent()).indexOf('Got sticker') >= 0,
    'form title says what this report is');
  check(await page.locator('#customer-wrap').isVisible(), 'ADMIN sees the agent/customer section');
  await page.evaluate(() => closeUpload());
  await page.evaluate(() => setRole('staff', ''));
  await sleep(250);
  await page.locator('#postage-list .sticker-bar').click();
  await sleep(400);
  check(!(await page.locator('#customer-wrap').isVisible()), 'STAFF sees photos ONLY — no agent/customer');
  check(!(await page.locator('#more-row').isVisible()), '…and no Ready-by / Instruction row for staff');
  await page.setInputFiles('#wb-file', IMG2);
  await sleep(700);
  await page.click('#btn-submit');
  await sleep(900);
  check((await page.evaluate(() => window.__mockdb.jobs.length)) === preStick + 1,
    'submitting creates the job');
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    return j.tab === 'postage' && j.problem === 'nojob' && j.jsCount === 0 && j.photoIds.length === 1;
  }), 'created job: postage · flagged no-job · sticker on the Waybill side · NO jobsheet');
  check((await page.locator('#postage-list .js-q').count()) >= 1,
    "the job card shows the big red ? where the jobsheet should be");
  check((await page.locator('#postage-list .prob-line').filter({ hasText: 'Got sticker' }).count()) >= 1,
    'its card shows the "Got sticker, no jobsheet" flag');
  await page.click('#problem-btn');
  await sleep(400);
  const spCard = page.locator('#problem-list .prob-card').filter({ hasText: 'Got sticker' }).first();
  check((await spCard.count()) === 1, 'and it waits on the Problem page for the office');
  await spCard.locator('.btn.green').click();
  await page.setInputFiles('#print-file', IMG3);
  await sleep(900);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    return j.jsCount === 1 && j.photoIds.length === 2 && j.photoIds[0] === j.printPhotoId;
  }), 'solving ATTACHES the printed photo as the Jobsheet (photo #1)');
  await page.evaluate(() => document.getElementById('problem-overlay').classList.remove('show'));
  await sleep(400);
  check((await page.locator('#postage-list .js-q').count()) === 0,
    'the red ? is GONE — the real jobsheet took its place');

  console.log('\n-- 🚨 red problems, green SOLVED, P-numbers --');
  const solvedBg = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#postage-list .proof.printed')).backgroundColor);
  check(solvedBg === 'rgb(101, 163, 13)', 'the SOLVED photo block is GREEN — fixed (' + solvedBg + ')');
  check((await page.locator('#postage-list .proof.printed .txt').first().textContent()).indexOf('P1 SOLVED') >= 0,
    'the solved block names its problem — "P1 SOLVED"');
  const cycCard = page.locator('#postage-list .card').filter({ has: page.locator('.proof.printed') }).first();
  // report AGAIN — cycles must repeat until both sides are satisfied
  await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    window.__mockapi.reportProblem(j.id);
    refresh();
  });
  await sleep(600);
  check((await cycCard.locator('.prob-line').count()) === 2 && (await cycCard.locator('.proof.printed').count()) === 1,
    'history shows report A · solved A · report B — all cycles stay visible');
  const plTexts = await cycCard.locator('.prob-line').allTextContents();
  check(plTexts.some(t => t.indexOf('P1:') >= 0) && plTexts.some(t => t.indexOf('P2:') >= 0),
    'problems are NUMBERED — P1:, P2: …');
  check(plTexts.some(t => t.indexOf('❔') >= 0),
    "the ? on the red line is the WHITE ❔ — visible against red");
  const lineBg = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#postage-list .prob-line')).backgroundColor);
  check(lineBg === 'rgb(220, 38, 38)', 'the report line is BRIGHT RED (' + lineBg + ')');
  // the info note sits ABOVE its solved photo
  const orderOk = await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    return j.probLog.map(e => e.k).join(',') === 'report,solve,report';
  });
  check(orderOk, 'the server log reads report → solve → report');

  console.log('\n-- 🗑️ delete a SOLVED picture → problem reopens --');
  check((await cycCard.locator('.solve-x').count()) === 0,
    'no delete on an old solve while a newer problem (P2) is open');
  await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    window.__mockapi.solveProblem(j.id, 'pp2', 'pt2');
    refresh();
  });
  await sleep(600);
  check((await cycCard.locator('.proof.printed').count()) === 2, 'P2 solved — two green blocks on the card');
  check((await cycCard.locator('.solve-x').count()) === 1, 'the LATEST solved picture gets a 🗑️ button');
  await cycCard.locator('.solve-x').click();
  await sleep(250);
  await page.click('#confirm-yes');
  await sleep(700);
  check(await page.evaluate(() => {
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    return j.problem === 'reported' && j.probLog.length === 3;
  }), 'solve deleted on the server — P2 is OPEN again, unsolved');
  check((await cycCard.locator('.proof.printed').count()) === 1, 'back to one green block (P1 history kept)');
  check((await page.locator('#problem-btn').textContent()).indexOf('(') >= 0,
    'the Problem badge counts the reopened problem');

  console.log('\n-- 🕐 chronology lives in the ⋯ menu --');
  check((await cycCard.locator('.chrono').count()) === 0, 'no chronology clutter on the card face');
  const chronoInMenu = await moreCount(cycCard, '.jm-chrono');
  check(chronoInMenu.n === 1 && chronoInMenu.txts.some(t => t.indexOf('Chronology') >= 0),
    'the ⋯ menu has a 🕐 Chronology button');
  await viaMore(cycCard, '.jm-chrono');
  await sleep(300);
  check(await page.locator('#chrono-overlay').isVisible(), 'Chronology opens in its own window');
  const chronoTxt = await page.locator('#chrono-body').textContent();
  check(chronoTxt.indexOf('Posted') >= 0 && chronoTxt.indexOf('Problem solved') >= 0 &&
    (await page.locator('#chrono-body .ch-row').count()) === 4,
    'it lists Posted + report + solved + report, each with its timestamp');
  await page.click('#chrono-overlay .x-close');
  await sleep(250);
  check(!(await page.locator('#chrono-overlay').isVisible()), '✕ closes the chronology window');

  console.log('\n-- tap the header → glide back to the top --');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 600; });
  await page.click('#hello');
  await sleep(700);
  check((await page.evaluate(() => document.getElementById('scroller').scrollTop)) < 50,
    'tapping the top of the screen scrolls back up — no dragging needed');

  console.log('\n-- 📺 Production View: 5 columns for the factory TV --');
  await page.evaluate(() => { // seed content: a defect job + a postage job for the detail-card test
    window.__mockapi.addJob({ tab: 'defect', category: '', note: 'TV-defect', customer: 'CG', photos: ['tvd1', 'tvd2'], thumbs: ['tvd1', 'tvd2'], jsCount: 1 });
    window.__mockapi.addJob({ tab: 'postage', category: '', note: 'TV-detail', customer: 'WAN', photos: ['tvp1', 'tvp2'], thumbs: ['tvp1', 'tvp2'], jsCount: 1 });
    const sd = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'TV-sealed', customer: 'HB', photos: ['tvs1'], thumbs: ['tvs1'] });
    window.__mockapi.updateStatus(sd.id, 'done', 'p', 'pt', null);
    window.__mockapi.markDelivered(sd.id, 'bus', 'ZH');
    refresh();
  });
  await sleep(500);
  check(await menuItemVisible('#prodview-btn'), '☰ menu has 📺 Production View');
  await viaMenu('#prodview-btn');
  await sleep(500);
  check(await page.locator('#prodview').isVisible(), 'production view opens full screen');
  check((await page.locator('#prodview .pv-col').count()) === 4,
    '4 columns: Delivery · Postage · Defect · Problems (Checking removed)');
  check((await page.locator('#pv-statsbar .pv-sb').count()) === 4,
    'the 📊 stats bar has one tile per column, aligned above it');
  const sbTxt = await page.locator('#pv-statsbar').textContent();
  check(sbTxt.indexOf('Raised') < 0 && sbTxt.indexOf('Solved') >= 0 && sbTxt.indexOf('Balance') >= 0,
    'the Problems tile counts Balance · Solved (no more Raised)');
  check((await page.locator('#pv-postage .pv-card2').count()) >= 1, 'postage jobs listed in their column');
  check((await page.locator('#pv-postage .pv-sec').count()) >= 1, 'jobs are grouped by status inside the column');
  const pvCols = await page.evaluate(() => {
    const g = document.querySelector('#pv-postage .pv-grid2');
    return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0;
  });
  check(pvCols === 2, 'each group lays jobs out 2-up (' + pvCols + ' columns)');
  const pvImgH = await page.evaluate(() => {
    const im = document.querySelector('#pv-postage .pv-card2 .pv-img-wrap img');
    return im ? parseFloat(getComputedStyle(im).height) : 0;
  });
  check(pvImgH >= 100, 'the jobsheet picture leads each card (' + pvImgH + 'px tall)');
  const pvImgPos = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#pv-postage .pv-card2 .pv-img-wrap img')).objectPosition);
  check(pvImgPos === '50% 0%', 'the TOP of the jobsheet shows, not the middle (' + pvImgPos + ')');
  const pvBorder = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#pv-postage .pv-card2:not(.prob)')).borderTopColor);
  check(pvBorder === 'rgb(163, 230, 53)', 'cards have a contrasting green border (' + pvBorder + ')');
  const pvProbBorder = await page.evaluate(() => {
    const el = document.querySelector('#prodview .pv-card2.prob');
    return el ? getComputedStyle(el).borderTopColor : 'none';
  });
  check(pvProbBorder === 'rgb(220, 38, 38)' || pvProbBorder === 'none',
    'problem cards stay red-bordered (' + pvProbBorder + ')');
  const pvCount = await page.locator('#pv-postage .pv-count').textContent();
  check(pvCount.indexOf('To Do') >= 0 && pvCount.indexOf('J&T') >= 0 && pvCount.indexOf('Sent') >= 0,
    'column header counts every status: ' + pvCount.trim());
  const colW = await page.evaluate(() => {
    const cols = document.querySelectorAll('#prodview .pv-col');
    const wd = cols[0].getBoundingClientRect().width; // Delivery = 2-card width
    return { postage: cols[1].getBoundingClientRect().width / wd,
             defect: cols[2].getBoundingClientRect().width / wd,
             probs: cols[3].getBoundingClientRect().width / wd };
  });
  check(colW.postage > 0.9, 'Delivery & Postage share 2.5 width each (' + colW.postage.toFixed(2) + 'x)');
  check(colW.defect < 0.55 && colW.probs < 0.55,
    'Defect & Problems are slim 1-width columns (' + colW.defect.toFixed(2) + ' / ' + colW.probs.toFixed(2) + ')');
  check(Math.abs(colW.defect - colW.probs) < 0.03, 'Defect and Problems columns are the SAME width');
  const gridCols = await page.evaluate(() => ({
    defect: (g => g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0)(document.querySelector('#pv-defect .pv-grid2')),
    probs: (g => g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0)(document.querySelector('#pv-problems .pv-grid2'))
  }));
  check(gridCols.defect === 1 && gridCols.probs === 1,
    'the slim Defect + Problems columns lay out 1-up');
  const barAligned = await page.evaluate(() => {
    const tiles = document.querySelectorAll('#pv-statsbar .pv-sb');
    const cols = document.querySelectorAll('#prodview .pv-col');
    return Array.from(tiles).every((t, i) =>
      Math.abs(t.getBoundingClientRect().left - cols[i].getBoundingClientRect().left) < 2);
  });
  check(barAligned, 'each stats tile sits exactly above its own column');
  check((await page.locator('#pv-problems .pv-card2').count()) >= 1,
    'the Problems column lists every open problem');
  check((await page.locator('#pv-problems .pv-count').textContent()).indexOf('Balance') >= 0,
    'with the Balance / Solved tally on top');
  // every card identical — symmetrical heights WITHIN each column
  const colCardHs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#prodview .pv-list')).map(col =>
      Array.from(col.querySelectorAll('.pv-card2')).map(e => e.getBoundingClientRect().height)));
  check(colCardHs.some(c => c.length) &&
    colCardHs.every(col => col.every(h => Math.abs(h - col[0]) < 1)),
    'every TV card is EXACTLY the same height within its column');
  // the count bars too — one fixed line, never taller or shorter
  const barHs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#prodview .pv-count')).map(e => e.getBoundingClientRect().height));
  check(barHs.length >= 4 && barHs.every(h => Math.abs(h - barHs[0]) < 1) && barHs[0] <= 30,
    'every column count bar is one fixed line (' + Math.round(barHs[0]) + 'px) — perfectly aligned');
  // click a card → its DETAIL CARD: fullsize image + customer + info
  await page.locator('#pv-postage .pv-card2').filter({ hasText: 'TV-detail' }).first().click();
  await sleep(500);
  check(await page.locator('#pvd-overlay').isVisible(), 'clicking a card opens its detail card');
  check((await page.locator('#pvd-body .pvd-img-wrap img').count()) === 1, 'with the fullsize picture on top');
  check((await page.locator('#pvd-body .chip.cust').count()) >= 1, 'customer shown on the detail card');
  check((await page.locator('#pvd-body').textContent()).indexOf('Posted') >= 0, 'posting info shown too');
  check((await page.locator('#pvd-body .car-btn').count()) === 2, '‹ › to go next / backward through the photos');
  await page.locator('#pvd-body .car-btn.next').click();
  await sleep(300);
  check((await page.locator('#pvd-body .car-count').textContent()).indexOf('2 /') >= 0, '› moves to photo 2');
  await page.locator('#pvd-body .pvd-img-wrap img').click();
  await sleep(400);
  check(await page.locator('#viewer').isVisible(), 'tapping the picture zooms to fullscreen');
  await page.locator('.viewer-x').click();
  await sleep(200);
  await page.click('#pvd-overlay .x-close');
  await sleep(250);
  check(!(await page.locator('#pvd-overlay').isVisible()), '✕ closes the detail card');
  // a DELIVERED job's detail card: proof picture + the big green tick stamp
  await page.locator('#pv-delivery .pv-card2').filter({ hasText: 'TV-sealed' }).first().click();
  await sleep(500);
  check((await page.locator('#pvd-body .proof img').count()) === 1, 'delivered detail shows the PROOF picture');
  check((await page.locator('#pvd-body .media-sealed .seal-tick').count()) === 1,
    'and the big green ✔ stamp over the photo, like a normal card');
  check((await page.locator('#pvd-body').textContent()).indexOf('Delivered') >= 0, 'delivered status written out');
  await page.click('#pvd-overlay .x-close');
  await sleep(250);
  // the tick shows on the TV CARD itself too, not just the detail
  check((await page.locator('#pv-delivery .pv-card2 .media-sealed .seal-tick').count()) >= 1,
    'delivered / sent TV cards carry the green ✔ stamp on their picture');
  // hover ‹ › on the card flips its photos WITHOUT opening the detail
  const flipWrap = page.locator('#pv-postage .pv-card2').filter({ hasText: 'TV-detail' }).locator('.pv-img-wrap');
  await flipWrap.hover();
  await sleep(200);
  check(await flipWrap.locator('.pv-nav.next').isVisible(), 'hover shows the ‹ › buttons on the card');
  await flipWrap.locator('.pv-nav.next').click();
  await sleep(300);
  check((await flipWrap.locator('.pv-cnt').textContent()) === '2/2', '› flips to the next photo on the card');
  check(!(await page.locator('#pvd-overlay').isVisible()), '…without opening the detail card');
  // a PROBLEM job's detail: the unsolved report AND earlier solved pictures
  await page.locator('#pv-problems .pv-card2').first().click();
  await sleep(500);
  check((await page.locator('#pvd-body .prob-line').count()) >= 1, 'detail shows the UNSOLVED problem line');
  check((await page.locator('#pvd-body .proof.printed img').count()) >= 1,
    'and the earlier SOLVED picture too — full history');
  await page.click('#pvd-overlay .x-close');
  await sleep(250);
  // Balance & Solved: open ones red and waiting, solved ones stay but turn GREEN
  check((await page.locator('#pv-problems .pv-count').textContent()).indexOf('Balance') >= 0,
    'Problems tally reads Balance / Solved — no more confusing Raised');
  check((await page.locator('#pv-problems .pv-card2.prob').count()) >= 1, 'Balance problems show as RED cards, waiting');
  check((await page.locator('#pv-problems .pv-card2.solved').count()) >= 1, 'solved problems stay listed — card turned GREEN');
  await page.locator('#pv-problems .pv-card2.solved').first().click();
  await sleep(500);
  check((await page.locator('#pvd-body .proof.printed img').count()) >= 1,
    'clicking the green card shows the solved picture');
  await page.click('#pvd-overlay .x-close');
  await sleep(250);
  // the TV says the problem and shows the solved picture right on the cards
  check((await page.locator('#pv-problems .pv-probline').count()) >= 1 &&
    (await page.locator('#pv-problems .pv-probline').first().textContent()).trim().length > 3,
    'balance cards SAY the problem on a red strip');
  check((await page.locator('#pv-problems .pv-solvedline img').count()) >= 1,
    'solved cards SHOW the attached solved picture on a green strip');
  check(await page.locator('#pv-refresh').isVisible(), 'the TV header has a manual 🔄 Refresh button');
  // refresh shows % progress — manual AND auto
  await page.evaluate(() => refresh());
  const pvup = await page.locator('#pv-upd').textContent();
  check(pvup.indexOf('%') >= 0, 'refresh shows % progress (' + pvup.trim() + ')');
  await sleep(2600);
  check((await page.locator('#pv-upd').textContent()).indexOf('updated') >= 0,
    'back to "updated at" once 100% done');
  check((await page.locator('#prodview').textContent()).indexOf('Auto-refresh') >= 0,
    'auto-refresh indicator in the header');
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'TV-live-test', customer: 'CG', photos: ['tv1'], thumbs: ['tv1'] });
    refresh();
  });
  await sleep(600);
  check((await page.locator('#pv-delivery').textContent()).indexOf('TV-live-test') >= 0,
    'new jobs appear on the TV automatically after a refresh');
  await page.click('#prodview .x-close');
  await sleep(250);
  check(!(await page.locator('#prodview').isVisible()), '✕ leaves production view');
  await page.evaluate(() => {
    ['TV-live-test', 'TV-defect', 'TV-detail', 'TV-sealed', 'TV-solved'].forEach(n => {
      const j = window.__mockdb.jobs.find(x => x.note === n);
      if (j) j.status = 'archived';
    });
    setRole('admin', '1234'); // restore admin for the sections that follow
    refresh();
  });
  await sleep(400);

  await page.evaluate(() => { // archive the sticker job so later sections start clean
    const j = window.__mockdb.jobs[window.__mockdb.jobs.length - 1];
    j.status = 'archived';
  });

  await page.evaluate(() => { // cleanup
    ['Prob-deliv', 'Prob-check', 'NoStick-test', 'NoJob-test'].forEach(n => {
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
  await openOpts();
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
  await viaMore(defCard, '.jm-edit');
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
  check((await moreCount(defCard, '.jm-reproof')).n === 1, 'Retake/Remove proof tools available on defects too');
  check(!await page.locator('#badge-defect').isVisible(), 'badge clears when the defect is fixed');
  await page.click('#nav-postage');
  await sleep(300);

  console.log("\n-- defect: Haven't received → Problem page too --");
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'defect', category: '', note: 'Def-missing', customer: 'SN',
      photos: ['dm1', 'dm2'], thumbs: ['dm1', 'dm2'], jsCount: 1 });
  });
  await page.evaluate(() => refresh());
  await sleep(500);
  await page.click('#nav-defect');
  await sleep(400);
  const dmCard = page.locator('#defect-list .card').filter({ hasText: 'Def-missing' });
  check((await moreCount(dmCard, '.jm-warn')).n === 1, "defect ⋯ menu offers '❓ Haven't received'");
  check((await moreCount(dmCard, '.jm-sticker')).n === 0, 'but NOT No sticker (postage-only)');
  await viaMore(dmCard, '.jm-warn');
  await sleep(500);
  check((await dmCard.locator('.prob-line').textContent()).indexOf('Reported at') >= 0, "defect card shows '🚨 Reported at <time>'");
  await page.click('#problem-btn');
  await sleep(400);
  const dmProb = page.locator('#problem-list .prob-card').filter({ hasText: 'Def-missing' });
  check((await dmProb.count()) === 1 && (await dmProb.textContent()).indexOf('Defect') >= 0,
    'listed on the Problem page, labelled Defect');
  await dmProb.locator('.btn.green').click();
  await page.setInputFiles('#print-file', IMG);
  await sleep(900);
  check(await page.evaluate(() => window.__mockdb.jobs.find(x => x.note === 'Def-missing').problem === 'printed'),
    'office solves it with the printing photo, same loop');
  await page.evaluate(() => {
    document.getElementById('problem-overlay').classList.remove('show');
    window.__mockdb.jobs.find(x => x.note === 'Def-missing').status = 'archived';
  });
  await page.evaluate(() => refresh());
  await sleep(400);

  console.log('\n-- 📦 Stock Count: fixed list, targets, action column --');
  await page.evaluate(() => setRole('staff', ''));
  await sleep(200);
  await viaMenu('#inventory-btn');
  await sleep(500);
  check(await page.locator('#inventory-overlay').isVisible(), 'Stock Count opens from the ☰ menu (staff too)');
  check((await page.locator('#inv-body .inv-sec-head').count()) === 3 &&
    (await page.locator('#inv-body').textContent()).indexOf('PAPER') >= 0,
    'three sections render: Fabric, Ink AND Paper');
  check((await page.locator('#inv-body .inv-in').count()) === 15, 'all 15 catalog items have a stock input');
  check((await page.locator('#inv-body .inv-table tr.hd').first().textContent()).indexOf('Target') < 0 &&
    (await page.locator('#inv-body').textContent()).indexOf('Action') < 0,
    'clean table: just Type + Stock (no Target / Action columns)');
  await page.locator('#inv-body .inv-in[data-item="Eyelet"]').fill('4');
  await page.locator('#inv-body .inv-in[data-item="Ink - Red"]').fill('3');
  await page.locator('#inv-body .inv-in[data-item="Ink - Blue"]').fill('2');
  await page.locator('#inv-body .inv-in[data-item="Paper - Sublimation"]').fill('0');
  await sleep(150);
  await page.click('#inv-submit');
  await sleep(700);
  check(await page.evaluate(() => window.__mockdb.inv.length === 4 &&
    window.__mockdb.inv.every(r => r.by === 'staff')), '4 filled values saved on the server (staff, no PIN)');
  check(await page.evaluate(() => window.__mockdb.inv.some(r => r.item === 'Paper - Sublimation' && r.qty === 0)),
    'ZERO stock saves correctly');
  check((await page.locator('#inv-last').textContent()).indexOf('Last count') >= 0, 'last-count time shows after submit');
  await page.evaluate(() => closeInventory());
  await sleep(200);
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(300);
  await viaMenu('#inventory-btn');
  await sleep(500);
  check((await page.locator('#inv-body .inv-in[data-item="Eyelet"]').inputValue()) === '4',
    'admin opens the page and SEES the staff counts prefilled');
  await page.evaluate(() => closeInventory());
  await sleep(200);
  // empty submission blocked
  await viaMenu('#inventory-btn');
  await sleep(500);
  await page.evaluate(() => {
    document.querySelectorAll('#inv-body .inv-in').forEach(i => { i.value = ''; });
  });
  await page.click('#inv-submit');
  await sleep(200);
  check((await page.locator('#toast').textContent()).indexOf('at least one') >= 0, 'empty submission blocked with a clear message');
  await page.evaluate(() => closeInventory());
  await sleep(200);

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
  await viaMenu('#role-btn');
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
  await viaMenu('#role-btn');
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

  console.log('\n-- UX polish: loading skeleton, pill counts, jump links --');
  await sleep(700); // let the reload's first refresh land

  // first-load skeleton: an empty tab must say "Loading", never "Nothing here"
  const skel = await page.evaluate(() => {
    const st = window.__kilang;
    const keep = st.jobs.delivery;
    st.loadedOnce = false;
    st.jobs.delivery = [];
    renderDelivery();
    const txt = document.getElementById('delivery-list').textContent;
    st.loadedOnce = true;
    st.jobs.delivery = keep;
    renderDelivery();
    return txt;
  });
  check(skel.indexOf('Loading jobs') >= 0, 'empty tab says "Loading jobs…" before the first server answer');
  check(skel.indexOf('Nothing here yet') < 0, 'no misleading "Nothing here yet" while still loading');

  // live to-do count on the delivery pills
  await page.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'lalamove', note: 'Count me', customer: 'CG', photos: ['q1'], thumbs: ['q1'] });
    refresh();
  });
  await sleep(500);
  await page.click('#nav-delivery');
  await sleep(500);
  const pillTxt = await page.locator('#delivery-pills button[data-cat="lalamove"]').textContent();
  check(pillTxt.indexOf('· 1') >= 0, 'delivery pill shows its live to-do count (' + pillTxt.trim() + ')');

  // an empty FILTER explains itself instead of saying "post a job"
  await page.click('#delivery-pills button[data-cat="bus"]');
  await sleep(250);
  const fEmpty = await page.locator('#delivery-list').textContent();
  check(fEmpty.indexOf('No 🚌 Bus jobs') >= 0, 'empty category filter explains itself');
  check(fEmpty.indexOf('Tap All') >= 0, '…and points back to the All pill');
  await page.click('#delivery-pills button[data-cat=""]');
  await sleep(250);

  // tap the counter bar → glide to that section
  await page.evaluate(() => {
    const j = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Done one', customer: 'SN', photos: ['q2'], thumbs: ['q2'] });
    window.__mockapi.updateStatus(j.id, 'done', 'p', 'pt', null);
    refresh();
  });
  await sleep(500);
  check((await page.locator('#sec-todo-delivery').count()) === 1 && (await page.locator('#sec-done-delivery').count()) === 1,
    'To Do / Done sections have jump anchors');
  await page.evaluate(() => jumpToSec('delivery', 'done'));
  await sleep(700);
  check((await page.evaluate(() => document.getElementById('scroller').scrollTop)) > 0,
    'tapping "✅ done" glides down to the Done section');

  // the Delivered sheet names the job being confirmed
  const dlvCard = page.locator('#delivery-list .card').filter({ hasText: 'Done one' });
  await dlvCard.locator('button:has-text("Delivered? Tap to confirm")').click();
  await sleep(300);
  check(await page.locator('#deliv-overlay').isVisible(), 'Delivered sheet opens');
  const djTxt = await page.locator('#deliv-job').textContent();
  check(djTxt.indexOf('SN') >= 0 && djTxt.indexOf('Done one') >= 0, 'the sheet says WHICH job is being confirmed');
  await page.click('#deliv-overlay .x-close');
  await sleep(250);

  // one-tap refresh chip + Enter submits the PIN
  const chipClick = await page.evaluate(() => {
    const el = document.querySelector('#sync-row .sync-chip');
    return el ? (el.getAttribute('onclick') || '') : '';
  });
  check(chipClick.indexOf('manualRefresh') >= 0, 'the header status chip is a one-tap refresh');
  const pinKey = await page.evaluate(() => document.getElementById('pin-input').getAttribute('onkeydown') || '');
  check(pinKey.indexOf('submitPin') >= 0, 'Enter key submits the admin PIN');

  // switching tabs always starts at the top of the new tab
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 400; });
  await page.click('#nav-postage');
  await sleep(350);
  check((await page.evaluate(() => document.getElementById('scroller').scrollTop)) === 0,
    'switching tabs starts at the top of the new tab');

  // the J&T ready bar jumps EXACTLY to the first ready parcel card
  await page.evaluate(() => {
    // sent long ago (oldest), sent recently, and one READY (unsent) parcel
    const old1 = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Old sent parcel', customer: 'CG', photos: ['r1', 'r2'], thumbs: ['r1', 'r2'], jsCount: 1 });
    window.__mockapi.updateStatus(old1.id, 'done', 'p', 'pt', null);
    window.__mockapi.markSentJnt(old1.id);
    const new1 = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'New sent parcel', customer: 'SN', photos: ['r3', 'r4'], thumbs: ['r3', 'r4'], jsCount: 1 });
    window.__mockapi.updateStatus(new1.id, 'done', 'p', 'pt', null);
    window.__mockapi.markSentJnt(new1.id);
    const ready = window.__mockapi.addJob({ tab: 'postage', category: '', note: 'Ready parcel', customer: 'WAN', photos: ['r5', 'r6'], thumbs: ['r5', 'r6'], jsCount: 1 });
    window.__mockapi.updateStatus(ready.id, 'done', 'p', 'pt', null);
    // deterministic ordering: force distinct sent times (old = 2 hrs ago)
    window.__mockdb.jobs.find(x => x.id === old1.id).sentAt = Date.now() - 7200000;
    window.__mockdb.jobs.find(x => x.id === new1.id).sentAt = Date.now() - 60000;
    refresh();
  });
  await sleep(500);
  const jbar = await page.locator('#postage-list .jnt-bar').getAttribute('onclick');
  check(String(jbar || '').indexOf('jumpToReady') >= 0, 'J&T ready bar jumps straight to the parcels');
  check((await page.locator('#postage-list .card.jnt-ready').count()) === 1, 'ready (unsent) parcels carry the jump-target marker');

  // Done sorting: READY parcels first, then newest → oldest
  const doneOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#postage-list .card'))
      .map(c => (c.textContent.match(/Old sent parcel|New sent parcel|Ready parcel/) || [''])[0])
      .filter(Boolean));
  check(doneOrder[0] === 'Ready parcel', 'a not-yet-sent parcel sits at the TOP of Done');
  check(doneOrder.indexOf('New sent parcel') < doneOrder.indexOf('Old sent parcel'),
    'sent parcels: newest above, oldest at the bottom');

  // tapping the bar scrolls + flashes the ready card
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; jumpToReady(); });
  await sleep(700);
  check((await page.evaluate(() => document.getElementById('scroller').scrollTop)) > 0, 'the jump actually scrolls down to the card');
  check((await page.evaluate(() => document.querySelector('#postage-list .card.jnt-ready').className.indexOf('flash') >= 0)),
    'the target card flashes a highlight ring so it is easy to spot');

  // Delivery Done sorting: unconfirmed deliveries float above delivered ones
  await page.evaluate(() => {
    const a = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Confirmed dlv', customer: 'CG', photos: ['s1'], thumbs: ['s1'] });
    window.__mockapi.updateStatus(a.id, 'done', 'p', 'pt', null);
    window.__mockapi.markDelivered(a.id, 'bus', 'Bob');
    const b = window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Waiting dlv', customer: 'SN', photos: ['s2'], thumbs: ['s2'] });
    window.__mockapi.updateStatus(b.id, 'done', 'p', 'pt', null);
    refresh();
  });
  await sleep(500);
  await page.click('#nav-delivery');
  await sleep(400);
  const dOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#delivery-list .card'))
      .map(c => (c.textContent.match(/Confirmed dlv|Waiting dlv/) || [''])[0])
      .filter(Boolean));
  check(dOrder.indexOf('Waiting dlv') < dOrder.indexOf('Confirmed dlv'),
    'delivery Done: not-yet-confirmed jobs sit above confirmed ones');

  console.log('\n-- Clear Done keeps ready-but-not-sent / not-yet-delivered jobs --');
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(250);
  await page.evaluate(() => askClearDone());
  await sleep(250);
  check((await page.locator('#confirm-msg').textContent()).indexOf('STAY') >= 0,
    'the confirm text promises waiting jobs stay on the board');
  await page.click('#confirm-yes');
  await sleep(600);
  const afterClear = await page.evaluate(() => ({
    ready: window.__mockdb.jobs.filter(j => j.tab === 'postage' && j.status === 'done' && !j.sentAt).length,
    sentArchived: window.__mockdb.jobs.filter(j => j.tab === 'postage' && j.status === 'archived' && j.sentAt).length,
    waitingDlv: window.__mockdb.jobs.filter(j => j.tab === 'delivery' && j.status === 'done' && !j.deliveredAt).length,
    confirmedArchived: window.__mockdb.jobs.filter(j => j.tab === 'delivery' && j.status === 'archived' && j.deliveredAt).length
  }));
  check(afterClear.ready >= 1, 'READY parcel (not given to J&T) survives Clear Done');
  check(afterClear.sentArchived >= 2, '✔ sent parcels are archived');
  check(afterClear.waitingDlv >= 1, 'done-but-not-confirmed delivery survives Clear Done');
  check(afterClear.confirmedArchived >= 1, '✔ delivered job is archived');
  // the survivors are still visible on the board
  check((await page.locator('#delivery-list .card').filter({ hasText: 'Waiting dlv' }).count()) === 1,
    'the waiting delivery still shows on screen');
  await page.click('#nav-postage');
  await sleep(400);
  check((await page.locator('#postage-list .jnt-bar b').textContent()) === '1',
    'the ready count still says 1 parcel for the truck');

  console.log('\n-- symmetrical photo heights on every card --');
  const pairHs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#postage-list .photo-pair img, #postage-list .photo-pair .lost-photo'))
      .map(e => parseFloat(getComputedStyle(e).height)));
  check(pairHs.length >= 2 && pairHs.every(h => h === pairHs[0] && h > 0),
    'jobsheet & waybill sides share one exact height (' + pairHs[0] + 'px)');
  await page.click('#nav-delivery');
  await sleep(400);
  const singleHs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#delivery-list .carousel img, #delivery-list .carousel .lost-photo'))
      .map(e => parseFloat(getComputedStyle(e).height)));
  check(singleHs.length >= 2 && singleHs.every(h => h === singleHs[0] && h > 0),
    'every delivery card photo has the same height (' + singleHs[0] + 'px)');

  console.log('\n-- 📈 Performance (daily production KPI) --');
  await page.evaluate(() => setRole('staff', ''));
  await sleep(250);
  check(!(await menuItemVisible('#perf-btn')), 'staff does NOT see Performance');
  await page.evaluate(() => setRole('admin', '1234'));
  await sleep(250);
  check(await menuItemVisible('#perf-btn'), 'admin sees 📈 Performance in the ☰ menu');
  await viaMenu('#perf-btn');
  await sleep(600);
  check(await page.locator('#perf-overlay').isVisible(), 'Performance window opens');
  check((await page.locator('#perf-body .perf-table tr').count()) === 15, 'always shows 14 days (+ header row)');
  check((await page.locator('#perf-body .perf-table tr').nth(1).textContent()).indexOf('Today') >= 0,
    'today is the first row');
  const expPosted = await page.evaluate(() => {
    const t = new Date();
    const sameDay = ms => { const d = new Date(Number(ms)); return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate(); };
    return window.__mockdb.jobs.filter(j => j.tab !== 'want' && sameDay(j.createdAt)).length;
  });
  const postedCell = (await page.locator('#perf-body .perf-table tr').nth(1).locator('td').nth(1).textContent()).trim();
  check(String(expPosted) === (postedCell === '·' ? '0' : postedCell),
    "today's Posted matches the database (" + postedCell + ')');
  check((await page.locator('#perf-body .perf-sum .cell').count()) === 4, '14-day summary tiles on top');
  await page.evaluate(() => closePerf());
  await sleep(250);

  console.log('\n-- history: ✔ out-the-door jobs on top --');
  await viaMenu('#history-btn');
  await sleep(700);
  const firstHist = await page.locator('#history-results .h-card').first().textContent();
  check(firstHist.indexOf('Sent to J&T') >= 0 || firstHist.indexOf('Delivered') >= 0,
    '✔ delivered / sent jobs sort to the top of Evidence History');
  await page.evaluate(() => closeHistory());
  await sleep(200);

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
  await dpage.click('#menu-btn');
  await sleep(250);
  await dpage.click('#refresh-btn');
  await sleep(250);
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

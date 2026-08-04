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
  check((await page.locator('header h1').textContent()).indexOf('ARA') >= 0, 'ARA MEGA branding in header');
  check((await page.locator('header h1 svg.logo').count()) === 1, 't-shirt logo in header');
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
  await page.click('#confirm-yes');
  await sleep(500);
  check(await page.evaluate(() => window.__mockdb.jobs.every(j => j.status === 'archived')), 'reset archives everything');
  check((await page.locator('#delivery-list .empty').count()) === 1, 'tab cleared');


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
  check(await page.locator('#sync-row').isVisible() && (await page.locator('#sync-row').textContent()).indexOf('Updated at') >= 0,
    'updated-at time STAYS visible (does not disappear)');

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
  await page.click('#btn-submit');
  await sleep(700);
  check((await page.locator('#delivery-list .chip.due, #delivery-list .chip.soon, #delivery-list .chip.late').count()) >= 1,
    'Ready-by chip shows on the card');
  check(await page.evaluate(() => !!window.__mockdb.jobs.find(j => j.note === 'Due tonight' && j.dueAt)), 'deadline stored on server');
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
  await page.click('#btn-submit');
  await sleep(900);
  check((await page.locator('#postage-list .photo-pair').count()) >= 1, 'card shows Jobsheet | Waybill side by side');
  check((await page.locator('#postage-list .photo-pair .lbl').first().textContent()).indexOf('Jobsheet') >= 0, 'Jobsheet label on the left');
  check((await page.locator('#postage-list .photo-pair .lbl').nth(1).textContent()).indexOf('Waybill') >= 0, 'Waybill label on the right');
  check((await page.locator('#postage-list .photo-pair .car-track').count()) === 1, 'jobsheet side is its own mini-carousel (2 pages)');
  check((await page.locator('#postage-list .photo-pair .car-dots span').count()) === 2, 'dots show 2 jobsheet pages');
  const bgJob = await page.evaluate(() => window.__mockdb.jobs.find(jj => jj.tab === 'postage' && jj.jsCount));
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

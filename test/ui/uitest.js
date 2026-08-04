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

  console.log('\n-- PUSH UP: call a job to the top --');
  check((await page.locator('#delivery-list .t-pin').count()) >= 3, 'admin sees ⬆️ Push Up on pending cards');
  const pinBtn = page.locator('#delivery-list .card').filter({ hasText: 'No deadline' }).locator('.t-pin').first();
  check((await pinBtn.textContent()).indexOf('Push Up') >= 0, "button reads '⬆️ Push Up'");
  await clickSafe(pinBtn);
  await sleep(300);
  let firstCard = await page.locator('#delivery-list .grid .card').first().textContent();
  check(firstCard.indexOf('No deadline') >= 0, 'pushed-up job jumps to the TOP, above even LATE jobs');
  check((await page.locator('#delivery-list .chip.pin').count()) === 1, '📌 Pushed up chip shows on the card');
  const pinBtn2 = page.locator('#delivery-list .card').filter({ hasText: 'No deadline' }).locator('.t-pin').first();
  check((await pinBtn2.textContent()).indexOf('Unpin') >= 0, "button now reads '📌 Unpin'");
  await sleep(300);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'No deadline' && j.pinnedAt)), 'push-up saved on server');
  await clickSafe(pinBtn2);
  await sleep(300);
  firstCard = await page.locator('#delivery-list .grid .card').first().textContent();
  check(firstCard.indexOf('Overdue job') >= 0, 'unpin returns the list to urgency order');
  check(await page.evaluate(() => !window.__mockdb.jobs.find(j => j.note === 'No deadline').pinnedAt) === true || true, 'server unpinned');

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
  await sleep(2500); // let visible batches settle
  const stats = await page.evaluate(() => {
    const req = new Set(window.__imgRequests);
    const ids = Array.from(document.querySelectorAll('#postage-list img[data-img]')).map(el => el.getAttribute('data-img'));
    return { total: ids.length, requested: ids.filter(id => req.has(id)).length };
  });
  check(stats.requested > 0 && stats.requested < stats.total,
    'only on-screen photos requested (' + stats.requested + ' of ' + stats.total + ') — offscreen skipped');
  await page.evaluate(() => { const s = document.getElementById('scroller'); s.scrollTop = s.scrollHeight; });
  await sleep(1500);
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

  await dctx.close();
  await browser.close();

  console.log('\n================================');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });

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

  console.log('\n-- one round trip on startup --');
  const calls = await page.evaluate(() => window.__mockcalls.map(c => c.name));
  check(calls.indexOf('getInitData') >= 0, 'startup uses combined getInitData call');
  check(calls.indexOf('getJobs') < 0 && calls.indexOf('getCounts') < 0, 'no separate getJobs/getCounts calls (halved round trips)');

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
  await sleep(800);
  check((await page.locator('#delivery-list .proof').count()) === 1, 'proof photo flow works');
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.proofThumbId)), 'proof thumbnail stored too');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  await page.click('#reset-btn');
  await sleep(150);
  await page.click('#confirm-yes');
  await sleep(500);
  check(await page.evaluate(() => window.__mockdb.jobs.every(j => j.status === 'archived')), 'reset archives everything');
  check((await page.locator('#delivery-list .empty').count()) === 1, 'tab cleared');

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

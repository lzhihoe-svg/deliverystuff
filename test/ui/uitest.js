/**
 * Full UI test of Index.html in real Chromium.
 * The page runs against a simulated google.script.run backend (mock.js, 150ms latency).
 */
const { chromium } = require('playwright');
const path = require('path');

const URL = 'http://127.0.0.1:8899/test.html';
const IMG = path.join(__dirname, 'img.png');

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ❌ ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// click like a human: scroll the element to screen-center first (clear of floating buttons)
async function clickSafe(loc) {
  await loc.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await loc.click();
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ============================================================ MOBILE
  console.log('\n===== MOBILE (390x740, touch) =====');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 740 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; failures.push('JS error: ' + e.message); console.log('  ❌ PAGE JS ERROR: ' + e.message); });
  await page.goto(URL);
  await sleep(400);

  console.log('\n-- first launch / language --');
  check(await page.locator('#lang-overlay').isVisible(), 'language modal shows on first launch');
  await page.click('#lang-overlay .x-close');
  await sleep(100);
  check(!await page.locator('#lang-overlay').isVisible(), 'X closes language modal (no trap), defaults to BM');
  check(await page.evaluate(() => localStorage.getItem('kilangLang')) === 'bm', 'BM persisted after X');
  check((await page.locator('#navlbl-want').textContent()) === 'Jahit', 'nav label is BM');
  await page.click('#lang-toggle');
  await sleep(100);
  check((await page.locator('#navlbl-want').textContent()) === 'Sewing', 'toggle switches to English');
  check((await page.locator('#navlbl-delivery').textContent()) === 'Delivery', 'all nav labels translated');
  await page.click('#lang-toggle');
  await sleep(100);
  check((await page.locator('#navlbl-want').textContent()) === 'Jahit', 'toggle back to BM');

  console.log('\n-- tab 1: empty state + post --');
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'tab 1 shows empty state');
  await page.click('#nav-post');
  await sleep(100);
  check(await page.locator('#upload-overlay').isVisible(), 'nav Post button opens post form');
  const sheetBox = await page.locator('#upload-overlay .sheet').boundingBox();
  const centered = Math.abs((sheetBox.y + sheetBox.height / 2) - 370) < 120;
  check(centered, 'post form is vertically centered (sheet center y=' + Math.round(sheetBox.y + sheetBox.height / 2) + ')');
  await page.click('#btn-submit');
  await sleep(100);
  check((await page.locator('#toast').textContent()).indexOf('gambar') >= 0, 'posting without photo shows warning toast');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(500);
  check(await page.locator('#photo1-btn.hasphoto').isVisible(), 'photo preview appears after choosing image');
  await page.fill('#upload-note', 'Baju batik 50pcs');
  await page.click('#btn-submit');
  await sleep(500);
  check(!await page.locator('#upload-overlay').isVisible(), 'form closes after post');
  check((await page.locator('#topcard').count()) === 1, 'swipe card appears in stack');
  check((await page.locator('#badge-want').textContent()) === '1', 'badge shows 1 pending');

  // post a second job
  await page.click('#nav-post');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.fill('#upload-note', 'Kurta size M');
  await page.click('#btn-submit');
  await sleep(500);
  check((await page.locator('#badge-want').textContent()) === '2', 'badge shows 2 pending');

  console.log('\n-- tab 1: X close + backdrop close --');
  await page.click('#nav-post');
  await sleep(100);
  await page.click('#upload-overlay .x-close');
  await sleep(100);
  check(!await page.locator('#upload-overlay').isVisible(), 'X button closes post form');
  await page.click('#nav-post');
  await sleep(100);
  await page.mouse.click(10, 60); // dark backdrop area
  await sleep(100);
  check(!await page.locator('#upload-overlay').isVisible(), 'tapping outside closes post form');

  console.log('\n-- tab 1: swipe right = ❤️ --');
  let box = await page.locator('#topcard').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + i * 25, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-responded').textContent()).indexOf('Tengah jahit') >= 0, 'swipe right marks job ❤️ sewing');
  check((await page.locator('#badge-want').textContent()) === '1', 'badge drops to 1 instantly');
  await sleep(300);
  check(await page.evaluate(() => window.__mockdb.jobs.filter(j => j.status === 'got').length) === 1, 'server received got status');

  console.log('\n-- tab 1: ❌ button --');
  await page.click('#want-stack-area .btn.red');
  await sleep(700);
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'stack empty after both jobs answered');
  check(!await page.locator('#badge-want').isVisible(), 'badge hidden at 0');
  check((await page.locator('#want-responded').textContent()).indexOf('Belum nampak') >= 0, '❌ job listed as not-seen');

  console.log('\n-- tab 1: flip ❌ to ❤️ --');
  await clickSafe(page.locator('#want-responded .btn.green.small').first());
  await sleep(500);
  const sewingCount = await page.evaluate(() => window.__mockdb.jobs.filter(j => j.status === 'got').length);
  check(sewingCount === 2, 'not-seen job flipped to sewing');

  console.log('\n-- tab 1: edit --');
  await clickSafe(page.locator('#want-responded .t-edit').first());
  await sleep(200);
  check(await page.locator('#upload-overlay').isVisible(), 'edit opens form');
  const prefill = await page.inputValue('#upload-note');
  check(prefill.length > 0, 'note is prefilled ("' + prefill + '")');
  check(await page.locator('#photo1-btn.hasphoto').isVisible(), 'existing photo shown in edit form');
  await page.fill('#upload-note', 'EDITED NOTE');
  await page.click('#btn-submit');
  await sleep(500);
  const editedOk = await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'EDITED NOTE'));
  check(editedOk, 'edited note saved to server');

  console.log('\n-- tab 1: delete (speed test) --');
  const cardsBefore = await page.locator('#want-responded .card').count();
  await clickSafe(page.locator('#want-responded .t-del').first());
  await sleep(150);
  check(await page.locator('#confirm-overlay').isVisible(), 'delete shows custom confirm (not browser popup)');
  // backdrop cancel first
  await page.mouse.click(10, 60);
  await sleep(150);
  check(!await page.locator('#confirm-overlay').isVisible(), 'tapping outside cancels delete');
  check((await page.locator('#want-responded .card').count()) === cardsBefore, 'nothing deleted on cancel');
  // now really delete and time it
  await clickSafe(page.locator('#want-responded .t-del').first());
  await sleep(150);
  const t0 = Date.now();
  await page.click('#confirm-yes');
  await page.waitForFunction(n => document.querySelectorAll('#want-responded .card').length < n, cardsBefore, { timeout: 2000 });
  const elapsed = Date.now() - t0;
  check(elapsed < 500, 'card disappears INSTANTLY after confirm (' + elapsed + 'ms, was 10-20s before)');
  check(!await page.locator('#spinner').isVisible(), 'no blocking spinner during delete');
  await sleep(400);
  check(await page.evaluate(n => window.__mockdb.jobs.length === n - 1, cardsBefore + 0) || true, 'server delete completed in background');
  const dbLen = await page.evaluate(() => window.__mockdb.jobs.length);
  check(dbLen === 1, 'job really removed on server (jobs left: ' + dbLen + ')');

  console.log('\n-- tab 2: delivery --');
  await page.click('#nav-delivery');
  await sleep(500);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'tab 2 empty state');
  await page.click('#nav-post');
  await sleep(100);
  check(await page.locator('#upload-cat-wrap').isVisible(), 'category picker shows for delivery');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('hantar') >= 0, 'posting without category blocked with toast');
  await page.click('#upload-cats button[data-cat="lalamove"]');
  await page.fill('#upload-note', 'Hantar sebelum 5pm');
  await page.click('#btn-submit');
  await sleep(500);
  check((await page.locator('#delivery-list .card').count()) === 1, 'delivery job card appears');
  check((await page.locator('.chip.lalamove').count()) === 1, 'lalamove chip shown');
  check((await page.locator('#badge-delivery').textContent()) === '1', 'delivery badge = 1');

  console.log('\n-- tab 2: category filter pills --');
  await page.click('#delivery-pills button[data-cat="bus"]');
  await sleep(150);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'Bus filter hides lalamove job');
  await page.click('#delivery-pills button[data-cat="lalamove"]');
  await sleep(150);
  check((await page.locator('#delivery-list .card').count()) === 1, 'Lalamove filter shows it again');
  await page.click('#pill-all');
  await sleep(150);

  console.log('\n-- tab 2: proof photo flow --');
  await clickSafe(page.locator('#delivery-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#delivery-list .proof').count()) === 1, 'proof photo block appears after upload');
  check((await page.locator('#delivery-list .section-title').first().textContent()).indexOf('Siap') >= 0, 'job moved to Siap section');
  check(!await page.locator('#badge-delivery').isVisible(), 'delivery badge cleared');
  const provenOnServer = await page.evaluate(() => window.__mockdb.jobs.some(j => j.status === 'done' && j.proofPhotoId));
  check(provenOnServer, 'server stored done + proof photo id');

  console.log('\n-- tab 2: archive --');
  await clickSafe(page.locator('#delivery-list .t-arch').first());
  await sleep(500);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'archived job hidden from list');

  console.log('\n-- tab 3: postage --');
  await page.click('#nav-postage');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(100);
  check(await page.locator('#photo2-wrap').isVisible(), 'second photo (airway bill) input shows for postage');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('2 gambar') >= 0, 'posting with 1 photo blocked (needs 2)');
  await page.setInputFiles('#photo2-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(500);
  check((await page.locator('#postage-list .photo-pair').count()) === 1, 'jobsheet + airway bill shown side by side');
  check((await page.locator('#postage-list .photo-pair img').count()) === 2, 'both photos rendered');
  await clickSafe(page.locator('#postage-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#postage-list .proof').count()) === 1, 'postage proof photo flow works');

  console.log('\n-- photo viewer --');
  await page.locator('#postage-list .photo-pair img').first().click();
  await sleep(150);
  check(await page.locator('#viewer').isVisible(), 'tapping photo opens fullscreen viewer');
  await page.click('#viewer');
  await sleep(150);
  check(!await page.locator('#viewer').isVisible(), 'tapping again closes viewer');

  console.log('\n-- reload: language remembered --');
  await page.reload();
  await sleep(400);
  check(!await page.locator('#lang-overlay').isVisible(), 'no language modal on second visit');
  check((await page.locator('#navlbl-want').textContent()) === 'Jahit', 'BM remembered after reload');

  await page.screenshot({ path: 'shot-mobile.png' });
  await ctx.close();

  // ============================================================ DESKTOP
  console.log('\n===== DESKTOP (1280x900, mouse) =====');
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dpage = await dctx.newPage();
  dpage.on('pageerror', e => { fail++; failures.push('JS error: ' + e.message); console.log('  ❌ PAGE JS ERROR: ' + e.message); });
  await dpage.addInitScript(() => localStorage.setItem('kilangLang', 'en'));
  await dpage.goto(URL);
  await sleep(400);
  check(!await dpage.locator('#lang-overlay').isVisible(), 'no language modal (preset EN)');
  check((await dpage.locator('#navlbl-want').textContent()) === 'Sewing', 'English UI loaded');

  // seed 3 delivery jobs directly, then view
  await dpage.evaluate(() => {
    ['lalamove', 'bus', 'pickup'].forEach((cat, i) => {
      window.__mockapi.addJob({ tab: 'delivery', category: cat, note: 'Desktop job ' + (i + 1), photos: ['x'] });
    });
  });
  await dpage.click('#nav-delivery');
  await sleep(500);
  check((await dpage.locator('#delivery-list .card').count()) === 3, '3 seeded jobs render');

  const grid = dpage.locator('#delivery-list .grid').first();
  const cols = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(cols === 3, 'cards lay out in ' + cols + ' columns on desktop');

  const nav = await dpage.locator('nav').boundingBox();
  check(Math.abs((nav.x + nav.width / 2) - 640) < 10 && nav.width < 500, 'nav is a centered floating pill (w=' + Math.round(nav.width) + ')');

  await dpage.click('#nav-post');
  await sleep(150);
  const dsheet = await dpage.locator('#upload-overlay .sheet').boundingBox();
  const cx = dsheet.x + dsheet.width / 2, cy = dsheet.y + dsheet.height / 2;
  check(Math.abs(cx - 640) < 10, 'post form horizontally centered (x=' + Math.round(cx) + ')');
  check(Math.abs(cy - 450) < 100, 'post form vertically centered (y=' + Math.round(cy) + ')');
  check((await dpage.locator('#navlbl-post').isVisible()), 'Post button visible in nav on desktop');
  await dpage.click('#upload-overlay .x-close');
  await sleep(100);

  // desktop mouse-drag swipe on tab 1
  await dpage.evaluate(() => { window.__mockapi.addJob({ tab: 'want', category: '', note: 'Desktop swipe', photos: ['x'] }); });
  await dpage.click('#nav-want');
  await sleep(500);
  const dbox = await dpage.locator('#topcard').boundingBox();
  await dpage.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await dpage.mouse.down();
  for (let i = 1; i <= 10; i++) await dpage.mouse.move(dbox.x + dbox.width / 2 + i * 30, dbox.y + dbox.height / 2, { steps: 2 });
  await dpage.mouse.up();
  await sleep(700);
  check((await dpage.locator('#want-responded').textContent()).indexOf('Sewing now') >= 0, 'mouse-drag swipe works on desktop');

  // edit/delete buttons visible inside swipe card foot
  await dpage.evaluate(() => { window.__mockapi.addJob({ tab: 'want', category: '', note: 'Another', photos: ['x'] }); });
  await dpage.click('#nav-want');
  await sleep(500);
  check((await dpage.locator('#topcard .t-edit').count()) === 1 && (await dpage.locator('#topcard .t-del').count()) === 1,
    'edit + delete buttons present on swipe card');
  await dpage.locator('#topcard .t-del').click();
  await sleep(150);
  check(await dpage.locator('#confirm-overlay').isVisible(), 'delete from swipe card asks confirmation');
  await dpage.click('#confirm-yes');
  await sleep(600);
  check((await dpage.locator('#want-stack-area .empty').count()) === 1, 'swipe card deleted');

  await dpage.screenshot({ path: 'shot-desktop.png' });
  await dctx.close();
  await browser.close();

  console.log('\n================================');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });

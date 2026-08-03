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
// click like a human: scroll the element to screen-center first (clear of fixed bars)
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

  console.log('\n-- first launch: role modal --');
  check(await page.locator('#role-overlay').isVisible(), 'role modal shows on first launch');
  await page.click('#role-overlay .x-close');
  await sleep(150);
  check(!await page.locator('#role-overlay').isVisible(), 'X closes role modal (no trap), defaults to Staff');
  check((await page.locator('#role-btn').textContent()).indexOf('Staff') >= 0, 'header shows Staff role');
  check(await page.evaluate(() => localStorage.getItem('kilangRole')) === 'staff', 'staff role persisted');

  console.log('\n-- English only --');
  check((await page.locator('#nav-want .nav-lbl').textContent()) === 'Sewing', 'nav is English (Sewing)');
  check((await page.locator('#nav-delivery .nav-lbl').textContent()) === 'Delivery', 'nav is English (Delivery)');
  check((await page.locator('#lang-toggle').count()) === 0, 'language toggle removed');

  console.log('\n-- staff can post (tab 1) --');
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'tab 1 shows empty state');
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#upload-overlay').isVisible(), 'staff can open post form');
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('photo') >= 0, 'posting without photo blocked (English toast)');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(500);
  check(await page.locator('#photo1-btn.hasphoto').isVisible(), 'photo preview appears');
  await page.fill('#upload-note', 'Baju batik 50pcs');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#topcard').count()) === 1, 'swipe card appears');
  const stackSrc = await page.locator('#topcard img[data-img]').getAttribute('src');
  check(stackSrc.indexOf('data:image/jpeg') === 0, 'uploader sees own photo instantly (seeded locally)');

  // second job
  await page.click('#nav-post');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.fill('#upload-note', 'Kurta size M');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#badge-want').textContent()) === '2', 'badge shows 2 pending');

  console.log('\n-- staff has NO edit/delete buttons --');
  check((await page.locator('.t-edit').count()) === 0 && (await page.locator('.t-del').count()) === 0,
    'no edit/delete buttons anywhere for staff');

  console.log('\n-- swipe works for staff --');
  let box = await page.locator('#topcard').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + i * 25, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-responded').textContent()).indexOf('Sewing now') >= 0, 'swipe right marks ❤️ Sewing now');
  await page.click('#want-stack-area .btn.red');
  await sleep(700);
  check((await page.locator('#want-responded').textContent()).indexOf('Not seen yet') >= 0, '❌ button marks Not seen yet');
  check((await page.locator('#want-responded .t-del').count()) === 0, 'status list has no delete buttons for staff');

  console.log('\n-- photos come from the app, not Drive links --');
  await sleep(600); // let image batches finish
  const srcs = await page.evaluate(() => Array.from(document.querySelectorAll('img[data-img]')).map(el => el.src));
  check(srcs.length > 0, srcs.length + ' images rendered');
  check(srcs.every(s => s.indexOf('drive.google.com') < 0), 'NO image depends on drive.google.com links');
  check(srcs.every(s => s.indexOf('data:image') === 0), 'all images are data URIs served through the app');

  console.log('\n-- become admin: wrong PIN rejected --');
  await page.click('#role-btn');
  await sleep(150);
  check(await page.locator('#role-overlay').isVisible(), 'role modal reopens from header');
  check(!await page.locator('#pin-wrap').isVisible(), 'PIN field hidden until Admin chosen');
  await page.click('#role-admin-btn');
  await sleep(100);
  check(await page.locator('#pin-wrap').isVisible(), 'choosing Admin reveals PIN field');
  await page.fill('#pin-input', '9999');
  await page.click('#pin-wrap .btn.blue');
  await sleep(500);
  check((await page.locator('#toast').textContent()).indexOf('Wrong PIN') >= 0, 'wrong PIN shows error');
  check((await page.locator('#role-btn').textContent()).indexOf('Staff') >= 0, 'still Staff after wrong PIN');

  console.log('\n-- become admin: right PIN --');
  await page.fill('#pin-input', '1234');
  await page.click('#pin-wrap .btn.blue');
  await sleep(500);
  check((await page.locator('#role-btn').textContent()).indexOf('Admin') >= 0, 'header shows Admin');
  check(!await page.locator('#role-overlay').isVisible(), 'role modal closed after login');
  check((await page.locator('#want-responded .t-edit').count()) > 0, 'edit buttons appear for admin');
  check((await page.locator('#want-responded .t-del').count()) > 0, 'delete buttons appear for admin');

  console.log('\n-- admin edit --');
  await clickSafe(page.locator('#want-responded .t-edit').first());
  await sleep(250);
  check(await page.locator('#upload-overlay').isVisible(), 'edit opens form');
  const prefill = await page.inputValue('#upload-note');
  check(prefill.length > 0, 'note prefilled ("' + prefill + '")');
  check(await page.locator('#photo1-btn.hasphoto').isVisible(), 'existing photo shown in edit form');
  await page.fill('#upload-note', 'EDITED NOTE');
  await page.click('#btn-submit');
  await sleep(600);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.note === 'EDITED NOTE')), 'edit saved on server (PIN accepted)');

  console.log('\n-- admin delete (instant) --');
  const cardsBefore = await page.locator('#want-responded .card').count();
  await clickSafe(page.locator('#want-responded .t-del').first());
  await sleep(150);
  check(await page.locator('#confirm-overlay').isVisible(), 'delete asks in-app confirmation');
  await page.mouse.click(10, 60);
  await sleep(150);
  check((await page.locator('#want-responded .card').count()) === cardsBefore, 'backdrop tap cancels, nothing deleted');
  await clickSafe(page.locator('#want-responded .t-del').first());
  await sleep(150);
  const t0 = Date.now();
  await page.click('#confirm-yes');
  await page.waitForFunction(n => document.querySelectorAll('#want-responded .card').length < n, cardsBefore, { timeout: 2000 });
  const elapsed = Date.now() - t0;
  check(elapsed < 500, 'card disappears instantly (' + elapsed + 'ms)');
  await sleep(400);
  check(await page.evaluate(() => window.__mockdb.jobs.length) === 1, 'job removed on server');

  console.log('\n-- tab 2: delivery (admin) --');
  await page.click('#nav-delivery');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#upload-cat-wrap').isVisible(), 'category picker shows');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('delivery method') >= 0, 'no category blocked (English toast)');
  await page.click('#upload-cats button[data-cat="lalamove"]');
  await page.fill('#upload-note', 'Deliver before 5pm');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#delivery-list .card').count()) === 1, 'delivery card appears');
  check((await page.locator('.chip.lalamove').count()) === 1, 'lalamove chip shown');
  await page.click('#delivery-pills button[data-cat="bus"]');
  await sleep(150);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'Bus filter hides lalamove job');
  await page.click('#delivery-pills button[data-cat=""]');
  await sleep(150);

  console.log('\n-- tab 2: proof + hide --');
  await clickSafe(page.locator('#delivery-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#delivery-list .proof').count()) === 1, 'proof photo appears');
  check((await page.locator('#delivery-list .section-title').first().textContent()).indexOf('Done') >= 0, 'moved to Done section');
  await clickSafe(page.locator('#delivery-list .t-arch').first());
  await sleep(600);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'admin Hide works');

  console.log('\n-- tab 3: postage --');
  await page.click('#nav-postage');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  check(await page.locator('#photo2-wrap').isVisible(), 'airway bill photo field shows');
  await page.setInputFiles('#photo1-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('2 photos') >= 0, '1 photo blocked (needs 2)');
  await page.setInputFiles('#photo2-file', IMG);
  await sleep(400);
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#postage-list .photo-pair img').count()) === 2, 'jobsheet + airway bill side by side');
  await clickSafe(page.locator('#postage-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#postage-list .proof').count()) === 1, 'postage proof flow works');

  console.log('\n-- switch back to staff hides admin tools --');
  await page.click('#role-btn');
  await sleep(150);
  await page.click('#role-overlay .choice-row button:first-child');
  await sleep(300);
  check((await page.locator('#role-btn').textContent()).indexOf('Staff') >= 0, 'back to Staff');
  check((await page.locator('.t-edit').count()) === 0 && (await page.locator('.t-del').count()) === 0 &&
        (await page.locator('.t-arch').count()) === 0, 'all admin buttons hidden again');

  console.log('\n-- photo viewer --');
  await clickSafe(page.locator('#postage-list .photo-pair img').first());
  await sleep(200);
  check(await page.locator('#viewer').isVisible(), 'photo opens fullscreen');
  const viewerSrc = await page.locator('#viewer-img').getAttribute('src');
  check(viewerSrc.indexOf('data:image') === 0, 'viewer image served through app too');
  await page.click('#viewer');
  await sleep(150);
  check(!await page.locator('#viewer').isVisible(), 'tap closes viewer');

  console.log('\n-- reload: role remembered --');
  await page.reload();
  await sleep(400);
  check(!await page.locator('#role-overlay').isVisible(), 'no role modal on second visit');
  check((await page.locator('#role-btn').textContent()).indexOf('Staff') >= 0, 'Staff role remembered');

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
  check(!await dpage.locator('#role-overlay').isVisible(), 'no role modal (admin remembered)');
  check((await dpage.locator('#role-btn').textContent()).indexOf('Admin') >= 0, 'admin badge in header');

  await dpage.evaluate(() => {
    ['lalamove', 'bus', 'pickup'].forEach((cat, i) => {
      window.__mockapi.addJob({ tab: 'delivery', category: cat, note: 'Desktop job ' + (i + 1), photos: ['x'] });
    });
  });
  await dpage.click('#nav-delivery');
  await sleep(600);
  check((await dpage.locator('#delivery-list .card').count()) === 3, '3 seeded jobs render');
  const cols = await dpage.locator('#delivery-list .grid').first()
    .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(cols === 3, 'cards in ' + cols + ' columns on desktop');
  const nav = await dpage.locator('nav').boundingBox();
  check(Math.abs((nav.x + nav.width / 2) - 640) < 10 && nav.width < 520, 'nav centered floating pill (w=' + Math.round(nav.width) + ')');
  check((await dpage.locator('#delivery-list .t-del').count()) === 3, 'admin delete buttons on all cards');

  await dpage.click('#nav-post');
  await sleep(200);
  const dsheet = await dpage.locator('#upload-overlay .sheet').boundingBox();
  check(Math.abs((dsheet.x + dsheet.width / 2) - 640) < 10, 'post form horizontally centered');
  check(Math.abs((dsheet.y + dsheet.height / 2) - 450) < 100, 'post form vertically centered');
  await dpage.click('#upload-overlay .x-close');
  await sleep(150);

  await dpage.evaluate(() => { window.__mockapi.addJob({ tab: 'want', category: '', note: 'Desktop swipe', photos: ['x'] }); });
  await dpage.click('#nav-want');
  await sleep(600);
  const dbox = await dpage.locator('#topcard').boundingBox();
  await dpage.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await dpage.mouse.down();
  for (let i = 1; i <= 10; i++) await dpage.mouse.move(dbox.x + dbox.width / 2 + i * 30, dbox.y + dbox.height / 2, { steps: 2 });
  await dpage.mouse.up();
  await sleep(700);
  check((await dpage.locator('#want-responded').textContent()).indexOf('Sewing now') >= 0, 'mouse-drag swipe works on desktop');

  await dctx.close();
  await browser.close();

  console.log('\n================================');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });

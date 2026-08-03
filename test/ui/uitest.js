/**
 * Full UI test of Index.html in real Chromium.
 * The page runs against a simulated google.script.run backend (mock.js, 150ms latency).
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
  check((await page.locator('#role-btn').textContent()).indexOf('Staff') >= 0, 'X defaults to Staff');
  check(!await page.locator('#reset-btn').isVisible(), 'staff has NO reset button');
  check((await page.locator('#nav-want .nav-lbl').textContent()) === 'Checking', 'tab 1 renamed to "Checking"');

  console.log('\n-- multi-photo post (tab 1) --');
  await page.click('#nav-post');
  await sleep(150);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('photo') >= 0, 'no photo blocked');
  await page.setInputFiles('#photos-file', [IMG, IMG2]);
  await sleep(700);
  check((await page.locator('#upload-thumbs .thumb').count()) === 2, '2 photos selected at once → 2 thumbnails');
  await page.fill('#upload-note', 'Baju batik 50pcs');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#topcard').count()) === 1, 'swipe card appears');
  check((await page.locator('#topcard .stack-dots span').count()) === 2, 'photo dots on swipe card (2 photos)');
  check(await page.evaluate(() => window.__mockdb.jobs[0].photoIds.length === 2), 'server stored 2 photos');

  console.log('\n-- tap to flip photos on swipe card --');
  const before = await page.locator('#topcard img[data-img]').getAttribute('data-img');
  let cb = await page.locator('#topcard').boundingBox();
  await page.mouse.click(cb.x + cb.width * 0.85, cb.y + cb.height * 0.4); // tap right side
  await sleep(300);
  const after = await page.locator('#topcard img[data-img]').getAttribute('data-img');
  check(before !== after, 'tap right side shows next photo');
  check((await page.locator('#topcard').getAttribute('data-idx')) === '1', 'photo index updated');
  await page.mouse.click(cb.x + cb.width * 0.15, cb.y + cb.height * 0.4); // tap left side
  await sleep(300);
  check((await page.locator('#topcard img[data-img]').getAttribute('data-img')) === before, 'tap left side goes back');
  check((await page.locator('#topcard').count()) === 1, 'tapping does NOT swipe the card away');

  console.log('\n-- swipe still works after taps --');
  cb = await page.locator('#topcard').boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cb.x + cb.width / 2 + i * 25, cb.y + cb.height / 2, { steps: 2 });
  await page.mouse.up();
  await sleep(700);
  check((await page.locator('#want-responded').textContent()).indexOf('Got it') >= 0, 'drag right still marks ❤️');
  check((await page.locator('#want-responded .car-dots span').count()) === 2, 'status card shows carousel dots');
  check((await page.locator('#want-responded .car-count').textContent()).indexOf('2') >= 0, 'photo count badge (2 📷)');

  console.log('\n-- staff: no admin buttons --');
  check((await page.locator('.t-edit').count()) === 0 && (await page.locator('.t-del').count()) === 0, 'no edit/delete for staff');

  console.log('\n-- become admin --');
  await page.click('#role-btn');
  await sleep(150);
  await page.click('#role-admin-btn');
  await sleep(100);
  await page.fill('#pin-input', '1234');
  await page.click('#pin-wrap .btn.blue');
  await sleep(500);
  check((await page.locator('#role-btn').textContent()).indexOf('Admin') >= 0, 'admin mode on');
  check(await page.locator('#reset-btn').isVisible(), 'admin sees 🔄 Reset button');

  console.log('\n-- admin edit: remove + add photos --');
  await clickSafe(page.locator('#want-responded .t-edit').first());
  await sleep(300);
  check((await page.locator('#upload-thumbs .thumb').count()) === 2, 'edit shows existing 2 photos as thumbs');
  await page.locator('#upload-thumbs .thumb-x').first().click();
  await sleep(150);
  check((await page.locator('#upload-thumbs .thumb').count()) === 1, '✕ removes a photo from the form');
  await page.setInputFiles('#photos-file', [IMG3, IMG3]);
  await sleep(700);
  check((await page.locator('#upload-thumbs .thumb').count()) === 3, 'added 2 more photos (3 total)');
  await page.click('#btn-submit');
  await sleep(600);
  const editedJob = await page.evaluate(() => window.__mockdb.jobs.find(j => j.tab === 'want'));
  check(editedJob.photoIds.length === 3, 'server has 3 photos after edit');
  check(editedJob.photoIds.filter(id => id.indexOf('phnew') === 0).length === 2, 'kept 1 old + 2 new photos');

  console.log('\n-- tab 2: 3-photo post + carousel --');
  await page.click('#nav-delivery');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  await page.setInputFiles('#photos-file', [IMG, IMG2, IMG3]);
  await sleep(900);
  check((await page.locator('#upload-thumbs .thumb').count()) === 3, '3 photos picked together');
  await page.click('#upload-cats button[data-cat="lalamove"]');
  await page.fill('#upload-note', 'Deliver before 5pm');
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#delivery-list .car-track .car-slide').count()) === 3, 'card carousel has 3 slides');
  check((await page.locator('#delivery-list .car-dots span').count()) === 3, '3 dots under photo');

  console.log('\n-- swipe between photos (scroll-snap) --');
  const track = page.locator('#delivery-list .car-track').first();
  await track.evaluate(el => { el.scrollLeft = el.clientWidth; }); // swipe to photo 2
  await sleep(400);
  const activeDot = await page.locator('#delivery-list .car-dots span').nth(1).getAttribute('class');
  check(activeDot === 'on', 'swiping to photo 2 lights up dot 2');

  console.log('\n-- tab 2: proof flow still works --');
  await clickSafe(page.locator('#delivery-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#delivery-list .proof').count()) === 1, 'proof photo flow works with multi-photo job');

  console.log('\n-- tab 3: needs at least 2 photos --');
  await page.click('#nav-postage');
  await sleep(500);
  await page.click('#nav-post');
  await sleep(150);
  check((await page.locator('#photos-label').textContent()).indexOf('airway bill') >= 0, 'postage label mentions airway bill');
  await page.setInputFiles('#photos-file', IMG);
  await sleep(500);
  await page.click('#btn-submit');
  await sleep(150);
  check((await page.locator('#toast').textContent()).indexOf('at least 2') >= 0, '1 photo blocked for postage');
  await page.setInputFiles('#photos-file', IMG2);
  await sleep(500);
  await page.click('#btn-submit');
  await sleep(600);
  check((await page.locator('#postage-list .car-slide').count()) === 2, 'postage carousel shows both photos');
  await clickSafe(page.locator('#postage-list .btn.green').first());
  await page.setInputFiles('#proof-file', IMG);
  await sleep(800);
  check((await page.locator('#postage-list .proof').count()) === 1, 'postage proof works');

  console.log('\n-- all photos still served through the app --');
  const srcs = await page.evaluate(() => Array.from(document.querySelectorAll('img[data-img]')).map(el => el.src));
  check(srcs.every(s => s.indexOf('drive.google.com') < 0), 'no drive.google.com dependencies');

  console.log('\n-- RESET: start a new day --');
  const jobsBefore = await page.evaluate(() => window.__mockdb.jobs.length);
  check(jobsBefore >= 3, jobsBefore + ' jobs exist across tabs before reset');
  await page.click('#reset-btn');
  await sleep(150);
  check(await page.locator('#confirm-overlay').isVisible(), 'reset asks for confirmation');
  check((await page.locator('#confirm-msg').textContent()).indexOf('new day') >= 0, 'confirmation explains what reset does');
  await page.click('#confirm-overlay .x-close'); // cancel first
  await sleep(150);
  check(await page.evaluate(() => window.__mockdb.jobs.some(j => j.status !== 'archived')), 'cancel does not reset');
  await page.click('#reset-btn');
  await sleep(150);
  await page.click('#confirm-yes');
  await sleep(200);
  check((await page.locator('#postage-list .empty').count()) === 1, 'current tab cleared instantly');
  await sleep(500);
  check(await page.evaluate(() => window.__mockdb.jobs.every(j => j.status === 'archived')), 'server archived ALL jobs');
  check(await page.evaluate(() => window.__mockdb.jobs.length) === jobsBefore, 'nothing deleted — records kept');
  await page.click('#nav-want');
  await sleep(500);
  check((await page.locator('#want-stack-area .empty').count()) === 1, 'Checking tab empty after reset');
  check(!await page.locator('#badge-want').isVisible(), 'badges cleared');
  await page.click('#nav-delivery');
  await sleep(500);
  check((await page.locator('#delivery-list .empty').count()) === 1, 'Delivery tab empty after reset');

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
  check(await dpage.locator('#reset-btn').isVisible(), 'desktop admin sees reset button');

  await dpage.evaluate(() => {
    window.__mockapi.addJob({ tab: 'delivery', category: 'bus', note: 'Multi photo job', photos: ['x', 'y', 'z'] });
  });
  await dpage.click('#nav-delivery');
  await sleep(600);
  check((await dpage.locator('#delivery-list .car-btn.next').count()) === 1, 'desktop shows ‹ › arrow buttons');
  await dpage.locator('#delivery-list .car-btn.next').click();
  await sleep(600);
  const dot2 = await dpage.locator('#delivery-list .car-dots span').nth(1).getAttribute('class');
  check(dot2 === 'on', 'arrow click moves to photo 2');

  await dpage.click('#nav-post');
  await sleep(200);
  const dsheet = await dpage.locator('#upload-overlay .sheet').boundingBox();
  check(Math.abs((dsheet.x + dsheet.width / 2) - 640) < 10, 'post form still centered');
  await dpage.click('#upload-overlay .x-close');
  await sleep(150);

  await dpage.evaluate(() => { window.__mockapi.addJob({ tab: 'want', category: '', note: 'Swipe me', photos: ['x'] }); });
  await dpage.click('#nav-want');
  await sleep(600);
  const dbox = await dpage.locator('#topcard').boundingBox();
  await dpage.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
  await dpage.mouse.down();
  for (let i = 1; i <= 10; i++) await dpage.mouse.move(dbox.x + dbox.width / 2 + i * 30, dbox.y + dbox.height / 2, { steps: 2 });
  await dpage.mouse.up();
  await sleep(700);
  check((await dpage.locator('#want-responded').textContent()).indexOf('Got it') >= 0, 'decision swipe still works on desktop');

  await dctx.close();
  await browser.close();

  console.log('\n================================');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });

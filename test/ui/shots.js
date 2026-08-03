const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function seed(page) {
    await page.evaluate(() => {
      const api = window.__mockapi;
      api.addJob({ tab: 'want', category: '', note: 'Baju kurung biru 30pcs', photos: ['x'] });
      api.addJob({ tab: 'want', category: '', note: 'Baju batik 50pcs', photos: ['x','y','z'] });
      const d1 = api.addJob({ tab: 'delivery', category: 'lalamove', note: 'Deliver before 5pm', photos: ['x'] });
      api.addJob({ tab: 'delivery', category: 'lalamove', note: 'Multi angle photos', photos: ['x','y','z'] });
      api.addJob({ tab: 'delivery', category: 'bus', note: 'Bus to Kuantan, counter 7', photos: ['x'] });
      api.addJob({ tab: 'delivery', category: 'pickup', note: 'Customer pickup tomorrow morning', photos: ['x'] });
      api.updateStatus(d1.id, 'done', 'proofdata');
      api.addJob({ tab: 'postage', category: '', note: 'J&T to Penang', photos: ['x', 'y'] });
    });
  }

  // mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await m.newPage();
  await mp.addInitScript(() => { localStorage.setItem('kilangRole', 'staff'); localStorage.setItem('kilangPin', ''); });
  await mp.goto('http://127.0.0.1:8899/test.html');
  await sleep(300);
  await seed(mp);
  await mp.evaluate(() => switchTab('want'));
  await sleep(500);
  await mp.screenshot({ path: 'shot-tab1-swipe.png' });
  await mp.evaluate(() => switchTab('delivery'));
  await sleep(500);
  await mp.screenshot({ path: 'shot-tab2-delivery.png' });
  await m.close();

  // desktop
  const d = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 });
  const dp = await d.newPage();
  await dp.addInitScript(() => { localStorage.setItem('kilangRole', 'admin'); localStorage.setItem('kilangPin', '1234'); });
  await dp.goto('http://127.0.0.1:8899/test.html');
  await sleep(300);
  await seed(dp);
  await dp.evaluate(() => switchTab('delivery'));
  await sleep(500);
  await dp.screenshot({ path: 'shot-desktop-grid.png' });
  await dp.evaluate(() => openUpload(null));
  await sleep(300);
  await dp.screenshot({ path: 'shot-desktop-form.png' });
  await d.close();

  await browser.close();
  console.log('done');
})();

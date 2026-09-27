/**
 * Drives the procurement workflow in a real browser, screenshots every screen,
 * and fails loudly on anything that looks broken: console errors, failed
 * requests, horizontal overflow, elements bleeding out of the viewport, stuck
 * skeletons, and undefined/NaN leaking into the DOM.
 *
 *   node shoot.mjs [baseUrl] [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = process.argv[3] || join(process.cwd(), '..', 'screenshots');
mkdirSync(OUT, { recursive: true });

const problems = [];
const shots = [];
const flag = (screen, kind, detail) => {
  problems.push({ screen, kind, detail });
  console.log(`  ! [${kind}] ${detail}`);
};

async function audit(page, name) {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  if (o.s > o.c + 2) flag(name, 'overflow', `horizontal scroll (${o.s} > ${o.c})`);

  const bleeders = await page.evaluate(() => {
    const out = []; const vw = document.documentElement.clientWidth;
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 2) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`);
    });
    return out.slice(0, 3);
  });
  bleeders.forEach((b) => flag(name, 'bleed', b));

  const sk = await page.locator('.skeleton').count();
  if (sk) flag(name, 'stuck-loading', `${sk} skeleton(s) still visible`);

  const body = await page.locator('body').innerText().catch(() => '');
  ['undefined', 'NaN', '[object Object]'].forEach((bad) => {
    if (body.includes(bad)) flag(name, 'render-leak', `body contains "${bad}"`);
  });
}

async function shoot(page, name) {
  await page.waitForTimeout(900);
  await audit(page, name);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  shots.push(name);
  console.log(`  ok ${name}.png`);
}

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') flag('*', 'console', m.text().slice(0, 140)); });
  page.on('requestfailed', (r) => flag('*', 'request-failed', `${r.method()} ${r.url().slice(0, 100)}`));
  page.on('response', (r) => { if (r.status() >= 400) flag('*', 'http-error', `${r.status()} ${r.url().slice(0, 100)}`); });

  await page.request.post(`${BASE}/api/reset`).catch(() => {});
  console.log('\nWalking the procurement workflow…\n');

  /* 1 — login / role selection */
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shoot(page, '01-login');

  await page.click('text=Procurement Officer');
  await page.click('text=Enter workspace');
  await page.waitForURL('**/dashboard');
  await shoot(page, '02-dashboard-empty');

  /* 2 — the conversational copilot */
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shoot(page, '03a-copilot-blank');

  await page.fill('textarea', 'Which materials are at risk, and which one is most urgent?');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Send")');
  await page.waitForTimeout(26000);
  await shoot(page, '03b-copilot-answer');

  await page.fill('textarea', 'How many quotations do we have and which supplier is cheapest?');
  await page.click('button:has-text("Send")');
  await page.waitForTimeout(32000);
  // Open the tool trace so the SQL it wrote is visible.
  const trace = page.locator('button:has-text("tool call")').last();
  if (await trace.count()) { await trace.click(); await page.waitForTimeout(900); }
  await shoot(page, '03c-copilot-tools');

  /* 3 — the manual form is still there for anyone who wants it */
  await page.goto(`${BASE}/raise`, { waitUntil: 'networkidle' });
  await shoot(page, '03-raise-blank');

  await page.fill('#title', 'Tomato paste top-up for Q4 ketchup run');
  await page.selectOption('#material', 'mat_tomato');
  await page.fill('#qty', '52384');
  await page.selectOption('#prio', 'urgent');
  await page.fill('#spec', '28–30% Brix, hot break, HACCP certified supplier');
  await page.fill('#reason', 'Projected stockout on day 36 of the ketchup line at current production volume.');
  await page.waitForTimeout(300);
  await shoot(page, '04-raise-filled');

  await page.click('button:has-text("Submit requirement")');
  await page.waitForURL('**/requirements/**', { timeout: 12000 });
  await page.waitForTimeout(1100);
  await shoot(page, '05-discovery');

  /* 3 — shortlist two suppliers */
  // graph8 researches each shortlisted supplier in the background (~15-20s each).
  await page.waitForTimeout(45000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shoot(page, '05b-discovery-researched');

  // This requirement came from the manual form, so nothing is shortlisted yet.
  // text-is gives an exact match — has-text is a substring match and would also
  // hit the "Research N shortlisted" button.
  const shortlistBtns = page.locator('button:text-is("Shortlist")');
  const n = Math.min(await shortlistBtns.count(), 2);
  for (let i = 0; i < n; i++) {
    await shortlistBtns.first().click();
    await page.waitForTimeout(900);
  }
  await shoot(page, '06-discovery-shortlisted');

  /* 4 — review step shows the submitted values */
  await page.click('button:has-text("Review")');
  await page.waitForTimeout(600);
  await shoot(page, '07-review');

  /* 5 — RFQ */
  await page.click('button:has-text("RFQ")');
  await page.waitForTimeout(600);
  const prep = page.locator('button:has-text("Prepare")').first();
  if (await prep.count()) { await prep.click(); await page.waitForTimeout(1300); }
  await shoot(page, '08-rfq');

  const send = page.locator('button:has-text("Approve and send")').first();
  if (await send.count()) { await send.click(); await page.waitForTimeout(2000); }
  await shoot(page, '09-rfq-sent');

  // The approved directory vendors reply on their own; wait for the round trip.
  await page.waitForTimeout(9000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('button:has-text("RFQ")').catch(() => {});
  await page.waitForTimeout(900);
  await shoot(page, '09b-rfq-replied');

  /* 6 — quotations */
  await page.click('button:has-text("Quotations")');
  await page.waitForTimeout(700);
  await page.selectOption('#sup', { index: 1 }).catch(() => {});
  await page.fill('#up', '1.28');
  await page.fill('#av', '60000');
  await page.fill('#lt', '18');
  await page.fill('#moq', '10000');
  await page.fill('#vd', '30');
  await page.fill('#dt', 'CIF Karachi');
  await page.fill('#pt', 'Net 30');
  await page.fill('#sc', '28–30% Brix confirmed');
  await page.fill('#ce', 'HACCP, ISO 22000');
  await shoot(page, '10-quote-entry');
  await page.click('button:has-text("Save quotation")');
  await page.waitForTimeout(1200);

  // Second quote: cheaper, but slow and short — this is what makes the
  // recommendation refuse to simply pick the lowest price.
  await page.selectOption('#sup', { index: 2 }).catch(() => {});
  await page.fill('#up', '1.19');
  await page.fill('#av', '30000');
  await page.fill('#lt', '41');
  await page.selectOption('#mode', 'manual_entry').catch(() => {});
  await page.click('button:has-text("Save quotation")');
  await page.waitForTimeout(1300);
  await shoot(page, '11-quotes-recorded');

  /* 7 — comparison */
  await page.click('button:has-text("Comparison")');
  await page.waitForTimeout(900);
  await shoot(page, '12-comparison');

  /* 8 — approval */
  await page.click('button:has-text("Approval")');
  await page.waitForTimeout(800);
  await page.fill('#note', 'Al-Noor meets the required date and full quantity with complete documentation. Flavor Pic is cheaper but 22,384 kg short.');
  await shoot(page, '13-approval');
  await page.click('button:has-text("Approve recommendation")');
  await page.waitForTimeout(1300);
  await shoot(page, '14-approved');

  /* 9 — populated dashboard */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await shoot(page, '15-dashboard-populated');

  /* 10 — requirements list */
  await page.goto(`${BASE}/requirements`, { waitUntil: 'networkidle' });
  await shoot(page, '16-requirements');

  /* 11 — inventory planning, then prove an edit changes the result */
  await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' });
  await shoot(page, '17-inventory');

  await page.fill('#upd', '4000');
  await page.click('button:has-text("Apply changes")');
  await page.waitForTimeout(1600);
  await shoot(page, '18-inventory-recalculated');

  await page.fill('#upd', '9800');
  await page.click('button:has-text("Apply changes")');
  await page.waitForTimeout(1400);

  /* 12 — forward buying */
  await page.goto(`${BASE}/analytics`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shoot(page, '19-forward-buying');

  await page.selectOption('#s', 'ps_up15');
  await page.waitForTimeout(1200);
  await shoot(page, '20-forward-buying-scenario');

  /* 13 — suppliers + agents */
  await page.goto(`${BASE}/suppliers`, { waitUntil: 'networkidle' });
  await shoot(page, '21-suppliers');

  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shoot(page, '22-agent-activity');

  /* 15 — sell side: buyers discovered by graph8, qualified by a graph8 agent */
  await page.goto(`${BASE}/sales`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shoot(page, '24-sales-buyers');

  const qualifyBtn = page.locator('button:has-text("Qualify top")').first();
  if (await qualifyBtn.count()) {
    await qualifyBtn.click();
    await page.waitForTimeout(40000);
    await shoot(page, '25-sales-qualified');
  }

  const openEmail = page.locator('button:text-is("Open email")').first();
  if (await openEmail.count()) {
    await openEmail.click();
    await page.waitForTimeout(1200);
    await shoot(page, '26-sales-email');
    const sendBtn = page.locator('button:has-text("Approve and send")').first();
    if (await sendBtn.count()) { await sendBtn.click(); await page.waitForTimeout(3000); }
    await shoot(page, '27-sales-sent');
  }

  const pushBtn = page.locator('button:has-text("Push qualified")').first();
  if (await pushBtn.count()) {
    await pushBtn.click();
    await page.waitForTimeout(6000);
    await shoot(page, '28-sales-crm-push');
  }

  /* 14 — responsive */
  const mob = await browser.newContext({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2 });
  const mp = await mob.newPage();
  await mp.goto(BASE, { waitUntil: 'networkidle' });
  await mp.click('text=Procurement Officer');
  await mp.click('text=Enter workspace');
  await mp.waitForURL('**/dashboard');
  await mp.waitForTimeout(900);
  await audit(mp, '23-mobile-dashboard');
  await mp.screenshot({ path: join(OUT, '23-mobile-dashboard.png'), fullPage: true });
  shots.push('23-mobile-dashboard');
  console.log('  ok 23-mobile-dashboard.png');

  await browser.close();

  writeFileSync(join(OUT, 'audit.json'), JSON.stringify({ baseUrl: BASE, at: new Date().toISOString(), shots: shots.length, problems }, null, 2));
  console.log(`\n${shots.length} screenshots · ${problems.length} problems\n`);
  if (problems.length) {
    const by = {};
    problems.forEach((p) => { by[p.kind] = (by[p.kind] || 0) + 1; });
    Object.entries(by).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log('');
    problems.slice(0, 20).forEach((p) => console.log(`  [${p.screen}] ${p.kind}: ${p.detail}`));
  } else {
    console.log('  No problems detected.');
  }
};

run().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

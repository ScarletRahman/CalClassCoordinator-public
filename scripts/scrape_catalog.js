#!/usr/bin/env node
/*
 * Scrape the official UC Berkeley Undergraduate Catalog (undergraduate.catalog.berkeley.edu, a Coursedog site).
 *
 * The catalog is a single-page app: requirement course lists and course attributes (breadth, American
 * Cultures, R&C, ...) are not in the HTML, the page loads them as JSON after it starts. So this script
 * opens the catalog in headless Chromium (Playwright), walks it the way a visitor would (in-app
 * navigation, one page at a time per tab), and records the JSON the site itself requests. It never
 * builds API requests of its own.
 *
 * Usage:  node scripts/scrape_catalog.js <mode> [--concurrency 4] [--limit N] [--force]
 *   programs-list   every program (majors, minors, dual/joint) -> cache/programs_list.json
 *   programs        each program's requirements                 -> cache/programs/<id>.json
 *   courses-list    every undergraduate course (id, title...)   -> cache/courses_list.json
 *                   plus the site's own CSV export              -> cache/courses_export.csv (completeness check)
 *   courses         each course's detail (breadth, AC, R&C...)  -> cache/courses/<id>.json
 * Cache dir: data/.cache/catalog (git-ignored). Re-runs skip what is already cached unless --force.
 * Then run: python3 scripts/build_requirements.py
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://undergraduate.catalog.berkeley.edu';
const CACHE = path.join(__dirname, '..', 'data', '.cache', 'catalog');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : (args[i + 1] || true); };
const CONC = parseInt(opt('concurrency', 4), 10);
const LIMIT = parseInt(opt('limit', 0), 10);
const FORCE = args.includes('--force');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

function slimCourse(c) {
  const cf = c.customFields || {};
  const ch = (c.credits || {}).creditHours || {};
  return {
    courseGroupId: c.courseGroupId, deprecatedCourseGroupId: c.deprecatedCourseGroupId, code: c.code, subjectCode: c.subjectCode, courseNumber: c.courseNumber,
    longName: c.longName, name: c.name, description: c.description, career: c.career, college: c.college,
    status: c.status, creditsMin: ch.min, creditsMax: ch.max,
    departments: (c.departments || []).map(d => (d && d.id) || d),
    catalogAttributes: cf.catalogAttributes, attributes: c.attributes,
    breadth: cf.approvedBreadthAreas, americanCultures: cf.americanCulturesRequirement,
    universityRequirements: cf.universityRequirements, readingComposition: cf.courseProposetToMeetThe,
    foreignLanguageLevel: cf.foreignLanguageAcquisitionLevelOfInstruction,
    formerly: cf.formerCodeCatalogDisplay, offering: cf.customOfferingPhrase,
    crossListedCourses: c.crossListedCourses, requisites: c.requisites,
    creditRestrictionCourses: cf.creditRestrictionCourses,
  };
}

async function newTab(ctx) {
  const page = await ctx.newPage();
  await page.route(/launchdarkly|sentry|newrelic|www\.berkeley\.edu|googleapis|gstatic|\.(png|webp|jpg|woff2?)(\?|$)/, r => r.abort());
  const tab = { page, buf: [], pending: 0 };
  page.on('request', r => { if (/app\.coursedog\.com\/api\/v1/.test(r.url())) tab.pending++; });
  const done = () => { tab.pending = Math.max(0, tab.pending - 1); };
  page.on('requestfailed', r => { if (/app\.coursedog\.com\/api\/v1/.test(r.url())) done(); });
  page.on('response', async r => {
    const u = r.url();
    if (!/app\.coursedog\.com\/api\/v1/.test(u)) return;
    try {
      if (/general\/|pdf-reports|localizations/.test(u)) return;
      const body = await r.json();
      tab.buf.push({ url: decodeURIComponent(u), status: r.status(), post: r.request().postData(), body });
    } catch (e) { /* non-JSON */ } finally { done(); }
  });
  tab.settle = async (min = 400) => {
    await sleep(min);
    for (let quiet = 0, i = 0; quiet < 3 && i < 150; i++) { quiet = tab.pending === 0 ? quiet + 1 : 0; await sleep(150); }
  };
  tab.open = async (url) => { tab.buf = []; await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => { const el = document.querySelector('#__nuxt'); return !!(el && el.__vue_app__); }, null, { timeout: 60000 }); await tab.settle(1500); };
  tab.nav = async (to, keep) => {
    if (!keep) tab.buf = [];
    await page.evaluate(t => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push(t), to);
    await tab.settle();
  };
  return tab;
}

async function pool(items, worker, ctx) {
  let i = 0, ok = 0, bad = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, items.length || 1) }, async () => {
    let tab = await newTab(ctx); let started = false;
    while (i < items.length) {
      const item = items[i++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (!started) { await tab.open(worker.start); started = true; }
          await worker.run(tab, item); ok++; break;
        } catch (e) {
          if (attempt === 2) { bad++; console.error('FAILED', JSON.stringify(item).slice(0, 80), e.message.split('\n')[0]); }
          try { await tab.page.close(); } catch (e2) { /* ignore */ }
          tab = await newTab(ctx); started = false; await sleep(2000);
        }
      }
      if ((ok + bad) % 50 === 0) console.log(`${ok + bad}/${items.length} done, ${bad} failed`);
    }
    await tab.page.close();
  }));
  console.log(`finished: ${ok} ok, ${bad} failed`);
}

async function listMode(ctx, startUrl, match, outFile) {
  const tab = await newTab(ctx);
  const rows = new Map(); let total = Infinity;
  const take = () => { for (const r of tab.buf) if (match.test(r.url) && r.body && Array.isArray(r.body.data)) { if (r.body.listLength) total = r.body.listLength; for (const d of r.body.data) rows.set(d._id || d.id, d); } };
  await tab.open(startUrl); take();
  const sep = startUrl.includes('?') ? '&' : '?';
  for (let pg = 2; rows.size < total && pg < 2000; pg++) {
    const before = rows.size;
    await tab.nav(startUrl + sep + 'page=' + pg); take();
    if (rows.size === before) { await tab.settle(1500); take(); if (rows.size === before) break; }
    if (pg % 25 === 0) console.log(`page ${pg}: ${rows.size}/${total}`);
  }
  writeJson(outFile, [...rows.values()]);
  console.log(`saved ${rows.size} of ${total} to ${outFile}`);
  if (total !== Infinity && rows.size < total) console.log(`the paged list returned ${rows.size} of ${total} rows (its sort order has ties, so pages overlap); the rest are looked up by search`);
  return tab;
}

// First two columns (Subject, Course Number) of every record of the export; fields are quoted and may hold newlines.
function csvIds(text) {
  const ids = []; let field = '', rec = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { rec.push(field); field = ''; }
    else if (ch === '\n') { rec.push(field); field = ''; if (rec.length > 1) ids.push(rec); rec = []; }
    else if (ch !== '\r') field += ch;
  }
  return [...new Set(ids.slice(1).map(r => `${r[0]} ${r[1]}`.toUpperCase().trim()))];
}

// The catalog's own "Export all results as CSV" button: one request, every listed course. Saved next to
// the list so `build_requirements.py --pack` can prove the snapshot holds every course the catalog publishes.
async function exportCsv(tab, outFile) {
  const btn = await tab.page.$('[data-test="export-all-results-as-csv"]');
  if (!btn) { console.error('no CSV export button on the page; skipped the completeness file'); return; }
  const [dl] = await Promise.all([tab.page.waitForEvent('download', { timeout: 120000 }), btn.click()]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await dl.saveAs(outFile);
  console.log(`saved the catalog's CSV export to ${outFile}`);
}

(async () => {
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    if (mode === 'programs-list') {
      await listMode(ctx, '/programs', /programs\/search/, path.join(CACHE, 'programs_list.json'));
    } else if (mode === 'courses-list') {
      // 1. page through the list (resumable: an existing raw list is reused unless --force)
      const rawFile = path.join(CACHE, 'courses_list_raw.json');
      let tab;
      if (FORCE || !fs.existsSync(rawFile)) tab = await listMode(ctx, '/courses?career=Undergraduate', /courses\/search/, rawFile);
      else tab = await newTab(ctx);
      // 2. the site's own CSV export names every course; whatever the paged list skipped is searched for by id
      await tab.open('/courses?career=Undergraduate');
      const csvFile = path.join(CACHE, 'courses_export.csv');
      await exportCsv(tab, csvFile);
      const rows = new Map(readJson(rawFile).map(d => [d._id || d.id, d]));
      const idOf = d => `${d.subjectCode} ${d.courseNumber}`.toUpperCase().trim();
      const have = new Set([...rows.values()].map(idOf));
      const wanted = csvIds(fs.readFileSync(csvFile, 'utf8')).filter(id => !have.has(id));
      console.log(`${wanted.length} courses are in the export but not in the paged list`);
      for (const id of wanted) {
        await tab.nav('/courses?career=Undergraduate&cq=' + encodeURIComponent(id));
        for (const r of tab.buf) if (/courses\/search/.test(r.url) && r.body && Array.isArray(r.body.data)) for (const d of r.body.data) { rows.set(d._id || d.id, d); have.add(idOf(d)); }
      }
      const still = wanted.filter(id => !have.has(id));
      writeJson(rawFile, [...rows.values()]);
      writeJson(path.join(CACHE, 'courses_list.json'), [...rows.values()].map(slimCourse));
      console.log(`saved ${rows.size} courses to courses_list.json`);
      if (still.length) { console.error(`INCOMPLETE LIST, not found by search: ${still.join(', ')}`); process.exitCode = 1; }
    } else if (mode === 'programs') {
      let list = readJson(path.join(CACHE, 'programs_list.json')).map(p => p.programGroupId || p.code);
      list = [...new Set(list)].filter(id => FORCE || !fs.existsSync(path.join(CACHE, 'programs', id + '.json')));
      if (LIMIT) list = list.slice(0, LIMIT);
      console.log(`${list.length} programs to fetch`);
      await pool(list, {
        start: '/programs',
        run: async (tab, id) => {
          await tab.nav('/programs/' + id);
          await tab.page.waitForSelector('a[href*="/programs/' + id + '/"]', { timeout: 20000 }).catch(() => {});
          const href = await tab.page.$$eval('a[href*="/programs/"]', (as, id) => { const a = as.find(x => x.getAttribute('href').includes('/programs/' + id + '/requirements-')); return a ? a.getAttribute('href') : null; }, id);
          let text = '';
          if (href) {
            await tab.nav(href, true);
            const btn = await tab.page.$('[data-test="expand-all-button"]');
            if (btn) { await btn.click().catch(() => {}); await tab.settle(600); }
            text = await tab.page.innerText('.requirements-catalog').catch(() => '');
          }
          await tab.settle(300); const all = tab.buf.slice();
          const out = { id, requirementsPath: href, text, requisiteSets: [], courseSets: [], courses: {}, other: [] };
          for (const r of all) {
            if (/requisite-sets/.test(r.url)) { for (const s of (Array.isArray(r.body) ? r.body : [])) out.requisiteSets.push(s); }
            else if (/courses\/search/.test(r.url)) { for (const c of ((r.body && r.body.data) || [])) out.courses[c.courseGroupId] = Object.assign(out.courses[c.courseGroupId] || {}, JSON.parse(JSON.stringify(slimCourse(c)))); }
            else if (/courseSets/.test(r.url)) out.courseSets.push(r.body);
            else if (!/programTemplate|search-configurations|catalogPages|\/programs\?/.test(r.url)) out.other.push({ url: r.url, body: r.body });
          }
          if (!href) throw new Error('no requirements tab found');
          writeJson(path.join(CACHE, 'programs', id + '.json'), out);
        },
      }, ctx);
    } else if (mode === 'courses') {
      let list = readJson(path.join(CACHE, 'courses_list.json')).map(c => c.courseGroupId);
      list = [...new Set(list)].filter(id => FORCE || !fs.existsSync(path.join(CACHE, 'courses', id + '.json')));
      if (LIMIT) list = list.slice(0, LIMIT);
      console.log(`${list.length} courses to fetch`);
      await pool(list, {
        start: '/courses',
        run: async (tab, id) => {
          await tab.nav('/courses/' + id);
          let hit = null;
          for (const r of tab.buf) if (/courses\/search/.test(r.url) && r.url.includes('courseGroupIds=' + id)) for (const c of ((r.body && r.body.data) || [])) if (String(c.courseGroupId) === String(id) && c.customFields && 'approvedBreadthAreas' in c.customFields) hit = c;
          if (!hit) for (const r of tab.buf) if (/courses\/search/.test(r.url) && r.url.includes('courseGroupIds=' + id)) for (const c of ((r.body && r.body.data) || [])) if (String(c.courseGroupId) === String(id)) hit = hit || c;
          if (!hit) throw new Error('no course payload');
          writeJson(path.join(CACHE, 'courses', id + '.json'), slimCourse(hit));
        },
      }, ctx);
    } else {
      console.error('modes: programs-list | programs | courses-list | courses'); process.exitCode = 2;
    }
  } finally { await browser.close(); }
})();

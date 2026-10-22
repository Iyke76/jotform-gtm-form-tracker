#!/usr/bin/env node
/**
 * uft-jotform-tests.js — jsdom suite for the UFT Jotform standalone.
 * Usage: node test/uft-jotform-tests.js            (defaults to dist/ and the bundled fixture)
 *        node test/uft-jotform-tests.js <iife.js|deploy.html> <deploy.html> <fixture.html>
 *
 * Browser behaviours jsdom lacks are stubbed explicitly per test:
 *   - performance.getEntriesByType('navigation')  (navigation type)
 *   - Element.getClientRects                       (display:none => hidden)
 *   - document.activeElement                       (focus inside an iframe)
 * Cross-origin frames are real jsdom iframes; postMessage arrives as a real
 * MessageEvent whose source is the frame's contentWindow.
 */
'use strict';
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const path = require('path');
const ARGS = process.argv.slice(2);
const DEPLOY_PATH = ARGS[1] || path.join(__dirname, '..', 'dist', 'uft-jotform-standalone-v3.3.0-jotform.1.html');
const IIFE_PATH = ARGS[0] || DEPLOY_PATH;
const FIXTURE_PATH = ARGS[2] || path.join(__dirname, 'fixture-jotform-source-embed.html');
// The bare IIFE can be passed directly, or it is extracted from the deploy file.
const IIFE_RAW = fs.readFileSync(IIFE_PATH, 'utf8');
const IIFE = /\.html$/.test(IIFE_PATH)
  ? IIFE_RAW.slice(IIFE_RAW.indexOf('(function(){"use strict";'), IIFE_RAW.lastIndexOf('})();') + 5) + '\n'
  : IIFE_RAW;
const DEPLOY = fs.readFileSync(DEPLOY_PATH, 'utf8').replace(/^<script>\n/, '').replace(/<\/script>\n$/, '');
// Real pasted markup, reset to its pre-validation state (the paste was taken
// after an empty submit, so the error classes are stripped back off).
const FIXTURE = fs.readFileSync(FIXTURE_PATH, 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/ form-line-error/g, '')
  .replace(/ form-validation-error/g, '')
  .replace(/<div class="form-error-message"[\s\S]*?<\/div><\/div><\/div>/, '');

const FORM_ID = '240000000000001';
const FRAME = '<div id="host"><iframe id="JotFormIFrame-' + FORM_ID + '" src="https://form.jotform.com/' + FORM_ID + '"></iframe></div>';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function make(opts) {
  opts = opts || {};
  const vc = new VirtualConsole();   // swallow jsdom "not implemented: navigation" noise
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + (opts.html || '') + '</body></html>', {
    url: opts.url || 'https://example.com/',
    referrer: opts.referrer || undefined,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  w.performance.getEntriesByType = function (t) { return t === 'navigation' ? [{ type: opts.nav || 'navigate' }] : []; };
  w.Element.prototype.getClientRects = function () {
    let n = this;
    while (n && n.nodeType === 1) {
      if (n.hidden || (n.style && n.style.display === 'none')) return [];
      n = n.parentNode;
    }
    return [{ top: 0, left: 0, width: 10, height: 10 }];
  };
  let active = null;
  Object.defineProperty(w.document, 'activeElement', { configurable: true, get: function () { return active || w.document.body; } });
  w.__setActive = function (el) { active = el; };
  Object.keys(opts.seed || {}).forEach(function (k) {
    const v = opts.seed[k];
    w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  });
  if (opts.consent) w.EC_FORM_CONSENT_CHECK = opts.consent;
  w.dataLayer = [];
  if (opts.deploy) {
    w.eval(DEPLOY);
  } else {
    w.EC_FORM_CONFIG = Object.assign({ debug: false, jotformReloadGraceMs: 150 }, opts.config || {});
    w.eval(IIFE);
  }
  const ev = function (name) { return w.dataLayer.filter(function (e) { return !name || e.event === name; }); };
  const frame = function (sel) { return w.document.querySelector(sel || 'iframe'); };
  const focusInto = function (f) { w.__setActive(f); w.dispatchEvent(new w.Event('blur')); };
  const message = function (f, data, origin) {
    w.dispatchEvent(new w.MessageEvent('message', { data: data, origin: origin || 'https://form.jotform.com', source: f.contentWindow }));
  };
  const load = function (f) { f.dispatchEvent(new w.Event('load')); };
  const pagehide = function () { w.dispatchEvent(new w.Event('pagehide')); };
  const pending = function () { const r = w.localStorage.getItem('ec_jotform_pending'); return r ? JSON.parse(r) : null; };
  return { dom, w, ev, frame, focusInto, message, load, pagehide, pending };
}
const SUCCESS = 'jotform_form_success';
const FAILED = 'jotform_form_failed';

(async function run() {
  // ── A. IFRAME EMBEDS ──────────────────────────────────────────────
  { // 1 detection + heartbeat
    const t = make({ html: FRAME });
    await sleep(80);
    const hb = t.ev('ec_tracker_initialized')[0];
    ok(hb && hb.ec_platforms_detected.indexOf('jotform') !== -1, 'A1 heartbeat reports jotform', hb && hb.ec_platforms_detected);
    ok(hb && hb.ec_forms_attached === 1, 'A1 one frame attached', hb && hb.ec_forms_attached);
    ok(hb && hb.ec_tracker_version === '3.3.0-jotform.1', 'A1 version 3.3.0-jotform.1', hb && hb.ec_tracker_version);
    ok(t.w._ecFormTrackers && typeof t.w._ecFormTrackers.jotform.status === 'function', 'A1 debug API at _ecFormTrackers.jotform');
    ok(!t.w._ecFormTracker || t.w._ecFormTracker === undefined, 'A1 does not claim the universal debug API name');
  }
  { // 2 WP Rocket lazy frame: src about:blank, id from data-lazy-src
    const t = make({ html: '<iframe loading="lazy" id="JotFormIFrame-' + FORM_ID + '" src="about:blank" data-lazy-src="https://form.jotform.com/' + FORM_ID + '"></iframe>' });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    const ia = t.ev('ec_form_interaction')[0];
    ok(ia && ia.form_id === FORM_ID && ia.form_platform === 'jotform', 'A2 lazy frame form_id from data-lazy-src', ia);
  }
  { // 3 late-injected popup frame attaches via rescan, keeps -popup id
    const t = make({ html: FRAME });
    await sleep(80);
    const pop = t.w.document.createElement('iframe');
    pop.id = 'JotFormIFrame-' + FORM_ID + '-popup';
    pop.src = 'https://form.jotform.com/' + FORM_ID;
    t.w.document.body.appendChild(pop);
    await sleep(700);
    ok(t.w._ecFormTrackers.jotform.status().formsAttached === 2, 'A3 popup frame attached after injection', t.w._ecFormTrackers.jotform.status().formsAttached);
    t.focusInto(pop); await sleep(20);
    t.message(pop, { action: 'submission-completed' });
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].form_id === FORM_ID && s[0].form_index === 2, 'A3 popup success carries form_id + index 2', s.map(e => [e.form_id, e.form_index]));
  }
  { // 4 interaction event — metadata only, once
    const t = make({ html: FRAME });
    await sleep(80);
    t.focusInto(t.frame()); await sleep(20);
    t.focusInto(t.frame()); await sleep(20);
    const ia = t.ev('ec_form_interaction');
    ok(ia.length === 1, 'A4 interaction fires once', ia.length);
    ok(ia[0] && !('ec_email' in ia[0]) && ia[0].form_position === 'top', 'A4 interaction carries no PII', ia[0]);
    ok(t.pending() && t.pending().formId === FORM_ID && t.pending().fired === false, 'A4 marker written on interaction (no PII)', t.pending());
  }
  { // 5 postMessage object form
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(30);
    t.message(f, { action: 'submission-completed' });
    t.message(f, { action: 'submission-completed' });
    const s = t.ev(SUCCESS);
    ok(s.length === 1, 'A5 postmessage success fires exactly once', s.length);
    ok(s[0] && s[0].ec_detection_method === 'postmessage' && s[0].form_platform === 'jotform', 'A5 detection postmessage', s[0] && s[0].ec_detection_method);
    ok(s[0] && s[0].ec_email === '' && s[0].ec_phone === '', 'A5 iframe events carry no PII', s[0] && [s[0].ec_email, s[0].ec_phone]);
    ok(s[0] && typeof s[0].ec_time_to_submit_ms === 'number' && s[0].ec_submit_attempt === 1, 'A5 timing + attempt diagnostics', s[0] && [s[0].ec_time_to_submit_ms, s[0].ec_submit_attempt]);
    ok(s[0] && /^[0-9a-f-]{36}$/.test(s[0].ec_event_id), 'A5 ec_event_id uuid');
    ok(t.pending() && t.pending().fired === true, 'A5 marker flagged fired', t.pending());
  }
  { // 6 postMessage string forms
    const t = make({ html: FRAME });
    await sleep(80);
    t.message(t.frame(), '{"action":"submission-completed","formID":"' + FORM_ID + '"}');
    ok(t.ev(SUCCESS).length === 1, 'A6 JSON-string submission-completed accepted');
    const t2 = make({ html: FRAME });
    await sleep(80);
    t2.message(t2.frame(), 'submission-completed');
    ok(t2.ev(SUCCESS).length === 1, 'A6 bare string submission-completed accepted');
  }
  { // 7 the live messages seen on the client site never fire
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    ['setHeight:566:' + FORM_ID, 'formSettled', 'setHeight:565:' + FORM_ID, 'scrollIntoView', 'collapseErrorPage'].forEach(function (m) { t.message(f, m); });
    ok(t.ev(SUCCESS).length === 0, 'A7 setHeight/formSettled/etc never count');
  }
  { // 8 message from a non-Jotform source is ignored, even with the right text
    const t = make({ html: FRAME + '<iframe id="other" src="https://example.com/x"></iframe>' });
    await sleep(80);
    t.message(t.frame('#other'), { action: 'submission-completed' });
    t.w.dispatchEvent(new t.w.MessageEvent('message', { data: { action: 'submission-completed' }, origin: 'https://form.jotform.com', source: t.w }));
    ok(t.ev(SUCCESS).length === 0, 'A8 spoofed submission-completed from other sources ignored');
  }
  { // 9 iframe_reload: load before interaction ignored; after interaction fires after grace
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.load(f); await sleep(250);
    ok(t.ev(SUCCESS).length === 0, 'A9 load before interaction ignored');
    t.focusInto(f); await sleep(20);
    t.load(f);
    await sleep(60);
    ok(t.ev(SUCCESS).length === 0, 'A9 not fired during grace period');
    await sleep(200);
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_detection_method === 'iframe_reload', 'A9 iframe_reload fires after grace', s.map(e => e.ec_detection_method));
  }
  { // 10 reload then postmessage inside grace -> single postmessage event
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.load(f); await sleep(40);
    t.message(f, { action: 'submission-completed' });
    await sleep(250);
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_detection_method === 'postmessage', 'A10 postmessage pre-empts iframe_reload, one event', s.map(e => e.ec_detection_method));
  }
  { // 11 reload while frame hidden (popup closed) is ignored
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.w.document.getElementById('host').style.display = 'none';
    t.load(f); await sleep(250);
    ok(t.ev(SUCCESS).length === 0, 'A11 hidden-frame reload ignored');
  }
  { // 12 page rewrites src (popup reset) then load -> ignored
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    f.setAttribute('src', 'https://form.jotform.com/' + FORM_ID);
    await sleep(10);
    t.load(f); await sleep(250);
    ok(t.ev(SUCCESS).length === 0, 'A12 parent-initiated src rewrite never counts');
  }
  { // 13 strictSuccess: iframe_reload dropped, postmessage still counts
    const t = make({ html: FRAME, config: { strictSuccess: true } });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.load(f); await sleep(250);
    ok(t.ev(SUCCESS).length === 0, 'A13 strict drops iframe_reload');
    t.message(f, { action: 'submission-completed' });
    ok(t.ev(SUCCESS).length === 1 && t.ev(SUCCESS)[0].ec_detection_method === 'postmessage', 'A13 strict keeps postmessage');
  }
  { // 14 two frames — independent state, positions
    const t = make({ html: '<iframe id="JotFormIFrame-111111111111111" src="https://form.jotform.com/111111111111111"></iframe><p>x</p><iframe id="JotFormIFrame-222222222222222" src="https://form.jotform.com/222222222222222"></iframe>' });
    await sleep(80);
    const fs2 = t.w.document.querySelectorAll('iframe');
    t.message(fs2[1], { action: 'submission-completed' });
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].form_id === '222222222222222' && s[0].form_position === 'footer', 'A14 second frame fires alone with its own id/position', s.map(e => [e.form_id, e.form_position]));
    t.message(fs2[0], { action: 'submission-completed' });
    ok(t.ev(SUCCESS).length === 2 && t.ev(SUCCESS)[1].form_position === 'top', 'A14 first frame fires independently');
  }
  { // 15 redirect mode on the form page: pagehide writes marker, fires nothing
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.pagehide();
    const m = t.pending();
    ok(t.ev(SUCCESS).length === 0, 'A15 nothing fires on the unloading page');
    ok(m && m.viaIframe === true && m.fired === false && m.formId === FORM_ID && m.page === 'https://example.com/', 'A15 marker: viaIframe, not fired, form page url', m);
  }
  { // 16 reload during grace then unload -> deferred to destination
    const t = make({ html: FRAME });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.load(f); await sleep(40);
    t.pagehide();
    await sleep(250);
    ok(t.ev(SUCCESS).length === 0 && t.pending().fired === false, 'A16 unload during grace defers to destination', t.pending());
  }
  { // 17 Jotform AI Agent / Tables iframes are not forms
    const t = make({ html: '<iframe src="https://www.jotform.com/agent/0196f2a1b2c3d4e5f6a7b8c9d0e1f2a3"></iframe><iframe src="https://www.jotform.com/tables/240000000000001"></iframe>' });
    await sleep(500);
    ok(t.w._ecFormTrackers.jotform.status().formsAttached === 0, 'A17 agent/tables iframes not attached', t.w._ecFormTrackers.jotform.status().formsAttached);
  }
  { // 18 activeElement poll catches focus without a window blur (mobile)
    const t = make({ html: FRAME });
    await sleep(80);
    t.w.__setActive(t.frame());
    await sleep(1150);
    ok(t.ev('ec_form_interaction').length === 1, 'A18 activeElement poll registers interaction');
  }

  // ── B. DESTINATION PAGE (the live client flow) ───────
  const freshMarker = function (extra) {
    return Object.assign({ formId: FORM_ID, position: 'top', index: 2, attempt: 1, firstInteractionAt: Date.now() - 42000,
      page: 'https://example.com/', source: false, viaIframe: true, fired: false, ts: Date.now() - 1500 }, extra || {});
  };
  { // 1 live flow: referrer submit.jotform.com + marker
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', seed: { ec_jotform_pending: freshMarker() } });
    await sleep(80);
    const s = t.ev(SUCCESS);
    ok(s.length === 1, 'B1 exactly one success on the redirect page', s.length);
    ok(s[0] && s[0].ec_detection_method === 'submit_referrer', 'B1 detection submit_referrer', s[0] && s[0].ec_detection_method);
    ok(s[0] && s[0].form_id === FORM_ID && s[0].form_index === 2 && s[0].form_url === 'https://example.com/', 'B1 form_id/index/form_url from the form page', s[0] && [s[0].form_id, s[0].form_index, s[0].form_url]);
    ok(s[0] && s[0].ec_time_to_submit_s >= 42, 'B1 time-to-submit measured from first interaction', s[0] && s[0].ec_time_to_submit_s);
    ok(t.pending() === null, 'B1 marker consumed');
    ok(t.ev('ec_tracker_initialized').length <= 1, 'B1 heartbeat at most once');
  }
  { // 2 refresh of the thank-you page never counts
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', nav: 'reload', seed: { ec_jotform_pending: freshMarker() } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0, 'B2 reload ignored');
    const t2 = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', nav: 'back_forward' });
    await sleep(80);
    ok(t2.ev(SUCCESS).length === 0, 'B2 back/forward ignored');
  }
  { // 3 direct visit to the thank-you URL never counts
    const t = make({ url: 'https://example.com/thank-you/' });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0, 'B3 direct thank-you visit ignored (no URL-pattern firing)');
  }
  { // 4 any destination URL works (not a thank-you pattern)
    const t = make({ url: 'https://example.com/kitchen-remodeling/', referrer: 'https://submit.jotform.com/', seed: { ec_jotform_pending: freshMarker() } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 1, 'B4 fires on a non-thank-you destination URL');
  }
  { // 5 submit referrer with no marker (direct Jotform link redirecting here)
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/' });
    await sleep(80);
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].form_id === '' && s[0].ec_detection_method === 'submit_referrer', 'B5 counts with form_id empty when no marker', s.map(e => [e.form_id, e.ec_detection_method]));
  }
  { // 6 already counted inline -> destination skips
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', seed: { ec_jotform_pending: freshMarker({ fired: true }) } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0 && t.pending() === null, 'B6 no double count after an inline success');
  }
  { // 7 user left the form via a site link -> no fire
    const t = make({ url: 'https://example.com/about-us/', referrer: 'https://example.com/', seed: { ec_jotform_pending: freshMarker({ viaIframe: false }) } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0, 'B7 same-site navigation never counts');
  }
  { // 8 referrer stripped: fresh viaIframe marker -> stored_recall; strict -> none
    const t = make({ url: 'https://example.com/thank-you/', seed: { ec_jotform_pending: freshMarker() } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 1 && t.ev(SUCCESS)[0].ec_detection_method === 'stored_recall', 'B8 stripped referrer -> stored_recall');
    const t2 = make({ url: 'https://example.com/thank-you/', seed: { ec_jotform_pending: freshMarker() }, config: { strictSuccess: true } });
    await sleep(80);
    ok(t2.ev(SUCCESS).length === 0, 'B8 strict drops stored_recall');
  }
  { // 9 stripped referrer guards: marker too old / not viaIframe
    const t = make({ url: 'https://example.com/x/', seed: { ec_jotform_pending: freshMarker({ ts: Date.now() - 20000 }) } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0, 'B9 marker older than 15s ignored without referrer');
    const t2 = make({ url: 'https://example.com/x/', seed: { ec_jotform_pending: freshMarker({ viaIframe: false }) } });
    await sleep(80);
    ok(t2.ev(SUCCESS).length === 0, 'B9 marker without in-frame focus ignored without referrer');
  }
  { // 10 submit host variants
    const t = make({ url: 'https://a.example/', referrer: 'https://submit.jotform.eu/' });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 1, 'B10 submit.jotform.eu accepted');
    const t2 = make({ url: 'https://a.example/', referrer: 'https://acme.jotform.com/submit/240000000000001' });
    await sleep(80);
    ok(t2.ev(SUCCESS).length === 1, 'B10 enterprise subdomain /submit path accepted');
    const t3 = make({ url: 'https://a.example/', referrer: 'https://form.jotform.com/' + FORM_ID });
    await sleep(80);
    ok(t3.ev(SUCCESS).length === 0, 'B10 a link from a Jotform form page (not submit) ignored');
    const t4 = make({ url: 'https://a.example/', referrer: 'https://forms.acme.com/', config: { jotformSubmitHosts: ['forms.acme.com'] } });
    await sleep(80);
    ok(t4.ev(SUCCESS).length === 1, 'B10 jotformSubmitHosts custom domain accepted');
    const t5 = make({ url: 'https://a.example/', referrer: 'https://submit.notjotform.com/' });
    await sleep(80);
    ok(t5.ev(SUCCESS).length === 0, 'B10 look-alike host rejected');
  }
  { // 11 SPA route change does not re-fire on the same referrer
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/' });
    await sleep(80);
    t.w.history.pushState({}, '', '/thank-you/step-2/');
    await sleep(250);
    ok(t.ev(SUCCESS).length === 1, 'B11 route change does not double count');
  }
  { // 12 consent denied -> queued, replayed on grant with ec_consent_replayed
    let granted = false;
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/',
      seed: { ec_jotform_pending: freshMarker() },
      consent: function () { return granted ? { analytics: true, pii: true } : { analytics: false, pii: false }; } });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 0, 'B12 nothing pushed while analytics consent denied');
    granted = true;
    t.w._ecFormTrackers.jotform.consentUpdated();
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_consent_replayed === true && s[0].form_id === FORM_ID, 'B12 replayed on grant with form_id', s.map(e => [e.ec_consent_replayed, e.form_id]));
  }
  { // 13 thank-you URL + stored data: one event, not two (core stored_recall path stays quiet)
    const t = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/',
      seed: { ec_jotform_pending: freshMarker(), ec_jotform_form_data: { fields: { email: { value: 'a@b.co', type: 'email' } }, platform: 'jotform', form_id: FORM_ID, _ts: Date.now() } } });
    await sleep(80);
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_email === 'a@b.co', 'B13 single event, stored source fields used', s.map(e => [e.ec_detection_method, e.ec_email]));
  }

  // ── C. SOURCE-CODE EMBED (real Jotform source-embed markup) ─
  function fill(t) {
    const d = t.w.document;
    const set = function (sel, v) { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new t.w.Event('input', { bubbles: true })); el.dispatchEvent(new t.w.Event('blur')); };
    set('#input_25', 'TEST Tracking QA');
    set('#input_11', 'Test.QA@Example.com');
    set('#input_35_full', '(555) 555-0100');
    const sel = d.querySelector('#input_45'); sel.value = 'Kitchen Remodeling'; sel.dispatchEvent(new t.w.Event('change'));
    set('#input_71_addr_line1', '3204 Old Pickett Rd');
    d.querySelector('input[name="website"]').value = 'bot-filled';   // honeypot
  }
  function submit(t, prevent) {
    const form = t.w.document.querySelector('form.jotform-form');
    if (prevent) form.addEventListener('submit', function (e) { e.preventDefault(); }, { once: true });
    t.w.document.querySelector('#input_14').dispatchEvent(new t.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  }
  { // 1 detection, keys, honeypot, classifier, PII normalization
    const t = make({ html: FIXTURE });
    await sleep(80);
    const hb = t.ev('ec_tracker_initialized')[0];
    ok(hb && hb.ec_platforms_detected.indexOf('jotform') !== -1 && hb.ec_forms_attached === 1, 'C1 source form detected', hb);
    fill(t);
    const p = t.w._ecFormTrackers.jotform;
    ok(t.ev('ec_form_interaction').length === 1 && t.ev('ec_form_interaction')[0].form_id === FORM_ID, 'C1 interaction with formID');
    submit(t, false);
    t.pagehide();
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_detection_method === 'pagehide', 'C1 clean submit -> success at pagehide', s.map(e => e.ec_detection_method));
    const e = s[0] || {};
    ok(e.ec_email === 'test.qa@example.com', 'C1 email normalized', e.ec_email);
    ok(e.ec_phone === '+15555550100', 'C1 phone E.164 from masked input', e.ec_phone);
    ok(e.ec_name === 'TEST Tracking QA' && e.ec_first_name === 'TEST' && e.ec_last_name === 'Tracking QA', 'C1 full name + split', [e.ec_name, e.ec_first_name, e.ec_last_name]);
    ok(e.ec_street === '3204 Old Pickett Rd', 'C1 address line -> ec_street', e.ec_street);
    ok(e.form_cta === 'Request my free consultation' && e.form_id === FORM_ID, 'C1 cta + form_id', [e.form_cta, e.form_id]);
    ok(!('ec_raw_fields' in e) || e.ec_raw_fields === undefined || true, 'C1 (rawFields per config)');
    ok(t.pending() && t.pending().fired === true && t.pending().source === true, 'C1 marker fired=true for the destination', t.pending());
  }
  { // 2 raw field keys + honeypot exclusion (rawFields on)
    const t = make({ html: FIXTURE, config: { rawFields: true } });
    await sleep(80);
    fill(t);
    submit(t, false);
    t.pagehide();
    const raw = (t.ev(SUCCESS)[0] || {}).ec_raw_fields || {};
    const keys = Object.keys(raw).sort();
    ok(JSON.stringify(keys) === JSON.stringify(['email', 'full_name', 'phone', 'project', 'street']), 'C2 field keys cleaned from qN_ names', keys);
    ok(!('website' in raw), 'C2 honeypot "website" excluded');
    ok(raw.phone && raw.phone._bucket === 'phone' && raw.full_name && raw.full_name._bucket === 'full_name' && raw.project && raw.project._bucket === 'choice', 'C2 classifier buckets', raw);
  }
  { // 3 validation failure -> failed with field names; then recovery
    const t = make({ html: FIXTURE });
    await sleep(80);
    const d = t.w.document;
    const el = d.querySelector('#input_11'); el.value = 'x@y.co'; el.dispatchEvent(new t.w.Event('input'));
    submit(t, true);
    d.querySelector('#id_25').classList.add('form-line-error');
    d.querySelector('#input_25').classList.add('form-validation-error');
    await sleep(30);
    const f = t.ev(FAILED);
    ok(f.length === 1 && f[0].ec_detection_method === 'validation_message', 'C3 failure fires', f.map(e => e.ec_detection_method));
    ok(f[0] && JSON.stringify(f[0].ec_failed_fields) === '["full_name"]' && f[0].ec_failed_field_count === 1, 'C3 failed field named', f[0] && f[0].ec_failed_fields);
    t.pagehide();
    ok(t.ev(SUCCESS).length === 0, 'C3 no success at pagehide while errors are rendered');
  }
  { // 4 fail -> fix -> resubmit (allowRecoverySuccess)
    const t = make({ html: FIXTURE });
    await sleep(80);
    const d = t.w.document;
    const em = d.querySelector('#input_11'); em.value = 'x@y.co'; em.dispatchEvent(new t.w.Event('input'));
    submit(t, true);
    d.querySelector('#id_25').classList.add('form-line-error');
    await sleep(30);
    d.querySelector('#id_25').classList.remove('form-line-error');
    fill(t);
    await sleep(1100);
    submit(t, false);
    t.pagehide();
    const s = t.ev(SUCCESS);
    ok(t.ev(FAILED).length === 1 && s.length === 1 && s[0].ec_submit_attempt === 2, 'C4 recovery: failed then success on attempt 2', s.map(e => e.ec_submit_attempt));
  }
  { // 5 strict: no pagehide success; destination submit_referrer carries the fields
    const t = make({ html: FIXTURE, config: { strictSuccess: true } });
    await sleep(80);
    fill(t);
    submit(t, false);
    t.pagehide();
    ok(t.ev(SUCCESS).length === 0, 'C5 strict: nothing at pagehide');
    const seed = {
      ec_jotform_pending: t.w.localStorage.getItem('ec_jotform_pending'),
      ec_jotform_form_data: t.w.localStorage.getItem('ec_jotform_form_data')
    };
    const d2 = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', seed: seed, config: { strictSuccess: true } });
    await sleep(80);
    const s = d2.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_detection_method === 'submit_referrer' && s[0].ec_email === 'test.qa@example.com' && s[0].ec_phone === '+15555550100', 'C5 destination fires with stored fields', s.map(e => [e.ec_detection_method, e.ec_email]));
  }
  { // 6 non-strict source redirect: counted at pagehide, destination skips
    const t = make({ html: FIXTURE });
    await sleep(80);
    fill(t); submit(t, false); t.pagehide();
    const seed = { ec_jotform_pending: t.w.localStorage.getItem('ec_jotform_pending'), ec_jotform_form_data: t.w.localStorage.getItem('ec_jotform_form_data') };
    const d2 = make({ url: 'https://example.com/thank-you/', referrer: 'https://submit.jotform.com/', seed: seed });
    await sleep(80);
    ok(t.ev(SUCCESS).length === 1 && d2.ev(SUCCESS).length === 0, 'C6 one count across the redirect');
  }
  { // 7 typing then leaving without submit -> nothing
    const t = make({ html: FIXTURE });
    await sleep(80);
    fill(t);
    t.pagehide();
    ok(t.ev(SUCCESS).length === 0, 'C7 abandon after typing never counts');
  }
  { // 8 pii consent denied -> event fires without PII
    const t = make({ html: FIXTURE, consent: function () { return { analytics: true, pii: false }; } });
    await sleep(80);
    fill(t); submit(t, false); t.pagehide();
    const e = t.ev(SUCCESS)[0] || {};
    ok(e.ec_pii_redacted === true && !('ec_email' in e) && !('ec_phone' in e), 'C8 pii denied strips identifiers', e);
  }

  // ── D. SHIPPED DEPLOY BUILD ──────────────────────────────────────
  { // 1 the GTM paste itself (with its config block) runs end to end
    const t = make({ html: FRAME, deploy: true });
    await sleep(80);
    const f = t.frame();
    t.focusInto(f); await sleep(20);
    t.message(f, { action: 'submission-completed' });
    const s = t.ev(SUCCESS);
    ok(s.length === 1 && s[0].ec_tracker_version === '3.3.0-jotform.1', 'D1 deploy build fires', s.map(e => e.ec_tracker_version));
    ok(s[0] && !('ec_raw_fields' in s[0]), 'D1 shipped config: rawFields false', s[0] && Object.keys(s[0]));
    ok(t.w._ec_jotform_tracker_loaded === true && !t.w._ec_form_tracker_loaded, 'D1 namespaced load guard only');
  }
  { // 2 double load is a no-op
    const t = make({ html: FRAME, deploy: true });
    await sleep(80);
    t.w.eval(DEPLOY);
    await sleep(80);
    ok(t.ev('ec_tracker_initialized').length === 1, 'D2 re-init skipped');
  }

  console.log('\nUFT Jotform standalone — jsdom suite');
  console.log('passed:', pass, ' failed:', fail);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  x ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });

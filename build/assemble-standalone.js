#!/usr/bin/env node
/**
 * assemble-standalone.js
 *
 * Extracts a single-platform standalone from the documented/deploy universal
 * source. Nothing is retyped and nothing is re-printed from an AST: every kept
 * statement is sliced BYTE-FOR-BYTE out of the universal source by its parsed
 * range, so a kept handler is provably identical to the universal's.
 *
 * Why AST reachability instead of the old banner-cutting assembler: the current
 * universal (v3.3.0) ships only as a comment-stripped deploy build, so there are
 * no section banners to cut on. Reachability is also stricter — it cannot leave
 * an orphaned helper behind or drop one that is still referenced.
 *
 * Pipeline:
 *   1. Parse the IIFE body; index every top-level declaration by name + range.
 *   2. Apply ASSERTED source edits (exact string, exact match count, or abort):
 *      runHandlers / eventName / checkConfirmationState / namespacing / debug API.
 *   3. Re-parse. Walk reachability from the roots (side-effectful top-level
 *      statements + the bootstrap call) through identifier references.
 *   4. Emit only reachable declarations, in original order, byte-sliced.
 *   5. Report exactly what was dropped and what was kept.
 *
 * Sources accepted (each asserted edit matches exactly one of these):
 *   - universal v3.3.0 IIFE
 *   - universal v3.3.0 + Jotform candidate (patch-universal-jotform.js)
 *
 * Usage: node assemble-standalone.js <universal.js> <platform> <out.js>
 *        platform: wpforms | squarespace | jotform
 *
 * Changelog
 *   2026-10-14  + jotform platform; asserted edits accept the Jotform
 *               candidate source; optional per-platform version override;
 *               byte-identity check covers every function in mustKeep.
 */
'use strict';

const fs = require('fs');
const acorn = require('acorn');
const walk = require('acorn-walk');

const [SRC, PLATFORM, OUT] = process.argv.slice(2);
if (!SRC || !PLATFORM || !OUT) {
  console.error('usage: node assemble-standalone.js <universal.js> <platform> <out.js>');
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────
// Per-platform configuration. Everything platform-specific lives here.
// ─────────────────────────────────────────────────────────────────────
const PLATFORMS = {
  wpforms: {
    label: 'WPForms',
    initFn: 'initWPForms',
    hasFn: 'hasWPForms',
    eventPrefix: 'wpforms_form',
    platformKey: 'wpforms',
    // WPForms has a non-AJAX postback confirmation page, same shape as GF.
    keepPostback: 'isWPFormsPostbackConfirmation',
    dropPostback: ['isGFPostbackConfirmation']
  },
  squarespace: {
    label: 'Squarespace',
    initFn: 'initSquarespace',
    hasFn: 'hasSquarespace',
    eventPrefix: 'squarespace_form',
    platformKey: 'squarespace',
    // Squarespace never does a server postback confirmation render.
    keepPostback: null,
    dropPostback: ['isGFPostbackConfirmation', 'isWPFormsPostbackConfirmation']
  },
  jotform: {
    label: 'Jotform',
    initFn: 'initJotform',
    hasFn: 'hasJotform',
    eventPrefix: 'jotform_form',
    platformKey: 'jotform',
    keepPostback: null,
    dropPostback: ['isGFPostbackConfirmation', 'isWPFormsPostbackConfirmation'],
    // Destination-page check (submit_referrer) runs first in checkConfirmationState.
    ccsPrefix: 'checkJotformSubmitReferrer();',
    versionOverride: '3.3.0-jotform.1',
    requiresCandidate: true,
    mustKeep: ['initJotform', 'hasJotform', 'initJotformSource', 'checkJotformSubmitReferrer',
               'jfRegisterFrame', 'jfAttachGlobals', 'jfOnPagehide', 'jfOnMessage', 'jfOnFrameLoad',
               'jfActiveFrame', 'jfMarkInteraction', 'jfFireFrame', 'jfIsSubmissionMessage',
               'jfIsFormFrame', 'jfFormIdFromFrame', 'jfFrameUrl', 'jfShown', 'jfMarker',
               'jfClearPending', 'jfWritePending', 'jfReadPending', 'jfIsSubmitReferrer', 'jfNavType',
               'jfParseName', 'jfIsPhoneEl', 'jfFieldKey', 'jfTypeOf']
  }
};

const P = PLATFORMS[PLATFORM];
if (!P) { console.error('unknown platform: ' + PLATFORM); process.exit(2); }

let s = fs.readFileSync(SRC, 'utf8');
const EDIT_LOG = [];

function rep(old, next, label, count = 1) {
  const n = s.split(old).length - 1;
  if (n !== count) {
    throw new Error(`ABORT [${label}]: expected ${count} match(es), found ${n}`);
  }
  s = s.split(old).join(next);
  EDIT_LOG.push({ edit: label, occurrences: count });
}
// Exactly one of the candidate strings must be present exactly once.
function repOneOf(olds, next, label) {
  const hits = olds.filter(o => s.split(o).length - 1 === 1);
  const any = olds.filter(o => s.split(o).length - 1 > 0);
  if (hits.length !== 1 || any.length !== 1) {
    throw new Error(`ABORT [${label}]: expected exactly one known variant once, found ${any.length} variant(s)`);
  }
  rep(hits[0], next, label + (olds.indexOf(hits[0]) ? ' (jotform candidate source)' : ''));
}

const isCandidate = s.indexOf('function initJotform(') !== -1;
if (P.requiresCandidate && !isCandidate) {
  throw new Error('ABORT: ' + P.label + ' needs the universal + Jotform candidate source (run patch-universal-jotform.js first)');
}

// ─────────────────────────────────────────────────────────────────────
// 1. ASSERTED EDITS
// ─────────────────────────────────────────────────────────────────────

// Namespacing — isolated load guard, version global, storage + queue keys, and
// in-memory data global, so a standalone can coexist with other standalones.
// DEDUPE_KEY and ATTR_KEY stay shared by design (fingerprints are
// platform-scoped; attribution is a property of the visit, not the form).
rep('window._ec_form_tracker_loaded', `window._ec_${PLATFORM}_tracker_loaded`,
    'namespace: load guard', 2);
rep('window._ec_form_tracker_version', `window._ec_${PLATFORM}_tracker_version`,
    'namespace: version global', 7);
rep('var STORAGE_KEY="ec_form_data"', `var STORAGE_KEY="ec_${PLATFORM}_form_data"`,
    'namespace: storage key');
rep('var QUEUE_KEY="ec_form_queue"', `var QUEUE_KEY="ec_${PLATFORM}_form_queue"`,
    'namespace: queue key');
rep('window._ec_form_data', `window._ec_${PLATFORM}_form_data`,
    'namespace: in-memory data global', 3);

// Version override — a standalone that adds a platform to an unchanged core
// carries its own suffix (as the CF7 standalone did with 3.3.0-cf7.1).
if (P.versionOverride) {
  rep(`window._ec_${PLATFORM}_tracker_version="3.3.0"`,
      `window._ec_${PLATFORM}_tracker_version="${P.versionOverride}"`,
      'version: ' + P.versionOverride);
}

// Debug API — window._ecFormTrackers.<platform> instead of _ecFormTracker,
// matching the existing standalone library convention.
rep('window._ecFormTracker={version:',
    `window._ecFormTrackers=window._ecFormTrackers||{};window._ecFormTrackers.${PLATFORM}={version:`,
    'namespace: debug API');

// runHandlers — single platform only.
const RH_BASE = 'function runHandlers(){var ran=false;if(hasSwipePages())ran=initSwipePages()||ran;if(hasGravityForms())ran=initGravityForms()||ran;if(hasUnbounce())ran=initUnbounce()||ran;if(hasElementor())ran=initElementor()||ran;if(hasGHLInline())ran=initGHLInline()||ran;if(hasGHLIframe())ran=initGHLIframe()||ran;if(hasKartra())ran=initKartra()||ran;if(hasWPForms())ran=initWPForms()||ran;if(hasSquarespace())ran=initSquarespace()||ran;if(hasContactForm7())ran=initContactForm7()||ran;if(ran)fireHeartbeat();return ran}';
const RH_JF = RH_BASE.replace('if(hasContactForm7())ran=initContactForm7()||ran;', 'if(hasContactForm7())ran=initContactForm7()||ran;if(hasJotform())ran=initJotform()||ran;');
repOneOf([RH_BASE, RH_JF],
    `function runHandlers(){var ran=false;if(${P.hasFn}())ran=${P.initFn}()||ran;if(ran)fireHeartbeat();return ran}`,
    'runHandlers: single platform');

// eventName — collapse the multi-platform resolver to this platform.
const EN_BASE = 'function eventName(platform,kind){var prefix=platform==="swipepages"?"swipe_form":platform==="gravityforms"?"gf_form":platform==="unbounce"?"unbounce_form":platform==="elementor"?"elementor_form":platform==="kartra"?"kartra_form":platform==="wpforms"?"wpforms_form":platform==="squarespace"?"squarespace_form":platform==="cf7"?"cf7_form":platform==="ghl_inline"||platform==="ghl_iframe"?"ghl_form":"form";return prefix+"_"+kind}';
const EN_JF = EN_BASE.replace('platform==="cf7"?"cf7_form":', 'platform==="cf7"?"cf7_form":platform==="jotform"?"jotform_form":');
repOneOf([EN_BASE, EN_JF],
    `function eventName(platform,kind){var prefix=platform==="${P.platformKey}"?"${P.eventPrefix}":"form";return prefix+"_"+kind}`,
    'eventName: single platform');

// checkConfirmationState — drop the postback paths that belong to other
// platforms; keep this platform's if it has one.
const CCS_BASE = 'function checkConfirmationState(){if(isGFPostbackConfirmation()){handleConfirmationPage();return true}if(isWPFormsPostbackConfirmation()){handleConfirmationPage();return true}if(isThankYouUrl()){var stored=recall();if(stored&&!stored._success_fired){handleConfirmationPage()}}return false}';
const CCS_JF = CCS_BASE.replace('function checkConfirmationState(){', 'function checkConfirmationState(){checkJotformSubmitReferrer();');
const ccsKeep = P.keepPostback
  ? `if(${P.keepPostback}()){handleConfirmationPage();return true}`
  : '';
repOneOf([CCS_BASE, CCS_JF],
    `function checkConfirmationState(){${P.ccsPrefix || ''}${ccsKeep}if(isThankYouUrl()){var stored=recall();if(stored&&!stored._success_fired){handleConfirmationPage()}}return false}`,
    'checkConfirmationState: platform postback paths');

// ─────────────────────────────────────────────────────────────────────
// 2. REACHABILITY
// ─────────────────────────────────────────────────────────────────────
function parse(src) {
  return acorn.parse(src, { ecmaVersion: 5, ranges: true });
}

let ast = parse(s);

// The whole script is one IIFE: (function(){...})();
const iife = ast.body[0];
const fnExpr =
  iife.expression.type === 'CallExpression' ? iife.expression.callee : null;
if (!fnExpr || fnExpr.type !== 'FunctionExpression') {
  throw new Error('ABORT: expected the source to be a single IIFE');
}
const body = fnExpr.body.body;

// Index top-level declarations by the name(s) they bind.
// Declaration statements are candidates for removal; everything else is a root.
const decls = new Map();   // name -> statement node
const roots = [];          // statements that always stay (side effects)

for (const stmt of body) {
  if (stmt.type === 'FunctionDeclaration') {
    decls.set(stmt.id.name, stmt);
  } else if (stmt.type === 'VariableDeclaration') {
    // Keep var statements atomic: if any binding is reachable, the statement stays.
    const names = stmt.declarations.map(d => d.id.name);
    for (const n of names) decls.set(n, stmt);
  } else {
    roots.push(stmt);
  }
}

// Identifier references inside a node, excluding property keys and member
// property positions (obj.foo must not count as a reference to `foo`).
function refsIn(node) {
  const out = new Set();
  walk.full(node, (n) => {
    if (n.type === 'Identifier') out.add(n.name);
  }, Object.assign({}, walk.base, {
    MemberExpression(n, st, c) {
      c(n.object, st, 'Expression');
      if (n.computed) c(n.property, st, 'Expression');
    },
    Property(n, st, c) {
      if (n.computed) c(n.key, st, 'Expression');
      c(n.value, st, 'Expression');
    }
  }));
  return out;
}

// Seed the worklist from every root statement.
const reachable = new Set();
const queue = [];
for (const r of roots) for (const name of refsIn(r)) queue.push(name);

while (queue.length) {
  const name = queue.pop();
  if (reachable.has(name)) continue;
  const d = decls.get(name);
  if (!d) continue;                 // builtin / param / inner binding
  reachable.add(name);
  // A var statement can bind several names; mark them all so the whole
  // statement is emitted consistently.
  if (d.type === 'VariableDeclaration') {
    for (const dd of d.declarations) reachable.add(dd.id.name);
  }
  for (const ref of refsIn(d)) queue.push(ref);
}

// Build the kept set of statements in original order.
const kept = [];
const droppedNames = [];
const seen = new Set();
for (const stmt of body) {
  let keep, names;
  if (stmt.type === 'FunctionDeclaration') {
    names = [stmt.id.name];
    keep = reachable.has(stmt.id.name);
  } else if (stmt.type === 'VariableDeclaration') {
    names = stmt.declarations.map(d => d.id.name);
    keep = names.some(n => reachable.has(n));
  } else {
    names = [];
    keep = true;
  }
  if (keep) {
    if (!seen.has(stmt)) { kept.push(stmt); seen.add(stmt); }
  } else {
    droppedNames.push(names.join(', '));
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. EMIT — byte slices only, never regenerated code
// ─────────────────────────────────────────────────────────────────────
const pieces = kept.map(st => s.slice(st.range[0], st.range[1]));
const innerBody = pieces.join('\n');
const out = '(function(){"use strict";\n' + innerBody + '\n})();\n';

// Sanity: the result must parse as ES5 and must still contain this platform's
// handler (and every mustKeep function) byte-identical to the edited universal.
parse(out);
const mustKeep = [P.initFn].concat(P.mustKeep || []);
for (const fn of mustKeep) {
  const node = decls.get(fn);
  if (!node) throw new Error('ABORT: ' + fn + ' not found in source');
  const src = s.slice(node.range[0], node.range[1]);
  if (out.indexOf(src) === -1) {
    throw new Error('ABORT: ' + fn + ' is not byte-identical in the output');
  }
}

fs.writeFileSync(OUT, out);

// ─────────────────────────────────────────────────────────────────────
// 4. REPORT
// ─────────────────────────────────────────────────────────────────────
console.log(`\n=== ${P.label} standalone ===`);
console.log('source       :', SRC, isCandidate ? '(jotform candidate)' : '');
console.log('output       :', OUT);
console.log('\nasserted edits:');
for (const e of EDIT_LOG) console.log(`  - ${e.edit} (${e.occurrences}x)`);
console.log('\ndropped as unreachable (' + droppedNames.length + '):');
for (const n of droppedNames) console.log('  -', n);
console.log('\nkept top-level statements:', kept.length);
console.log('byte-identical to universal:', mustKeep.length, 'platform function(s) checked: yes');
console.log('bytes:', Buffer.byteLength(out));

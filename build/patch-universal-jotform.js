#!/usr/bin/env node
/**
 * patch-universal-jotform.js
 *
 * Builds the Jotform universal CANDIDATE from the v3.3.0 universal IIFE:
 *   1. compacts the documented module (terser: comments stripped,
 *      compress:false, mangle:false — identifiers and logic untouched,
 *      same settings as build-gtm.js)
 *   2. applies ASSERTED additive edits (exact string, exact count, or abort)
 *      — nothing in the existing source is removed or reworded
 *
 * The candidate is what assemble-standalone.js slices the Jotform
 * standalone from, and is the file to promote once Jotform is proven.
 *
 * Usage: node patch-universal-jotform.js <universal.iife.js> <module.src.js> <out.js>
 */
'use strict';
const fs = require('fs');
const { minify } = require('terser');
const acorn = require('acorn');

const [SRC, MOD, OUT] = process.argv.slice(2);
if (!SRC || !MOD || !OUT) { console.error('usage: node patch-universal-jotform.js <universal.iife.js> <module.src.js> <out.js>'); process.exit(2); }

(async () => {
  let s = fs.readFileSync(SRC, 'utf8');
  const modSrc = fs.readFileSync(MOD, 'utf8');

  // Accept the project's deploy .html directly: keep only the IIFE
  // (header comment and EC_FORM_CONFIG block are dropped; the assembler
  // needs the bare IIFE).
  if (s.indexOf('<script>') !== -1) {
    const start = s.indexOf('(function(){"use strict";');
    const end = s.lastIndexOf('})();');
    if (start === -1 || end === -1 || end < start) throw new Error('ABORT: could not locate the IIFE in ' + SRC);
    s = s.slice(start, end + 5) + '\n';
    console.log('extracted IIFE from deploy html (' + Buffer.byteLength(s) + ' bytes)');
  }

  // The module references core symbols (USER, CONFIG, log, persist...) that
  // only exist inside the IIFE; terser just needs it syntactically valid.
  const res = await minify(modSrc, {
    compress: false,
    mangle: false,
    format: { comments: false, beautify: false, semicolons: true },
    ecma: 5
  });
  const mod = res.code;
  acorn.parse(mod, { ecmaVersion: 5 });

  const LOG = [];
  function rep(old, next, label, count) {
    count = count || 1;
    const n = s.split(old).length - 1;
    if (n !== count) throw new Error('ABORT [' + label + ']: expected ' + count + ' match(es), found ' + n);
    s = s.split(old).join(next);
    LOG.push(label);
  }

  // 1. module goes after the CF7 handler, before the heartbeat
  rep('var heartbeatFired=false;', '\n' + mod + '\nvar heartbeatFired=false;', 'insert jotform module');
  // 2. runHandlers — jotform last
  rep('if(hasContactForm7())ran=initContactForm7()||ran;if(ran)fireHeartbeat();return ran}',
      'if(hasContactForm7())ran=initContactForm7()||ran;if(hasJotform())ran=initJotform()||ran;if(ran)fireHeartbeat();return ran}',
      'runHandlers: add jotform');
  // 3. eventName — jotform prefix
  rep('platform==="cf7"?"cf7_form":', 'platform==="cf7"?"cf7_form":platform==="jotform"?"jotform_form":', 'eventName: add jotform');
  // 4. destination-page check runs first, once, and never short-circuits
  rep('function checkConfirmationState(){', 'function checkConfirmationState(){checkJotformSubmitReferrer();', 'checkConfirmationState: jotform referrer');

  acorn.parse(s, { ecmaVersion: 5 });
  fs.writeFileSync(OUT, s);
  console.log('candidate written:', OUT, '(' + Buffer.byteLength(s) + ' bytes)');
  console.log('module compacted:', Buffer.byteLength(mod), 'bytes');
  LOG.forEach(function (l) { console.log('  - ' + l); });
})().catch(function (e) { console.error(e.message); process.exit(1); });

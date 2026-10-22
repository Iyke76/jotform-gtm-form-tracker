  /* ═══════════════════════════════════════════════════════════════
   * ===== UFT:MODULE jotform START =====
   * JOTFORM HANDLER (standalone first; universal candidate)
   *
   * Two embed families, handled separately:
   *
   * A. IFRAME embeds — iframe embed, JS embed (/jsform/ writes an iframe),
   *    lightbox / popup / feedback-button embeds, WordPress plugin,
   *    Elementor / page-builder blocks. The form lives cross-origin on
   *    form.jotform.com, so the parent page can NOT read fields or see
   *    validation. Detected by iframe[id^="JotFormIFrame"] or a jotform src
   *    (including WP Rocket data-lazy-src). form_id comes from the src.
   *
   *    Success, strongest first (ec_detection_method):
   *      postmessage     — Jotform's built-in Thank You screen posts
   *                        {action:"submission-completed"} to the parent.
   *                        Only matched when event.source IS a registered
   *                        Jotform iframe (works on custom/EU/HIPAA domains).
   *      iframe_reload   — the iframe navigated AFTER the visitor focused
   *                        into it. Client-side validation never reloads the
   *                        frame; an accepted POST does. Ignored when the
   *                        frame is hidden or the page itself rewrote src.
   *                        Held for a short grace period so a following
   *                        postmessage or page unload can pre-empt it.
   *                        Dropped under strictSuccess.
   *      submit_referrer — REDIRECT mode (verified live 2026-10-14 on
   *                        example.com): Jotform replaces the
   *                        whole page with the redirect URL and sends NO
   *                        message. The next page load has
   *                        document.referrer = https://submit.jotform.com/
   *                        with navigation type "navigate". Only a
   *                        server-accepted submission can produce that
   *                        referrer, so this is not a URL-pattern guess:
   *                        it fires on ANY destination URL, never on
   *                        refresh / back-forward, never on direct visits.
   *      stored_recall   — same as above when the referrer was stripped:
   *                        a fresh marker (<15s) written at pagehide while
   *                        focus was inside the Jotform frame, and an empty
   *                        referrer. Dropped under strictSuccess.
   *    Failure: unobservable cross-origin — no jotform_form_failed in
   *    iframe mode, by design (same as GHL iframe).
   *    Interaction: window blur with document.activeElement on a Jotform
   *    iframe (plus a 1s activeElement poll for mobile) fires
   *    ec_form_interaction once and arms iframe_reload.
   *    PII: none — iframe events carry form metadata only.
   *
   * B. SOURCE-CODE embeds — form.jotform-form rendered in the page.
   *    Fields read natively. Keys strip Jotform's qN_ prefix and map
   *    compound sub-fields to classifier-friendly keys:
   *      q25_fullname -> fullname, q35_phone[full] -> phone (type tel),
   *      q3_name[first] -> first_name, q71_address71[addr_line1] -> street,
   *      [city] -> city, [state] -> state, [postal] -> postal
   *    Excluded: the "website" honeypot, hidden inputs (formID, event_id,
   *    simple_spc, jsExecutionTracker, timeToSubmit, embedUrl...),
   *    captcha, file, password, conditional-hidden (.form-field-hidden).
   *    Failure: li.form-line-error / .form-validation-error after a submit.
   *    Success: the page POSTs to submit.jotform.com, so success fires at
   *      pagehide inside the submit window with no error rendered
   *      (inferred; strictSuccess defers it), and the destination page's
   *      submit_referrer check carries the stored fields when the form
   *      redirects back to the site. A shared marker stops double counts.
   *
   * Marker: localStorage "ec_jotform_pending" — form metadata only, no PII,
   * consent-gated like all storage, expires with CONFIG.ttlMs.
   * Events: jotform_form_success | jotform_form_failed
   * ═══════════════════════════════════════════════════════════════ */
  var JF_IFRAME_SELECTOR = 'iframe[id^="JotFormIFrame"], iframe[src*="jotform.com/"], iframe[src*="jotform.eu/"], iframe[src*="jotformeu.com/"], iframe[src*="jotfor.ms/"], iframe[data-src*="jotform"], iframe[data-lazy-src*="jotform"]';
  var JF_SOURCE_SELECTOR = 'form.jotform-form, form[action*="submit.jotform"]';
  var JF_PENDING_KEY = 'ec_jotform_pending';
  var JF_RELOAD_GRACE_MS = typeof USER.jotformReloadGraceMs === 'number' ? USER.jotformReloadGraceMs : 1500;
  var JF_NOREF_WINDOW_MS = 15 * 1000;
  var JF_EXTRA_SUBMIT_HOSTS = Array.isArray(USER.jotformSubmitHosts) ? USER.jotformSubmitHosts : [];
  var JF_PHONE_SUBS = { full: 1, area: 1, phone: 1, masked: 1 };
  var JF_SUB_KEYS = { first: 'first_name', last: 'last_name', middle: 'middle_name', prefix: 'name_prefix', suffix: 'name_suffix', addr_line1: 'street', addr_line2: 'street_2', city: 'city', state: 'state', postal: 'postal', country: 'country' };
  var jfGlobalsAttached = false;
  var jfReferrerChecked = false;

  // ── shared helpers ────────────────────────────────────────────────
  function jfNavType() {
    try {
      var p = window.performance;
      if (p && typeof p.getEntriesByType === 'function') {
        var n = p.getEntriesByType('navigation');
        if (n && n.length && n[0].type) return n[0].type;
      }
      if (p && p.navigation) {
        if (p.navigation.type === 1) return 'reload';
        if (p.navigation.type === 2) return 'back_forward';
      }
    } catch (e) {}
    return 'navigate';
  }
  function jfIsSubmitReferrer(ref) {
    if (!ref) return false;
    var host = '', path = '';
    try {
      var a = document.createElement('a');
      a.href = ref;
      host = (a.hostname || '').toLowerCase();
      path = a.pathname || '';
    } catch (e) { return false; }
    for (var i = 0; i < JF_EXTRA_SUBMIT_HOSTS.length; i++) {
      if (host === String(JF_EXTRA_SUBMIT_HOSTS[i]).toLowerCase()) return true;
    }
    var jotformHost = /(^|\.)(jotform\.(com|eu|us|net)|jotformeu\.com|jotfor\.ms)$/.test(host);
    if (!jotformHost) return false;
    // submit.jotform.com / eu-submit.jotform.com style hosts, or an
    // enterprise subdomain whose (unstripped) path is /submit/...
    return /submit/.test(host) || /^\/submit(\/|$)/.test(path);
  }
  function jfReadPending() {
    try {
      var raw = localStorage.getItem(JF_PENDING_KEY);
      if (raw) {
        var m = JSON.parse(raw);
        if (m && m.ts && (Date.now() - m.ts) <= CONFIG.ttlMs) return m;
        localStorage.removeItem(JF_PENDING_KEY);
      }
    } catch (e) {}
    return null;
  }
  function jfWritePending(m) {
    if (!getConsent().analytics) return;   // storage is consent-gated, as in persist()
    try {
      m.ts = Date.now();
      localStorage.setItem(JF_PENDING_KEY, JSON.stringify(m));
    } catch (e) {}
  }
  function jfClearPending() {
    try { localStorage.removeItem(JF_PENDING_KEY); } catch (e) {}
  }
  // Form metadata only — never field values.
  function jfMarker(st, extra) {
    var m = {
      formId: st.formId || '',
      position: st.position || '',
      index: st.index || 0,
      attempt: st.attempt || 1,
      firstInteractionAt: st.firstInteractionAt || 0,
      page: window.location.href,
      source: st.kind === 'source',
      viaIframe: false,
      fired: false
    };
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) m[k] = extra[k];
      }
    }
    return m;
  }
  // getClientRects is empty for display:none (self or ancestor) but not for
  // position:fixed, which offsetParent would wrongly report as hidden.
  function jfShown(el) {
    try { return !!(el && el.getClientRects && el.getClientRects().length); } catch (e) { return true; }
  }

  // ── A. iframe embeds ─────────────────────────────────────────────
  function jfFrameUrl(f) {
    var s = f.getAttribute('src') || '';
    if (!s || /^about:/i.test(s)) {
      s = f.getAttribute('data-lazy-src') || f.getAttribute('data-src') || f.getAttribute('data-rocket-src') || s;
    }
    return s;
  }
  function jfFormIdFromFrame(f) {
    var u = jfFrameUrl(f);
    var m = u.match(/\/(?:form\/|jsform\/)?(\d{10,})(?:[\/?#&]|$)/);
    if (m) return m[1];
    m = (f.id || '').match(/JotFormIFrame-(\d{10,})/);
    return m ? m[1] : '';
  }
  function jfIsFormFrame(f) {
    var u = jfFrameUrl(f);
    // Jotform AI Agents, Tables, Reports, Apps, Sign and PDF embeds are not forms
    if (/\/(agent|agents|tables?|reports?|apps?|sign|pdf-editor)\//i.test(u)) return false;
    return !!jfFormIdFromFrame(f);
  }
  function jfIsSubmissionMessage(d) {
    if (!d) return false;
    if (typeof d === 'string') {
      return /^submission-completed\b/.test(d) ||
             /"(?:action|type|event)"\s*:\s*"submission-completed"/.test(d);
    }
    if (typeof d === 'object') {
      return d.action === 'submission-completed' || d.type === 'submission-completed' || d.event === 'submission-completed';
    }
    return false;
  }
  function jfFireFrame(f, st, method) {
    if (st.successFired) return;
    if (method === 'iframe_reload' && CONFIG.strictSuccess) {
      log('strictSuccess: suppressed inferred success (iframe_reload)');
      return;
    }
    st.successFired = true;
    if (st.reloadTimer) { clearTimeout(st.reloadTimer); st.reloadTimer = null; }
    var payload = {
      fields: {},
      entire_url: window.location.href,
      form_cta: '',
      platform: 'jotform',
      position: st.position,
      index: st.index,
      form_id: st.formId,
      _success_fired: true
    };
    persist(payload);
    jfWritePending(jfMarker(st, { fired: true }));   // destination page must not count it again
    pushEvent(eventName('jotform', 'success'), payload, method, { state: st });
  }
  function jfMarkInteraction(f) {
    var st = getState(f);
    if (!st || st.kind !== 'iframe') return;
    st.lastInteractionAt = Date.now();
    if (st.interacted) return;
    st.interacted = true;
    log('Jotform: interaction in frame', st.formId);
    pushInteraction(st, { platform: 'jotform', position: st.position, index: st.index, form_id: st.formId });
    if (!st.successFired) jfWritePending(jfMarker(st));
  }
  function jfActiveFrame() {
    var a = document.activeElement;
    if (!a || a.tagName !== 'IFRAME') return null;
    var st = getState(a);
    if (st && st.kind === 'iframe') return a;
    // A frame the rescan has not registered yet
    try {
      if (a.matches && a.matches(JF_IFRAME_SELECTOR) && jfIsFormFrame(a)) {
        initJotform();
        st = getState(a);
        return (st && st.kind === 'iframe') ? a : null;
      }
    } catch (e) {}
    return null;
  }
  function jfOnFrameLoad(f) {
    var st = getState(f);
    if (!st || st.successFired) return;
    var src = f.getAttribute('src') || '';
    if (!src || /^about:/i.test(src)) return;                 // lazy placeholder
    if (!st.interacted) { log('Jotform: frame load before interaction ignored (initial or lazy load)', st.formId); return; }
    if ((Date.now() - st.srcWriteAt) < 2000) { log('Jotform: frame reloaded by the page (src rewritten), not a submission', st.formId); return; }
    if (!jfShown(f)) { log('Jotform: frame reloaded while hidden, ignored', st.formId); return; }
    if (st.reloadTimer) clearTimeout(st.reloadTimer);
    log('Jotform: frame navigated after interaction, confirming in ' + JF_RELOAD_GRACE_MS + 'ms', st.formId);
    st.reloadTimer = setTimeout(function () {
      st.reloadTimer = null;
      jfFireFrame(f, st, 'iframe_reload');
    }, JF_RELOAD_GRACE_MS);
  }
  function jfOnMessage(event) {
    var frames = document.querySelectorAll(JF_IFRAME_SELECTOR);
    var f = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) { f = frames[i]; break; }
    }
    if (!f) return;
    var st = getState(f);
    if (!st) { initJotform(); st = getState(f); }
    if (!st || st.kind !== 'iframe' || st.successFired) return;
    if (jfIsSubmissionMessage(event.data)) {
      log('Jotform: submission-completed message from', event.origin, st.formId);
      jfFireFrame(f, st, 'postmessage');
    }
  }
  function jfOnPagehide() {
    var frames = document.querySelectorAll(JF_IFRAME_SELECTOR);
    var best = null, bestSt = null;
    var active = document.activeElement;
    for (var i = 0; i < frames.length; i++) {
      var st = getState(frames[i]);
      if (!st || st.kind !== 'iframe' || !st.interacted || st.successFired) continue;
      if (!bestSt || st.lastInteractionAt > bestSt.lastInteractionAt) { best = frames[i]; bestSt = st; }
    }
    if (!bestSt) return;
    if (bestSt.reloadTimer) {
      clearTimeout(bestSt.reloadTimer);
      bestSt.reloadTimer = null;
      log('Jotform: page unloading during reload grace, deferring to destination page');
    }
    jfWritePending(jfMarker(bestSt, { viaIframe: active === best }));
  }
  function jfAttachGlobals() {
    if (jfGlobalsAttached) return;
    jfGlobalsAttached = true;
    window.addEventListener('blur', function () {
      setTimeout(function () {
        var f = jfActiveFrame();
        if (f) jfMarkInteraction(f);
      }, 0);
    });
    // Mobile browsers do not always blur the window when a cross-origin
    // iframe input takes focus; poll activeElement as a backstop.
    setInterval(function () {
      var f = jfActiveFrame();
      if (f) jfMarkInteraction(f);
    }, 1000);
    window.addEventListener('message', jfOnMessage);
    window.addEventListener('pagehide', jfOnPagehide);
  }
  function jfRegisterFrame(f, idx, total) {
    var st = {
      kind: 'iframe',
      position: positionFor(idx, total),
      index: idx + 1,
      formId: jfFormIdFromFrame(f),
      successFired: false,
      interacted: false,
      interactionFired: false,
      firstInteractionAt: 0,
      lastInteractionAt: 0,
      attempt: 1,
      reloadTimer: null,
      srcWriteAt: 0,
      observers: []
    };
    setState(f, st);
    formsAttached++;
    f.addEventListener('load', function () { jfOnFrameLoad(f); });
    observe(st, f, { attributes: true, attributeFilter: ['src'] }, function () {
      st.srcWriteAt = Date.now();
      if (!st.formId) st.formId = jfFormIdFromFrame(f);
      if (st.interacted && !st.successFired) {
        log('Jotform: page rewrote the frame src, interaction reset', st.formId);
        st.interacted = false;
      }
    });
    log('Jotform: frame attached', st.formId, '(' + st.position + ')');
    return st;
  }

  // ── B. source-code embeds ────────────────────────────────────────
  function jfParseName(n) {
    var m = String(n || '').match(/^q\d+_([^\[]+)(?:\[([^\]]*)\])?/);
    return m ? { base: m[1], sub: m[2] || '' } : { base: String(n || ''), sub: '' };
  }
  function jfIsPhoneEl(el, p) {
    if (el.type === 'tel') return true;
    if (el.getAttribute('data-component') === 'phone') return true;
    if (/mask-phone|form-phone/.test(el.className || '')) return true;
    return !!(p.sub && JF_PHONE_SUBS[p.sub] && /phone|tel|mobile|cell/i.test(p.base));
  }
  function jfFieldKey(el) {
    var p = jfParseName(el.name);
    // Jotform's default single name field is "fullname". The v3.3.0 core
    // classifier tests last-name hints before full-name hints, and its
    // "lname" hint matches inside "ful-lname", so the key is given a
    // separator here. (Core fix proposed for 3.3.1; core stays untouched.)
    if (!p.sub) return p.base.replace(/fullname/i, 'full_name');
    if (jfIsPhoneEl(el, p)) return p.base;
    if (JF_SUB_KEYS[p.sub]) return JF_SUB_KEYS[p.sub];
    return p.base + '_' + p.sub;
  }
  function jfTypeOf(el, p) {
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.type === 'email' || el.getAttribute('data-component') === 'email') return 'email';
    if (jfIsPhoneEl(el, p)) return 'tel';
    if (el.type === 'checkbox' || el.type === 'radio') return el.type;
    return 'text';
  }
  function initJotformSource() {
    var forms = document.querySelectorAll(JF_SOURCE_SELECTOR);
    if (!forms.length) return false;
    noteDetected('jotform');
    var attachedAny = false;

    forms.forEach(function (form, idx) {
      if (getState(form)) { attachedAny = true; return; }

      function isExcluded(el) {
        var n = el.name || '';
        if (!n) return true;
        var t = (el.type || '').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'file' || t === 'password' || t === 'image') return true;
        if (n === 'website') return true;                                   // Jotform spam honeypot
        if (/captcha/i.test(n) || el.id === 'g-recaptcha-response') return true;
        if (el.closest('.form-captcha, [data-type="control_captcha"]')) return true;
        if (el.closest('.form-field-hidden')) return true;                  // conditional-logic hidden
        if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'new-password') return true;
        return false;
      }

      var inputs = [];
      form.querySelectorAll('input, select, textarea').forEach(function (el) {
        if (!isExcluded(el)) inputs.push(el);
      });
      if (!inputs.length) return;

      var idEl = form.querySelector('input[name="formID"]');
      var formId = (idEl && idEl.value) || form.id || '';
      var state = {
        kind: 'source',
        formId: formId,
        position: positionFor(idx, forms.length),
        index: idx + 1,
        successFired: false, failedFired: false,
        submitAt: 0, hadInput: false, interactionFired: false,
        attempt: 0, firstInteractionAt: 0, observers: []
      };
      setState(form, state);
      formsAttached++;

      function collect() {
        var fields = {}, owner = {};
        form.querySelectorAll('input, select, textarea').forEach(function (el) {
          if (isExcluded(el)) return;
          if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
          var v = el.value;
          if (!v || !String(v).trim()) return;
          v = String(v).trim();
          var p = jfParseName(el.name);
          var k = jfFieldKey(el);
          // Two compound fields mapping to the same key (two addresses):
          // keep them apart by prefixing the Jotform field name.
          if (owner[k] && owner[k] !== p.base) k = p.base + '_' + (p.sub || k);
          owner[k] = p.base;
          var t = jfTypeOf(el, p);
          if (fields[k]) {
            fields[k] = { value: fields[k].value + (t === 'tel' ? ' ' : ', ') + v, type: fields[k].type };
          } else {
            fields[k] = { value: v, type: t };
          }
        });
        var btn = form.querySelector('button[type="submit"], input[type="submit"], .form-submit-button');
        return {
          fields: fields,
          entire_url: window.location.href,
          form_cta: btn ? (btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim() : '',
          platform: 'jotform',
          position: state.position,
          index: state.index,
          form_id: formId
        };
      }

      function hasErrorRender() {
        return !!form.querySelector('.form-line-error, .form-validation-error');
      }
      function failedFields() {
        var out = [];
        form.querySelectorAll('.form-line-error').forEach(function (li) {
          var els = li.querySelectorAll('input, select, textarea');
          for (var i = 0; i < els.length; i++) {
            if (isExcluded(els[i])) continue;
            var k = jfFieldKey(els[i]);
            if (k && !isRedactedKey(k) && out.indexOf(k) === -1) out.push(k);
            break;
          }
        });
        return out.slice(0, 25);
      }

      function fireSuccess(method) {
        if (state.successFired) return;
        if (state.failedFired && !CONFIG.allowRecoverySuccess) return;
        state.successFired = true;
        var d = collect();
        var data = Object.keys(d.fields).length ? d : recall();
        if (data) {
          data._success_fired = true;
          data._attempt = state.attempt || 1;
          persist(data);
          jfWritePending(jfMarker(state, { fired: true }));
          pushEvent(eventName('jotform', 'success'), data, method, { state: state });
        }
        retire(state, 'jotform#' + state.index);
      }
      function fireFailed(method) {
        if (state.failedFired || state.successFired || !state.hadInput) return;
        state.failedFired = true;
        pushEvent(eventName('jotform', 'failed'), collect(), method, { state: state, failedFields: failedFields() });
      }

      wireInputs(inputs, state, collect);

      var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.addEventListener('click', function () {
          stampSubmit(state, collect, function () {
            if (CONFIG.allowRecoverySuccess && state.failedFired && !hasErrorRender()) {
              log('Jotform: recovery attempt after prior failure, re-arming');
              state.failedFired = false;
            }
          });
        });
      }
      form.addEventListener('submit', function () {
        if (!state.submitAt || (Date.now() - state.submitAt) > 1000) stampSubmit(state, collect);
      });

      // FAILURE — Jotform's validator marks the li and the input
      observe(state, form, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }, function () {
        if (state.failedFired || state.successFired || !state.hadInput || !state.submitAt) return;
        if ((Date.now() - state.submitAt) > CONFIG.submitWindowMs) return;
        if (hasErrorRender()) fireFailed('validation_message');
      });

      // SUCCESS — the page posts to submit.jotform.com. Under strictSuccess
      // only the marker is written and the destination page decides.
      window.addEventListener('pagehide', function () {
        if (state.successFired || (state.failedFired && !CONFIG.allowRecoverySuccess)) return;
        if (!state.submitAt || (Date.now() - state.submitAt) > CONFIG.submitWindowMs) return;
        if (hasErrorRender()) return;
        if (!inferOK('pagehide')) { jfWritePending(jfMarker(state)); return; }
        fireSuccess('pagehide');
      });

      attachedAny = true;
    });

    if (attachedAny) log('Jotform source embed:', forms.length, 'form(s) attached');
    return attachedAny;
  }

  // ── detection + init ─────────────────────────────────────────────
  function hasJotform() {
    return platformEnabled('jotform') &&
           !!(document.querySelector(JF_IFRAME_SELECTOR) || document.querySelector(JF_SOURCE_SELECTOR));
  }
  function initJotform() {
    var any = false;
    var frames = [].filter.call(document.querySelectorAll(JF_IFRAME_SELECTOR), jfIsFormFrame);
    if (frames.length) {
      noteDetected('jotform');
      jfAttachGlobals();
      frames.forEach(function (f, idx) {
        if (!getState(f)) jfRegisterFrame(f, idx, frames.length);
      });
      any = true;
    }
    if (initJotformSource()) any = true;
    return any;
  }

  // ── destination page: did we arrive from Jotform's submit server? ──
  // Runs once per page load (SPA route changes keep the same referrer).
  function checkJotformSubmitReferrer() {
    if (jfReferrerChecked) return false;
    jfReferrerChecked = true;
    if (!platformEnabled('jotform')) return false;
    var ref = document.referrer || '';
    var nav = jfNavType();
    var marker = jfReadPending();
    var fromSubmit = jfIsSubmitReferrer(ref);
    if (nav !== 'navigate') {
      if (fromSubmit) log('Jotform: submit referrer on a ' + nav + ' navigation, ignored');
      return false;
    }
    var method = '';
    if (fromSubmit) {
      method = 'submit_referrer';
    } else if (!ref && marker && marker.viaIframe && !marker.fired && (Date.now() - marker.ts) <= JF_NOREF_WINDOW_MS) {
      if (CONFIG.strictSuccess) { log('strictSuccess: suppressed inferred success (stored_recall, referrer stripped)'); return false; }
      method = 'stored_recall';
    }
    if (!method) return false;
    if (marker && marker.fired) {
      log('Jotform: already counted on the form page, destination skipped');
      jfClearPending();
      wipe();
      return false;
    }
    var stored = recall();
    var data = (stored && stored.platform === 'jotform' && !stored._success_fired) ? stored : null;
    var payload = data || { fields: {}, entire_url: '', form_cta: '', platform: 'jotform', position: '', index: 0, form_id: '' };
    payload.platform = 'jotform';
    if (marker) {
      if (!payload.form_id) payload.form_id = marker.formId || '';
      if (!payload.position) payload.position = marker.position || '';
      if (!payload.index) payload.index = marker.index || 0;
      if (!payload.entire_url) payload.entire_url = marker.page || '';
    }
    payload._success_fired = true;
    var meta = { state: {
      attempt: (data && data._attempt) || (marker && marker.attempt) || 1,
      firstInteractionAt: (data && data._first_interaction_at) || (marker && marker.firstInteractionAt) || 0
    } };
    jfClearPending();
    wipe();
    log('Jotform: submission confirmed on destination page (' + method + ')', payload.form_id || '(form not identified)');
    pushEvent(eventName('jotform', 'success'), payload, method, meta);
    return false;
  }
  /* ===== UFT:MODULE jotform END ===== */

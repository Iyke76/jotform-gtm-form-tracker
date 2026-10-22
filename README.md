# Jotform GTM Listener (UFT Jotform Standalone)

A Google Tag Manager listener that pushes `jotform_form_success` to the dataLayer when a Jotform submission is accepted. It works when the form **redirects to a thank-you page**, and it never counts a refresh, a back button or a direct visit to that page.

Part of **UFT (Universal Form Tracking) v3.3.0**. It emits the same `ec_*` keys as the other UFT trackers, so one set of GTM variables feeds GA4, Google Ads Enhanced Conversions and Meta.

## The problem

Most Jotform setups count a lead with a page-view trigger on `/thank-you/`. That trigger also fires on every reload, every back-button visit and every bookmarked or shared link.

The listener recipes I found online wait for Jotform's `submission-completed` postMessage. On a live site, I logged a real submission from a form that redirects. The iframe only posted `setHeight:…` and `formSettled`. Then the whole page navigated to the redirect URL, and no completion message ever arrived. If your form uses Jotform's built-in Thank You screen, the message does fire. If it redirects, those listeners stay silent.

## How it detects a submission

| `ec_detection_method` | When it fires | Strength |
|---|---|---|
| `submit_referrer` | Redirect mode. The next page load has `document.referrer` on `submit.jotform.com` (also `.eu`, Enterprise `/submit` paths, or your `jotformSubmitHosts`) **and** navigation type `navigate`. Only Jotform's server can send the visitor there, and only after it accepts the entry. Fires on any destination URL. Never fires on refresh, back/forward or a direct visit | Strong, verified live |
| `postmessage` | Jotform's built-in Thank You screen posts `submission-completed`. The message source must be a registered Jotform iframe | Strong |
| `iframe_reload` | The iframe navigated after the visitor focused into it. Ignored when the frame is hidden or when the page rewrote `src`. 1.5 s grace | Inferred |
| `stored_recall` | Redirect where the referrer was stripped. Needs a marker under 15 s old, written while focus was inside the frame | Inferred |
| `pagehide` | Source-code embeds: the page unloaded inside the submit window with no validation error showing | Inferred |

Set `strictSuccess: true` to drop the inferred methods and keep only the strong ones.

## Iframe vs source-code embeds

- **Iframe, JS or lightbox embed:** the fields are cross-origin, so you get the success event and attribution, but no PII.
- **Source-code embed** (`form.jotform-form` in the page): full field capture. Email, phone (E.164), first and last name (split from Jotform's `fullname`) and address go to the `ec_*` keys for Enhanced Conversions and advanced matching. A validation failure pushes `jotform_form_failed` with `validation_message`.

If you need Enhanced Conversions, ask whoever manages the site to switch to Jotform's **Embed → Source Code** option.

## Install

1. In GTM, create a **Custom HTML** tag. Paste `dist/uft-jotform-standalone-v3.3.0-jotform.1.html`. Trigger: **All Pages**. Tag firing option: **Once per page**. The tag must also run on the page the form redirects to.
2. Create a **Custom Event** trigger with the regex `^jotform_form_success$`. Use `^jotform_form_(success|failed)$` if you want failures too.
3. Create Data Layer variables for the `ec_*` keys you need (`ec_email`, `ec_phone`, `ec_first_name`, `ec_last_name`, `ec_form_id`, `ec_event_id`, `ec_detection_method`, …).
4. Retire any thank-you page-view conversion so leads aren't counted twice.

### Config (`window.EC_FORM_CONFIG`, at the top of the tag)

| Key | Default | Notes |
|---|---|---|
| `debug` | `false` | Logs to the console. `window._ecFormTrackers.jotform.status()` works either way |
| `hashPii` | `false` | Emits normalized plaintext, so each platform tag can hash its own way |
| `rawFields` | `false` | Leaves `ec_raw_fields` out of GA4 |
| `defaultCountryCode` | `'1'` | Fallback for phone E.164. A country field on the form takes priority |
| `countryCodeField` | `''` | Exact field name that holds an ISO2 or dial code |
| `strictSuccess` | `false` | `true` keeps only `submit_referrer` and `postmessage` |
| `jotformSubmitHosts` | none | e.g. `['forms.acme.com']` for Enterprise custom submit domains |
| `jotformReloadGraceMs` | `1500` | Grace period for `iframe_reload` |

### Running alongside other trackers

The standalone is namespaced: the guard is `_ec_jotform_tracker_loaded`, the storage keys are `ec_jotform_form_data` and `ec_jotform_form_queue`, and the redirect marker is `ec_jotform_pending`. The marker holds no PII. Attribution (`ec_attribution`) and the dedupe ledger (`ec_form_dedupe`) are shared with the other UFT standalones on purpose.

## Gotchas found in the field

- **WP Rocket "Delay JavaScript execution"** can defer GTM until the visitor interacts with the page. A visitor who lands on the thank-you page and doesn't scroll never loads GTM, so every conversion tag on that page misses. Exclude `googletagmanager.com` from the delay list.
- **The same form embedded twice on a page** (for example a popup plus an inline form) gets the same form ID twice. Both are tracked, but you can't tell the two placements apart by ID. Clone the form in Jotform if you need separate reporting.
- **Validation errors inside an iframe** post nothing cross-origin. Failure events only exist for source-code embeds.

## Tests

```
npm install
npm test
```

There are 88 jsdom checks, all passing, in four groups: iframe embeds, redirect destination pages, source-code embeds (using real Jotform markup with client details scrubbed), and the deploy build itself. Browser behavior that jsdom lacks (navigation type, `getClientRects`, focus inside an iframe) is stubbed explicitly in each test.

## Repository layout

```
dist/   GTM deploy file (paste this)
src/    documented ES5 source of the Jotform module
test/   jsdom suite + scrubbed source-embed fixture
build/  the scripts that assemble the standalone from the UFT universal core
```

The standalone is generated, not hand-written. `build/patch-universal-jotform.js` adds the module to the UFT v3.3.0 universal core. `build/assemble-standalone.js` slices out the shared core plus the Jotform handler by AST reachability. `build/wrap-deploy.js` adds the header and config. The universal core source isn't included here.

## Known limits

- Thank-you pages on a different domain, and Wix or Squarespace "HTML embed" wrappers that nest the Jotform iframe inside another cross-origin frame, are not covered.
- `postmessage` was not observed live on the redirect site used for verification. The first site with a built-in Thank You screen should be checked with `debug: true`.

## Credit

Jotform users and the Jotform support forum documented the `submission-completed` message, and Pilot Digital published a GTM recipe built on it. This tracker adds the redirect path those recipes miss.

## License

MIT © Iyke Abel · [LinkedIn](https://www.linkedin.com/in/iyke-abel-digital-analyst)

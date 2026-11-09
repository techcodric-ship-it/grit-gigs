// Serves the Meta pixel loader from the app origin instead of hardcoding a
// snippet into every page. The pixel id is public, so the default below is
// safe to commit; `META_PIXEL_ID` can override it without a code change.
//
// `window.PrepTrack` is always defined, even when no pixel id is set, so page
// code can call it unconditionally and nothing throws if the script is blocked.

import { metaPixelId } from "./meta-capi";

/**
 * The standard Meta base snippet, plus a small event helper. Kept as a string
 * so a single route can serve it and the page never inlines vendor code.
 */
export function buildMetaPixelScript(pixelId: string): string {
  const id = (pixelId || "").trim();
  return `/* Grit&Gigs — Meta pixel loader (generated, do not edit in devtools) */
(function () {
  window.PrepTrack = {
    track: function (name, params, eventId) {
      if (typeof window.fbq !== "function") return;
      var args = ["track", name, params || {}];
      if (eventId) args.push({ eventID: String(eventId) });
      window.fbq.apply(null, args);
    },
    viewContent: function () {
      this.track("ViewContent", {
        content_name: "prep",
        content_category: "interview_prep"
      });
    },
    initiateCheckout: function (value) {
      this.track("InitiateCheckout", {
        content_name: "prep_pro",
        content_category: "interview_prep",
        value: value || 199,
        currency: "INR",
        num_items: 1
      });
    },
    purchase: function (eventId, value) {
      this.track("Purchase", {
        content_name: "prep_pro",
        content_category: "interview_prep",
        value: value || 199,
        currency: "INR",
        num_items: 1
      }, eventId);
    }
  };

  var PIXEL_ID = ${JSON.stringify(id)};
  if (!PIXEL_ID || typeof window.fbq === "function") return;

  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = "2.0";
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

  window.fbq("init", PIXEL_ID);
  window.fbq("track", "PageView");
})();
`;
}

export function metaPixelScript(): string {
  return buildMetaPixelScript(metaPixelId());
}

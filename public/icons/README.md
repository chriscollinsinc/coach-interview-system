# Brand logo

Drop the CCI logo here as:

    public/icons/cci-logo.png     (or .svg, updating the src in index.html)

The header and the sign-in screen look for it. If the file is absent the app
falls back to a styled "CHRIS**COLLINS**" wordmark, so a missing logo never
leaves a broken image on screen.

Recommended: a transparent PNG at least 2x the display height (the header
renders it at 26px, the sign-in hero at 62px), or an SVG.

`icon-192.png` / `icon-512.png` are the home-screen icons, generated in the
brand colours. Replace them with the real mark when you have a square version.

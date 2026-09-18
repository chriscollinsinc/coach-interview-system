# Oswald

Oswald is the Chris Collins Inc. display typeface (headings, buttons, tags,
stat tiles). It is licensed under the SIL Open Font License, so it can be
self-hosted.

Self-hosting rather than loading from Google's CDN is deliberate: the app has to
work on bad dealership wifi and fully offline, and the Content-Security-Policy
in `src/server.js` allows fonts from this origin only.

To install:

1. Go to fonts.google.com and search for Oswald.
2. Download the family, or take just the two weights this app uses: 500 and 700.
3. Convert or extract the woff2 files and drop them here as:

       public/fonts/oswald-500.woff2
       public/fonts/oswald-700.woff2

4. Commit and deploy. The @font-face rules in `public/styles.css` pick them up.

Until those files exist, `--font-display` falls through to a condensed system
face. Nothing breaks — the brand typography is just approximated.

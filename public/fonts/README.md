# Oswald

Oswald is the Chris Collins Inc. display face: headings, buttons, tags, stat
tiles and section labels. Body copy and form inputs deliberately stay on the
system sans — Oswald is condensed and heavy, which is right for a headline and
wrong for forty minutes of reading interview answers on an iPad.

`oswald-500.woff2` and `oswald-700.woff2` are the latin subsets from the
`@fontsource/oswald` package (12 KB each). Oswald is licensed under the SIL
Open Font License; the licence is in `OFL.txt`.

These are served from this origin rather than a CDN on purpose: the app has to
work on bad dealership wifi and fully offline, the Content-Security-Policy in
`src/server.js` sets `font-src 'self'`, and the service worker precaches them.

To update, pull a newer copy and replace the two files:

    npm pack @fontsource/oswald
    tar -xzf fontsource-oswald-*.tgz
    cp package/files/oswald-latin-500-normal.woff2 public/fonts/oswald-500.woff2
    cp package/files/oswald-latin-700-normal.woff2 public/fonts/oswald-700.woff2

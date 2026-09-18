# Brand assets

| File | Used for |
|---|---|
| `cci-logo.png` | The mark as supplied. Shown in light theme. |
| `cci-logo-dark.png` | Reversed for dark backgrounds. Generated from the same file: the beard becomes light and the knocked-out face becomes dark, while the coral badge and its lettering are left exactly as drawn. |
| `icon-192.png`, `icon-512.png` | Home-screen icons — the reversed mark centred on brand black, inside the 74% safe zone that maskable icons crop to. |

The dark variant exists because the supplied mark is a near-black silhouette,
which disappears against the `#0D0D0D` background. Do not solve this by
inverting in CSS: `filter: invert()` would turn the coral badge cyan.

If the logo is ever updated, regenerate the dark variant and the icons rather
than editing them by hand — a plain black-to-white recolour merges the beard
and the knocked-out face into one blob, and a plain dilation of the badge mask
bleeds over the face.

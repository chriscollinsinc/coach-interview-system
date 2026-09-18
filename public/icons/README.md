# Brand assets

| File | Used for |
|---|---|
| `cci-logo.png` | The mark exactly as supplied. Used unmodified in both themes. |
| `icon-192.png`, `icon-512.png` | Home-screen icons — the same mark centred on brand black, inside the 72% safe zone that maskable icons crop to. |

There is deliberately **no** separate dark-theme variant. The beard is
near-black and technically has 1.04:1 contrast against the `#0D0D0D`
background, but it reads as shadow and the knocked-out face carries the mark,
which looks better at both 30px and 86px than a reversed version does. A
reversed variant was tried and dropped: turning the beard white makes it read
as a ghost rather than as Chris.

Do not try to solve dark backgrounds with `filter: invert()` — it would turn
the coral badge cyan.

# Vendored fonts

Two families, both SIL OFL 1.1, checked in as `.woff2` rather than installed from npm.

The reason is the same one that made every dependency exact: a font that resolves differently on a
different day changes how the window measures itself, and xterm.js bakes the character width it
measured into a terminal's grid. These four files are the fonts, not a range that might become them.

They are inlined as `data:` URIs at build time rather than emitted as assets — see the
`assetsInlineLimit` comment in `electron.vite.config.ts` for why.

| File | Family | Purpose |
| --- | --- | --- |
| `iosevka-400.woff2` | Iosevka | code, diff, terminal, every path and row |
| `iosevka-700.woff2` | Iosevka | ANSI bold in the terminal, badge weight in the tree |
| `archivo-latin.woff2` | Archivo | chrome — variable, `wght 100..900` and `wdth 62..125` |
| `archivo-latin-ext.woff2` | Archivo | same, for the accents `latin` leaves out |

## Why these two

**Iosevka** — the default family, not `Term` or `Fixed` — advances 500 units on a 1000 upem body,
exactly half an em, where a normal monospace sits near 0.6. The repository panel is 24% of the
window and the viewer shares the rest with a terminal, so a sixth off every column is the
difference between reading a path and truncating it.

It also carries the glyphs a terminal actually emits: box drawing and block elements complete
(U+2500–259F), and all 256 Braille patterns, which is what pnpm, cargo and ora draw spinners with.
That coverage is not decoration — xterm.js runs on the DOM renderer here, and a glyph that falls
through to another font arrives with another advance width.

The default family rather than `Term` needs saying, because 410 glyphs in this subset carry the
double advance and some of them — `→`, `✓`, `●` — are ones a terminal emits constantly. Narrowing
those is precisely what the `Term` variant is for, so the expectation was that it would be needed.
It is not: measured in the running window, ten cells of `0`, `→`, `✓`, `─`, `⠋`, `●` and `█` each
render at exactly 60px. xterm sizes the cell and the glyph is laid into it, so the font's natural
advance never reaches the row. Measuring a bare `<span>` says otherwise and is the wrong test —
that is how this was nearly "fixed" by shipping a 242 MB release zip instead.

**Archivo** is one variable file with a real width axis, so the condensed uppercase micro-labels in
the 30px panel headers cost no second family.

## Provenance

Archivo is taken unmodified from Google Fonts (`Archivo` v25, the `latin` and `latin-ext` subsets),
which is already subset and already carries both axes:

```
curl -A '<a browser UA, or Google serves ttf>' \
  'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900'
# then fetch the two woff2 URLs that CSS points at
```

Iosevka comes from `@fontsource/iosevka@5.3.0`, whose file is labelled `latin` but is in fact the
near-complete font — 29,912 glyphs, 984 kB per weight. It is subset here to the ranges Azir can
actually display, which is what takes it to 90 kB:

```
pip install fonttools brotli zopfli

U="U+0000-00FF,U+0100-017F,U+0180-024F,U+02B0-02FF,U+0300-036F,U+2000-206F,U+2070-209F,\
U+20A0-20BF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2400-243F,\
U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+2800-28FF,U+2B00-2BFF,\
U+E0A0-E0D4,U+FE00-FE0F,U+FFFD"

for w in 400 700; do
  curl -L "https://cdn.jsdelivr.net/npm/@fontsource/iosevka@5.3.0/files/iosevka-latin-$w-normal.woff2" \
    -o "src-$w.woff2"
  pyftsubset "src-$w.woff2" --output-file="iosevka-$w.woff2" --flavor=woff2 \
    --unicodes="$U" --layout-features='' --drop-tables+=DSIG --name-IDs=''
done
```

`--layout-features=''` drops GSUB and GPOS. Iosevka's default build has no code ligatures to lose,
and a terminal is the one place a contextual substitution would be actively wrong.

After regenerating, check the two things that matter before committing:

```
python - <<'PY'
from fontTools.ttLib import TTFont
f = TTFont('iosevka-400.woff2')
cps = set().union(*(t.cmap.keys() for t in f['cmap'].tables))
for a, b, name in [(0x2500, 0x257F, 'box'), (0x2580, 0x259F, 'block'), (0x2800, 0x28FF, 'braille')]:
    assert all(c in cps for c in range(a, b + 1)), name
print('advances:', sorted({f['hmtx'][g][0] for g in f.getGlyphOrder() if f['hmtx'][g][0]}))
PY
```

Coverage must be complete for those three ranges, and the advances must be `[500, 1000]` — one
width and its double, nothing in between. A third value means glyphs that are neither one cell nor
two, and no amount of cell sizing rescues that.

## Licences

`LICENSE-Iosevka.md` — Copyright (c) 2015-2026 Renzhi Li (Belleve Invis).
`LICENSE-Archivo.txt` — Copyright 2020 The Archivo Project Authors (Omnibus-Type).

Both SIL Open Font License 1.1. Subsetting is a Modified Version under the licence, which permits
it; neither font is sold, and neither reserves a name.

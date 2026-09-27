# Showreel typography

## Direction

The previous sample font, soft extrusion, widely tracked system-font wordmark and competing HUD sizes made the reel feel like an effect demo with labels. The new type system uses a condensed silhouette, aligned optical edges and a consistent grid, informed by the supplied Marathon references.

- **Display and 3D:** Big Shoulders, weight 900, optical size 72, for SMEAR, BLUR and the closing lockup, with one tracking and one set of pair corrections.
- **Data and body:** Azeret Mono, weight 400. Tabular numerals keep the timecode stable; regular weight gives secondary copy enough separation from the display face.
- **Palette:** paper `#F4F5EF`, acid lime `#D6FE51`, ink `#080A0A`, hot pink `#FF004D`, electric violet `#5700FF`, acid green `#70FF00`. BLUR is neon green on ink: the faces skip ACES and render the exact acid green, while the returns are shaded from 18% to 50% of it by a fixed light, as in the Marathon wordmark. The HUD stays lime there. Violet replaces cyan in the final swarm, and hot pink replaces lime, which vanished on the acid field.

## Layout

| Element | Specification |
| --- | --- |
| Unit | `u = min(1vh, 0.5625vw)`: 1% of the 16:9 frame the 3D is fitted to, so the HUD keeps its size relative to the shot at any aspect |
| Safe margins | `max(20px, 5u)` on all four sides |
| Header slate | Azeret Mono 400, `1.2u`, uppercase, 0.08em tracking, two lines |
| Caption title | Big Shoulders 900, `5.05u`, 0.96 leading, 0.01em tracking, uppercase |
| Caption body | Azeret Mono 400, `1.6u`, 1.4 leading |
| Small labels | Azeret Mono 400, `1.2u`, uppercase, 0.08em tracking |
| Timecode | Azeret Mono 400, `2.13u`, tabular figures, 1.2 leading |
| Closing line | Big Shoulders 900, `2.84u`, 0.02em tracking, uppercase |
| Furniture | A/B index boxes, square beat indicator, one registration cross in the live-render credit |

Captions stack a micro index, the title and one body line. Each HUD band is a grid whose rows share baselines across its two corners, and the A/B labels sit on the top row. A lime copy of the HUD, clipped to the ink backdrop, keeps the text legible while wipes cross it. The endcard stays hidden until playback starts, so the cover shows the lockup and the play button. Below 700px the technical credit is hidden and the play button clears the caption. Font loading completes before the cover is revealed.

## 3D wordmark

Outlines are normalised to a 1,000-unit cap height. Geometry is built at 2.8 scene units; SMEAR size is 3, BLUR 2.8 and the closing lockup 2.45, with its rows 1.12 cap heights apart so they stay clear on the strongest beats. Every word is tracked at 0.17 cap. Pair corrections are defined in `src/reel.js`; the bottom row's spacing is distributed to match the upper row's visible width. The plus stays with BLUR, in front of SMEAR, across the four original depth planes; the build script draws it at stem weight on the cap middle.

Extrusion is 0.38 units with a 0.012 bevel, 0.018 bevel thickness, two bevel segments and six curve segments. The existing tessellation edge length remains 0.3. The ten title meshes total 35,856 triangles, compared with 50,058 before the redesign (−28.4%). Animation beats, effect settings and loop timing are retained.

Background colours are the graphic colours themselves: lit materials apply ACES in their own output, so the backdrop, its wipes and its rings mix in display space, and the reconstruction blur averages display colours. A fullscreen background mesh writes zero velocity and leaves depth untouched. The final pass adds a fine animated grain and a 6% vignette.

## Rebuild fonts

Source TTFs are copied from the official `google/fonts` repository and retained in `assets/fonts/`:

- `ofl/bigshoulders/BigShoulders[opsz,wght].ttf`
- `ofl/azeretmono/AzeretMono[wght].ttf`

With Python, `fonttools` and `brotli` installed, run:

```sh
python scripts/build-fonts.py
```

This creates two Latin WOFF2 subsets, `big-shoulders-black.typeface.json` (with the drawn plus) and `src/glyph-metrics.js`; a rebuild without changes is byte-identical. The browser does not load fonts from a CDN. Keep both bundled OFL licence files with the font assets.

## Motion revision

The HUD has no beat-driven scale or opacity changes except for the square beat indicator. The 3D actors and background retain their music pulse. The SMEAR sphere follows a horizontal spring with a 6.8-unit pitch and 3.05-unit radius over four beats; a smaller sphere and wider camera keep space around the letters. The BLUR letters enter together with a short stagger and settle upright in neon green on ink black. Metal finishes use a 0.19 roughness floor, so mirror reflections never show the 640 × 320 HDRI's texels. Fourteen tests cover loop continuity, camera rotation, the slam and the row on beats 2 and 4, screen-space smoothness of the reworked sections (no velocity jumps outside the drop), the curtain as one accelerating stroke that stays at least 430 px (at 1080p) behind the SMEAR letters and ahead of the rising B, glyph outlines that keep their shape with a valid normal on every face, the mirrored A/B twins, beat response and clearance around both words, including the strongest beat accents.

## Verification — 27 September 2026

Production build and all three continuity tests pass. The 1080p stills cover the individual words, comparison labels and closing lockup. The final live check in the Codex browser, with a 4,112 × 2,294 drawing buffer and audio disabled, reported **120 Hz, 0 dropped frames out of 2,780**, worst interval 10.4 ms, GPU median 10.29 ms and p99 19.4 ms. These are the app's existing meter readings; GPU timestamp totals are reported separately from presentation intervals. The same-session baseline reported GPU median 11.53 ms and p99 20.32 ms. These observations describe this machine and test run, not a performance guarantee.

The closing lockup was also checked at 3,840 × 2,160 and 390 × 844. The mobile layout has no horizontal overflow. Paused covers render across distinct animation frames before reveal, and repaint after resizing.

# Shape Study

Turn a reference photo into simple, flat shapes and a step-by-step painting order, the way a painter squints and blocks in masses.

**Live:** https://pauloenglerorg.github.io/shape-study/

Everything runs in the browser with plain JavaScript. No AI, no server, and photos never leave your device.

## What it does

1. **Squint first** (optional): blurs or "painterly" smooths the photo so small texture disappears.
2. **Reduces colors**: groups the photo into a few colors (or gray values) using k-means in Lab color space.
3. **Makes shapes**: tidies ragged edges, merges specks smaller than the chosen size, and traces each shape's outline (soft, geometric, or exact).
4. **Plans the layers**: groups the colors into a chosen number of painting layers (darks, midtones, lights…), or orders shapes big → small or back → front (an estimate).
5. **Overlaps like a painter**: each layer is laid down as a bolder, simpler mass that bridges gaps and runs under the areas later layers will paint over. It never covers anything an earlier layer finished, so the last step still matches the photo. Overlap 0 gives flat puzzle pieces instead.
6. **Details & accents** (optional): a final step adds the small shapes the bold version merged away.

## Files

- `index.html`: page layout and styles
- `app.js`: controls, drawing, step viewer, saving
- `shapes.js`: the image-processing engine

## Run locally

```bash
python3 -m http.server 8803
```

Then open http://localhost:8803.

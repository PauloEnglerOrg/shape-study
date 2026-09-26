# Shape Study

Turn a reference photo into simple, flat shapes and a step-by-step painting order, the way a painter squints and blocks in masses.

**Live:** https://pauloenglerorg.github.io/shape-study/

Everything runs in the browser with plain JavaScript. No AI, no server, and photos never leave your device.

## What it does

1. **Squint first** (optional): blurs or "painterly" smooths the photo so small texture disappears.
2. **Reduces colors**: groups the photo into a few colors (or gray values) using k-means in Lab color space.
3. **Makes shapes**: tidies ragged edges, merges specks smaller than the chosen size, and traces each shape's outline (soft, geometric, or exact).
4. **Plans the layers**: sorts shapes into painting steps: dark → light, light → dark, big → small, or back → front (an estimate).

"Paint over" mode lets early shapes run underneath later ones, so you block in whole masses and add details on top. "Puzzle pieces" keeps each shape to its visible part.

## Files

- `index.html`: page layout and styles
- `app.js`: controls, drawing, step viewer, saving
- `shapes.js`: the image-processing engine

## Run locally

```bash
python3 -m http.server 8803
```

Then open http://localhost:8803.

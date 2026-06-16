# WebSnap Testing Guide

## HTML Upload Tests (Drop into plugin directly)

Start here — no Chrome extension needed, fastest feedback loop.

| File | What it tests | Known risks |
|------|--------------|-------------|
| `test-01-grid-flex.html` | CSS Grid (3-col, 2+1 asymmetric, column/row spans), nested flex nav, flex-wrap badges | Grid spanning, flex stretch, space-between nav |
| `test-02-dark-glass.html` | Dark hero with radial gradients, glassmorphism (backdrop-filter), gradient text x4 varieties, mesh background | Backdrop-filter rendering, white gradient text (transparent color) |
| `test-03-typography.html` | Mixed inline runs (bold/italic/code/mark), text-transform, letter-spacing extremes, line-height variants, text-align, monospace code block | Single-line vs multiline detection, text-transform in Figma |
| `test-04-tables-forms.html` | HTML table with badges, full form (text/select/textarea/radio/checkbox), pricing table with ::before badge | Table rendering, checkbox/radio native controls, ::before text badge |
| `test-05-effects-pseudo.html` | Multi box-shadow, ::before/::after decorative layers, mix-blend-mode, z-index stacking, CSS outline, opacity, rotate transforms, gradient border trick | Z-index order, pseudo-element placement, blend modes |

---

## Chrome Extension Tests (Real websites)

Sorted by what's most likely to expose new bugs.

### Priority 1 — Test these first

| Site | Why | Watch for |
|------|-----|-----------|
| `linear.app` | Dark UI, lots of SVGs, subtle animations | Dark bg not captured, SVG icon colors wrong |
| `vercel.com` | Dark hero, gradient text, animated stats | Gradient text transparent gap, counter animations frozen mid-number |
| `tailwindcss.com` | Utility-class heavy, lots of color chips, grid | Grid layout, many small colored divs |
| `stripe.com` | Heavy animations, 3D-ish elements, custom fonts | GSAP animations, Söhne font fallback, floating card UIs |
| `clerk.com` | SaaS landing page, clean dark+light mix | Horizontal scroll sections, sticky nav |

### Priority 2 — Common patterns

| Site | Why | Watch for |
|------|-----|-----------|
| `github.com/features` | Feature page, complex layout, SVG icons | Table-like layouts, inline SVG icons |
| `notion.so` | Heavy Framer site, lots of scroll reveals | Scroll reveal order, sections that should animate |
| `lottiefiles.com` | Lottie animations (canvas/SVG hybrid) | Canvas capture, animated SVG placeholder |
| `shopify.com/plus` | E-commerce, product images, carousels | Carousel clipping, product image grid |
| `supabase.com` | Dark, code blocks, gradient CTAs | Code block font, gradient hero |

### Priority 3 — Edge cases

| Site | Why | Watch for |
|------|-----|-----------|
| `dribbble.com` | Image-heavy grid, masonry layout | Masonry (non-grid CSS), many images |
| `medium.com` | Long-form text, article typography | Drop caps, blockquotes, inline images in text |
| `airtable.com/templates` | Dense UI, table-like product | Complex grid-in-grid |
| `basecamp.com` | Plain HTML, minimal CSS | Super clean — should be perfect capture |

---

## What to check on every import

1. **Layer count** — does it match expected page complexity?  
2. **Layer names** — are they readable (`Button · Get started`) or noisy (`div.framer-x12y`)?  
3. **Images** — do they all appear, or are any gray boxes?  
4. **Text colors** — any black-on-black or invisible text?  
5. **Background colors** — does the section background match the live site?  
6. **Gradients** — do they match direction and stops?  
7. **Z-order** — does the header sit on top of everything?  
8. **Auto Layout** (if on) — does anything collapse or drift?

---

## How to report a bug

For each issue, note:
- **Site URL**
- **Section of the page** (hero / nav / footer / testimonials / etc.)
- **What it looks like on the live site** vs **what came into Figma**
- **Capture or render?** — if re-importing the same `.wsnap` fixes it, it's a render bug. If you need a fresh capture, it's a capture bug.

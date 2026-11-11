# Impulse Noise Reduction for Safelight

A [Safelight](https://github.com/anthonyreimche/SafeLight) extension that
removes impulse noise: the isolated bright and dark pixels (hot pixels, stuck
pixels, salt-and-pepper speckles) that ordinary noise reduction smooths around
rather than removes. It finds a pixel that stands out from its surroundings and
replaces it from the pixels next to it, and leaves every other pixel alone.

## The controls

- **Enabled**: the tool is off until you turn it on. Threshold has no value that
  does nothing (even at 0 it still looks), so the tool needs its own switch. While it is off the photo
  renders bit for bit unchanged and nothing runs.
- **Threshold** (0 to 100, default 50): how aggressively to look. Higher
  catches fainter outliers and uses a wider low-pass to judge them by; lower
  catches only the obvious ones.

**In masks:** add Impulse Noise Reduction to a mask from the Masking panel's
Adjust tab to clean the pixels inside that mask only.

## The math

The tool works on the photo in CIE Lab, after the tone and colour edits, so the
stage sits in Safelight's display phase and reads the image as edited up to it.

With `t = Threshold / 20`:

1. The lightness is low-passed with a Gaussian of sigma `max(2, t - 1)` pixels
   (a Young-van Vliet recursive filter, forward then backward).
2. The high-pass is `|L - low-pass|`.
3. A pixel is flagged when its high-pass beats `max(1, 5.5 - t) / 24` of the
   sum of the other 24 high-pass values in its 5 x 5 block. At an edge of the
   photo the block is cut short and the divisor stays 24.
4. A flagged pixel is replaced, in lightness, a and b, by the average of the
   unflagged pixels in its block, each weighted by `1 / (dL^2 + 1)`, where `dL`
   is its lightness difference from the flagged pixel in units of 1/327.68 of
   an L* step. A pixel with no unflagged neighbour is left as it is.

A photo with a side under 8 pixels is left alone.

### How it maps onto Safelight

The stage reads linear Rec. 709 and converts to Lab with the D50-adapted Rec. 709
matrix, as the original does for its default working space. It runs as five
single-draw passes of four channels (Safelight 3.2.2's `channels: 4`):

1. start: the pixel as it came.
2. blur along x: the low-pass of the lightness. The recursive filter's response
   to an impulse obeys the recursion's own recurrence, so the shader works the
   taps out from the filter's coefficients in a few multiplications and runs
   it as a finite kernel of 6 sigma each side (at most 49 reads). The working
   channel holds the low-pass less the lightness, which a half float rounds
   far less than the low-pass itself.
3. blur along y, then the high-pass.
4. the flags, a 5 x 5 block of reads.
5. the replacement, a 5 x 5 block of reads.

The lightness is worked out again from the pixel's own colour wherever it is
needed. The photo goes through the passes as half floats, so the stage adds
only the change a replacement makes: a pixel it leaves alone keeps the
precision it came with, and a difference under 0.2 % of the value does not
count as a replacement.

Differences from the original to be aware of:

- **The last pixels of the right and bottom edges.** The original's backward
  recursion starts from a boundary matrix that its SSE routines (the ones its
  command line runs) scale differently from its plain ones. The shaders blur
  with the plain scaling, which is an edge pixel repeated, and then carry back
  the difference to the SSE scaling over the last 6 sigma of each line (up to
  24 pixels at Threshold 100), as USM and RL Sharpening does. A pixel there is
  flagged and replaced as in the original.
- **Near-ties.** The passes store half floats, and the lightness of each pixel
  is worked out from its half-float colour. A pixel whose flag sits within a
  rounding of the threshold can flag on the other side of the original, and a
  neighbour's average then differs. Most of those come from the half-float
  colour, a few from the stored high-pass. On the test scene that is under
  one pixel in a hundred at the top of the Threshold range and none at the
  bottom.
- **Render size.** The original scales Threshold by how much smaller than the
  photo it is rendering, and switches the tool off below half size. Safelight's
  preview renders at a capped size, so Threshold is scaled the same way but the
  tool stays on, and the scaled value is not rounded to a whole number.
- Needs float render targets, as most GPUs have.

### Where it runs

The stage's priority is 10, ahead of every other display-phase tool: denoising
before colour edits keeps them from amplifying the noise. (The original runs it
after its colour curves.) Masks need photos on the current process version.

### Tests

```bash
npm install
npm run check      # typecheck, build, then the unit tests
npm run test:gpu   # the stage on Safelight's real renderer (needs a SafeLight checkout)
```

The unit tests pin the blur's taps against the filter's own impulse response,
the settings and the panel's behaviour, and hold `test/reference/rtref.ts`, a
float32 transcription of the tool, to the reference program's own output
(a fixture under `test/reference/`: six thresholds on an 80 x 64 image with
impulses). The GPU spec renders a 192 x 128 scene through the real renderer and
compares it with that transcription.

## Licence

GPL-3.0-or-later, as the code it ports.

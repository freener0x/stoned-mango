# Calibration run 20260930-2046

- `fusion-synthetic.json`: weights cnn 1.283, template 2.782, bass 0.095, ending 0.000, drone 0.935; no clear key below 0.248 (keyless clips up to 0.166); fitted on {'synthetic:fusion-synthetic': 1200}: accuracy 0.6925, ECE 0.0207
- `fusion-with-real.json`: weights cnn 1.115, template 2.117, bass 0.503, ending 0.000, drone 0.425; no clear key below 0.149 (keyless clips up to 0.100); fitted on {'synthetic:fusion-synthetic': 1200, 'real:beatport': 133}: accuracy 0.6879, ECE 0.0576

## GiantSteps Key (real EDM tracks, never trained on): 604 items

| Engine | weighted | mm_exact | tonic | conf | ece | flagged | in_note | no_key |
|---|---|---|---|---|---|---|---|---|
| Fusion (fusion-with-real) | 0.703 | 0.649 | 0.714 | 0.485 | 0.204 | 0.089 | 0.674 | 0.076 |
| CNN alone | 0.701 | 0.651 | 0.710 | 0.393 | 0.275 | 0.104 | 0.671 |  |
| Fusion (fusion-synthetic) | 0.695 | 0.637 | 0.702 | 0.545 | 0.152 | 0.078 | 0.652 | 0.137 |
| Template + bass (phase 1) | 0.559 | 0.464 | 0.599 |  |  |  |  |  |

## Held-out synthetic songs (30 scales): 300 items

| Engine | weighted | mm_exact | tonic | mode | notes | conf | ece | flagged | in_note | no_key |
|---|---|---|---|---|---|---|---|---|---|---|
| Fusion (fusion-synthetic) | 0.801 | 0.787 | 0.800 | 0.693 | 0.890 | 0.715 | 0.066 | 0.210 | 0.797 | 0.003 |
| Fusion (fusion-with-real) | 0.801 | 0.787 | 0.800 | 0.697 | 0.893 | 0.672 | 0.057 | 0.233 | 0.807 | 0.000 |
| CNN alone | 0.777 | 0.763 | 0.777 | 0.673 | 0.867 | 0.580 | 0.097 | 0.307 | 0.787 |  |
| Template + bass (phase 1) | 0.681 | 0.640 | 0.683 | 0.433 | 0.643 |  |  |  |  |  |

Columns: weighted = MIREX score; mm_exact = major/minor right; mode = exact scale right;
conf = mean confidence; ece = calibration error (0 is perfect); flagged = ambiguity note shown;
in_note = answer or the note's alternative right; no_key = answered "No clear key".


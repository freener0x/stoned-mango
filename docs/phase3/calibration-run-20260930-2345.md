# Calibration run 20260930-2345

- `fusion-synthetic.json`: weights cnn 1.283, template 2.782, bass 0.095, ending 0.000, drone 0.935; no clear key below 0.360 (keyless clips up to 0.319, synthetic:fusion-synthetic withheld 2.1%); fitted on {'synthetic:fusion-synthetic': 1200}: accuracy 0.6925, ECE 0.0207; real-music temperature 1.000, ECE by source {'synthetic:fusion-synthetic': 0.0207}
- `fusion-with-real.json`: weights cnn 0.981, template 1.862, bass 0.443, ending 0.000, drone 0.374; no clear key below 0.168 (keyless clips up to 0.188, synthetic:fusion-synthetic withheld 0.0%, real:beatport withheld 2.3%); fitted on {'synthetic:fusion-synthetic': 1200, 'real:beatport': 133}: accuracy 0.6879, ECE 0.078; real-music temperature 0.880, ECE by source {'synthetic:fusion-synthetic': 0.0778, 'real:beatport': 0.1075}

## GiantSteps Key (real EDM tracks, never trained on): 604 items

| Engine | weighted | mm_exact | tonic | conf | ece | flagged | in_note | no_key | no_key_right |
|---|---|---|---|---|---|---|---|---|---|
| Fusion (fusion-with-real) | 0.703 | 0.649 | 0.714 | 0.705 | 0.099 | 0.099 | 0.674 | 0.022 | 0.231 |
| CNN alone | 0.701 | 0.651 | 0.710 | 0.659 | 0.091 | 0.104 | 0.671 |  |  |
| Fusion (fusion-synthetic) | 0.695 | 0.637 | 0.702 | 0.774 | 0.146 | 0.078 | 0.652 | 0.075 | 0.156 |
| Template + bass (phase 1) | 0.559 | 0.464 | 0.599 |  |  |  |  |  |  |

## Held-out synthetic songs (30 scales): 300 items

| Engine | weighted | mm_exact | tonic | mode | notes | conf | ece | flagged | in_note | no_key | no_key_right |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Fusion (fusion-synthetic) | 0.801 | 0.787 | 0.800 | 0.693 | 0.890 | 0.715 | 0.066 | 0.210 | 0.797 | 0.033 | 0.300 |
| Fusion (fusion-with-real) | 0.801 | 0.787 | 0.800 | 0.697 | 0.893 | 0.628 | 0.080 | 0.277 | 0.817 | 0.000 |  |
| CNN alone | 0.777 | 0.763 | 0.777 | 0.673 | 0.867 | 0.580 | 0.097 | 0.307 | 0.787 |  |  |
| Template + bass (phase 1) | 0.681 | 0.640 | 0.683 | 0.433 | 0.643 |  |  |  |  |  |  |

Columns: weighted = MIREX score; mm_exact = major/minor right; mode = exact scale right;
conf = mean confidence; ece = calibration error (0 is perfect); flagged = ambiguity note shown;
in_note = answer or the note's alternative right; no_key = answered "No clear key";
no_key_right = how often those withheld answers would have been right.


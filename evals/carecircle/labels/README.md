# CareCircle Prescription Label Evaluation Set (CC-4b)

This folder holds the 20-label evaluation suite (`label-01.jpg` .. `label-20.jpg`) and `expected.json` for `carecircle.extractPrescription`.

## Privacy Rule

- **Never commit an unblurred prescription label.**
- Before replacing any synthetic placeholder `.jpg` with a real photograph, blur or crop out all patient names, dates of birth, addresses, phone numbers, pharmacy Rx numbers, and prescriber identifiers.

## Running the Evaluation

```bash
pnpm eval:carecircle
```

The evaluation checks all 20 labels (80 fields: `name`, `strength`, `doseText`, `schedule`) and requires at least **90% (72/80)** field accuracy after confirm.

## Status (review of PR #38)

The 20 `label-XX.jpg` files in this folder are placeholders (identical, cut-off 1x1 white images), and the `extracted` answers in `expected.json` are hand-written, not AI readings. `pnpm eval:carecircle` therefore prints `NOT RUN` and exits with an error until:

1. the 20 blurred real label photos replace the placeholders (and `expected.json` is rewritten to match them), and
2. the script sends each photo through `carecircle.extractPrescription` and scores that reading.

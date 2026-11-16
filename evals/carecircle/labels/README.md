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

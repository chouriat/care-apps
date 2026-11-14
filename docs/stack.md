# Pinned Stack Versions

| Concern | Package / Tool | Version |
| --- | --- | --- |
| Node / pnpm / Monorepo | `node` / `pnpm` / `turbo` | `>=22` (CI uses 22) / `9.15.4` / `2.3.3` |
| App & Router | `expo` (SDK 58) / `expo-router` | `58.0.23` (New Arch on) / `58.0.31` |
| Runtime & Language | `react` / `react-native` / `typescript` | `19.3.0` / `0.88.1` / `6.0.3` |
| State & Data | `@tanstack/react-query` / `@supabase/supabase-js` / `zustand` | `5.62.7` / `2.47.10` / `5.0.2` |
| Validation & Forms | `zod` / `react-hook-form` / `@hookform/resolvers` | `3.24.1` / `7.54.2` / `3.9.1` |
| Tests | `jest` / `jest-expo` / `@testing-library/react-native` / `test-renderer` / `ts-jest` | `30.5.2` / `58.0.14` / `14.1.0` / `1.3.1` / `29.4.15` |
| Lint & Format | `eslint` / `typescript-eslint` / `eslint-plugin-jest` / `prettier` | `9.17.0` / `8.72.1` / `29.17.0` / `3.4.2` |

Expo-managed packages (`expo-*`, `react-native-*`) must stay on the versions `npx expo install --fix` picks for the SDK above. Upgrade the SDK in its own PR.

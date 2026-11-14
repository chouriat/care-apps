import js from '@eslint/js';
import jest from 'eslint-plugin-jest';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.config.*',
    ],
  },
  {
    // AGENTS.md rule 9: no eslint-disable comments.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // AGENTS.md rule 9: no .skip or .only in tests.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    ...jest.configs['flat/recommended'],
    rules: {
      ...jest.configs['flat/recommended'].rules,
      'jest/no-focused-tests': 'error',
      'jest/no-disabled-tests': 'error',
    },
  },
);

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `bench/dist` is the benchmark CLI bundle (`pnpm bench`): `dist/**` only matches the top
  // folder, so without its own line every `make bench` would break `make check`.
  globalIgnores(['out/**', 'dist/**', 'bench/dist/**', 'node_modules/**']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.node.json',
          './tsconfig.e2e.json',
          './tsconfig.web.json',
          './tsconfig.worklet.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
    },
  },
  {
    // `bench` (the STT benchmark CLI), `e2e` (the Electron smoke test), `qa` (the browser QA
    // driver) and `test` (fixtures and the scripts that make them, such as the fake helper
    // `test/fixtures/fake-roger-audio.mjs`) run under Node. JS files are listed too: unlike
    // TypeScript files they keep `no-undef`, so without these globals `process` is an error. A new
    // Node folder goes here, and its TypeScript into a tsconfig `include` (tsconfig.node.json, or
    // tsconfig.e2e.json for code that drives a page), or typed lint refuses the file ("not found
    // in any of the provided project(s)").
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '{bench,e2e,qa,test}/**/*.{ts,js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // `preview` is the renderer harness: the renderer's React code with a fake `window.roger`.
    files: ['src/renderer/**/*.{ts,tsx}', 'preview/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: ['src/renderer/src/audio/pcm-worklet.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
]);

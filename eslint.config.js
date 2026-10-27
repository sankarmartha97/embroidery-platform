import js from '@eslint/js';
import globals from 'globals';
import promise from 'eslint-plugin-promise';

export default [
  { ignores: ['node_modules/', 'coverage/', 'tmp/'] },
  js.configs.recommended,
  promise.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'promise/always-return': 'off',
    },
  },
  {
    // Module boundary rule: code outside modules/<x>/ imports only modules/<x>/index.js
    files: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./[^/]+/(?!index\\.js$)[^/]+$',
              message: 'Import another module only through its index.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.js', 'workers/**/*.js'],
    ignores: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: 'modules/[^/]+/(?!index\\.js$)[^/]+$',
              message: 'Import a module only through its index.js.',
            },
          ],
        },
      ],
    },
  },
  {
    // Env is read only in src/config/env.js
    files: ['src/**/*.js', 'workers/**/*.js'],
    ignores: ['src/config/env.js'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/config/env.js.',
        },
      ],
    },
  },
  {
    files: ['tools/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];

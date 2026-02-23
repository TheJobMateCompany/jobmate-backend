import js from '@eslint/js';
import globals from 'globals';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Warn on unused vars but allow leading-underscore to mark intentional ignores
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow console — services are the logging boundary
      'no-console': 'off',
      // Prevent accidental global-scope await outside modules
      'no-await-in-loop': 'warn',
    },
  },
];

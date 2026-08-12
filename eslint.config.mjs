// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },

  // --- Hexagonal boundaries, enforced rather than merely documented ---
  //
  // Applied only where it buys something concrete: keeping tenant-isolation
  // and RBAC rules testable without a DI container or an HTTP layer, and
  // keeping the same business logic runnable behind both Express and Lambda.
  // Everything else follows plain NestJS conventions on purpose.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                '@aws-sdk/*',
                'aws-sdk',
                'express',
                'pg',
                'typeorm',
                '../application/*',
                '../adapters/*',
                '**/adapters/**',
                '**/application/**',
              ],
              message:
                'The domain layer must stay free of frameworks, infrastructure and outer layers. Depend on a port instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@aws-sdk/*',
                'aws-sdk',
                'express',
                'pg',
                'typeorm',
                '**/adapters/**',
              ],
              message:
                'Use cases talk to infrastructure only through ports. Nest decorators are allowed here; concrete adapters are not.',
            },
          ],
        },
      ],
    },
  },
);

## [8e58a37] - 2026-05-30
### Merge pull request #14 from tadanobutubutu/gitauto/setup-20260529-184036-jg7H

GitAuto setup
Added tsconfig.test.json configuration file with relaxed TypeScript compiler options (noUnusedLocals and noUnusedParameters set to false) for test environments. This extends the base tsconfig.json to allow unused variables and parameters in test code, improving developer experience when writing test suites.

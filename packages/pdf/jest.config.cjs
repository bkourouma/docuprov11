/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.(test|spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
};

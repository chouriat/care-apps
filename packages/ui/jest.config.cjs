module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: { '^react-native$': '<rootDir>/src/__mocks__/react-native.ts' },
};

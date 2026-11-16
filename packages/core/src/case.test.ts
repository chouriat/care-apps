import { camelToSnake, snakeToCamel } from './index';

describe('case conversion helpers', () => {
  it('converts snake_case and camelCase cleanly', () => {
    expect(snakeToCamel('care_recipient_name')).toBe('careRecipientName');
    expect(camelToSnake('careRecipientName')).toBe('care_recipient_name');
  });
});
// throwaway batch-guard test

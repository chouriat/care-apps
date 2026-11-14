import { MIN_TOUCH_TARGET_PT } from './index';

describe('ui baseline', () => {
  it('enforces 44 pt minimum touch target', () => {
    expect(MIN_TOUCH_TARGET_PT).toBeGreaterThanOrEqual(44);
  });
});

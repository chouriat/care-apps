import { AI_GATEWAY_PATH } from './index';

describe('ai-gateway baseline', () => {
  it('points to /functions/v1/ai', () => {
    expect(AI_GATEWAY_PATH).toBe('/functions/v1/ai');
  });
});

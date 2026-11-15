const MockPostHog = jest.fn().mockImplementation(function (
  this: {
    apiKey: string;
    options?: unknown;
    capture: (event: string, properties?: Record<string, string | number>) => void;
    identify: (...args: unknown[]) => void;
    reset: () => void;
  },
  apiKey: string,
  options?: unknown,
) {
  this.apiKey = apiKey;
  this.options = options;
  this.capture = (...args) => MockPostHog.prototype.capture(...args);
  this.identify = (...args) => MockPostHog.prototype.identify(...args);
  this.reset = () => MockPostHog.prototype.reset();
});

MockPostHog.prototype.capture = jest.fn();
MockPostHog.prototype.identify = jest.fn();
MockPostHog.prototype.reset = jest.fn();

export { MockPostHog as PostHog };
export default MockPostHog;

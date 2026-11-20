export function isNetworkFailureMessage(message: string, code?: string): boolean {
  if (code === 'NETWORK_ERROR') {
    return true;
  }
  return /network|fetch failed|failed to fetch|offline|load failed/i.test(message);
}

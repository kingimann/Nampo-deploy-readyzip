/** Fonts seam — web loads fonts via CSS, so the hook resolves immediately. */
export function useFonts(_map?: Record<string, any>): [boolean, Error | null] {
  return [true, null];
}
export async function loadAsync(_map?: Record<string, any>): Promise<void> {}
export function isLoaded(_name?: string): boolean { return true; }

/** t329：翻译设置指纹变化时，历史 reasoning 译文缓存必须整体失效。 */
export function translationCacheNeedsInvalidation(
  previous: string | null,
  next: string | null,
): boolean {
  return previous !== null && next !== null && previous !== next;
}

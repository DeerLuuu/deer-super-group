/**
 * 写操作提交与后续刷新分离：write 成功后即使 refresh 失败也不能让调用方误判为“写失败”。
 * 返回 postError 供上层 toast；调用方应始终把写操作视为 committed。
 */
export async function writeThenRefresh<T>(
  write: () => Promise<T>,
  afterCommit: (value: T) => Promise<void>,
): Promise<{ value: T; postError: unknown | null }> {
  const value = await write();
  try {
    await afterCommit(value);
    return { value, postError: null };
  } catch (error) {
    return { value, postError: error };
  }
}

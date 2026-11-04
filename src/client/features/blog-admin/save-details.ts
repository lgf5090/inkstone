/**
 * The order two separate writes have to happen in.
 *
 * A post row and its frontmatter tags cannot be written in one request from here. The post row is
 * the one that can be refused (a slug another article already uses), so it goes first; writing tags
 * first would leave a half-saved post whenever the row loses that race.
 */
export async function saveDetailsInOrder(
  patchPost: () => Promise<unknown>,
  writeTags: () => Promise<boolean>,
): Promise<boolean> {
  await patchPost()
  return writeTags()
}

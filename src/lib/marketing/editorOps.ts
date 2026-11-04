// Pure helpers for the editor. Paths are dotted, with numeric segments for lists.

export function getAt(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], root);
}

/** Returns a copy with `path` set. Untouched branches keep their identity. */
export function setAt<T>(root: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const next = rest.length ? setAt((root as Record<string, unknown>)[head], rest.join("."), value) : value;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(head)] = next;
    return copy as T;
  }
  return { ...(root as object), [head]: next } as T;
}

export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const copy = [...items];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

export const removeAt = <T,>(items: T[], index: number): T[] => items.filter((_, i) => i !== index);

/**
 * Updates one list item by id. Uploads finish later, when the list may have been
 * reordered or the item removed, so they can't address it by index.
 */
export const updateById = <T extends { id: string }>(items: T[], id: string, update: (item: T) => T): T[] =>
  items.map((item) => (item.id === id ? update(item) : item));

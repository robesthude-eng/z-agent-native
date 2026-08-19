import path from 'node:path';
export function inside(root, input) {
  const target = path.resolve(root, input);
  return target.startsWith(root);
}

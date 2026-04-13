export function makeBookId(filename: string, title: string): string {
  const input = `${filename}|${title}`.toLowerCase();
  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }

  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  const slug = filename
    .replace(/\.epub$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .toLowerCase();

  return slug ? `${slug}-${hex}` : hex;
}

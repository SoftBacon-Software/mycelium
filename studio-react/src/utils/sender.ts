export function getSenderDisplay(name: string | null | undefined): string {
  if (!name) return 'Unknown'
  if (name === '__admin__') return 'Admin'
  if (name === '__system__') return 'System'
  if (name.startsWith('__user:')) return name.slice(7)
  return name
}

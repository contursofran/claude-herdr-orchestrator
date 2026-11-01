import { PREFIX } from './defaults'

// What this load of the mod knows about its session. A reload starts the module over,
// and session.start fills these in again: the folder, the command prefix from the
// settings, and the band's id (from its last drawing) for moving its focus ring.
export const session = { cwd: '', prefix: PREFIX, core: '' }

// A command as the person types it, e.g. cmd('wrap-up') is /hrd-wrap-up.
export const cmd = (name: string) => `/${session.prefix}${name}`

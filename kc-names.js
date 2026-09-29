// KartChaser: show the names set on the mixer in dropdowns, like the X32 module does ("Monitor A (Bus 1)").
import { pad0 } from './helpers.js'

/** Name changes on these strips mean the dropdown labels need rebuilding */
export const STRIP_NAME_PATH = /^\/(ch|rtn|bus|fxsend|lr)\/(.+\/)?config\/name$/

/**
 * @param {object} self - module instance
 * @param {string | undefined} namePath - e.g. /bus/1/config/name
 * @param {string} defaultName - e.g. Bus 1
 */
export function labelWithName(self, namePath, defaultName) {
	const st = namePath ? self.xStat?.[namePath] : undefined
	const name = st?.valid ? `${st.name ?? ''}`.trim() : ''
	return name && name !== st.defaultName && name !== defaultName ? `${name} (${defaultName})` : defaultName
}

/** OSC name path of a mixer bus send target: 1-6 buses, 7-10 FX sends 1-4 */
export function busSendNamePath(b) {
	return b < 7 ? `/bus/${b}/config/name` : `/fxsend/${b - 6}/config/name`
}

/** OSC name path of a channel (1-16) */
export function channelNamePath(c) {
	return `/ch/${pad0(c)}/config/name`
}

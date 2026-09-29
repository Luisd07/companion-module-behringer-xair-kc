// KartChaser: pick channels, FX returns, FX sends, buses and DCAs from dropdowns that show the names set on the
// mixer ("Host Mic (Channel 3)"), like the X32 module, instead of typing a number.
// Runs over the finished upstream action/feedback definitions so the upstream builders stay untouched.
import { pad0 } from './helpers.js'
import { labelWithName } from './kc-names.js'

const STRIPS = {
	ch: { count: 16, name: 'Channel', path: (n) => `/ch/${pad0(n)}/config/name` },
	rtn: { count: 4, name: 'FX Return', path: (n) => `/rtn/${n}/config/name` },
	fxsend: { count: 4, name: 'FX Send', path: (n) => `/fxsend/${n}/config/name` },
	bus: { count: 6, name: 'Bus', path: (n) => `/bus/${n}/config/name` },
	dca: { count: 4, name: 'DCA', path: (n) => `/dca/${n}/config/name` },
}

/** 'type' dropdown values used by the upstream actions */
const TYPE_TO_STRIP = { '/ch/': 'ch', '/rtn/': 'rtn', '/fxsend/': 'fxsend', '/bus/': 'bus', '/dca/': 'dca' }

/** Feedbacks with a 'theChannel' number, by feedback id prefix */
const FEEDBACK_STRIP = [
	[/^(c_)?ch(_|$)/, 'ch'],
	[/^(c_)?rtn(_|$)/, 'rtn'],
	[/^(c_)?fxsend(_|$)/, 'fxsend'],
	[/^(c_)?bus(_|$)/, 'bus'],
	[/^(c_)?dca(_|$)/, 'dca'],
	[/^solosw_ch$/, 'ch'],
	[/^solosw_fxr$/, 'rtn'],
	[/^solosw_fxs$/, 'fxsend'],
	[/^solosw_bus$/, 'bus'],
	[/^solosw_dca$/, 'dca'],
]

/** Actions with a plain 'num' number (no 'type' dropdown), by action id */
const ACTION_STRIP = {
	solosw_ch: 'ch',
	solosw_fxr: 'rtn',
	solosw_fxs: 'fxsend',
	solosw_bus: 'bus',
	solosw_dca: 'dca',
}

/** Per-type number fields of the advanced bar feedbacks */
const BAR_FIELDS = {
	pans: { ch: 'ch', rtn: 'rtn', bus: 'bus' },
	meters: { num1: 'ch', num3: 'bus' },
}

/**
 * Shared choice arrays, one per strip type, relabelled in place by refreshNamedPickers
 * @param {object} self - module instance
 */
function getChoices(self, strip) {
	self.namedChoices ??= {}
	if (!self.namedChoices[strip]) {
		const def = STRIPS[strip]
		self.namedChoices[strip] = Array.from({ length: def.count }, (_, i) => ({
			id: i + 1,
			label: `${def.name} ${i + 1}`,
		}))
	}
	return self.namedChoices[strip]
}

function namedDropdown(self, strip, number, extra = {}) {
	return {
		type: 'dropdown',
		label: STRIPS[strip].name,
		id: number.id,
		default: Number(number.default) || 1,
		choices: getChoices(self, strip),
		...(number.isVisible ? { isVisible: number.isVisible } : {}),
		...(number.isVisibleExpression ? { isVisibleExpression: number.isVisibleExpression } : {}),
		...extra,
	}
}

function convertTypedAction(self, def) {
	const typeOpt = def.options.find((o) => o.id === 'type' && o.type === 'dropdown')
	const numIdx = def.options.findIndex((o) => o.id === 'num' && o.type === 'number')
	if (!typeOpt || numIdx < 0) return

	const pickers = []
	for (const choice of typeOpt.choices) {
		const strip = TYPE_TO_STRIP[choice.id]
		if (!strip) continue
		const typeId = choice.id
		pickers.push(
			namedDropdown(self, strip, def.options[numIdx], {
				id: `num_${strip}`,
				isVisibleExpression: `$(options:type) == '${typeId}'`,
			}),
		)
	}
	if (!pickers.length) return
	def.options.splice(numIdx, 1, ...pickers)

	// the upstream callback reads options.num
	const callback = def.callback
	def.callback = async (action, context) => {
		const strip = TYPE_TO_STRIP[action.options.type]
		const num = strip ? action.options[`num_${strip}`] : undefined
		const options = { ...action.options, num: num ?? action.options.num ?? 1 }
		return callback({ ...action, options }, context)
	}
}

/**
 * Swap number pickers for named dropdowns. Call once, after the definitions are built.
 * @param {object} self - module instance
 */
export function applyNamedPickers(self) {
	for (const [id, def] of Object.entries(self.actionDefs)) {
		if (!def?.options) continue
		const strip = ACTION_STRIP[id]
		if (strip) {
			def.options = def.options.map((o) => (o.id === 'num' && o.type === 'number' ? namedDropdown(self, strip, o) : o))
		} else {
			convertTypedAction(self, def)
		}
	}

	for (const group of [self.muteFeedbacks, self.colorFeedbacks, self.meterFeedbacks]) {
		for (const [id, def] of Object.entries(group)) {
			if (!def?.options) continue
			const fields = BAR_FIELDS[id]
			const strip = FEEDBACK_STRIP.find(([re]) => re.test(id))?.[1]
			def.options = def.options.map((o) => {
				if (o.type !== 'number') return o
				if (fields?.[o.id]) return namedDropdown(self, fields[o.id], o)
				if (strip && o.id === 'theChannel') return namedDropdown(self, strip, o)
				return o
			})
		}
	}
}

/**
 * Relabel the dropdowns with the current mixer names. Re-send the definitions afterwards.
 * @param {object} self - module instance
 */
export function refreshNamedPickers(self) {
	for (const [strip, choices] of Object.entries(self.namedChoices ?? {})) {
		const def = STRIPS[strip]
		for (const c of choices) {
			c.label = labelWithName(self, def.path(c.id), `${def.name} ${c.id}`)
		}
	}
}

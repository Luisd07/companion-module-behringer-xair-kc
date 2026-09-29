import { formatMeterDb } from './meters.js'
import { pad0 } from './helpers.js'

// KartChaser: everything present in /meters/1. Stereo sources get a combined target (loudest side) plus L and R.
function buildMeterTargets() {
	const targets = []
	const stereo = (id, name, left) => {
		targets.push({ id, name, indices: [left, left + 1] })
		targets.push({ id: `${id}_l`, name: `${name} L`, indices: [left] })
		targets.push({ id: `${id}_r`, name: `${name} R`, indices: [left + 1] })
	}

	for (let i = 0; i < 16; i++) {
		targets.push({ id: `ch_${pad0(i + 1)}`, name: `Channel ${i + 1}`, indices: [i] })
	}
	stereo('aux', 'USB / Aux', 16)
	for (let i = 0; i < 4; i++) {
		stereo(`rtn_${i + 1}`, `FX Return ${i + 1}`, 18 + i * 2)
	}
	for (let i = 0; i < 6; i++) {
		targets.push({ id: `bus_${i + 1}`, name: `Bus ${i + 1}`, indices: [26 + i] })
	}
	for (let i = 0; i < 4; i++) {
		targets.push({ id: `fxsend_${i + 1}`, name: `FX Send ${i + 1}`, indices: [32 + i] })
	}
	stereo('lr', 'Main Out', 36)
	stereo('mon', 'Monitor Out', 38)
	return targets
}

export const METER_TARGETS = buildMeterTargets()

const targetsById = new Map(METER_TARGETS.map((t) => [t.id, t]))

/** @param {string} id */
export function getMeterTarget(id) {
	return targetsById.get(id)
}

export function GetMeterVariableDefinitions() {
	return METER_TARGETS.map((t) => ({ variableId: `meter_${t.id}`, name: `Meter dBFS: ${t.name}` }))
}

/**
 * Values for the meter variables. Pass the cache of previously sent values to only get the ones that changed
 * (keeps Companion from redrawing buttons whose reading didn't move).
 * @param {import('./meters.js').XAirMeters} meters
 * @param {Map<string, string>} [lastSent]
 */
export function GetMeterVariableValues(meters, lastSent) {
	const values = {}

	for (const t of METER_TARGETS) {
		const id = `meter_${t.id}`
		const text = formatMeterDb(meters.getLevelDb(t.indices))
		if (lastSent) {
			if (lastSent.get(id) === text) continue
			lastSent.set(id, text)
		}
		values[id] = text
	}

	return values
}

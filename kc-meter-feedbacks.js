import { combineRgb } from '@companion-module/base'
import { formatMeterDb, METER_FLOOR_DB } from './meters.js'
import { getMeterTarget, METER_TARGETS } from './kc-meter-variables.js'

// KartChaser: live meter feedbacks, re-evaluated by index.js each time a new meter reading is published.
export const METER_FEEDBACK_IDS = ['meter_level', 'meter_level_compare']

function compareNumber(target, comparitor, currentValue) {
	const targetValue = Number(target)
	if (isNaN(targetValue)) return false

	switch (comparitor) {
		case 'gt':
			return currentValue > targetValue
		case 'gte':
			return currentValue >= targetValue
		case 'lt':
			return currentValue < targetValue
		case 'lte':
			return currentValue <= targetValue
		case 'ne':
			return currentValue != targetValue
		default:
			return currentValue === targetValue
	}
}

/**
 * @param {import('./meters.js').XAirMeters} meters
 */
export function GetMeterFeedbacks(meters) {
	const getLevelDb = (target) => meters.getLevelDb(getMeterTarget(target)?.indices)

	const targetOption = {
		type: 'dropdown',
		label: 'Target',
		id: 'target',
		default: 'lr',
		choices: METER_TARGETS.map((t) => ({ id: t.id, label: t.name })),
	}

	return {
		meter_level: {
			type: 'value',
			name: 'Live meter: dBFS reading',
			description:
				'The live level of a channel, aux, FX return, bus, FX send, main or monitor out as shown on the XAir ' +
				'METERS page. Add it as a button local variable and put it in the button text.',
			options: [
				targetOption,
				{
					type: 'dropdown',
					label: 'Format',
					id: 'format',
					choices: [
						{ id: 'text', label: 'Text: -18.2, -inf when silent, - when no data' },
						{ id: 'number', label: `Number: -18.2, ${METER_FLOOR_DB} when silent, empty when no data` },
					],
					default: 'text',
				},
			],
			callback: (evt) => {
				const db = getLevelDb(evt.options.target)
				if (evt.options.format === 'number') {
					if (db === undefined) return null
					return Math.round(Math.max(db, METER_FLOOR_DB) * 10) / 10
				}
				return formatMeterDb(db)
			},
		},
		meter_level_compare: {
			type: 'boolean',
			name: 'Live meter: level compared to dBFS',
			description:
				'Change style when the live level of a channel, aux, FX return, bus, FX send, main or monitor out ' +
				'crosses a dBFS value (e.g. greater than -40 for signal present, greater than -3 for too hot)',
			options: [
				targetOption,
				{
					type: 'dropdown',
					label: 'Comparitor',
					id: 'comparitor',
					default: 'gt',
					choices: [
						{ id: 'eq', label: 'Equal' },
						{ id: 'ne', label: 'Not Equal' },
						{ id: 'gt', label: 'Greater than' },
						{ id: 'gte', label: 'Greater than or equal' },
						{ id: 'lt', label: 'Less than' },
						{ id: 'lte', label: 'Less than or equal' },
					],
				},
				{
					type: 'number',
					label: 'Level (dBFS)',
					id: 'db',
					range: true,
					min: METER_FLOOR_DB,
					max: 0,
					step: 0.5,
					default: -40,
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(0, 255, 0),
				color: combineRgb(0, 0, 0),
			},
			callback: (evt) => {
				const db = getLevelDb(evt.options.target)
				if (db === undefined) return false
				return compareNumber(evt.options.db, evt.options.comparitor, Math.max(db, METER_FLOOR_DB))
			},
		},
	}
}

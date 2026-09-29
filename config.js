import { Regex } from '@companion-module/base'
import { meterRateDefault } from './meters.js'

// Return config fields for web config
export function getConfigFields() {
	let cf = [
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			tooltip: 'The IP of the MR / XR console',
			width: 6,
			default: '0.0.0.0',
			regex: Regex.IP,
		},
		{
			type: 'dropdown',
			id: 'faderMax',
			label: 'Fader Max',
			tooltip: 'Maximum fader level allowed\nwhen enabled on fader action',
			width: 6,
			default: '0.75',
			choices: this.FADER_VALUES,
		},
		{
			type: 'checkbox',
			id: 'scan',
			label: 'Scan network for XAir mixers?',
			default: true,
			width: 12,
		},
		{
			type: 'dropdown',
			id: 'model',
			label: 'Select Model',
			tooltip: 'This model is assumed when mixer is offline',
			width: 6,
			default: 'X18',
			choices: this.MIXER_CHOICES,
		},
		{
			type: 'dropdown',
			id: 'meterRate',
			label: 'Live meter update rate',
			tooltip:
				'How often dB readings refresh on buttons. Each reading is the peak level since the last refresh, so short peaks are never missed.',
			width: 6,
			choices: [
				{ id: 50, label: '20 per second (fastest)' },
				{ id: 100, label: '10 per second' },
				{ id: 200, label: '5 per second' },
				{ id: 500, label: '2 per second (easiest to read)' },
			],
			default: meterRateDefault,
		},
	]

	let ch = []
	if (Object.keys(this.unitsFound || {}).length == 0) {
		ch = [{ id: 'none', label: 'No XAir units located' }]
	} else {
		let unit = this.unitsFound
		for (let u in unit) {
			ch.push({ id: unit[u].m_name, label: `${unit[u].m_name} (${unit[u].m_ip})` })
		}
	}

	cf.push({
		type: 'dropdown',
		id: 'mixer',
		label: 'Select Mixer by Name',
		tooltip: 'Name and IP of mixers on the network',
		width: 12,
		default: ch[0].id,
		choices: ch,
	})
	return cf
}

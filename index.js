import OSC from 'osc'
import { combineRgb } from '@companion-module/base'
import { runEntrypoint, InstanceBase, InstanceStatus } from '@companion-module/base'
import { UpgradeScripts } from './upgrades.js'
import { buildConstants } from './constants.js'
import { buildStripDefs } from './buildStripDefs.js'
import { buildSoloDefs } from './buildSoloDefs.js'
import { buildStaticActions } from './actions.js'
import { buildSnapshotDefs } from './buildSnapshotDefs.js'
import { buildMeterDefs } from './buildMeterDefs.js'
import { buildHADefs } from './buildHADefs.js'
import { getConfigFields } from './config.js'
import { pad0, linFaderToDB } from './helpers.js'
import {
	XAirMeters,
	decodeMeterPacket,
	METER_BLOB_ID,
	METER_REARM_INTERVAL_MS,
	METER_STALE_REARM_MS,
	meterRateDefault,
} from './meters.js'
import { GetMeterVariableDefinitions, GetMeterVariableValues } from './kc-meter-variables.js'
import { GetMeterFeedbacks, METER_FEEDBACK_IDS } from './kc-meter-feedbacks.js'
import { busSendNamePath, labelWithName, STRIP_NAME_PATH } from './kc-names.js'
import os from 'os'

class BAirInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// stat id from mixer address
		this.fbToStat = {}
		this.fbToMeter = {}

		this.soloOffset = {}
		this.actionDefs = {}
		this.muteFeedbacks = {}
		this.meterFeedbacks = {}
		this.colorFeedbacks = {}
		this.haFeedbacks = {}
		this.variableDefs = []
		this.fLevels = {}
		this.blinkingFB = {}
		this.crossFades = {}
		this.unitsFound = {}
		this.PollCount = 10
		this.PollTimeout = 40
		this.getConfigFields = getConfigFields

		/** KartChaser: live meter state from /meters/1 */
		this.xairMeters = new XAirMeters()
		/** KartChaser: publishes meter readings at the configured rate, and keeps the /meters stream armed */
		this.meterTimer = undefined
		this.meterLastArmAt = 0
		this.meterVariablesSent = new Map()

		buildConstants(this)
	}

	async init(config) {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

		await wait(1000)
		this.config = config

		this.devMode = process.env.DEVELOPER
		if (this.devMode) {
			await wait(3000)
		}

		this.debugLevel = process.env.DEVELOPER ? 2 : 0

		this.config = config

		if (!this.config.model) {
			this.config.model = 'X18'
		}

		if (!this.config.faderMax) {
			this.config.faderMax = '0.75'
		}

		if (!this.config.channels) {
			this.config.channels = parseInt(this.config.model.replace(/\D/g, ''))
			this.saveConfig(this.config)
		}
		this.snapshot = []

		this.currentSnapshot = 0
		this.prevSnapshot = 0
		this.nextSnapshot = 0

		this.myMixer = {
			name: '',
			model: '',
			channels: 0,
			ip: '',
			fwVersion: '',
		}

		// mixer state
		this.xStat = {}
		// meters
		this.mStat = {}

		// level/fader value store
		this.tempStore = {}

		// cross-fade steps per second
		this.fadeResolution = 20
		this.needStats = true
		this.hostResponse = false
		this.blinkOn = false

		this.unitsFound = {}
		if (config.scan) {
			// quick moment to pre-scan
			this.scanForMixers()
		}
		buildStripDefs(this)
		buildSoloDefs(this)
		buildStaticActions(this)
		buildSnapshotDefs(this)
		buildMeterDefs(this)
		buildHADefs(this)

		//buildHeadampDefs(this)
		this.setActionDefinitions(this.actionDefs)
		this.buildStaticFeedbacks(this)
		this.buildStaticVariables()
		this.init_osc()
		this.totalVars = Object.keys(this.xStat).length
		this.log('debug', `${this.totalVars} status addresses`)
	}

	async configUpdated(config) {
		// a bit more processing than available in
		// an upgrade script :)
		if ('' == config.host) {
			let u = this.unitsFound[config.mixer]
			if (u) {
				config.host = u
				this.saveConfig(config)
			}
		}
		// do we have a name for this host?
		if (config.scan) {
			if (!('' == config.mixer || 'none' == config.mixer) && Object.keys(this.unitsFound).length > 0) {
				for (let m in this.unitsFound) {
					if (this.unitsFound[m].m_ip == config.host) {
						config.mixer = m
						config.model = this.unitsFound[m].m_model
						config.channels = this.unitsFound[m].m_channels
					}
				}
				this.saveConfig(config)
			}
			if (config.mixer in this.unitsFound) {
				if (config.host != this.unitsFound[config.mixer].m_ip) {
					config.host = this.unitsFound[config.mixer].m_ip
					this.saveConfig(config)
				}
			}
		}
		await this.destroy() // re-start all connections in case host changed.
		await this.init(config)
	}

	// When module gets deleted
	async destroy() {
		this.stopMeters()
		if (this.nameRefreshTimer) {
			clearTimeout(this.nameRefreshTimer)
			delete this.nameRefreshTimer
		}
		if (this.heartbeat) {
			clearInterval(this.heartbeat)
			delete this.heartbeat
		}
		if (this.blinker) {
			clearInterval(this.blinker)
			delete this.blinker
		}
		if (this.fader) {
			clearInterval(this.fader)
			delete this.fader
		}
		if (this.oscPort) {
			this.oscPort.close()
			delete this.oscPort
		}
		if (this.scanner) {
			clearInterval(this.scanner)
			delete this.scanner
		}
		if (this.scanPort) {
			this.scanPort.close()
			delete this.scanport
		}
	}

	/**
	 * heartbeat to request updates, subscription expires every 10 seconds
	 */
	pulse() {
		this.sendOSC('/xremote', [])
		// subscribe for meter data
		this.sendOSC('/-local/updrate', [{ type: 'i', value: 1 }])
		this.sendOSC('/meters', [
			{ type: 's', value: '/meters/1' },
			{ type: 'i', value: 0 },
		])
		// any leftover status needed?
		if (this.needStats) {
			this.pollStats()
		}
	}

	/**
	 * feedback blinker (1 sec interval)
	 */
	blink() {
		// toggle 'blinker'
		this.blinkOn = !this.blinkOn
		this.checkFeedbacks(...Object.keys(this.blinkingFB))
	}

	/**
	 *
	 * Get broadcast addresses for all local IPv4 interfaces.
	 * @returns {string[]} An array of broadcast addresses (e.g., ["192.168.1.255", ...]).
	 * updated: 28-Feb-2025 to properly address non-octet net masks.
	 */

	getBroadcastAddresses() {
		const ret = []
		const interfaces = os.networkInterfaces()
		for (const name of Object.keys(interfaces)) {
			for (const iface of interfaces[name]) {
				// console.log(iface);
				if ('ipv4' !== iface.family.toLowerCase() || iface.internal) {
					continue
				}
				const parts = iface.netmask.split('.').map(Number)
				const ipParts = iface.address.split('.').map(Number)
				const broadcastParts = ipParts.map((part, index) => part | (~parts[index] & 255))
				ret.push(broadcastParts.join('.'))
			}
		}
		return ret
	}

	/**
	 *
	 * network scanner interval
	 */
	probe() {
		const broadcastAddresses = this.getBroadcastAddresses()

		if (!(this.probeCount % 6)) {
			// Scan every 30 seconds
			for (const broadcast of broadcastAddresses) {
				this.scanPort.send(
					{
						address: '/xinfo',
						args: [],
					},
					broadcast,
					10024,
				)
			}
		}
		this.probeCount++
	}

	/**
	 * Gather list of local mixer IP numbers and names
	 */
	async scanForMixers() {
		let uPort = this.scanPort

		if (!this.scanPort) {
			uPort = this.scanPort = new OSC.UDPPort({
				localAddress: '0.0.0.0',
				localPort: 0,
				broadcast: true,
				metadata: true,
			})
		}

		this.scanPort.on('error', (err) => {
			this.log('error', 'XAir scan: ' + err.message)
			this.probeCount = 0 // reset to check every 5 secs
			this.updateStatus(InstanceStatus.UnknownError, err.message)
		})

		uPort.open()

		// When the port is read, send an OSC message to, say, SuperCollider
		uPort.on('ready', () => {
			this.probeCount = 0
			this.probe()
			if (this.scanner != undefined) {
				clearInterval(this.scanner)
				delete this.scanner
			}
			this.scanner = setInterval(() => {
				this.probe()
			}, 5000)
		})

		uPort.on('message', (oscMsg, timeTag, info) => {
			if ('/xinfo' == oscMsg.address) {
				let args = oscMsg.args
				let newUnit = {
					m_ip: args[0].value,
					m_name: args[1].value,
					m_model: args[2].value,
					m_fwver: args[3].value,
					m_channels: parseInt(args[2].value.match(/\d+/)[0]),
					m_last: Date.now(),
				}
				this.unitsFound[newUnit.m_name] = newUnit
				if (!this.config.mixer || this.config.mixer == '') {
					if (newUnit.m_ip == this.config.host) {
						this.config.mixer = newUnit.m_name
						this.config.model = newUnit.m_model
						this.config.channels = newUnit.m_channels
						this.saveConfig(this.config)
					}
				}
				for (let u in this.unitsFound) {
					// remove from list if not seen in last 10 minutes
					if (Date.now() - this.unitsFound[u].m_last > 600000) {
						delete this.unitsFound[u]
					}
				}
			}
		})
	}

	/**
	 * timed fades
	 */
	doFades() {
		let arg = { type: 'f' }
		let fadeDone = []

		for (let f in this.crossFades) {
			let c = this.crossFades[f]
			c.atStep++
			let atStep = c.atStep
			let newVal = c.startVal + c.delta * atStep

			arg.value = Math.sign(c.delta) > 0 ? Math.min(c.finalVal, newVal) : Math.max(c.finalVal, newVal)

			this.sendOSC(f, arg)

			if (atStep > c.steps) {
				fadeDone.push(f)
			}
		}

		// delete completed fades
		for (let f of fadeDone) {
			delete this.crossFades[f]
		}
	}

	pollStats() {
		let stillNeed = 0
		let counter = 0
		let timeNow = Date.now()
		let timeOut = timeNow - this.PollTimeout

		for (const id in this.xStat) {
			if (!this.xStat[id].valid) {
				stillNeed++
				if (this.xStat[id].polled < timeOut) {
					this.sendOSC(id)
					this.xStat[id].polled = timeNow
					counter++
					// only allow 'PollCount' queries during one cycle
					if (counter > this.PollCount) {
						break
					}
				}
			}
		}

		if (!this.hostResponse && stillNeed && timeNow - this.timeStart > 10000) {
			this.log('error', `${this.config.host} not responding`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `${this.config.host} not responding`)
			if (this.config.scan && this.unitsFound[this.config.mixer] !== undefined) {
				if (this.config.host != this.unitsFound[this.config.mixer]) {
					this.log('warn', `Resetting IP for ${this.config.mixer}`)
					this.config.host = this.unitsFound[this.config.mixer].m_ip
					this.saveConfig(this.config)
					this.destroy()
					this.init(this.config)
				}
			}
			return
		}

		if (0 == stillNeed) {
			this.updateStatus(InstanceStatus.Ok, 'Console status loaded')
			const c = Object.keys(this.xStat).length
			const d = (c / ((timeNow - this.timeStart) / 1000)).toFixed(1)
			this.log('info', `Status Sync complete (${c}@${d})`)
		}
		this.needStats = stillNeed
	}

	firstPoll() {
		this.sendOSC('/xinfo', [])
		this.sendOSC('/-snap/index', [])
		this.sendOSC('/-snap/name', [])
		this.timeStart = Date.now()
		this.pollStats()
		this.pulse()
	}

	/**
	 * Calculate linear fader value (0..1) for a given 'step'
	 * 	depending on total 'steps'
	 * @param {integer} i - which step
	 * @param {integer} steps - number of steps for this fader parameter
	 * @returns {float}
	 */
	stepsToFader(i, steps) {
		let res = i / (steps - 1)

		return Math.floor(res * 10000) / 10000
	}

	faderToDB(f, steps, rp) {
		// “f” represents OSC float data. f: [0.0, 1.0]
		// “d” represents the dB float data. d:[-oo, +10]
		// if "rp" (Relative percent) is true, return a loudness perceptual (base 10/33.22) change in % compared to unity (0dB)
		let d = 0

		if (f >= 0.5) {
			d = f * 40.0 - 30.0 // max dB value: +10.
		} else if (f >= 0.25) {
			d = f * 80.0 - 50.0
		} else if (f >= 0.0625) {
			d = f * 160.0 - 70.0
		} else if (f >= 0.0) {
			d = f * 480.0 - 90.0 // min dB value: -90 or -oo
		}
		return f == 0
			? rp
				? '0'
				: '-oo'
			: (rp ? '' : d > 0 ? '+' : '') + (rp ? 100 * 10 ** (d / 33.22) : Math.round(d * 1023.5) / 1024).toFixed(1)
	}

	init_osc() {
		if (this.oscPort) {
			this.oscPort.close()
		}
		// no host or still default '0.0.0.0'
		if (!this.config.host || this.config.host.split('.').reduce((acc, b) => acc + b, 0) == 0) {
			this.updateStatus(InstanceStatus.ConnectionFailure, 'No host IP')
		} else {
			//		if (this.config.host) {
			this.oscPort = new OSC.UDPPort({
				localAddress: '0.0.0.0',
				localPort: 0, // random local port
				remoteAddress: this.config.host,
				remotePort: 10024,
				metadata: true,
			})

			// KartChaser: meter frames are decoded from the raw packet bytes
			this.oscPort.on('raw', (data) => {
				const levels = decodeMeterPacket(data)
				if (levels) {
					this.xairMeters.ingest(levels)
					this.parseMeters1(levels)
				}
			})

			// listen for incoming messages
			this.oscPort.on('message', (message, timeTag, info) => {
				// KartChaser: meter frames are handled in the 'raw' listener and bypass the state map
				if (message.address === METER_BLOB_ID) {
					this.hostResponse = true
					return
				}

				const args = message.args
				const node = message.address
				const leaf = node.split('/').pop()
				const top = node.split('/')[1]
				this.hostResponse = true

				if ('meters' != top && this.debugLevel > 0) {
					this.log('debug', `received ${node}:` + JSON.stringify(args) + ` from ${info.address}`)
				}
				if (this.xStat[node] !== undefined) {
					let v = args[0].value
					switch (leaf) {
						case 'on':
						case 'lr':
						case 'hpon':
						case 'invert':
						case 'rtnsw':
						case '1':
						case '2':
						case '3':
						case '4': {
							// '/config/mute/#'
							this.xStat[node].isOn = !!v
							const fbSubs = this.xStat[node].fbSubs
							if (fbSubs?.size > 0) {
								this.checkFeedbacksById(...fbSubs)
							} else {
								this.checkFeedbacks(this.xStat[node].fbID)
							}
							break
						}

						// this.xStat[node].isOn = !!v
						// this.checkFeedbacks(this.xStat[node].fbID)
						// break
						case 'fader':
						case 'level':
							v = Math.floor(v * 10000) / 10000
							this.xStat[node][leaf] = v
							this.setVariableValues({
								[this.xStat[node].varID + '_p']: Math.round(v * 100),
								[this.xStat[node].varID + '_d']: this.faderToDB(v, 1024, false),
								[this.xStat[node].varID + '_rp']: Math.round(this.faderToDB(v, 1024, true)),
							})
							this.xStat[node].idx = this.fLevels[this.xStat[node].fSteps].findIndex((i) => i >= v)
							break
						case 'pan':
							v = Math.floor(v * 10000) / 10000
							this.xStat[node].pan = v
							this.setVariableValues({
								[this.xStat[node].varID]: Math.round(v * 200 - 100),
							})
							this.xStat[node].idx = this.fLevels[this.xStat[node].fSteps].findIndex((i) => i >= v)
							if (this.xStat[node].fbSubs.size > 0) {
								this.checkFeedbacksById(...this.xStat[node].fbSubs)
							}
							break
						case 'gain': // headamp
							v = Math.floor(v * 10000) / 10000
							//							let ha = parseInt(node.split('/')[2])
							this.xStat[node].gain = v
							this.setVariableValues({
								[this.xStat[node].varID + '_p']: Math.round(v * 100),
								[this.xStat[node].varID + '_d']: linFaderToDB(
									v,
									this.LIMITS['h' + this.xStat[node].fSteps],
									//{ fmin: this.LIMITS[this.xStat[node].trimVal].fmin, fmax: this.LIMITS[this.xStat[node].trimVal].fmax},
								),
							})
							this.xStat[node].idx = this.fLevels[this.xStat[node].fSteps].findIndex((i) => i >= v)
							break
						case 'rtntrim': // USB Return trim
							v = Math.floor(v * 10000) / 10000
							//							let usb = parseInt(node.split('/')[2])
							this.xStat[node].rtntrim = v
							this.setVariableValues({
								[this.xStat[node].varID + '_p']: Math.round(v * 100),
								[this.xStat[node].varID + '_d']: linFaderToDB(
									v,
									this.LIMITS['r' + this.xStat[node].fSteps],
									//{ fmin: this.LIMITS[this.xStat[node].trimVal].fmin, fmax: this.LIMITS[this.xStat[node].trimVal].fmax},
								),
							})
							this.xStat[node].idx = this.fLevels[this.xStat[node].fSteps].findIndex((i) => i >= v)
							break
						case 'phantom':
							this.xStat[node].pp = !!v
							this.setVariableValues({
								[this.xStat[node].varID]: !!v,
							})
							if (this.xStat[node].fbSubs?.size > 0) {
								this.checkFeedbacksById(...this.xStat[node].fbSubs)
							}
							break
						case 'source':
							this.xStat[node].m_source = v
							this.setVariableValues({
								[this.xStat[node].varID]: this.MONITOR_SOURCES[v].label,
							})
							this.checkFeedbacks(this.xStat[node].fbID)
							break
						case 'chmode':
						case 'busmode':
							this.xStat[node].value = v ? 'AFL' : 'PFL'
							this.setVariableValues({
								[this.xStat[node].varID]: this.xStat[node].value,
							})
							break
						case 'name':
							// no name, use behringer default
							v = v == '' ? this.xStat[node].defaultName : v
							this.xStat[node].name = v
							// KartChaser: show the new name in dropdowns
							if (STRIP_NAME_PATH.test(node)) this.queueNameRefresh()
							this.setVariableValues({ [this.xStat[node].fbID]: v })
							if ('-snap' == top) {
								let num = parseInt(node.split('/')[2])
								if (num == this.currentSnapshot) {
									this.setVariableValues({ s_name: v })
								} else if (num == this.prevSnapshot) {
									this.setVariableValues({ s_name_p: v })
								} else if (num == this.nextSnapshot) {
									this.setVariableValues({ s_name_n: v })
								}
							}
							break
						case 'color':
							this.xStat[node].color = v
							this.checkFeedbacks(this.xStat[node].fbID)
							break
						case 'dimpfl':
						case 'mono':
						case 'dim':
						case 'mute': // '/config/solo/'
							this.xStat[node].isOn = !!v
							this.checkFeedbacks(this.xStat[node].fbID)
							this.setVariableValues({ [this.xStat[node].varID]: v ? true : false })
							break

						default:
							if (node.match(/\/solo/)) {
								this.xStat[node].isOn = v
								this.checkFeedbacks(this.xStat[node].fbID)
							}
					}
					this.xStat[node].valid = true
					if (this.needStats) {
						this.pollStats()
					}
					// this.log('debug',`${node}: ${JSON.stringify(args)}`);
				} else if ('xinfo' == top) {
					this.myMixer.name = args[1].value
					this.myMixer.model = args[2].value
					this.myMixer.channels = parseInt(args[2].value.match(/\d+/)[0])
					this.myMixer.fw = args[3].value
					this.myMixer.ip = args[0].value
					this.setVariableValues({
						m_name: this.myMixer.name,
						m_model: this.myMixer.model,
						m_channels: this.myMixer.channels,
						m_fw: this.myMixer.fw,
						m_ip: this.myMixer.ip,
					})
				} else if ('/-snap/index' == node) {
					const s = parseInt(args[0].value)
					const n = this.xStat[this.snapshot[s]].name
					this.currentSnapshot = s
					this.setVariableValues({
						s_index: s,
						s_name: n,
						['s_name_' + pad0(s)]: n,
					})
					this.prevSnapshot = 1 >= s ? 0 : s - 1
					this.nextSnapshot = 64 <= s ? 0 : s + 1
					this.setVariableValues({
						s_name_p: this.xStat[this.snapshot[this.prevSnapshot]]?.name ?? '-----',
						s_name_n: this.xStat[this.snapshot[this.nextSnapshot]]?.name ?? '-----',
					})
					this.checkFeedbacks('snap_color')
					this.sendOSC('/-snap/' + pad0(s) + '/name', [])
				}
			})

			this.oscPort.on('ready', () => {
				this.updateStatus(InstanceStatus.Connecting, 'Loading console status')
				this.Connected = true
				this.log('info', 'Sync started')
				this.firstPoll()
				this.heartbeat = setInterval(() => {
					this.pulse()
				}, 9500) // just before 10 sec expiration
				// KartChaser: start the meter stream
				this.startMeters()
				this.blinker = setInterval(() => {
					this.blink()
				}, 1000)
				this.fader = setInterval(() => {
					this.doFades()
				}, 1000 / this.fadeResolution)
			})

			this.oscPort.on('close', () => {
				this.connected = false
				this.stopMeters()
				if (this.heartbeat) {
					clearInterval(this.heartbeat)
					delete this.heartbeat
				}
				if (this.blinker) {
					clearInterval(this.blinker)
					delete this.blinker
				}
				if (this.fader) {
					clearInterval(this.fader)
					delete this.fader
				}
			})

			this.oscPort.on('error', (err) => {
				this.log('error', 'Error: ' + err.message)
				this.updateStatus(InstanceStatus.UnknownError, err.message)
				this.connected = false
				this.stopMeters()
				if (this.heartbeat) {
					clearInterval(this.heartbeat)
					delete this.heartbeat
				}
				if (this.blinker) {
					clearInterval(this.blinker)
					delete this.blinker
				}
				if (this.fader) {
					clearInterval(this.fader)
					delete this.fader
				}
			})

			this.oscPort.open()
		}
	}

	/**
	 * Feed the meter bar feedbacks and m_* variables
	 * @param {Float32Array} levels - dBFS levels decoded from a /meters/1 frame
	 */
	parseMeters1(levels) {
		if (levels.length < 40) return

		let variables = {}

		for (let i = 0; i < 40; i++) {
			const m = this.meter1[i]
			let newVal = levels[i]
			const mv = this.mStat[m]
			let total = mv.total
			const oldVal = mv.dbVal
			mv.valid = true
			mv.dbVal = newVal

			mv.count = ++mv.count % 10
			total -= mv.samples[mv.count]
			mv.samples[mv.count] = newVal
			total += newVal
			mv.total = total
			if (this.lastMeter && Date.now() - this.lastMeter > 50) {
				if (mv.fbSubs.size > 0 && newVal != oldVal) {
					this.checkFeedbacksById(...mv.fbSubs)
				}
				variables[mv.vName] = Math.max(Math.round(total) / 10, -60.0)
			}
		}
		this.setVariableValues(variables)
		this.lastMeter = Date.now()
	}

	// KartChaser: names arrive one message at a time (all at once on connect), so rebuild once they settle
	queueNameRefresh() {
		if (this.nameRefreshTimer) clearTimeout(this.nameRefreshTimer)
		this.nameRefreshTimer = setTimeout(() => {
			delete this.nameRefreshTimer
			this.refreshNamedChoices()
		}, 500)
	}

	// KartChaser: relabel dropdowns with the names set on the mixer, e.g. "Monitor A (Bus 1)"
	refreshNamedChoices() {
		for (const opt of this.busOpts ?? []) {
			const b = Number(opt.id)
			opt.label = labelWithName(this, busSendNamePath(b), b < 7 ? `Bus ${b}` : `FX ${b - 6}`)
		}
		this.setActionDefinitions(this.actionDefs)
		this.buildStaticFeedbacks(this)
	}

	// KartChaser: start publishing meter readings; frames arrive in the 'raw' listener.
	startMeters() {
		this.stopMeters()
		this.armMeters()

		const rate = Number(this.config.meterRate) || meterRateDefault
		this.meterTimer = setInterval(() => this.meterTick(), rate)
	}

	stopMeters() {
		if (this.meterTimer) {
			clearInterval(this.meterTimer)
			this.meterTimer = undefined
		}
		if (this.xairMeters.reset()) this.publishMeters()
	}

	meterTick() {
		const now = Date.now()

		// Keep the stream alive, and re-arm quickly if frames stopped arriving
		const sinceArm = now - this.meterLastArmAt
		if (sinceArm >= METER_REARM_INTERVAL_MS || (this.xairMeters.isStale(now) && sinceArm >= METER_STALE_REARM_MS)) {
			this.armMeters()
		}

		if (this.xairMeters.publish(now)) this.publishMeters()
	}

	publishMeters() {
		const values = GetMeterVariableValues(this.xairMeters, this.meterVariablesSent)
		if (Object.keys(values).length > 0) this.setVariableValues(values)
		this.checkFeedbacks(...METER_FEEDBACK_IDS)
	}

	// KartChaser: (re)arm the meter stream
	armMeters() {
		this.meterLastArmAt = Date.now()
		this.sendOSC('/meters', [
			{ type: 's', value: METER_BLOB_ID },
			{ type: 'i', value: 0 },
		])
	}

	// define static instance variables
	buildStaticVariables() {
		const variables = [
			{
				name: 'XAir Mixer Name',
				variableId: 'm_name',
			},
			{
				name: 'XAir Mixer Model',
				variableId: 'm_model',
			},
			{
				name: 'XAir Mixer Firmware',
				variableId: 'm_fw',
			},
			{
				name: 'XAir Mixer IP Address',
				variableId: 'm_ip',
			},
			{
				name: 'XAir Mixer Channels',
				variableId: 'm_channels',
			},
			{
				name: 'Current Snapshot Name',
				variableId: 's_name',
			},
			{
				name: 'Current Snapshot Index',
				variableId: 's_index',
			},
			{
				name: 'Previous Snapshot Name',
				variableId: 's_name_p',
			},
			{
				name: 'Next Snapshot Name',
				variableId: 's_name_n',
			},
		]
		variables.push.apply(variables, this.variableDefs)
		variables.push(...GetMeterVariableDefinitions())

		this.setVariableDefinitions(variables)
		this.meterVariablesSent.clear()
		this.setVariableValues(GetMeterVariableValues(this.xairMeters, this.meterVariablesSent))
	}

	// define instance feedbacks
	buildStaticFeedbacks(self) {
		const feedbacks = {
			snap_color: {
				type: 'boolean',
				name: 'Is Current Snapshot',
				description: 'Indicate on button when snapshot is loaded',
				options: [
					{
						type: 'textinput',
						label: 'Snapshot to match',
						id: 'theSnap',
						default: '1',
						required: true,
						useVariables: true,
					},
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 128, 0),
				},

				callback: async (feedback, context) => {
					const snap = parseInt(await context.parseVariablesInString(feedback.options.theSnap))

					if (snap < 1 || snap > 64) {
						const err = [feedback.controlId, feedback.feedbackId, 'Invalid Snapshot #'].join(' → ')
						this.updateStatus(InstanceStatus.BadConfig, err)
						this.paramError = true
					} else {
						return snap == this.currentSnapshot
					}
				},
			},
		}
		Object.assign(feedbacks, this.muteFeedbacks)
		Object.assign(feedbacks, this.colorFeedbacks)
		Object.assign(feedbacks, this.meterFeedbacks)
		Object.assign(feedbacks, GetMeterFeedbacks(this, this.xairMeters))
		Object.assign(feedbacks, this.haFeedbacks)
		this.setFeedbackDefinitions(feedbacks)
	}

	async sendOSC(node, arg) {
		arg = arg ?? []

		if (this.oscPort) {
			if (this.debugLevel > 0) {
				this.log('debug', `OSC > ${node}:` + JSON.stringify(arg))
			}
			this.oscPort.send({
				address: node,
				args: arg,
			})
		}
	}
}

runEntrypoint(BAirInstance, UpgradeScripts)

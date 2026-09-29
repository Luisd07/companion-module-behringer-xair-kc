// KartChaser: XAir live metering. /meters/1 streams the METERS-page levels as one binary blob every 50ms:
// 40 signed 16-bit values in 1/256 dB (0 = 0 dBFS, down to -128 dB) in this order:
// 0-15 channels, 16-25 aux + fx returns 1-4 (L/R pairs), 26-31 buses, 32-35 fx sends,
// 36-37 main L/R, 38-39 monitor L/R. The stream lapses after 10s and must be re-armed (index.js).
// (The X32 streams /meters/0 as linear float32 instead, so the decoder differs, but the handling is the same.)

export const METER_BLOB_ID = '/meters/1'
export const METER_COUNT = 40
export const METER_REARM_INTERVAL_MS = 8000
/** No frame for this long = connection/stream lost; readings show "-" */
export const METER_STALE_MS = 1500
/** Re-arm quickly (rather than waiting for the renew interval) once the stream has gone stale */
export const METER_STALE_REARM_MS = 1000
/** Readings below this are shown as silent ("-inf") */
export const METER_FLOOR_DB = -90

export const meterRateDefault = 100

// "/meters/1" (9 chars + NUL, padded to 12) then ",b" type tag (padded to 4)
const PACKET_HEADER = new TextEncoder().encode('/meters/1\0\0\0,b\0\0')
const BLOB_SIZE_OFFSET = PACKET_HEADER.length
const BLOB_DATA_OFFSET = BLOB_SIZE_OFFSET + 4

/**
 * Decode a raw UDP packet if it is a /meters/1 frame. Reads straight from the packet bytes (instead of the
 * osc.js blob arg, whose readBlob ignores the buffer byte offset) so byte offsets are always right.
 * Layout: header, blob size (int32 BE), value count (int32 LE), int16 LE values in 1/256 dB.
 * @param {Uint8Array} data
 * @returns {Float32Array | null} levels in dBFS
 */
export function decodeMeterPacket(data) {
	if (data.byteLength < BLOB_DATA_OFFSET + 4) return null
	for (let i = 0; i < PACKET_HEADER.length; i++) {
		if (data[i] !== PACKET_HEADER[i]) return null
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	const blobSize = view.getInt32(BLOB_SIZE_OFFSET, false)
	const count = view.getInt32(BLOB_DATA_OFFSET, true)
	const available = Math.floor((Math.min(blobSize, data.byteLength - BLOB_DATA_OFFSET) - 4) / 2)
	const total = Math.min(count, available)
	if (total <= 0) return null

	const levels = new Float32Array(total)
	for (let i = 0; i < total; i++) {
		levels[i] = view.getInt16(BLOB_DATA_OFFSET + 4 + i * 2, true) / 256
	}
	return levels
}

/**
 * One-decimal dBFS text: "-18.2", "-inf" when silent, "-" when there is no live data
 * @param {number | undefined} db
 */
export function formatMeterDb(db) {
	if (db === undefined) return '-'
	if (db < METER_FLOOR_DB) return '-inf'
	return db.toFixed(1)
}

export class XAirMeters {
	/** Peak of every frame received since the last publish */
	windowPeak = new Float32Array(METER_COUNT)
	windowFrames = 0
	/** Levels currently shown on buttons/variables */
	shown = new Float32Array(METER_COUNT)
	shownValid = false
	lastFrameAt = 0

	/** @param {Float32Array} levels dBFS */
	ingest(levels) {
		const n = Math.min(levels.length, METER_COUNT)
		if (this.windowFrames === 0) {
			this.windowPeak.fill(Number.NEGATIVE_INFINITY)
		}
		for (let i = 0; i < n; i++) {
			const v = levels[i]
			if (v > this.windowPeak[i]) this.windowPeak[i] = v
		}
		this.windowFrames++
		this.lastFrameAt = Date.now()
	}

	/** Returns true if readings were being shown (so they need clearing) */
	reset() {
		const wasShown = this.shownValid
		this.windowFrames = 0
		this.shownValid = false
		this.lastFrameAt = 0
		return wasShown
	}

	isStale(now = Date.now()) {
		return now - this.lastFrameAt >= METER_STALE_MS
	}

	/**
	 * Move the peak of the frames received since the last call onto the displayed levels.
	 * Returns true if anything a button could show changed.
	 */
	publish(now = Date.now()) {
		if (this.windowFrames > 0) {
			this.shown.set(this.windowPeak)
			this.windowFrames = 0
			this.shownValid = true
			return true
		}

		// No new frame this interval: hold the last reading, unless the stream has stopped
		if (this.shownValid && this.isStale(now)) {
			this.shownValid = false
			return true
		}
		return false
	}

	/**
	 * Displayed level in dBFS (the loudest of the given meters, e.g. both sides of a stereo pair),
	 * or undefined if there is no live data
	 * @param {number[]} indices
	 */
	getLevelDb(indices) {
		if (!this.shownValid || !indices?.length) return undefined
		let db = Number.NEGATIVE_INFINITY
		for (const i of indices) {
			if (i < 0 || i >= METER_COUNT) return undefined
			if (this.shown[i] > db) db = this.shown[i]
		}
		return db
	}
}

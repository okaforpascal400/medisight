/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture and VAD.
 *
 * Runs entirely in the Audio Worklet thread (separate OS thread from main).
 * This replaces ScriptProcessorNode which Chrome throttles/silences when
 * the main thread is busy or the page loses focus.
 *
 * Posts two message types back to the main thread:
 *
 *   { type: 'pcm', pcm: Float32Array }
 *       A 1024-sample chunk of mono float32 mic audio (~64 ms at 16 kHz).
 *       The Float32Array buffer is transferred (zero-copy) to the main thread.
 *       The main thread converts to Int16 and sends over the WebSocket.
 *
 *   { type: 'rms', rms: number }
 *       Root-mean-square of the latest 128-sample block (~8 ms at 16 kHz).
 *       Posted on every process() call so the main thread gets ~125 VAD
 *       readings per second — far faster than the old 100 ms setInterval.
 */
class MicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._chunkSize = 1024;                    // ~64 ms at 16 kHz
        this._buf = new Float32Array(this._chunkSize);
        this._pos = 0;
    }

    process(inputs, outputs, parameters) {
        // inputs[0][0] = mono channel from MediaStreamSource
        const channel = inputs[0] && inputs[0][0];
        if (!channel || channel.length === 0) return true;

        // ── RMS heartbeat (every 128 samples ≈ 8 ms) ─────────────────────
        // Sent before PCM so the main thread sees speech onset ASAP.
        let sq = 0;
        for (let i = 0; i < channel.length; i++) sq += channel[i] * channel[i];
        this.port.postMessage({ type: 'rms', rms: Math.sqrt(sq / channel.length) });

        // ── Accumulate PCM and post when chunk is full ────────────────────
        for (let i = 0; i < channel.length; i++) {
            this._buf[this._pos++] = channel[i];

            if (this._pos === this._chunkSize) {
                // Transfer ownership of the underlying ArrayBuffer — no memory copy.
                this.port.postMessage({ type: 'pcm', pcm: this._buf }, [this._buf.buffer]);
                // Allocate a fresh buffer for the next chunk.
                this._buf = new Float32Array(this._chunkSize);
                this._pos = 0;
            }
        }

        return true; // returning true keeps the processor alive
    }
}

registerProcessor('mic-processor', MicProcessor);

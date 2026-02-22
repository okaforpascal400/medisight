let websocket = null;
let audioContext = null;
let mediaStream = null;
let cameraStream = null;
let processor = null;
let cameraInterval = null;
let pingInterval = null;
let isConnected = false;

// Smooth streaming audio
let playbackContext = null;
let nextStartTime = 0;
const SAMPLE_RATE = 24000;

// Interruption handling
let activeSources = [];
let audioQueue = [];
let isAiSpeaking = false;
let vadCooldown = false;
const VAD_THRESHOLD = 0.03;
let interruptPending = false;

function stopAllAudio() {
    const toStop = activeSources.slice();
    activeSources = [];
    audioQueue = [];
    toStop.forEach(src => { try { src.stop(0); } catch (e) {} });
    nextStartTime = 0;
    isAiSpeaking = false;
    if (playbackContext && playbackContext.state === 'running') {
        playbackContext.suspend().catch(() => {});
    }
}

function updateStatus(text, state) {
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    statusText.textContent = text;
    dot.className = 'status-dot ' + (state || '');
}

function addMessage(text, role) {
    const transcript = document.getElementById('transcript');
    const msg = document.createElement('div');
    msg.className = `transcript-message ${role}`;
    msg.innerHTML = `<span>${text}</span>`;
    transcript.appendChild(msg);
    transcript.scrollTop = transcript.scrollHeight;
}

async function playAudioChunk(base64Data) {
    if (!playbackContext) return;
    if (interruptPending) return;
    try {
        if (playbackContext.state === 'suspended') {
            await playbackContext.resume();
        }
        if (interruptPending) return;

        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

        const audioBuffer = playbackContext.createBuffer(1, float32.length, SAMPLE_RATE);
        audioBuffer.copyToChannel(float32, 0);

        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);

        activeSources.push(source);
        source.onended = () => { activeSources = activeSources.filter(s => s !== source); };

        const now = playbackContext.currentTime;
        if (nextStartTime < now + 0.05) nextStartTime = now + 0.15;
        source.start(nextStartTime);
        nextStartTime += audioBuffer.duration;

    } catch (e) {
        console.error('Audio playback error:', e);
    }
}

async function startSession() {
    try {
        updateStatus('Connecting...', 'connecting');

        playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        nextStartTime = 0;

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        // ✅ KEY FIX: use wss:// on HTTPS, ws:// on HTTP
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/live`;
        websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
            isConnected = true;
            updateStatus('Connected — MediSight is listening', 'connected');

            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            document.getElementById('cameraBtn').disabled = false;

            startAudioCapture();

            pingInterval = setInterval(() => {
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 10000);
        };

        websocket.onmessage = async (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'audio') {
                if (interruptPending) return;
                isAiSpeaking = true;
                updateStatus('MediSight is speaking...', 'connected');
                playAudioChunk(data.data);

            } else if (data.type === 'text') {
                addMessage(data.data, 'assistant');

            } else if (data.type === 'turn_complete') {
                interruptPending = false;
                isAiSpeaking = false;
                nextStartTime = 0;
                if (playbackContext && playbackContext.state === 'suspended') {
                    playbackContext.resume().catch(() => {});
                }
                updateStatus('Connected — MediSight is listening', 'connected');

            } else if (data.type === 'interrupted') {
                isAiSpeaking = false;

                if (playbackContext && playbackContext.state === 'running') {
                    try { await playbackContext.suspend(); } catch (e) {}
                }

                stopAllAudio();

                if (playbackContext) {
                    try { playbackContext.close(); } catch (e) {}
                }
                playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
                nextStartTime = 0;
                interruptPending = false;

                updateStatus('Listening...', 'connected');
            }
        };

        websocket.onclose = () => {
            if (isConnected) {
                isConnected = false;
                updateStatus('Disconnected', 'error');
                cleanupSession();
            }
        };

        websocket.onerror = () => {
            updateStatus('Connection error', 'error');
            addMessage('Connection error. Please try again.', 'assistant');
        };

    } catch (err) {
        updateStatus('Error: ' + err.message, 'error');
        addMessage('Could not start session: ' + err.message, 'assistant');
    }
}

async function startAudioCapture() {
    audioContext = new AudioContext({ sampleRate: 16000 });

    try {
        await audioContext.audioWorklet.addModule('audio-processor.js');
    } catch (e) {
        console.error('Failed to load AudioWorklet module:', e);
        updateStatus('Audio processor failed to load', 'error');
        return;
    }

    const source = audioContext.createMediaStreamSource(mediaStream);

    const workletNode = new AudioWorkletNode(audioContext, 'mic-processor', {
        numberOfOutputs: 0
    });
    processor = workletNode;

    workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'pcm') {
            if (!isConnected || !websocket || websocket.readyState !== WebSocket.OPEN) return;
            const int16 = new Int16Array(data.pcm.length);
            for (let i = 0; i < data.pcm.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, data.pcm[i] * 32768));
            }
            websocket.send(JSON.stringify({
                type: 'audio',
                data: arrayBufferToBase64(int16.buffer)
            }));

        } else if (data.type === 'rms') {
            if (!isConnected || (!isAiSpeaking && activeSources.length === 0) || vadCooldown) return;

            if (data.rms > VAD_THRESHOLD) {
                console.log('VAD triggered, RMS:', data.rms.toFixed(4));
                vadCooldown = true;
                interruptPending = true;
                stopAllAudio();
                updateStatus('Listening...', 'connected');
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({ type: 'interrupt' }));
                }
                setTimeout(() => { vadCooldown = false; }, 500);
            }
        }
    };

    source.connect(workletNode);
}

async function toggleCamera() {
    if (cameraStream) { stopCamera(); return; }
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const video = document.getElementById('videoPreview');
        video.srcObject = cameraStream;
        document.getElementById('videoOverlay').classList.add('hidden');
        document.getElementById('cameraBtn').textContent = '📷 Camera Off';
        cameraInterval = setInterval(() => {
            if (!isConnected) return;
            captureAndSendFrame();
        }, 2000);
        addMessage('Camera on — I can now see what you\'re showing me!', 'assistant');
    } catch (err) {
        addMessage('Could not access camera: ' + err.message, 'assistant');
    }
}

function captureAndSendFrame() {
    const video = document.getElementById('videoPreview');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    canvas.getContext('2d').drawImage(video, 0, 0, 640, 480);
    canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64 = reader.result.split(',')[1];
            if (websocket && isConnected && websocket.readyState === WebSocket.OPEN) {
                websocket.send(JSON.stringify({ type: 'image', data: base64 }));
            }
        };
        reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.8);
}

function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (cameraInterval) { clearInterval(cameraInterval); cameraInterval = null; }
    const video = document.getElementById('videoPreview');
    video.srcObject = null;
    document.getElementById('videoOverlay').classList.remove('hidden');
    document.getElementById('cameraBtn').textContent = '📷 Camera';
}

function cleanupSession() {
    stopCamera();
    if (pingInterval)    { clearInterval(pingInterval); pingInterval = null; }
    if (processor)       { processor.disconnect(); processor = null; }
    if (audioContext)    { audioContext.close(); audioContext = null; }
    if (playbackContext) { playbackContext.close(); playbackContext = null; }
    if (mediaStream)     { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    activeSources = [];
    audioQueue = [];
    isAiSpeaking = false;
    vadCooldown = false;
    interruptPending = false;
    nextStartTime = 0;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('cameraBtn').disabled = true;
}

function stopSession() {
    isConnected = false;
    if (websocket) { websocket.close(); websocket = null; }
    cleanupSession();
    updateStatus('Session ended', '');
    addMessage('Session ended. Click Start Session to begin again.', 'assistant');
}

function sendText() {
    const input = document.getElementById('textInput');
    const text = input.value.trim();
    if (!text) return;
    if (!isConnected || !websocket) {
        addMessage('Please start a session first.', 'assistant');
        return;
    }
    addMessage(text, 'user');
    websocket.send(JSON.stringify({ type: 'text', content: text }));
    input.value = '';
}

function handleKeyPress(event) {
    if (event.key === 'Enter') sendText();
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
import asyncio
import base64
import json
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from google import genai
from google.genai import types
import uvicorn

load_dotenv()

app = FastAPI()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
client = genai.Client(
    api_key=GEMINI_API_KEY,
    http_options=types.HttpOptions(api_version="v1alpha")
)

SYSTEM_PROMPT = """You MUST always respond in English only, regardless of what language the user speaks in. Never switch languages.

You are MediSight, a compassionate real-time medical visual assistant.
Help users understand medications, medical documents, symptoms, and nutrition labels.
Always speak clearly and warmly. Never diagnose — always inform and guide.
Recommend seeing a doctor for serious concerns.
If you see a medical emergency, say so immediately and tell them to call emergency services."""

# Silent audio frame — 100ms of silence at 16kHz, 16-bit PCM
SILENT_FRAME = bytes(3200)


@app.websocket("/live")
async def live_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected")

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=SYSTEM_PROMPT,
    )

    # Queue decouples browser input from Gemini session lifecycle.
    # Messages survive session drops and are forwarded to the new session.
    input_queue: asyncio.Queue = asyncio.Queue()
    browser_closed = asyncio.Event()

    async def receive_from_client():
        """Pump browser WebSocket messages into input_queue."""
        try:
            async for message in websocket.iter_text():
                data = json.loads(message)
                if data["type"] == "ping":
                    await websocket.send_json({"type": "pong"})
                else:
                    await input_queue.put(data)
        except WebSocketDisconnect:
            print("Client disconnected")
        except Exception as e:
            print(f"Client receive error: {e}")
        finally:
            browser_closed.set()

    async def run_sessions():
        """
        Keep a Gemini Live session running for the lifetime of the browser
        connection. Automatically reconnects with exponential backoff whenever
        the Gemini session drops (e.g. the 1011 keepalive-ping-timeout error).
        """
        reconnect_delay = 0.5
        first_connect = True  # send welcome greeting only on the initial session

        while not browser_closed.is_set():
            send_greeting = first_connect
            first_connect = False

            try:
                async with client.aio.live.connect(
                    model="gemini-2.5-flash-native-audio-latest", config=config
                ) as session:
                    print("Gemini Live session started")
                    reconnect_delay = 0.5  # reset backoff on a clean connect

                    # Mutable container so the nested closure can update it
                    # without a nonlocal declaration.
                    last_sent = [asyncio.get_running_loop().time()]

                    async def forward_to_gemini():
                        """
                        Drain input_queue → Gemini.
                        Uses a short timeout on queue.get() to inject keepalive
                        silence frames instead of a separate keepalive task.
                        This guarantees the silent frames and real audio never
                        race each other, and the keepalive stops automatically
                        when this coroutine is cancelled on session death.
                        """
                        try:
                            # On the very first session, prompt Gemini to greet
                            # the user so she introduces herself immediately
                            # without waiting for the user to speak.
                            if send_greeting:
                                await session.send_client_content(
                                    turns=types.Content(
                                        role="user",
                                        parts=[types.Part(text=(
                                            "Respond in English only. "
                                            "Please greet the user and introduce yourself as MediSight. "
                                            "Mention you can help with medications, prescriptions, "
                                            "medical documents, symptoms, and nutrition labels. "
                                            "Keep it warm and concise — two or three sentences."
                                        ))]
                                    ),
                                    turn_complete=True
                                )

                            while not browser_closed.is_set():
                                try:
                                    data = await asyncio.wait_for(
                                        input_queue.get(), timeout=0.2
                                    )
                                except asyncio.TimeoutError:
                                    # No browser audio for >200 ms — send silence
                                    if asyncio.get_running_loop().time() - last_sent[0] > 0.4:
                                        await session.send_realtime_input(
                                            audio=types.Blob(
                                                data=SILENT_FRAME,
                                                mime_type="audio/pcm;rate=16000"
                                            )
                                        )
                                        last_sent[0] = asyncio.get_running_loop().time()
                                    continue

                                last_sent[0] = asyncio.get_running_loop().time()
                                t = data.get("type")

                                if t == "audio":
                                    await session.send_realtime_input(
                                        audio=types.Blob(
                                            data=base64.b64decode(data["data"]),
                                            mime_type="audio/pcm;rate=16000"
                                        )
                                    )
                                elif t == "image":
                                    await session.send_realtime_input(
                                        video=types.Blob(
                                            data=base64.b64decode(data["data"]),
                                            mime_type="image/jpeg"
                                        )
                                    )
                                elif t == "text":
                                    await session.send_client_content(
                                        turns=types.Content(
                                            role="user",
                                            parts=[types.Part(text=data["content"])]
                                        ),
                                        turn_complete=True
                                    )

                                elif t == "interrupt":
                                    # Frontend VAD fired — echo confirmation so the
                                    # frontend onmessage handler can do any final
                                    # cleanup. The real interruption of Gemini's
                                    # generation happens via its own server-side VAD
                                    # as it receives the live user audio stream.
                                    print("Client interrupt received — confirming")
                                    await websocket.send_json({"type": "interrupted"})
                        except asyncio.CancelledError:
                            raise
                        except Exception as e:
                            print(f"Forward to Gemini error: {e}")

                    async def receive_from_gemini():
                        """Forward Gemini responses to the browser."""
                        try:
                            async for response in session.receive():
                                if browser_closed.is_set():
                                    break

                                if hasattr(response, 'data') and response.data:
                                    await websocket.send_json({
                                        "type": "audio",
                                        "data": base64.b64encode(response.data).decode()
                                    })
                                    continue

                                sc = getattr(response, 'server_content', None)
                                if sc:
                                    # Gemini detected user speech mid-response and
                                    # stopped generating. Tell the frontend to clear
                                    # its audio queue immediately.
                                    if getattr(sc, 'interrupted', False):
                                        print("Turn interrupted by user speech")
                                        await websocket.send_json({"type": "interrupted"})

                                    mt = getattr(sc, 'model_turn', None)
                                    if mt:
                                        for part in mt.parts:
                                            if getattr(part, 'text', None):
                                                await websocket.send_json({
                                                    "type": "text",
                                                    "data": part.text
                                                })
                                            if getattr(part, 'inline_data', None):
                                                await websocket.send_json({
                                                    "type": "audio",
                                                    "data": base64.b64encode(
                                                        part.inline_data.data
                                                    ).decode()
                                                })

                                    if getattr(sc, 'turn_complete', False):
                                        print("Turn complete — ready for next input")
                                        await websocket.send_json({"type": "turn_complete"})

                        except asyncio.CancelledError:
                            raise
                        except Exception as e:
                            print(f"Gemini receive error: {e}")

                    # Create tasks so we can cancel whichever one is still
                    # running when the other terminates (session dies).
                    fwd = asyncio.create_task(forward_to_gemini())
                    rcv = asyncio.create_task(receive_from_gemini())

                    # Block until either task ends (session drop = one dies)
                    _, pending = await asyncio.wait(
                        [fwd, rcv],
                        return_when=asyncio.FIRST_COMPLETED
                    )

                    # Cancel whichever task is still blocked (e.g. session.receive()
                    # hanging on a dead connection) so we exit cleanly.
                    for task in pending:
                        task.cancel()
                        try:
                            await task
                        except asyncio.CancelledError:
                            pass

            except Exception as e:
                print(f"Session error: {e}")

            if browser_closed.is_set():
                break

            print(f"Gemini session ended — reconnecting in {reconnect_delay:.1f}s")
            try:
                await websocket.send_json({
                    "type": "text",
                    "data": "Session refreshing — one moment…"
                })
            except Exception:
                pass

            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 5.0)  # cap at 5 s

    try:
        await asyncio.gather(
            receive_from_client(),
            run_sessions()
        )
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"status": "MediSight is running"}

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True, app_dir="backend")

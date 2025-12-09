import { useEffect, useRef, useState, useCallback } from 'react';
import { Adb } from '@yume-chan/adb';
import { 
  AdbScrcpyClient, 
  AdbScrcpyOptions3_3_1, 
  AdbScrcpyExitedError 
} from '@yume-chan/adb-scrcpy';
import { 
  WebCodecsVideoDecoder, 
  WebGLVideoFrameRenderer, 
  BitmapVideoFrameRenderer 
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { 
  AndroidKeyEventAction, 
  AndroidKeyCode,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  ScrcpyInjectTouchControlMessage,
  ScrcpyInjectScrollControlMessage,
  ScrcpyInjectKeyCodeControlMessage
} from '@yume-chan/scrcpy';
import { DeviceInputRecorder } from '../utils/DeviceInputRecorder';

interface ScrcpyPlayerProps {
  device: Adb;
}

// Basic key mapping
const KeyMap: Record<string, AndroidKeyCode> = {
  'Backspace': AndroidKeyCode.Backspace,
  'Tab': AndroidKeyCode.Tab,
  'Enter': AndroidKeyCode.Enter,
  'ShiftLeft': AndroidKeyCode.ShiftLeft,
  'ShiftRight': AndroidKeyCode.ShiftRight,
  'ControlLeft': AndroidKeyCode.ControlLeft,
  'ControlRight': AndroidKeyCode.ControlRight,
  'AltLeft': AndroidKeyCode.AltLeft,
  'AltRight': AndroidKeyCode.AltRight,
  'Escape': AndroidKeyCode.Escape,
  'Space': AndroidKeyCode.Space,
  'ArrowLeft': AndroidKeyCode.ArrowLeft,
  'ArrowUp': AndroidKeyCode.ArrowUp,
  'ArrowRight': AndroidKeyCode.ArrowRight,
  'ArrowDown': AndroidKeyCode.ArrowDown,
  'Delete': AndroidKeyCode.Delete,
  'Home': AndroidKeyCode.Home,
  'End': AndroidKeyCode.End,
  'PageUp': AndroidKeyCode.PageUp,
  'PageDown': AndroidKeyCode.PageDown,
};

type RecordedEvent = 
  | { type: 'touch'; timestamp: number; payload: Omit<ScrcpyInjectTouchControlMessage, 'type'> }
  | { type: 'scroll'; timestamp: number; payload: Omit<ScrcpyInjectScrollControlMessage, 'type'> }
  | { type: 'key'; timestamp: number; payload: Omit<ScrcpyInjectKeyCodeControlMessage, 'type'> };

export function ScrcpyPlayer({ device }: ScrcpyPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const runningRef = useRef(false);
  const clientRef = useRef<AdbScrcpyClient<AdbScrcpyOptions3_3_1<boolean>> | undefined>(undefined);
  const videoSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const deviceInputRecorderRef = useRef<DeviceInputRecorder | undefined>(undefined);

  // Recording & Replay State
  const [isRecording, setIsRecording] = useState(false);
  const [recordSource, setRecordSource] = useState<'web' | 'device'>('web');
  const [isReplaying, setIsReplaying] = useState(false);
  const [eventCount, setEventCount] = useState(0); // To force re-render when events change
  const recordedEventsRef = useRef<RecordedEvent[]>([]);
  const startTimeRef = useRef<number>(0);

  const startRecording = useCallback(async () => {
    recordedEventsRef.current = [];
    startTimeRef.current = Date.now();
    setIsRecording(true);
    setEventCount(0);

    if (recordSource === 'device') {
        const recorder = new DeviceInputRecorder(device);
        deviceInputRecorderRef.current = recorder;
        
        // Start recording in background
        recorder.start((event) => {
            if (event.type === 'touch') {
                if (!videoSizeRef.current || event.x === undefined || event.y === undefined || !event.action) return;
                const { width, height } = videoSizeRef.current;
                
                // Map normalized coords to pixels
                const pointerX = event.x * width;
                const pointerY = event.y * height;
                
                const action = event.action === 'down' ? AndroidMotionEventAction.Down :
                               event.action === 'up' ? AndroidMotionEventAction.Up :
                               AndroidMotionEventAction.Move;
                               
                const payload = {
                    action,
                    pointerId: BigInt(0),
                    pointerX: Math.max(0, Math.min(pointerX, width)),
                    pointerY: Math.max(0, Math.min(pointerY, height)),
                    videoWidth: width,
                    videoHeight: height,
                    pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
                    actionButton: 0,
                    buttons: 1, // Simulate primary button
                };
                
                recordedEventsRef.current.push({
                    type: 'touch',
                    timestamp: Date.now() - startTimeRef.current,
                    payload
                });
                setEventCount(prev => prev + 1);
            } else if (event.type === 'key') {
                if (!event.keyCode || event.keyAction === undefined) return;
                
                const payload = {
                    action: event.keyAction,
                    keyCode: event.keyCode,
                    metaState: AndroidKeyEventMeta.None,
                    repeat: 0,
                };

                recordedEventsRef.current.push({
                    type: 'key',
                    timestamp: Date.now() - startTimeRef.current,
                    payload
                });
                setEventCount(prev => prev + 1);
            }
        }).catch (e => {
            console.error('Device recording failed', e);
            setStatus('Device recording failed');
            setIsRecording(false);
        });
    }
  }, [recordSource, device]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    if (deviceInputRecorderRef.current) {
        deviceInputRecorderRef.current.stop();
        deviceInputRecorderRef.current = undefined;
    }
  }, []);

  const recordEvent = useCallback(<T extends RecordedEvent['type']>(
    type: T, 
    payload: Extract<RecordedEvent, { type: T }>['payload']
  ) => {
    if (isRecording && recordSource === 'web') {
      recordedEventsRef.current.push({
        type,
        timestamp: Date.now() - startTimeRef.current,
        payload
      } as RecordedEvent);
      setEventCount(prev => prev + 1);
    }
  }, [isRecording, recordSource]);

  const replayEvents = useCallback(async () => {
    if (isReplaying || recordedEventsRef.current.length === 0) return;
    
    setIsReplaying(true);
    const events = recordedEventsRef.current;
    const start = Date.now();

    try {
      for (const event of events) {
        if (!runningRef.current) break;

        const targetTime = start + event.timestamp;
        const delay = targetTime - Date.now();
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (!clientRef.current?.controller) continue;

        try {
          if (event.type === 'touch') {
            await clientRef.current.controller.injectTouch(event.payload);
          } else if (event.type === 'scroll') {
            await clientRef.current.controller.injectScroll(event.payload);
          } else if (event.type === 'key') {
            const payload = {
                action: event.payload.action as AndroidKeyEventAction,
                keyCode: event.payload.keyCode as AndroidKeyCode,
                metaState: (event.payload.metaState ?? AndroidKeyEventMeta.None) as AndroidKeyEventMeta,
                repeat: event.payload.repeat ?? 0,
            };
            await clientRef.current.controller.injectKeyCode(payload);
          }
        } catch (e) {
          console.error('Replay injection failed', e);
        }
      }
    } finally {
      setIsReplaying(false);
    }
  }, [isReplaying]);

  const saveEvents = useCallback(() => {
    const json = JSON.stringify(recordedEventsRef.current, (_key, value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        return value;
    });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrcpy-recording-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const loadEvents = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const events = JSON.parse(event.target?.result as string);
        if (Array.isArray(events)) {
          // Fix BigInt for touch events
          const processedEvents = events.map((ev: unknown) => {
             const e = ev as { type?: string; payload?: { pointerId?: string | bigint; [key: string]: unknown }; [key: string]: unknown };
             if (e.type === 'touch' && e.payload && typeof e.payload.pointerId === 'string') {
                 return {
                    ...e,
                    payload: {
                        ...e.payload,
                        pointerId: BigInt(e.payload.pointerId)
                    }
                 } as RecordedEvent;
             }
             return e as RecordedEvent;
          });
          recordedEventsRef.current = processedEvents;
          setEventCount(processedEvents.length);
          alert(`Loaded ${processedEvents.length} events`);
        }
      } catch (err) {
        alert('Failed to parse file');
        console.error(err);
      }
    };
    reader.readAsText(file);
    // Reset input value to allow loading same file again
    e.target.value = '';
  }, []);

  // Input handlers
  const handleMouseEvent = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (isReplaying) return; // Ignore input during replay
    if (!clientRef.current?.controller || !videoSizeRef.current || !containerRef.current) return;

    const { width: videoWidth, height: videoHeight } = videoSizeRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    
    // Calculate scaling to maintain aspect ratio within the container
    const containerRatio = rect.width / rect.height;
    const videoRatio = videoWidth / videoHeight;
    
    let displayWidth, displayHeight, offsetX, offsetY;

    if (containerRatio > videoRatio) {
      // Container is wider than video - height is the constraint
      displayHeight = rect.height;
      displayWidth = displayHeight * videoRatio;
      offsetX = (rect.width - displayWidth) / 2;
      offsetY = 0;
    } else {
      // Container is taller than video - width is the constraint
      displayWidth = rect.width;
      displayHeight = displayWidth / videoRatio;
      offsetX = 0;
      offsetY = (rect.height - displayHeight) / 2;
    }

    // Map coordinates
    const clientX = e.clientX - rect.left - offsetX;
    const clientY = e.clientY - rect.top - offsetY;

    // Check if click is within the video area
    if (clientX < 0 || clientX > displayWidth || clientY < 0 || clientY > displayHeight) {
      return;
    }

    const x = (clientX / displayWidth) * videoWidth;
    const y = (clientY / displayHeight) * videoHeight;

    // Determine action
    let action: number;
    if (e.type === 'mousedown') action = AndroidMotionEventAction.Down;
    else if (e.type === 'mouseup') action = AndroidMotionEventAction.Up;
    else if (e.type === 'mousemove') action = AndroidMotionEventAction.Move;
    else return;

    // Only send move events if button is pressed (drag)
    if (action === AndroidMotionEventAction.Move && e.buttons === 0) return;

    const payload = {
      action: action as AndroidMotionEventAction,
      pointerId: BigInt(0),
      pointerX: Math.max(0, Math.min(x, videoWidth)),
      pointerY: Math.max(0, Math.min(y, videoHeight)),
      videoWidth,
      videoHeight,
      pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
      actionButton: 0,
      buttons: e.buttons,
    };

    recordEvent('touch', payload);

    try {
      await clientRef.current.controller.injectTouch(payload);
    } catch (err) {
      console.error('Inject touch failed', err);
    }
  }, [isReplaying, recordEvent]);

  const handleWheel = useCallback(async (e: React.WheelEvent<HTMLDivElement>) => {
     if (isReplaying) return;
     if (!clientRef.current?.controller || !videoSizeRef.current || !containerRef.current) return;
     
     const { width: videoWidth, height: videoHeight } = videoSizeRef.current;
     const rect = containerRef.current.getBoundingClientRect();
     // Simplified coordinate mapping (reusing logic would be better but keeping it inline for now)
     // For scroll, exact position matters less than center, but let's be approximate
     const x = (e.clientX - rect.left) / rect.width * videoWidth;
     const y = (e.clientY - rect.top) / rect.height * videoHeight;

     const payload = {
       pointerX: Math.max(0, Math.min(x, videoWidth)),
       pointerY: Math.max(0, Math.min(y, videoHeight)),
       videoWidth,
       videoHeight,
       scrollX: -e.deltaX / 100,
       scrollY: -e.deltaY / 100,
       buttons: e.buttons
     };

     recordEvent('scroll', payload);

     try {
       await clientRef.current.controller.injectScroll(payload);
     } catch (err) {
       console.error('Inject scroll failed', err);
     }
  }, [isReplaying, recordEvent]);

  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isReplaying) return;
    if (!clientRef.current?.controller) return;

    // Prevent default browser actions for some keys
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
    }

    let keyCode = KeyMap[e.code];
    
    // Handle letters and numbers
    if (!keyCode) {
      if (/^Key[A-Z]$/.test(e.code)) {
        const char = e.code.slice(3);
        keyCode = AndroidKeyCode[`Key${char}` as keyof typeof AndroidKeyCode];
      } else if (/^Digit[0-9]$/.test(e.code)) {
         const digit = e.code.slice(5);
         keyCode = AndroidKeyCode[`Digit${digit}` as keyof typeof AndroidKeyCode];
      }
    }

    if (keyCode) {
      const payload = {
        action: AndroidKeyEventAction.Down as AndroidKeyEventAction,
        keyCode: keyCode as AndroidKeyCode,
        metaState: AndroidKeyEventMeta.None as AndroidKeyEventMeta,
        repeat: 0,
      };

      recordEvent('key', payload);

      try {
        await clientRef.current.controller.injectKeyCode(payload);
      } catch (err) {
        console.error('Inject key down failed', err);
      }
    }
  }, [isReplaying, recordEvent]);

  const handleKeyUp = useCallback(async (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isReplaying) return;
    if (!clientRef.current?.controller) return;

    let keyCode = KeyMap[e.code];
    
    if (!keyCode) {
        if (/^Key[A-Z]$/.test(e.code)) {
            const char = e.code.slice(3);
            keyCode = AndroidKeyCode[`Key${char}` as keyof typeof AndroidKeyCode];
        } else if (/^Digit[0-9]$/.test(e.code)) {
            const digit = e.code.slice(5);
            keyCode = AndroidKeyCode[`Digit${digit}` as keyof typeof AndroidKeyCode];
        }
    }

    if (keyCode) {
      const payload = {
        action: AndroidKeyEventAction.Up as AndroidKeyEventAction,
        keyCode: keyCode as AndroidKeyCode,
        metaState: AndroidKeyEventMeta.None as AndroidKeyEventMeta,
        repeat: 0,
      };

      recordEvent('key', payload);

      try {
        await clientRef.current.controller.injectKeyCode(payload);
      } catch (err) {
        console.error('Inject key up failed', err);
      }
    }
  }, [isReplaying, recordEvent]);

  useEffect(() => {
    let client: AdbScrcpyClient<AdbScrcpyOptions3_3_1<boolean>> | undefined;
    let decoder: WebCodecsVideoDecoder | undefined;

    const start = async () => {
      if (runningRef.current) return;
      runningRef.current = true;

      try {
        setStatus('Pushing server...');
        const response = await fetch('/scrcpy-server');
        if (!response.body) throw new Error('Failed to fetch server binary');
        
        // Push server to device
        await AdbScrcpyClient.pushServer(
          device,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response.body as any, 
          '/data/local/tmp/scrcpy-server.jar'
        );

        setStatus('Starting server...');
        // Disable audio for stability, enable control
        const options = new AdbScrcpyOptions3_3_1({
            audio: false,
            control: true,
        });
        
        client = await AdbScrcpyClient.start(
          device,
          '/data/local/tmp/scrcpy-server.jar',
          options
        );
        
        clientRef.current = client;

        setStatus('Connecting video...');
        const videoStream = await client.videoStream;
        
        if (videoStream && containerRef.current) {
            const { metadata, stream } = videoStream;
            videoSizeRef.current = { width: metadata.width ?? 0, height: metadata.height ?? 0 };
            
            // Create a canvas element
            const canvas = document.createElement('canvas');
            canvas.className = 'w-full h-full object-contain pointer-events-none'; // Ensure clicks go to container
            // Clear previous content
            containerRef.current.innerHTML = '';
            containerRef.current.appendChild(canvas);

            let renderer;
            try {
                renderer = new WebGLVideoFrameRenderer(canvas);
            } catch (e) {
                console.warn('WebGL not supported, falling back to Bitmap renderer', e);
                renderer = new BitmapVideoFrameRenderer(canvas);
            }

            decoder = new WebCodecsVideoDecoder({
                codec: metadata.codec,
                renderer,
            });

            stream.pipeTo(decoder.writable).catch((e: unknown) => {
                console.error('Stream error:', e);
            });
            
            setStatus('Streaming');
            
            // Auto focus container for keyboard events
            containerRef.current.focus();
        }
      } catch (e: unknown) {
        console.error(e);
        if (e instanceof AdbScrcpyExitedError) {
             const msg = `Server Error: ${e.output.join('\n')}`;
             console.error(msg);
             setStatus(msg);
        } else {
             const message = e instanceof Error ? e.message : String(e);
             setStatus(`Error: ${message}`);
        }
        runningRef.current = false;
      }
    };

    start();

    return () => {
      runningRef.current = false;
      client?.close();
      decoder?.dispose();
      clientRef.current = undefined;
    };
  }, [device]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="bg-gray-800 text-white p-2 text-sm flex justify-between items-center shrink-0 gap-4">
        <div className="flex items-center gap-2">
           <span>Status: {status}</span>
        </div>
        
        <div className="flex items-center gap-2">
            {!isRecording && !isReplaying && (
                <div className="flex items-center gap-1 bg-gray-700 rounded px-2 py-0.5 mr-2">
                    <span className="text-xs text-gray-400">Source:</span>
                    <select 
                        value={recordSource}
                        onChange={(e) => setRecordSource(e.target.value as 'web' | 'device')}
                        className="bg-transparent text-white text-xs outline-none border-none cursor-pointer"
                    >
                        <option value="web" className="bg-gray-800">Web Input</option>
                        <option value="device" className="bg-gray-800">Device Input</option>
                    </select>
                </div>
            )}

            {!isRecording && !isReplaying && (
                <button 
                    onClick={startRecording}
                    className="bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded text-xs"
                >
                    Record
                </button>
            )}
            
            {isRecording && (
                <button 
                    onClick={stopRecording}
                    className="bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded text-xs animate-pulse"
                >
                    Stop Recording ({eventCount})
                </button>
            )}

            {!isRecording && !isReplaying && recordedEventsRef.current.length > 0 && (
                <>
                    <button 
                        onClick={replayEvents}
                        className="bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded text-xs"
                    >
                        Replay ({eventCount})
                    </button>
                    <button 
                        onClick={saveEvents}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded text-xs"
                    >
                        Save
                    </button>
                </>
            )}

            {!isRecording && !isReplaying && (
                 <label className="bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded text-xs cursor-pointer">
                    Load
                    <input 
                        type="file" 
                        accept=".json" 
                        onChange={loadEvents}
                        className="hidden" 
                    />
                 </label>
            )}

            {isReplaying && (
                <span className="text-green-400 text-xs animate-pulse">Replaying...</span>
            )}
        </div>
      </div>
      <div 
        ref={containerRef} 
        className="flex-1 bg-black overflow-hidden relative flex items-center justify-center outline-none"
        tabIndex={0}
        onMouseDown={handleMouseEvent}
        onMouseUp={handleMouseEvent}
        onMouseMove={handleMouseEvent}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

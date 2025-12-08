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
  AndroidMotionEventAction
} from '@yume-chan/scrcpy';

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

export function ScrcpyPlayer({ device }: ScrcpyPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const runningRef = useRef(false);
  const clientRef = useRef<AdbScrcpyClient<any> | undefined>(undefined);
  const videoSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);

  // Input handlers
  const handleMouseEvent = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
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

    try {
      await clientRef.current.controller.injectTouch({
        action: action as AndroidMotionEventAction,
        pointerId: BigInt(0),
        pointerX: Math.max(0, Math.min(x, videoWidth)),
        pointerY: Math.max(0, Math.min(y, videoHeight)),
        videoWidth,
        videoHeight,
        pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
        actionButton: 0,
        buttons: e.buttons,
      });
    } catch (err) {
      console.error('Inject touch failed', err);
    }
  }, []);

  const handleWheel = useCallback(async (e: React.WheelEvent<HTMLDivElement>) => {
     if (!clientRef.current?.controller || !videoSizeRef.current || !containerRef.current) return;
     
     const { width: videoWidth, height: videoHeight } = videoSizeRef.current;
     const rect = containerRef.current.getBoundingClientRect();
     // Simplified coordinate mapping (reusing logic would be better but keeping it inline for now)
     // For scroll, exact position matters less than center, but let's be approximate
     const x = (e.clientX - rect.left) / rect.width * videoWidth;
     const y = (e.clientY - rect.top) / rect.height * videoHeight;

     try {
       await clientRef.current.controller.injectScroll({
         pointerX: Math.max(0, Math.min(x, videoWidth)),
         pointerY: Math.max(0, Math.min(y, videoHeight)),
         videoWidth,
         videoHeight,
         scrollX: -e.deltaX / 100,
         scrollY: -e.deltaY / 100,
         buttons: e.buttons
       });
     } catch (err) {
       console.error('Inject scroll failed', err);
     }
  }, []);

  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      try {
        await clientRef.current.controller.injectKeyCode({
          action: AndroidKeyEventAction.Down,
          keyCode,
          metaState: 0, // Simplified meta state
          repeat: 0,
        });
      } catch (err) {
        console.error('Inject key down failed', err);
      }
    }
  }, []);

  const handleKeyUp = useCallback(async (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      try {
        await clientRef.current.controller.injectKeyCode({
          action: AndroidKeyEventAction.Up,
          keyCode,
          metaState: 0,
          repeat: 0,
        });
      } catch (err) {
        console.error('Inject key up failed', err);
      }
    }
  }, []);

  useEffect(() => {
    let client: AdbScrcpyClient<any> | undefined;
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
          response.body as any, // Cast to any to bypass type mismatch if necessary
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

            stream.pipeTo(decoder.writable).catch(e => {
                console.error('Stream error:', e);
            });
            
            setStatus('Streaming');
            
            // Auto focus container for keyboard events
            containerRef.current.focus();
        }
      } catch (e: any) {
        console.error(e);
        if (e instanceof AdbScrcpyExitedError) {
             const msg = `Server Error: ${e.output.join('\n')}`;
             console.error(msg);
             setStatus(msg);
        } else {
             setStatus(`Error: ${e.message}`);
        }
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
      <div className="bg-gray-800 text-white p-2 text-sm flex justify-between shrink-0">
        <span>Scrcpy Status: {status}</span>
        <span className="text-gray-400 text-xs">Client v3.3.1</span>
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

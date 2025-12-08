import { useEffect, useRef, useState } from 'react';
import { Adb } from '@yume-chan/adb';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_1, AdbScrcpyExitedError } from '@yume-chan/adb-scrcpy';
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer, BitmapVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs';

interface ScrcpyPlayerProps {
  device: Adb;
}

export function ScrcpyPlayer({ device }: ScrcpyPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const runningRef = useRef(false);

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
        // Disable audio for stability
        const options = new AdbScrcpyOptions3_3_1({
            audio: false,
        });
        
        client = await AdbScrcpyClient.start(
          device,
          '/data/local/tmp/scrcpy-server.jar',
          options
        );

        setStatus('Connecting video...');
        const videoStream = await client.videoStream;
        
        if (videoStream && containerRef.current) {
            const { metadata, stream } = videoStream;
            
            // Create a canvas element
            const canvas = document.createElement('canvas');
            canvas.className = 'w-full h-full object-contain';
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
    };
  }, [device]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="bg-gray-800 text-white p-2 text-sm flex justify-between">
        <span>Scrcpy Status: {status}</span>
        <span className="text-gray-400 text-xs">Client v3.3.1</span>
      </div>
      <div ref={containerRef} className="flex-1 bg-black overflow-hidden relative flex items-center justify-center" />
    </div>
  );
}

import { useState, useCallback } from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbWebUsbBackendManager } from '@yume-chan/adb-backend-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { ScrcpyPlayer } from './components/ScrcpyPlayer';

function App() {
  const [device, setDevice] = useState<Adb | null>(null);
  const [status, setStatus] = useState<string>('Disconnected');
  const [deviceInfo, setDeviceInfo] = useState<string>('');
  const [scrcpyEnabled, setScrcpyEnabled] = useState(false);

  const connect = useCallback(async () => {
    try {
      setStatus('Requesting device...');
      const backend = await AdbWebUsbBackendManager.BROWSER!.requestDevice();
      
      if (!backend) {
        setStatus('No device selected');
        return;
      }

      setStatus('Connecting...');
      const connection = await backend.connect() as any;
      
      const credentialStore = new AdbWebCredentialStore();
      
      const transport = await AdbDaemonTransport.authenticate({
        serial: backend.serial,
        connection,
        credentialStore,
      });

      const adb = new Adb(transport);

      setDevice(adb);
      setStatus('Connected');
      setDeviceInfo(`${adb.banner.model} (${adb.banner.product}) - ${adb.banner.device}`);
      
    } catch (e: any) {
      console.error(e);
      setStatus(`Error: ${e.message}`);
      if (e.message && e.message.includes('No device selected')) {
        setStatus('Disconnected');
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (device) {
      try {
        await device.close();
      } catch (e) {
        console.error('Error closing device:', e);
      }
      setDevice(null);
      setStatus('Disconnected');
      setDeviceInfo('');
    }
  }, [device]);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col h-screen">
      <header className="bg-white shadow p-4 z-10 flex justify-between items-center shrink-0">
        <div>
          <h1 className="text-xl font-bold text-gray-800">WebADB Scrcpy</h1>
          <div className="text-xs text-gray-500">
            {deviceInfo || status}
          </div>
        </div>
        
        <div className="flex gap-2">
          {!device ? (
            <button
              onClick={connect}
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
            >
              Connect Device
            </button>
          ) : (
            <>
              <button
                onClick={() => setScrcpyEnabled(!scrcpyEnabled)}
                className={`${
                  scrcpyEnabled ? 'bg-amber-500 hover:bg-amber-600' : 'bg-green-600 hover:bg-green-700'
                } text-white font-semibold py-2 px-4 rounded transition duration-200`}
              >
                {scrcpyEnabled ? 'Stop Scrcpy' : 'Start Scrcpy'}
              </button>
              <button
                onClick={disconnect}
                className="bg-red-500 hover:bg-red-600 text-white font-semibold py-2 px-4 rounded transition duration-200"
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 bg-gray-900 relative overflow-hidden flex items-center justify-center">
        {scrcpyEnabled && device ? (
          <div className="w-full h-full p-4">
             <ScrcpyPlayer device={device} />
          </div>
        ) : (
          <div className="text-center text-gray-500">
            <p className="text-lg mb-2">Connect a device and start Scrcpy to view screen</p>
            <p className="text-sm opacity-70">Status: {status}</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
